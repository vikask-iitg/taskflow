// TaskFlow data layer on Firebase (Auth + Cloud Firestore).
//
// Firestore layout (protected by firestore.rules: each user can only touch their own data):
//   users/{uid}                  name, note, noteUpdatedAt, createdAt
//   users/{uid}/tasks/{taskId}   title, description, status, priority, category, dueDate,
//                                attachments, completedAt, deletedAt, createdAt, updatedAt
//
// The functions below keep the shapes the UI was built on ({ tasks }, { task }, task._id,
// ISO date strings), so app.js doesn't need to know about Firestore types.
// Attachment files live on the TaskFlow server (/api/attachments), which checks the
// user's Firebase ID token; Firestore only stores their metadata.
import { auth, db } from './firebase.js';
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  updateProfile as updateAuthProfile, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup,
  RecaptchaVerifier, signInWithPhoneNumber, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, onSnapshot, serverTimestamp,
  Timestamp, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const STATUSES = ['pending', 'completed'];
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const TRASH_RETENTION_DAYS = 60;
const COMPLETED_RETENTION_DAYS = 60; // completed tasks are removed this long after completion
// Always offered in the category picker and can't be deleted
const DEFAULT_CATEGORIES = ['Bills', 'Family', 'Groceries', 'Health', 'Interview', 'Personal', 'Purchase', 'Study', 'Work'];

/* ---------------- Errors ---------------- */

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Invalid email or password',
  'auth/invalid-login-credentials': 'Invalid email or password',
  'auth/wrong-password': 'Invalid email or password',
  'auth/user-not-found': 'Invalid email or password',
  'auth/email-already-in-use': 'An account with this email already exists. Try logging in instead.',
  'auth/invalid-email': 'Please enter a valid email address',
  'auth/weak-password': 'Password must be at least 8 characters',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error. Check your connection.',
  'auth/popup-closed-by-user': 'The Google sign-in window was closed before finishing.',
  'auth/cancelled-popup-request': 'The Google sign-in window was closed before finishing.',
  'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
  'auth/unauthorized-domain': 'This website address isn’t allowed to sign in yet. Add it under Firebase Authentication → Settings → Authorized domains.',
  'auth/operation-not-allowed': 'This sign-in method isn’t enabled in Firebase yet.',
  'auth/invalid-phone-number': 'Please enter a valid phone number with country code, for example +91 98765 43210',
  'auth/missing-phone-number': 'Please enter your phone number',
  'auth/invalid-verification-code': 'That code isn’t right. Check the SMS and try again.',
  'auth/code-expired': 'That code has expired. Please request a new one.',
  'auth/quota-exceeded': 'SMS limit reached for now. Please try again later.',
  'auth/captcha-check-failed': 'The security check failed. Please try again.',
  'auth/requires-recent-login': 'For your security, please log out and log in again, then retry.',
  'auth/account-exists-with-different-credential': 'An account already exists with this email using a different sign-in method.',
  'auth/billing-not-enabled': 'Phone sign-in needs the Firebase Blaze plan for real SMS. Use a test phone number, or upgrade the project.',
  'permission-denied': 'You don’t have permission to do that.',
  unavailable: 'Can’t reach the server. Check your connection.',
};

function friendly(err) {
  const message = AUTH_MESSAGES[err?.code] || err?.message || 'Something went wrong';
  return Object.assign(new Error(message), { code: err?.code });
}

// Runs a Firebase call and turns its error into a readable message
async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    throw friendly(err);
  }
}

/* ---------------- Conversions ---------------- */

const iso = (ts) => (ts instanceof Timestamp ? ts.toDate().toISOString() : null);
const toTimestamp = (value) => (value ? Timestamp.fromDate(new Date(value)) : null);

function toTask(snap) {
  const d = snap.data({ serverTimestamps: 'estimate' });
  return {
    _id: snap.id,
    title: d.title,
    description: d.description || '',
    status: d.status === 'in-progress' ? 'pending' : d.status, // "In progress" was retired
    priority: d.priority,
    category: d.category || '',
    dueDate: iso(d.dueDate),
    attachments: (d.attachments || []).map((a) => ({
      _id: a.id, originalName: a.name, mimeType: a.type, size: a.size, uploadedAt: iso(a.uploadedAt),
    })),
    completedAt: iso(d.completedAt),
    deletedAt: iso(d.deletedAt),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

// UI attachment shape -> Firestore shape
const toStoredAttachment = (a) => ({
  id: a._id, name: a.originalName, type: a.mimeType, size: a.size, uploadedAt: toTimestamp(a.uploadedAt),
});

/* ---------------- Session ---------------- */

let currentUser = null;      // firebase.User
let profile = null;          // users/{uid} data
let cache = new Map();       // taskId -> task (UI shape)
let unsubscribeTasks = null;
let tasksReady = Promise.resolve();
let pendingName = null;      // name typed during sign-up / phone sign-in, used for a new profile
const authListeners = new Set();
const taskListeners = new Set();

const userRef = () => doc(db, 'users', currentUser.uid);
const tasksCol = () => collection(db, 'users', currentUser.uid, 'tasks');
const taskRef = (id) => doc(db, 'users', currentUser.uid, 'tasks', id);

function publicUser() {
  if (!currentUser) return null;
  return {
    id: currentUser.uid,
    name: profile?.name || currentUser.displayName || 'Friend',
    email: currentUser.email || '',
    phone: currentUser.phoneNumber || '',
    providers: currentUser.providerData.map((p) => p.providerId),
    note: profile?.note || '',
    noteUpdatedAt: iso(profile?.noteUpdatedAt),
  };
}

// Creates users/{uid} the first time someone signs in
async function ensureProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const name = (pendingName || user.displayName || user.email?.split('@')[0] || 'Friend').trim().slice(0, 60);
  const data = { name, note: '', noteUpdatedAt: null, createdAt: serverTimestamp() };
  await setDoc(ref, data);
  return { ...data, createdAt: Timestamp.now() };
}

function subscribeTasks() {
  let resolveReady;
  let rejectReady;
  tasksReady = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  let first = true;
  unsubscribeTasks = onSnapshot(tasksCol(), (snap) => {
    cache = new Map(snap.docs.map((d) => [d.id, toTask(d)]));
    if (first) {
      first = false;
      resolveReady();
      purgeOldTrash();
    } else {
      taskListeners.forEach((fn) => fn());
    }
  }, (err) => {
    if (first) rejectReady(friendly(err));
    console.error('Task sync failed:', err);
  });
}

onAuthStateChanged(auth, async (user) => {
  unsubscribeTasks?.();
  unsubscribeTasks = null;
  cache = new Map();
  currentUser = user;
  profile = null;
  if (user) {
    try {
      profile = await ensureProfile(user);
    } catch (err) {
      console.error('Could not load profile:', err);
    }
    pendingName = null;
    subscribeTasks();
  }
  authListeners.forEach((fn) => fn(publicUser()));
});

/* ---------------- Task helpers ---------------- */

function requireTask(id) {
  const task = cache.get(id);
  if (!task) throw new Error('Task not found');
  return task;
}

// "2026-10": the due date's month, or the month the task was added if it has no due date
const monthKey = (t) => {
  const d = new Date(t.dueDate || t.createdAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const isDueToday = (t) => Boolean(t.dueDate) && new Date(t.dueDate).toDateString() === new Date().toDateString();
const isOverdue = (t) => t.dueDate && t.status !== 'completed' && new Date(t.dueDate) < new Date();

// Deleted tasks are removed for good after TRASH_RETENTION_DAYS,
// completed ones COMPLETED_RETENTION_DAYS after they were completed
async function purgeOldTrash() {
  const trashCutoff = Date.now() - TRASH_RETENTION_DAYS * 86400000;
  const doneCutoff = Date.now() - COMPLETED_RETENTION_DAYS * 86400000;
  const old = [...cache.values()].filter((t) => (t.deletedAt
    ? new Date(t.deletedAt).getTime() < trashCutoff
    : t.status === 'completed' && t.completedAt && new Date(t.completedAt).getTime() < doneCutoff));
  for (const t of old) await api.deleteTaskForever(t._id).catch(() => {});
}

// Builds Firestore fields from a UI payload (only fields that were sent)
function taskFields(payload, existing) {
  const out = {};
  if (payload.title !== undefined) {
    out.title = String(payload.title).trim();
    if (!out.title) throw new Error('Title is required');
  }
  if (payload.description !== undefined) out.description = String(payload.description).trim();
  if (payload.category !== undefined) out.category = String(payload.category).trim();
  if (payload.priority !== undefined) out.priority = payload.priority;
  if (payload.dueDate !== undefined) out.dueDate = toTimestamp(payload.dueDate);
  if (payload.status !== undefined) {
    out.status = payload.status;
    const wasDone = existing?.status === 'completed';
    if (payload.status === 'completed' && !wasDone) out.completedAt = serverTimestamp();
    if (payload.status !== 'completed') out.completedAt = null;
  }
  return out;
}

/* ---------------- Attachments (TaskFlow server) ---------------- */

async function attachmentRequest(path, options = {}) {
  if (!currentUser) throw new Error('Please log in again');
  const token = await currentUser.getIdToken();
  let res;
  try {
    res = await fetch(`/api/attachments/${path}`, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error('Network error. Check your connection.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return res;
}

async function setAttachments(taskId, attachments) {
  await updateDoc(taskRef(taskId), { attachments: attachments.map(toStoredAttachment), updatedAt: serverTimestamp() });
  return { task: { ...requireTask(taskId), attachments } };
}

/* ---------------- Public API ---------------- */

const api = {
  /* Auth */
  onAuthChange(fn) {
    authListeners.add(fn);
    return () => authListeners.delete(fn);
  },
  // Called when tasks change on another device or tab
  onTasksChange(fn) {
    taskListeners.add(fn);
    return () => taskListeners.delete(fn);
  },
  isSignedIn: () => Boolean(currentUser),

  register: ({ name, email, password }) => call(async () => {
    pendingName = name;
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await updateAuthProfile(cred.user, { displayName: name.trim() });
  }),
  login: ({ email, password }) => call(() => signInWithEmailAndPassword(auth, email.trim(), password)),
  signInWithGoogle: () => call(() => signInWithPopup(auth, new GoogleAuthProvider())),

  // Phone: send an SMS code, then confirm it. The reCAPTCHA is invisible unless Google needs a check.
  sendPhoneCode: (phoneNumber, buttonId) => call(async () => {
    window.taskflowRecaptcha?.clear();
    window.taskflowRecaptcha = new RecaptchaVerifier(auth, buttonId, { size: 'invisible' });
    return signInWithPhoneNumber(auth, phoneNumber, window.taskflowRecaptcha);
  }),
  confirmPhoneCode: (confirmation, code, name) => call(() => {
    pendingName = name?.trim() || null;
    return confirmation.confirm(code);
  }),

  forgotPassword: (email) => call(async () => {
    await sendPasswordResetEmail(auth, email.trim(), { url: `${location.origin}/` });
    return { message: 'If an account exists for that email, a reset link is on its way.' };
  }),

  logout: () => call(() => signOut(auth)),

  updateProfile: ({ name }) => call(async () => {
    const clean = String(name).trim().slice(0, 60);
    if (!clean) throw new Error('Display name is required');
    await updateDoc(userRef(), { name: clean });
    await updateAuthProfile(currentUser, { displayName: clean });
    profile = { ...profile, name: clean };
    return { user: publicUser() };
  }),

  changePassword: ({ currentPassword, newPassword }) => call(async () => {
    if (!currentUser.email) throw new Error('This account doesn’t use a password');
    const cred = EmailAuthProvider.credential(currentUser.email, currentPassword);
    try {
      await reauthenticateWithCredential(currentUser, cred);
    } catch (err) {
      if (['auth/invalid-credential', 'auth/wrong-password', 'auth/invalid-login-credentials'].includes(err.code)) {
        throw new Error('Current password is incorrect');
      }
      throw err;
    }
    await updatePassword(currentUser, newPassword);
    return { message: 'Password updated' };
  }),

  saveNote: (note) => call(async () => {
    await updateDoc(userRef(), { note, noteUpdatedAt: serverTimestamp() });
    profile = { ...profile, note };
    return { note, noteUpdatedAt: new Date().toISOString() };
  }),

  /* Tasks */
  async listTasks(params = {}) {
    await tasksReady;
    const { search = '', status = '', priority = '', category = '', month = '', sort = 'newest' } = params;
    const q = search.trim().toLowerCase();
    let tasks = [...cache.values()].filter((t) => (status === 'deleted' ? t.deletedAt : !t.deletedAt));
    // Finished tasks only show under Completed (and in the trash once deleted); 'all' keeps everything
    if (!['completed', 'deleted', 'all'].includes(status)) tasks = tasks.filter((t) => t.status !== 'completed');
    if (status === 'overdue') tasks = tasks.filter(isOverdue);
    else if (status === 'today') tasks = tasks.filter(isDueToday);
    else if (STATUSES.includes(status)) tasks = tasks.filter((t) => t.status === status);
    if (priority) tasks = tasks.filter((t) => t.priority === priority);
    if (category) tasks = tasks.filter((t) => t.category === category);
    if (month) tasks = tasks.filter((t) => monthKey(t) === month);
    if (q) tasks = tasks.filter((t) => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));

    const newest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
    const sorters = {
      newest,
      oldest: (a, b) => -newest(a, b),
      // Tasks without a due date go last
      due: (a, b) => (!a.dueDate - !b.dueDate) || (new Date(a.dueDate) - new Date(b.dueDate)) || newest(a, b),
      priority: (a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || newest(a, b),
    };
    tasks.sort(sorters[sort] || newest);
    // Copies, so UI changes (e.g. optimistic status updates) never alter the synced cache
    return { tasks: tasks.map((t) => ({ ...t })) };
  },

  async categories() {
    await tasksReady;
    const set = new Set([...cache.values()].filter((t) => !t.deletedAt && t.category).map((t) => t.category));
    return {
      categories: [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      defaultCategories: DEFAULT_CATEGORIES,
    };
  },

  async months() {
    await tasksReady;
    const set = new Set([...cache.values()].filter((t) => !t.deletedAt).map(monthKey));
    return { months: [...set].sort() };
  },

  async stats() {
    await tasksReady;
    const all = [...cache.values()];
    const active = all.filter((t) => !t.deletedAt);
    const count = (s) => active.filter((t) => t.status === s).length;
    return {
      stats: {
        total: active.length - count('completed'),
        pending: count('pending'),
        completed: count('completed'),
        overdue: active.filter(isOverdue).length,
        deleted: all.length - active.length,
      },
      trashRetentionDays: TRASH_RETENTION_DAYS,
      completedRetentionDays: COMPLETED_RETENTION_DAYS,
    };
  },

  createTask: (payload) => call(async () => {
    const fields = taskFields({ description: '', category: '', priority: 'medium', status: 'pending', dueDate: null, ...payload });
    const data = {
      description: '', category: '', priority: 'medium', status: 'pending', dueDate: null, completedAt: null,
      ...fields,
      attachments: [],
      deletedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const ref = await addDoc(tasksCol(), data);
    return { task: cache.get(ref.id) || { _id: ref.id, ...payload, attachments: [], createdAt: new Date().toISOString() } };
  }),

  updateTask: (id, payload) => call(async () => {
    const existing = requireTask(id);
    await updateDoc(taskRef(id), { ...taskFields(payload, existing), updatedAt: serverTimestamp() });
    return { task: { ...cache.get(id) } };
  }),

  deleteTask: (id) => call(() => updateDoc(taskRef(id), { deletedAt: serverTimestamp(), updatedAt: serverTimestamp() })),
  restoreTask: (id) => call(async () => {
    await updateDoc(taskRef(id), { deletedAt: null, updatedAt: serverTimestamp() });
    return { task: cache.get(id) };
  }),
  deleteTaskForever: (id) => call(async () => {
    const task = cache.get(id);
    await deleteDoc(taskRef(id));
    if (task?.attachments?.length) await attachmentRequest(encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  }),
  emptyTrash: () => call(async () => {
    const trashed = [...cache.values()].filter((t) => t.deletedAt);
    for (const t of trashed) await api.deleteTaskForever(t._id);
    return { deleted: trashed.length };
  }),

  // Removes a custom category from every task that uses it (tasks are kept)
  deleteCategory: (name) => call(async () => {
    if (DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase())) {
      throw new Error('Default categories can’t be deleted');
    }
    const affected = [...cache.values()].filter((t) => t.category === name);
    for (let i = 0; i < affected.length; i += 400) {
      const batch = writeBatch(db);
      affected.slice(i, i + 400).forEach((t) => batch.update(taskRef(t._id), { category: '', updatedAt: serverTimestamp() }));
      await batch.commit();
    }
    return { updated: affected.length };
  }),

  /* Attachments */
  uploadAttachments: (taskId, files) => call(async () => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f, f.name));
    const res = await attachmentRequest(encodeURIComponent(taskId), { method: 'POST', body: form });
    const { attachments } = await res.json();
    return setAttachments(taskId, [...requireTask(taskId).attachments, ...attachments]);
  }),
  deleteAttachment: (taskId, attId) => call(async () => {
    await attachmentRequest(`${encodeURIComponent(taskId)}/${encodeURIComponent(attId)}`, { method: 'DELETE' });
    return setAttachments(taskId, requireTask(taskId).attachments.filter((a) => a._id !== attId));
  }),
  async attachmentBlob(taskId, attId, { inline = false } = {}) {
    const res = await attachmentRequest(`${encodeURIComponent(taskId)}/${encodeURIComponent(attId)}${inline ? '?inline=1' : ''}`);
    return res.blob();
  },
};

window.api = api;
export default api;

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let lastListHtml = ''; // what renderTasks last put in #task-list
  const state = {
    user: null,
    tasks: [], // currently visible (filtered/sorted) tasks
    allTasks: [], // unfiltered (not deleted), used for stats
    deletedCount: 0,
    categories: [],
    defaultCategories: [],
    trashRetentionDays: 30,
    editingId: null,
    // The list opens on today's tasks; the Total card shows everything
    filters: { search: '', status: 'today', priority: '', category: '', month: '', sort: 'newest' },
  };

  const STATUS_LABELS = { pending: 'Pending', 'in-progress': 'In progress', completed: 'Completed' };
  const PRIORITY_LABELS = { low: 'Low', medium: 'Medium', high: 'High' };

  /* ---------------- Helpers ---------------- */

  const escapeHtml = (s = '') =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtDate = (d, opts = {}) =>
    new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts,
    }).format(new Date(d));

  function fmtDateSmart(d) {
    const date = new Date(d);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return fmtDate(date, sameYear ? {} : { year: 'numeric' });
  }

  // ISO -> { date, time } values for <input type="date"> / <input type="time"> in local time
  function toLocalInputs(iso) {
    if (!iso) return { date: '', time: '' };
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }

  const isOverdue = (t) => t.dueDate && t.status !== 'completed' && new Date(t.dueDate) < new Date();

  function relativeDue(iso) {
    const diff = new Date(iso) - new Date();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    const hours = Math.round(abs / 3600000);
    const days = Math.round(abs / 86400000);
    let unit;
    if (mins < 60) unit = `${mins} min`;
    else if (hours < 24) unit = `${hours} hr`;
    else unit = `${days} day${days === 1 ? '' : 's'}`;
    return diff < 0 ? `${unit} overdue` : `in ${unit}`;
  }

  /* ---------------- Links in descriptions ---------------- */

  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  // Drop trailing punctuation that is almost always sentence punctuation, not part of the URL.
  // A closing bracket is kept only if the URL also contains its opening pair, e.g. wiki/Foo_(bar)
  function trimUrl(url) {
    const pairs = { ')': '(', ']': '[', '}': '{' };
    let end = url.length;
    while (end > 0) {
      const ch = url[end - 1];
      if ('.,;:!?\'"'.includes(ch)) { end--; continue; }
      if (pairs[ch]) {
        const body = url.slice(0, end);
        if (body.split(pairs[ch]).length < body.split(ch).length) { end--; continue; }
      }
      break;
    }
    return url.slice(0, end);
  }

  // Escapes the text and turns http(s):// and www. URLs into safe links with a copy button
  function linkify(text) {
    let html = '';
    let last = 0;
    for (const match of text.matchAll(URL_RE)) {
      const url = trimUrl(match[0]);
      if (!url || /^www\.$/i.test(url)) continue;
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      html += escapeHtml(text.slice(last, match.index));
      html += `<span class="link-wrap"><a class="desc-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(href)} in a new tab">${escapeHtml(url)}</a>`
        + `<button type="button" class="link-copy" data-copy-url="${escapeHtml(href)}" aria-label="Copy link ${escapeHtml(url)}" title="Copy link">${COPY_ICON}</button></span>`;
      last = match.index + url.length;
    }
    return html + escapeHtml(text.slice(last));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers/contexts without the async clipboard API
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('Copy failed');
    }
  }

  // One delegated handler for every copy button (cards and details view)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-url]');
    if (!btn) return;
    e.stopPropagation();
    try {
      await copyText(btn.dataset.copyUrl);
      btn.innerHTML = CHECK_ICON;
      btn.classList.add('is-copied');
      toast('Link copied to clipboard', 'success');
      setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('is-copied'); }, 1500);
    } catch {
      toast('Could not copy the link', 'error');
    }
  });

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // action: optional { label, onClick } rendered as a button inside the toast (e.g. Undo)
  function toast(message, type = 'info', action = null) {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.textContent = message;
    el.append(text);

    const dismiss = () => {
      if (el.classList.contains('is-leaving')) return;
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };

    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast__action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { dismiss(); action.onClick(); }, { once: true });
      el.append(btn);
    }

    const container = $('#toasts');
    container.append(el);
    while (container.children.length > 3) container.firstElementChild.remove();
    setTimeout(dismiss, action ? 6000 : 3000);
  }

  const looksLikeEmail = (value) => /^\S+@\S+\.\S+$/.test(value.trim());

  function setFormError(form, msg = '') {
    const el = $('.form-error', form);
    if (el) el.textContent = msg;
  }

  async function withBusy(button, fn) {
    const label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Please wait…';
    try { return await fn(); } finally {
      button.disabled = false;
      button.innerHTML = label;
    }
  }

  /* ---------------- Theme ---------------- */

  // Light unless the user switched to dark (the OS appearance setting is not used)
  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('taskflow-theme', next); } catch {}
    syncThemeButtons();
  }

  function syncThemeButtons() {
    const dark = currentTheme() === 'dark';
    $$('[data-action="toggle-theme"]').forEach((b) => {
      b.setAttribute('aria-checked', String(dark));
      b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  /* ---------------- Views ---------------- */

  function showAuth(panel = 'login') {
    state.user = null;
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
    showAuthPanel(panel);
  }

  /* ---------------- Forgot password & phone sign-in ---------------- */

  // login | register | forgot | phone
  function showAuthPanel(panel) {
    const tabbed = panel === 'login' || panel === 'register';
    $('.tabs').hidden = !tabbed;
    $('.auth-alt').hidden = !tabbed;
    $('.auth-card').classList.toggle('is-recovery', !tabbed);
    $('#forgot-form').hidden = panel !== 'forgot';
    $('#phone-form').hidden = panel !== 'phone';
    if (tabbed) {
      switchTab(panel);
      $(panel === 'login' ? '#login-email' : '#reg-name').focus();
    } else {
      $('#login-form').hidden = true;
      $('#register-form').hidden = true;
      $(panel === 'forgot' ? '#forgot-email' : '#phone-number').focus();
    }
  }

  $('#forgot-link').addEventListener('click', () => {
    const form = $('#forgot-form');
    form.reset();
    setFormError(form);
    $('.form-success', form).textContent = '';
    form.email.value = $('#login-email').value.trim();
    showAuthPanel('forgot');
  });

  $$('[data-auth-back]').forEach((b) => b.addEventListener('click', () => showAuthPanel('login')));

  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = form.email.value.trim();
    setFormError(form);
    $('.form-success', form).textContent = '';
    if (!looksLikeEmail(email)) return setFormError(form, 'Please enter a valid email address.');
    try {
      const data = await withBusy($('button[type=submit]', form), () => api.forgotPassword(email));
      $('.form-success', form).textContent = `${data.message} Check your inbox (and spam folder).`;
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#google-btn').addEventListener('click', async (e) => {
    const authCard = $('.auth-card');
    $$('.form-error', authCard).forEach((el) => { el.textContent = ''; });
    try {
      await withBusy(e.currentTarget, () => api.signInWithGoogle());
    } catch (err) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
      setFormError($('#login-form').hidden ? $('#register-form') : $('#login-form'), err.message);
    }
  });

  // Phone: step 1 sends the SMS code, step 2 confirms it
  let phoneConfirmation = null;

  function setPhoneStep(step) {
    $('#phone-step-number').hidden = step !== 1;
    $('#phone-step-code').hidden = step !== 2;
    $('#phone-submit').textContent = step === 1 ? 'Send code' : 'Verify & continue';
    $('#phone-submit').dataset.step = String(step);
  }

  $('#phone-btn').addEventListener('click', () => {
    const form = $('#phone-form');
    form.reset();
    setFormError(form);
    phoneConfirmation = null;
    setPhoneStep(1);
    showAuthPanel('phone');
  });

  $('#phone-change').addEventListener('click', () => {
    phoneConfirmation = null;
    setFormError($('#phone-form'));
    setPhoneStep(1);
    $('#phone-number').focus();
  });

  $('#phone-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $('#phone-submit');
    setFormError(form);
    if (button.dataset.step === '1') {
      // Indian mobile numbers only: 10 digits starting with 6-9. A typed +91 / 91 / leading 0 is ignored.
      const digits = form.phone.value.replace(/\D/g, '').replace(/^(91(?=\d{10}$)|0(?=\d{10}$))/, '');
      if (!/^[6-9]\d{9}$/.test(digits)) return setFormError(form, 'Please enter a valid 10-digit Indian mobile number, for example 98765 43210.');
      const number = `+91${digits}`;
      try {
        phoneConfirmation = await withBusy(button, () => api.sendPhoneCode(number, 'phone-submit'));
        $('#phone-sent-to').textContent = `${digits.slice(0, 5)} ${digits.slice(5)}`;
        setPhoneStep(2);
        form.code.focus();
      } catch (err) {
        setFormError(form, err.message);
      }
    } else {
      const code = form.code.value.replace(/\D/g, '');
      if (code.length !== 6) return setFormError(form, 'Enter the 6-digit code from the SMS.');
      try {
        await withBusy(button, () => api.confirmPhoneCode(phoneConfirmation, code, form.name.value));
      } catch (err) {
        setFormError(form, err.message);
      }
    }
  });

  function showApp() {
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    loadNote();
    renderUser();
    loadTasks();
  }

  function renderUser() {
    const { name, email } = state.user;
    $('#user-name').textContent = name;
    $('#user-avatar').textContent = name.trim().charAt(0).toUpperCase();
    renderGreeting();
    $('#profile-email').textContent = email || state.user.phone;
    // Only email/password accounts have a password to change
    $('#password-form').hidden = !state.user.providers.includes('password');
    $('#password-form').previousElementSibling.hidden = $('#password-form').hidden;
  }

  const GREETING_ICONS = {
    // Sunrise
    Morning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 2v7M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1"/><path d="m8 6 4-4 4 4"/></svg>',
    // Sun
    Afternoon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v2.5M12 20v2.5M1.5 12H4M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>',
    // Moon
    Evening: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  };

  const SUMMARY_CALENDAR = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';

  // Re-run every minute so the greeting follows the clock while the tab stays open
  function renderGreeting() {
    if (!state.user) return;
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
    // After midnight it is still "Good Morning", but a moon fits the hour better than a sunrise
    const icon = hour < 5 ? 'Evening' : part;
    const name = state.user.name.trim().replace(/\s+/g, ' ').toUpperCase();
    $('#greeting').innerHTML = `<span class="greeting__icon greeting__icon--${icon.toLowerCase()}" aria-hidden="true">${GREETING_ICONS[icon]}</span>
      <span class="greeting__text"><span class="greeting__hello">Good ${part}</span> <span class="greeting__name">${escapeHtml(name)}</span></span>`;
  }

  function logout(message) {
    flushNote();
    api.logout();
    state.tasks = [];
    state.allTasks = [];
    $('#task-list').innerHTML = '';
    lastListHtml = '';
    showAuth();
    if (message) toast(message);
  }

  /* ---------------- Auth ---------------- */

  function switchTab(name) {
    $$('.tab').forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $('#login-form').hidden = name !== 'login';
    $('#register-form').hidden = name !== 'register';
  }

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = tab.dataset.tab === 'login' ? 'register' : 'login';
        switchTab(next);
        $(`[data-tab="${next}"]`).focus();
      }
    });
  });

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { email, password } = Object.fromEntries(new FormData(form));
    if (!email || !password) return setFormError(form, 'Please enter your email and password.');
    if (!looksLikeEmail(email)) {
      form.email.focus();
      return setFormError(form, 'Log in with your email address (for example you@example.com), not your name.');
    }
    setFormError(form);
    try {
      await withBusy($('button[type=submit]', form), () => api.login({ email, password }));
      form.reset();
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { name, email, password } = Object.fromEntries(new FormData(form));
    if (!name.trim() || !email || !password) return setFormError(form, 'All fields are required.');
    if (!looksLikeEmail(email)) {
      form.email.focus();
      return setFormError(form, 'Please enter a valid email address, for example you@example.com.');
    }
    if (password.length < 8) return setFormError(form, 'Password must be at least 8 characters.');
    setFormError(form);
    try {
      await withBusy($('button[type=submit]', form), () => api.register({ name, email, password }));
      form.reset();
      toast(`Welcome to TaskFlow, ${name.trim()}!`, 'success');
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#logout-btn').addEventListener('click', () => logout('You have been logged out.'));

  /* ---------------- Tasks: load & render ---------------- */

  function renderSkeletons(n = 4) {
    const list = $('#task-list');
    list.setAttribute('aria-busy', 'true');
    $('#empty-state').hidden = true;
    lastListHtml = null; // skeletons are showing, so the next render must always replace them
    list.innerHTML = Array.from({ length: n }, () => `
      <li class="task-card skeleton" aria-hidden="true">
        <span class="sk sk--check"></span>
        <div class="task-card__body">
          <span class="sk sk--title"></span>
          <span class="sk sk--line"></span>
          <span class="sk sk--meta"></span>
        </div>
      </li>`).join('');
  }

  let loadSeq = 0;
  async function loadTasks({ silent = false } = {}) {
    const seq = ++loadSeq;
    if (!silent) renderSkeletons();
    try {
      const [filtered, all, cats, months, stats] = await Promise.all([
        api.listTasks(state.filters),
        api.listTasks({}),
        api.categories(),
        api.months(),
        api.stats(),
      ]);
      if (seq !== loadSeq) return; // a newer request superseded this one
      state.tasks = filtered.tasks;
      state.allTasks = all.tasks;
      state.deletedCount = stats.stats.deleted;
      state.trashRetentionDays = stats.trashRetentionDays;
      state.defaultCategories = cats.defaultCategories || [];
      renderCategories(cats.categories);
      renderMonths(months.months);
      renderTasks();
      renderStats();
      refreshDetail();
    } catch (err) {
      if (seq !== loadSeq) return;
      $('#task-list').setAttribute('aria-busy', 'false');
      $('#task-list').innerHTML = '';
      lastListHtml = '';
      toast(err.message, 'error');
    }
  }

  function renderCategories(categories) {
    const select = $('#filter-category');
    const current = state.filters.category;
    select.innerHTML = '<option value="">All</option>' +
      categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (current && !categories.includes(current)) {
      select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
    }
    select.value = current;
    state.categories = categories;
    filterSelects.category.refresh();
  }

  const monthLabel = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  };

  function renderMonths(months) {
    const select = $('#filter-month');
    const current = state.filters.month;
    const keys = current && !months.includes(current) ? [...months, current].sort() : months;
    select.innerHTML = '<option value="">All</option>' +
      keys.map((k) => `<option value="${k}">${escapeHtml(monthLabel(k))}</option>`).join('');
    select.value = current;
    filterSelects.month.refresh();
  }

  function renderStats() {
    const all = state.allTasks;
    const count = (s) => all.filter((t) => t.status === s).length;
    const overdue = all.filter(isOverdue).length;
    $('#stat-total').textContent = all.length;
    $('#stat-pending').textContent = count('pending');
    $('#stat-progress').textContent = count('in-progress');
    $('#stat-done').textContent = count('completed');
    $('#stat-today').textContent = all.filter(isDueToday).length;
    $('#stat-deleted').textContent = state.deletedCount;
    syncStatButtons();

    const active = all.length - count('completed');
    const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const todayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
    $('#summary').innerHTML = `<span class="summary__date">${SUMMARY_CALENDAR}<span class="summary__long">${escapeHtml(today)}</span><span class="summary__short">${escapeHtml(todayShort)}</span></span>` + (all.length
      ? `<span class="summary__pill">${plural(active, 'active task')}</span>${overdue ? `<span class="summary__pill summary__pill--danger">${overdue} overdue</span>` : ''}`
      : '<span class="summary__pill">No tasks yet. Create your first one!</span>');

    renderReminders();
    renderToday();
  }

  /* ---------------- Quick note (autosaved) ---------------- */

  const noteEl = $('#quick-note');
  const NOTE_MAX = 10000;
  const NOTE_SAVE_DELAY = 700; // ms after the last keystroke
  const noteTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  let noteTimer = null;
  let noteSaved = ''; // last value the server has
  let noteSaving = null;

  function setNoteStatus(text, kind = '') {
    $('#note-status').textContent = text;
    $('#note-status').className = `note__status${kind ? ` is-${kind}` : ''}`;
  }

  function sizeNote() {
    noteEl.style.height = 'auto';
    noteEl.style.height = `${Math.min(Math.max(noteEl.scrollHeight, 120), 320)}px`;
    $('#note-count').textContent = `${noteEl.value.length.toLocaleString()} / ${NOTE_MAX.toLocaleString()}`;
  }

  function loadNote() {
    clearTimeout(noteTimer);
    noteSaved = state.user?.note || '';
    noteEl.value = noteSaved;
    sizeNote();
    const at = state.user?.noteUpdatedAt;
    setNoteStatus(noteSaved && at ? `Saved · ${noteTime.format(new Date(at))}` : '');
  }

  async function saveNote({ keepalive = false } = {}) {
    clearTimeout(noteTimer);
    const value = noteEl.value;
    if (value === noteSaved) return;
    setNoteStatus('Saving…', 'saving');
    try {
      noteSaving = api.saveNote(value, { keepalive });
      const res = await noteSaving;
      noteSaved = res.note;
      if (state.user) Object.assign(state.user, { note: res.note, noteUpdatedAt: res.noteUpdatedAt });
      // Only show "Saved" if nothing new was typed while the request was in flight
      if (noteEl.value === noteSaved) setNoteStatus(`Saved · ${noteTime.format(new Date(res.noteUpdatedAt))}`, 'saved');
    } catch (err) {
      setNoteStatus('Not saved, retrying…', 'error');
      noteTimer = setTimeout(saveNote, 3000);
    } finally {
      noteSaving = null;
    }
  }

  // Save right away (e.g. before logging out or closing the tab)
  function flushNote() {
    if (api.isSignedIn() && noteEl.value !== noteSaved) saveNote();
  }

  noteEl.addEventListener('input', () => {
    sizeNote();
    setNoteStatus('Editing…', 'saving');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, NOTE_SAVE_DELAY);
  });
  noteEl.addEventListener('blur', () => saveNote());
  addEventListener('pagehide', flushNote);

  $('#note-clear').addEventListener('click', async () => {
    if (!noteEl.value) return;
    const ok = await confirmDialog({ title: 'Clear note?', text: 'Your quick note will be erased.', confirmLabel: 'Clear note' });
    if (!ok) return;
    noteEl.value = '';
    sizeNote();
    saveNote();
    noteEl.focus();
  });

  /* ---------------- Today card: progress ---------------- */

  // Live clock with seconds and today's full date at the top of the Today card
  const clockFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const fullDateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  function tickTodayClock() {
    const now = new Date();
    const [time, ampm] = clockFmt.format(now).split(' ');
    // Wrap the colons so they can be spaced apart from the digits
    $('#today-clock').innerHTML = time.split(':').join('<span class="today__colon">:</span>');
    $('#today-clock').dateTime = now.toISOString();
    $('#today-ampm').textContent = ampm;
    $('#today-day').textContent = dayFmt.format(now);
    $('#today-date').textContent = fullDateFmt.format(now);
  }
  tickTodayClock();
  setInterval(tickTodayClock, 1000);

  // Shows "Add a task for today" when nothing unfinished is due by the end of today
  function syncTodayAdd(endOfToday) {
    const open = state.allTasks.some((t) => t.status !== 'completed' && t.dueDate && new Date(t.dueDate) < endOfToday);
    $('#today-add').hidden = open;
  }

  $('#today-add').addEventListener('click', () => {
    openTaskDialog();
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    $('#task-due-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    $('#task-due-date').dispatchEvent(new Event('change')); // applies the default due time
  });

  const dayKey = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  };
  // Tasks completed before completedAt existed fall back to their last update time
  const completedOn = (t) => (t.status === 'completed' ? (t.completedAt || t.updatedAt) : null);

  function renderToday() {
    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const todayKey = dayKey(now);
    const tasks = state.allTasks;

    const doneToday = tasks.filter((t) => completedOn(t) && dayKey(completedOn(t)) === todayKey).length;
    // Still to do today: unfinished tasks due by the end of today (overdue ones included)
    const leftToday = tasks.filter((t) => t.status !== 'completed' && t.dueDate && new Date(t.dueDate) < endOfToday).length;
    const total = doneToday + leftToday;
    const pct = total ? Math.round((doneToday / total) * 100) : doneToday ? 100 : 0;

    $('#today-pct').textContent = total ? `${pct}%` : '–';
    const circumference = 2 * Math.PI * 27;
    const ring = $('#today-ring-value');
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${circumference * (1 - (total ? pct : 0) / 100)}`;
    $('#today-ring').classList.toggle('is-complete', total > 0 && pct === 100);
    $('#today-ring').setAttribute('aria-label', total ? `${pct}% of today's tasks done` : 'No tasks due today');

    $('#today-count').innerHTML = total
      ? `<strong>${doneToday}</strong> of <strong>${total}</strong> done today`
      : doneToday ? `<strong>${doneToday}</strong> done today` : 'Nothing due today';
    let msg;
    if (total && pct === 100) msg = 'All done for today. Great work! 🎉';
    else if (leftToday) msg = `${leftToday} task${leftToday === 1 ? '' : 's'} left. You've got this.`;
    else msg = doneToday ? 'Keep the momentum going.' : 'Plan ahead or enjoy the calm ✨';
    $('#today-msg').textContent = msg;
    syncTodayAdd(endOfToday);
  }

  const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  // "Today, 4:05 PM" / "Tomorrow, 9:00 AM" / "Fri, 9:00 AM"
  function dayLabel(iso) {
    const d = new Date(iso);
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(d) - startOf(new Date())) / 86400000);
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
    if (days === 0) return `Today, ${time}`;
    if (days === 1) return `Tomorrow, ${time}`;
    return `${new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(d)}, ${time}`;
  }

  function renderReminders() {
    const now = Date.now();
    const upcoming = state.allTasks
      .filter((t) => t.dueDate && t.status !== 'completed')
      .filter((t) => {
        const due = new Date(t.dueDate).getTime();
        return due >= now && due <= now + UPCOMING_WINDOW_MS;
      })
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    const section = $('#reminders');
    section.hidden = upcoming.length === 0;
    if (!upcoming.length) return;

    $('#reminders-count').textContent = `${upcoming.length} task${upcoming.length === 1 ? '' : 's'}`;

    const [next, ...rest] = upcoming;
    const soon = new Date(next.dueDate) - now < 24 * 60 * 60 * 1000;
    $('#next-up').innerHTML = `
      <button type="button" class="next-up${soon ? ' next-up--soon' : ''}" data-id="${next._id}"
        aria-label="Next up: ${escapeHtml(next.title)}, due ${escapeHtml(dayLabel(next.dueDate))}. Open task">
        <span class="next-up__label">Next up</span>
        <span class="next-up__main">
          <span class="next-up__title">${escapeHtml(next.title)}</span>
          <span class="next-up__meta">
            <span class="badge badge--${next.priority}">${PRIORITY_LABELS[next.priority]}</span>
            ${next.category ? `<span class="chip chip--cat"><span aria-hidden="true">#</span>${escapeHtml(next.category)}</span>` : ''}
            <span>${escapeHtml(dayLabel(next.dueDate))}</span>
          </span>
        </span>
        <span class="next-up__countdown">${escapeHtml(relativeDue(next.dueDate))}</span>
      </button>`;

    $('#upcoming-list').innerHTML = rest.map((t) => `
      <li>
        <button type="button" class="upcoming-item" data-id="${t._id}"
          aria-label="${escapeHtml(t.title)}, due ${escapeHtml(dayLabel(t.dueDate))}. Open task">
          <span class="upcoming-item__dot upcoming-item__dot--${t.priority}" aria-hidden="true"></span>
          <span class="upcoming-item__title">${escapeHtml(t.title)}</span>
          <span class="upcoming-item__when">${escapeHtml(dayLabel(t.dueDate))}</span>
          <span class="upcoming-item__rel">${escapeHtml(relativeDue(t.dueDate))}</span>
        </button>
      </li>`).join('');
  }

  $('#reminders').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (btn) openDetail(btn.dataset.id);
  });

  // Pill like the Due chip: "🕒 Added 21 Oct, 22:09 (2 hr ago)"
  function timeChip(icon, label, iso) {
    return `
      <span class="chip chip--time" title="${escapeHtml(label)} ${escapeHtml(fmtDateSmart(iso))}">
        <span aria-hidden="true">${icon}</span>
        <time datetime="${iso}">${escapeHtml(label)} ${escapeHtml(fmtDateSmart(iso))}</time>
        <span class="chip__rel">(${escapeHtml(timeAgo(iso))})</span>
      </span>`;
  }

  function timeChipsHtml(t) {
    return timeChip('🕒', 'Added', t.createdAt);
  }

  function deletedCardHtml(t) {
    const purgeAt = new Date(new Date(t.deletedAt).getTime() + state.trashRetentionDays * 86400000);
    const daysLeft = Math.max(0, Math.ceil((purgeAt - new Date()) / 86400000));
    return `
      <li class="task-card task-card--${t.priority} is-deleted" data-id="${t._id}">
        <span class="trash-icon" aria-hidden="true">🗑</span>
        <div class="task-card__body">
          <h3 class="task-card__title"><button type="button" class="task-card__open" data-action="open" aria-haspopup="dialog">${escapeHtml(t.title)}</button></h3>
          <div class="task-card__time">
            ${timeChip('🗑', 'Deleted', t.deletedAt)}
            <span class="chip chip--time"><span aria-hidden="true">⏳</span><span>Removed in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</span></span>
          </div>
          ${t.description ? `<p class="task-card__desc">${linkify(t.description)}</p>` : ''}
          <div class="task-card__meta">
            <span class="badge badge--${t.priority}"><span class="visually-hidden">Priority: </span>${PRIORITY_LABELS[t.priority]}</span>
            <span class="badge badge--status badge--${t.status}">${STATUS_LABELS[t.status]}</span>
            ${t.category ? `<span class="chip chip--cat"><span aria-hidden="true">#</span>${escapeHtml(t.category)}</span>` : ''}
          </div>
        </div>
        <div class="task-card__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-action="restore" aria-label="Restore “${escapeHtml(t.title)}”">↺ Restore</button>
          <button type="button" class="btn btn--ghost btn--icon btn--danger-ghost" data-action="delete-forever" aria-label="Delete “${escapeHtml(t.title)}” forever" title="Delete forever">✕</button>
        </div>
      </li>`;
  }

  function taskCardHtml(t) {
    if (t.deletedAt) return deletedCardHtml(t);
    const overdue = isOverdue(t);
    const done = t.status === 'completed';
    const classes = ['task-card', `task-card--${t.priority}`];
    if (done) classes.push('is-completed');
    if (overdue) classes.push('is-overdue');

    const due = t.dueDate ? `
      <span class="chip chip--due${overdue ? ' chip--overdue' : ''}" title="Due ${escapeHtml(fmtDateSmart(t.dueDate))}">
        <span aria-hidden="true">⏰</span>
        <span>${overdue ? '<strong>Overdue</strong> · ' : 'Due '}${escapeHtml(fmtDateSmart(t.dueDate))}</span>
        ${done ? '' : `<span class="chip__rel">(${escapeHtml(relativeDue(t.dueDate))})</span>`}
      </span>` : '';


    return `
      <li class="${classes.join(' ')}" data-id="${t._id}">
        <label class="check">
          <input type="checkbox" class="check__input" data-action="toggle" ${done ? 'checked' : ''}
            aria-label="Mark “${escapeHtml(t.title)}” as ${done ? 'not completed' : 'completed'}" />
          <span class="check__box" aria-hidden="true"></span>
        </label>
        <div class="task-card__body">
          <h3 class="task-card__title"><button type="button" class="task-card__open" data-action="open" aria-haspopup="dialog">${escapeHtml(t.title)}</button></h3>
          <div class="task-card__time">${timeChipsHtml(t)}</div>
          ${t.description ? `<p class="task-card__desc">${linkify(t.description)}</p>` : ''}
          <div class="task-card__meta">
            <span class="badge badge--${t.priority}"><span class="visually-hidden">Priority: </span>${PRIORITY_LABELS[t.priority]}</span>
            <span class="badge badge--status badge--${t.status}">${STATUS_LABELS[t.status]}</span>
            ${t.category ? `<span class="chip chip--cat"><span aria-hidden="true">#</span>${escapeHtml(t.category)}</span>` : ''}
            ${due}
            ${t.attachments?.length ? `<span class="chip chip--att" title="${t.attachments.length} attachment${t.attachments.length === 1 ? '' : 's'}"><span aria-hidden="true">📎</span>${t.attachments.length}<span class="visually-hidden"> attachment${t.attachments.length === 1 ? '' : 's'}</span></span>` : ''}
          </div>
        </div>
        <div class="task-card__actions">
          ${statusTriggerHtml(t.status, `data-action="status-menu" aria-label="Status: ${STATUS_LABELS[t.status]}. Change status for “${escapeHtml(t.title)}”"`)}
          <button type="button" class="btn card-btn card-btn--edit" data-action="edit" aria-label="Edit “${escapeHtml(t.title)}”" title="Edit">${ICONS.edit}<span class="card-btn__label">Edit</span></button>
          <button type="button" class="btn card-btn card-btn--delete" data-action="delete" aria-label="Delete “${escapeHtml(t.title)}”" title="Delete">${ICONS.trash}<span class="card-btn__label">Delete</span></button>
        </div>
        ${isDueToday(t) ? `<span class="task-card__today" title="Due today">${TODAY_BADGE_ICON}Today</span>` : ''}
      </li>`;
  }

  const TODAY_BADGE_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  const isDueToday = (t) => Boolean(t.dueDate) && new Date(t.dueDate).toDateString() === new Date().toDateString();

  function renderTasks() {
    closeStatusMenu();
    const list = $('#task-list');
    // Remember which card control had focus so keyboard users don't lose their place
    const focused = document.activeElement?.closest?.('.task-card [data-action]');
    const restore = focused && list.contains(focused)
      && { id: focused.closest('.task-card').dataset.id, action: focused.dataset.action };
    list.setAttribute('aria-busy', 'false');
    // Live sync re-renders after every save; skip identical output and only animate cards that are new,
    // otherwise the whole list replays its fade-in and blinks on each click
    const html = state.tasks.map(taskCardHtml).join('');
    if (html !== lastListHtml) {
      const shown = new Set([...list.querySelectorAll('.task-card')].map((c) => c.dataset.id));
      list.innerHTML = html;
      lastListHtml = html;
      list.querySelectorAll('.task-card').forEach((c) => { if (!shown.has(c.dataset.id)) c.classList.add('is-new'); });
    }
    if (restore) $(`.task-card[data-id="${restore.id}"] [data-action="${restore.action}"]`, list)?.focus();

    const inTrash = state.filters.status === 'deleted';
    $('#clear-filters').hidden = !Object.entries(state.filters).some(([k, v]) => (k === 'status' ? v !== 'today' : k !== 'sort' && v));
    $('#trash-banner').hidden = !inTrash;
    $('#trash-days').textContent = state.trashRetentionDays;
    $('#empty-trash-btn').disabled = !state.deletedCount;

    const empty = $('#empty-state');
    empty.hidden = state.tasks.length > 0;
    if (!state.tasks.length) {
      const filtered = Object.entries(state.filters).some(([k, v]) => k !== 'sort' && k !== 'status' && v);
      let title = 'No tasks yet';
      let text = 'Click “New task” to add your first one.';
      if (inTrash) [title, text] = ['Trash is empty', 'Deleted tasks show up here so you can restore them.'];
      else if (state.filters.status === 'overdue' && !filtered) [title, text] = ['Nothing overdue', 'You’re all caught up. Nice work!'];
      else if (state.filters.status === 'today' && !filtered) [title, text] = ['Nothing due today', 'Enjoy the free time, or plan something new.'];
      else if (filtered || state.filters.status) [title, text] = ['No matching tasks', 'Try a different search or clear your filters.'];
      $('.empty__title', empty).textContent = title;
      $('.empty__text', empty).textContent = text;
    }
  }

  const findTask = (id) => state.tasks.find((t) => t._id === id) || state.allTasks.find((t) => t._id === id);

  /* ---------------- Tasks: actions ---------------- */

  async function setStatus(id, status) {
    const task = findTask(id);
    if (!task) return;
    const prev = { status: task.status, completedAt: task.completedAt };
    // Optimistic update so the UI responds instantly. The filtered list and the full list hold
    // separate copies of the task, so update both (the Today card reads the full list).
    const copies = [...state.tasks, ...state.allTasks].filter((t) => t._id === id);
    const apply = (values) => copies.forEach((t) => Object.assign(t, values));
    apply({ status, completedAt: status === 'completed' ? new Date().toISOString() : null });
    const card = $(`.task-card[data-id="${id}"]`);
    if (card) card.outerHTML = taskCardHtml(task);
    renderStats();
    refreshDetail();
    try {
      await api.updateTask(id, { status });
      if (status === 'completed') toast('Task completed 🎉', 'success');
      loadTasks({ silent: true });
    } catch (err) {
      apply(prev);
      renderTasks();
      renderStats();
      refreshDetail();
      toast(err.message, 'error');
    }
  }

  // Animates the card out, runs the request, then refreshes. Restores the card on failure.
  async function removeCard(id, request) {
    const card = $(`.task-card[data-id="${id}"]`);
    card?.classList.add('is-removing');
    try {
      await request();
      await loadTasks({ silent: true });
      return true;
    } catch (err) {
      card?.classList.remove('is-removing');
      toast(err.message, 'error');
      return false;
    }
  }

  // Deleting is recoverable, so it skips the confirm dialog and offers Undo instead
  async function moveToTrash(id) {
    const task = findTask(id);
    if (!task) return;
    const ok = await removeCard(id, () => api.deleteTask(id));
    if (!ok) return;
    $('#new-task-btn').focus();
    toast(`Moved “${task.title}” to Deleted`, 'success', {
      label: 'Undo',
      onClick: () => restoreTask(id, { quiet: true }),
    });
  }

  async function restoreTask(id, { quiet = false } = {}) {
    const task = findTask(id);
    const ok = await removeCard(id, () => api.restoreTask(id));
    if (ok) toast(quiet ? 'Task restored' : `Restored “${task?.title ?? 'task'}”`, 'success');
  }

  async function deleteForever(id) {
    const task = findTask(id);
    if (!task) return;
    const ok = await confirmDialog({
      title: 'Delete forever?',
      text: `“${task.title}” will be permanently deleted. This can't be undone.`,
      confirmLabel: 'Delete forever',
    });
    if (ok && await removeCard(id, () => api.deleteTaskForever(id))) toast('Task permanently deleted', 'success');
  }

  $('#empty-trash-btn').addEventListener('click', async () => {
    const n = state.deletedCount;
    const ok = await confirmDialog({
      title: 'Empty trash?',
      text: `${n} deleted task${n === 1 ? '' : 's'} will be permanently removed. This can't be undone.`,
      confirmLabel: 'Empty trash',
    });
    if (!ok) return;
    try {
      const { deleted } = await api.emptyTrash();
      toast(`Permanently deleted ${deleted} task${deleted === 1 ? '' : 's'}`, 'success');
      loadTasks({ silent: true });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#task-list').addEventListener('change', (e) => {
    const card = e.target.closest('.task-card');
    if (!card) return;
    const { action } = e.target.dataset;
    if (action === 'toggle') setStatus(card.dataset.id, e.target.checked ? 'completed' : 'pending');
  });

  $('#task-list').addEventListener('click', (e) => {
    const card = e.target.closest('.task-card:not(.skeleton)');
    if (!card) return;
    const { id } = card.dataset;
    const btn = e.target.closest('button[data-action]');

    // Clicking empty space on a card opens its details (but not while selecting text
    // or when the click landed on a control such as the checkbox or status dropdown)
    if (!btn) {
      if (e.target.closest('input, select, label, a, button')) return;
      if (window.getSelection()?.toString()) return;
      openDetail(id);
      return;
    }

    const actions = {
      'status-menu': () => openStatusMenu(btn, findTask(id).status, (v) => {
        setStatus(id, v);
        $(`.task-card[data-id="${id}"] [data-action="status-menu"]`)?.focus();
      }),
      open: () => openDetail(id),
      edit: () => openTaskDialog(findTask(id)),
      delete: () => moveToTrash(id),
      restore: () => restoreTask(id),
      'delete-forever': () => deleteForever(id),
    };
    actions[btn.dataset.action]?.();
  });

  /* ---------------- Task details ---------------- */

  const detailDialog = $('#detail-dialog');
  let detailId = null;

  // Details popup: date in bold with the time in a small chip
  const fmtStamp = (iso) => {
    const d = new Date(iso);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
    return `<span class="detail__when"><span class="detail__date">${escapeHtml(day)}</span><span class="detail__clock">${escapeHtml(time)}</span></span>`;
  };

  function timeAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // Line icons for the details footer: same box, stroke and baseline so labels line up
  const svgIcon = (paths) => `<svg class="btn__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    check: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
    undo: svgIcon('<path d="M3 7v6h6"/><path d="M3.5 13A9 9 0 1 0 6 6.3L3 9"/>'),
    edit: svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    trash: svgIcon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  };

  const DETAIL_ICON = (paths) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const DETAIL_ICONS = {
    status: DETAIL_ICON('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>'),
    priority: DETAIL_ICON('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    category: DETAIL_ICON('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
    due: DETAIL_ICON('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    created: DETAIL_ICON('<path d="M12 5v14M5 12h14"/>'),
    updated: DETAIL_ICON('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    deleted: DETAIL_ICON('<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  };

  // One property tile: icon, label, value and an optional second line
  function detailRow(key, label, value, sub = '') {
    return `
      <div class="detail__row detail__row--${key}">
        <span class="detail__row-icon">${DETAIL_ICONS[key]}</span>
        <div class="detail__row-body">
          <dt>${label}</dt>
          <dd>${value}${sub ? `<span class="detail__sub">${sub}</span>` : ''}</dd>
        </div>
      </div>`;
  }

  function renderDetail(t) {
    const deleted = Boolean(t.deletedAt);
    const done = t.status === 'completed';
    const overdue = isOverdue(t);

    let due = '<span class="muted">No due date</span>';
    let dueSub = '';
    if (t.dueDate) {
      due = fmtStamp(t.dueDate);
      // Countdown pill: red when overdue, amber within 24 hours, otherwise purple
      const soon = new Date(t.dueDate) - Date.now() < 86400000;
      const tone = overdue ? 'overdue' : soon ? 'soon' : 'later';
      if (!done) dueSub = `<span class="detail__pill detail__pill--${tone}">${escapeHtml(relativeDue(t.dueDate))}</span>`;
    }
    const catIcon = t.category ? (CATEGORY_ICONS[t.category.toLowerCase()] || CATEGORY_ICONS.custom) : '';

    const statusControl = deleted
      ? `<span class="badge badge--status badge--${t.status}">${STATUS_LABELS[t.status]}</span>`
      : statusTriggerHtml(t.status, `data-detail-action="status-menu" aria-label="Status: ${STATUS_LABELS[t.status]}. Change status"`);

    const footer = deleted
      ? `<button type="button" class="btn btn--danger-outline" data-detail-action="delete-forever">${ICONS.trash}<span>Delete forever</span></button>
         <span class="detail__spacer"></span>
         <button type="button" class="btn btn--primary" data-detail-action="restore">${ICONS.undo}<span>Restore</span></button>`
      : `<button type="button" class="btn btn--danger-outline" data-detail-action="delete">${ICONS.trash}<span>Delete</span></button>
         <span class="detail__spacer"></span>
         <button type="button" class="btn btn--primary" data-detail-action="edit">${ICONS.edit}<span>Edit</span></button>
         <button type="button" class="btn ${done ? 'btn--outline' : 'btn--success'}" data-detail-action="toggle">${done ? `${ICONS.undo}<span>Mark as pending</span>` : `${ICONS.check}<span>Mark complete</span>`}</button>`;

    $('#detail-content').className = `detail detail--${t.priority}${done ? ' is-completed' : ''}${overdue ? ' is-overdue' : ''}`;
    $('#detail-content').innerHTML = `
      <header class="detail__header">
        <span class="detail__badge detail__badge--${t.priority}" aria-hidden="true">${DETAIL_ICONS.priority.replace('width="15" height="15"', 'width="20" height="20"')}</span>
        <div class="detail__heading">
          <h2 id="detail-title" class="detail__title">${escapeHtml(t.title)}</h2>
          <div class="detail__meta">
            ${timeChipsHtml(t)}
          </div>
        </div>
        <button type="button" class="detail__close" data-detail-action="close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </header>

      ${deleted ? `<p class="detail__notice">🗑 This task is in Deleted. Restore it to edit or complete it.</p>` : ''}
      ${overdue ? `<p class="detail__notice detail__notice--danger">⏰ This task is overdue.</p>` : ''}

      <section class="detail__section" aria-label="Description">
        <h3 class="detail__label">Description</h3>
        ${t.description
          ? `<p class="detail__desc">${linkify(t.description)}</p>`
          : '<p class="detail__desc muted">No description.</p>'}
      </section>

      ${t.attachments?.length ? `
      <section class="detail__section" aria-label="Attachments">
        <h3 class="detail__label">Attachments (${t.attachments.length})</h3>
        <ul class="att-list att-list--detail">${t.attachments.map(attDetailItemHtml).join('')}</ul>
      </section>` : ''}

      <h3 class="detail__label detail__label--info">Details</h3>
      <dl class="detail__grid">
        ${detailRow('status', 'Status', statusControl)}
        ${detailRow('priority', 'Priority', `<span class="badge badge--${t.priority}">${PRIORITY_LABELS[t.priority]}</span>`)}
        ${detailRow('category', 'Category', t.category ? `<span class="detail__cat detail__cat--plain">${catIcon}${escapeHtml(t.category)}</span>` : '<span class="muted">None</span>')}
        ${detailRow('due', 'Due', due, dueSub)}
        ${detailRow('created', 'Created', fmtStamp(t.createdAt), escapeHtml(timeAgo(t.createdAt)))}
        ${detailRow('updated', 'Last updated', fmtStamp(t.updatedAt), escapeHtml(timeAgo(t.updatedAt)))}
        ${deleted ? detailRow('deleted', 'Deleted', fmtStamp(t.deletedAt), escapeHtml(timeAgo(t.deletedAt))) : ''}
      </dl>

      <footer class="detail__footer">${footer}</footer>`;
  }

  function openDetail(id) {
    const task = findTask(id);
    if (!task) return;
    detailId = id;
    renderDetail(task);
    loadThumbs(task);
    if (!detailDialog.open) detailDialog.showModal();
    // Keep keyboard focus in the dialog without drawing a focus ring after a mouse click
    $('[data-detail-action="close"]', detailDialog).focus({ focusVisible: false });
  }

  // Keep an open details view in sync after the task list reloads
  function refreshDetail() {
    if (!detailDialog.open || !detailId) return;
    const task = findTask(detailId);
    if (task) {
      renderDetail(task);
      loadThumbs(task);
    } else detailDialog.close();
  }

  detailDialog.addEventListener('close', () => {
    detailId = null;
    clearThumbs();
  });


  detailDialog.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-detail-action]');
    if (!btn || !detailId) return;
    const id = detailId;
    const task = findTask(id);
    const close = () => detailDialog.close();
    const actions = {
      close,
      edit: () => { close(); openTaskDialog(task); },
      toggle: () => setStatus(id, task.status === 'completed' ? 'pending' : 'completed'),
      delete: () => { close(); moveToTrash(id); },
      restore: () => { close(); restoreTask(id); },
      'delete-forever': () => { close(); deleteForever(id); },
      'status-menu': () => openStatusMenu(btn, task.status, (v) => {
        setStatus(id, v);
        $('[data-detail-action="status-menu"]', detailDialog)?.focus();
      }),
    };
    actions[btn.dataset.detailAction]?.();
  });

  /* ---------------- Dropdown positioning ---------------- */

  // Opens a dropdown list upwards (adds .combo--up to wrap) when there isn't room below
  // inside the dialog, and caps its height to the space available.
  function fitListInDialog(anchor, list, wrap) {
    const dialog = anchor.closest('dialog');
    const bounds = dialog ? dialog.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    // Pinned header/footer cover the edges of the scroll area, so measure between them
    const top = (dialog && $('.dialog__header', dialog)?.getBoundingClientRect().bottom) ?? bounds.top;
    const bottom = (dialog && $('.dialog__footer', dialog)?.getBoundingClientRect().top) ?? bounds.bottom;
    const r = anchor.getBoundingClientRect();
    const below = Math.min(bottom, innerHeight) - r.bottom - 10;
    const above = r.top - Math.max(top, 0) - 10;
    const wanted = Math.min(list.scrollHeight, 264);
    const up = below < wanted && above > below;
    wrap.classList.toggle('combo--up', up);
    list.style.maxHeight = `${Math.max(120, Math.min(264, up ? above : below))}px`;
  }

  /* ---------------- Category picker ---------------- */

  // A styled combobox replacing <datalist>, whose popup can't be styled
  const catInput = $('#task-category');
  const catList = $('#category-listbox');
  let catOptions = [];
  let catActive = -1;

  // Default categories come from the server; they're always offered and can't be deleted
  const isDefaultCategory = (name) => state.defaultCategories.some((c) => c.toLowerCase() === name.toLowerCase());

  // The user's categories plus the defaults, de-duplicated case-insensitively
  function pickerCategories() {
    const seen = new Map();
    [...state.defaultCategories, ...state.categories].forEach((c) => {
      if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
    });
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  // Open upwards when there isn't room below inside the (scrollable) dialog
  const positionCategoryList = () => fitListInDialog(catInput, catList, $('#category-combo'));

  function highlightMatch(text, query) {
    const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (i < 0) return escapeHtml(text);
    return `${escapeHtml(text.slice(0, i))}<mark>${escapeHtml(text.slice(i, i + query.length))}</mark>${escapeHtml(text.slice(i + query.length))}`;
  }

  function buildCategoryOptions() {
    const q = catInput.value.trim();
    const ql = q.toLowerCase();
    // While the box holds an exact existing category, show the full list so it's easy to switch
    const all = pickerCategories();
    const exact = all.some((c) => c.toLowerCase() === ql);
    const opts = all
      .filter((c) => exact || c.toLowerCase().includes(ql))
      .map((value) => ({ value }));
    if (q && !exact) opts.push({ value: q, create: true });
    return { opts, query: exact ? '' : q };
  }

  function renderCategoryList() {
    const { opts, query } = buildCategoryOptions();
    catOptions = opts;
    if (catActive >= opts.length) catActive = opts.length - 1;
    const counts = {};
    state.allTasks.forEach((t) => { if (t.category) counts[t.category] = (counts[t.category] || 0) + 1; });
    const current = catInput.value.trim().toLowerCase();

    catList.innerHTML = opts.length ? opts.map((o, i) => {
      const id = `category-opt-${i}`;
      const active = i === catActive ? ' is-active' : '';
      if (o.create) {
        return `<li id="${id}" class="combo__option combo__option--create${active}" role="option" aria-selected="false" data-index="${i}">
          <span class="combo__plus" aria-hidden="true">+</span>
          <span class="combo__label">Create “<strong>${escapeHtml(o.value)}</strong>”</span>
        </li>`;
      }
      const selected = o.value.toLowerCase() === current;
      const n = counts[o.value] || 0;
      const builtIn = isDefaultCategory(o.value);
      const del = builtIn
        ? '<span class="combo__del-spacer" aria-hidden="true"></span>'
        : `<button type="button" class="combo__del" data-delete-category="${escapeHtml(o.value)}" tabindex="-1"
             aria-label="Delete category ${escapeHtml(o.value)}" title="Delete category">${ICONS.trash}</button>`;
      return `<li id="${id}" class="combo__option${active}${selected ? ' is-selected' : ''}${builtIn ? ' is-builtin' : ''}" role="option" aria-selected="${selected}" data-index="${i}">
        <span class="combo__label"><span class="combo__icon">${CATEGORY_ICONS[o.value.toLowerCase()] || CATEGORY_ICONS.custom}</span>${highlightMatch(o.value, query)}</span>
        <span class="combo__end">
          ${selected ? '<span class="combo__check" aria-hidden="true">✓</span>' : ''}
          <span class="combo__count" title="${n} task${n === 1 ? '' : 's'}">${n}</span>
          ${del}
        </span>
      </li>`;
    }).join('') : '<li class="combo__empty" role="presentation">No categories yet. Type a name to create one.</li>';

    catInput.setAttribute('aria-activedescendant', catActive >= 0 ? `category-opt-${catActive}` : '');
    positionCategoryList();
    $('.combo__option.is-active', catList)?.scrollIntoView({ block: 'nearest' });
  }

  function openCategoryList() {
    if (!catList.hidden) return renderCategoryList();
    catActive = -1;
    catList.hidden = false;
    catInput.setAttribute('aria-expanded', 'true');
    $('#category-combo').classList.add('is-open');
    renderCategoryList();
    $('.combo__option.is-selected', catList)?.scrollIntoView({ block: 'nearest' });
  }

  function closeCategoryList() {
    catList.hidden = true;
    catActive = -1;
    catInput.setAttribute('aria-expanded', 'false');
    catInput.removeAttribute('aria-activedescendant');
    $('#category-combo').classList.remove('is-open');
  }

  function chooseCategory(index) {
    const opt = catOptions[index];
    if (!opt) return;
    catInput.value = opt.value;
    syncCategoryLead();
    closeCategoryList();
  }

  // Shows the category's icon inside the input, like the icons on Priority and Status
  function syncCategoryLead() {
    const value = catInput.value.trim();
    $('#category-lead').innerHTML = value ? (CATEGORY_ICONS[value.toLowerCase()] || CATEGORY_ICONS.custom) : '';
    $('#category-combo').classList.toggle('has-lead', Boolean(value));
  }

  catInput.addEventListener('focus', openCategoryList);
  catInput.addEventListener('click', openCategoryList);
  catInput.addEventListener('input', () => {
    syncCategoryLead();
    openCategoryList();
    catActive = catInput.value.trim() ? 0 : -1;
    renderCategoryList();
  });
  catInput.addEventListener('blur', () => setTimeout(closeCategoryList, 120));
  catInput.addEventListener('keydown', (e) => {
    const open = !catList.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openCategoryList();
      if (!catOptions.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      catActive = (catActive + step + catOptions.length) % catOptions.length;
      renderCategoryList();
    } else if (e.key === 'Enter' && open && catActive >= 0) {
      e.preventDefault(); // pick the option instead of submitting the form
      chooseCategory(catActive);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); // close the list, not the whole dialog
      e.stopPropagation();
      closeCategoryList();
    } else if (e.key === 'Tab') {
      closeCategoryList();
    }
  });

  // mousedown keeps focus in the input so blur doesn't close the list before the click lands
  catList.addEventListener('mousedown', (e) => e.preventDefault());
  catList.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-category]');
    if (del) {
      deleteCategory(del.dataset.deleteCategory);
      return;
    }
    const li = e.target.closest('.combo__option');
    if (li) chooseCategory(Number(li.dataset.index));
  });

  async function deleteCategory(name) {
    // Count across all tasks, including ones in the trash, since the server clears them all
    const active = state.allTasks.filter((t) => t.category === name).length;
    const ok = await confirmDialog({
      title: `Delete “${name}”?`,
      text: active
        ? `The category will be removed from ${active} task${active === 1 ? '' : 's'}${state.deletedCount ? ' (and any in Deleted)' : ''}. The tasks themselves are kept.`
        : 'The category will be removed from the list.',
      confirmLabel: 'Delete category',
    });
    if (ok) {
      try {
        await api.deleteCategory(name);
        if (catInput.value.trim().toLowerCase() === name.toLowerCase()) {
          catInput.value = '';
          syncCategoryLead();
        }
        toast(`Category “${name}” deleted`, 'success');
        await loadTasks({ silent: true });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    // Return to the picker so more categories can be managed
    if ($('#task-dialog').open) {
      catInput.focus();
      openCategoryList();
    }
  }
  $('#category-toggle').addEventListener('mousedown', (e) => e.preventDefault());
  $('#category-toggle').addEventListener('click', () => {
    if (catList.hidden) {
      catInput.focus();
      openCategoryList();
    } else {
      closeCategoryList();
    }
  });

  /* ---------------- Attachments ---------------- */

  const MAX_ATTACHMENTS = 10;
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  // Must match the server's inline-safe list; everything else is download-only
  const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
  const isImage = (mime) => /^image\/(png|jpeg|gif|webp)$/.test(mime);

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fileIcon(mime = '', name = '') {
    const ext = name.split('.').pop().toLowerCase();
    if (mime.startsWith('image/')) return '🖼️';
    if (mime === 'application/pdf') return '📕';
    if (mime.startsWith('video/')) return '🎞️';
    if (mime.startsWith('audio/')) return '🎵';
    if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return '🗜️';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
    if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext) || mime.startsWith('text/')) return '📝';
    if (['ppt', 'pptx', 'key'].includes(ext)) return '📽️';
    return '📄';
  }

  // Changes made in the task dialog. Nothing is sent until the form is saved.
  const attDraft = { existing: [], removed: new Set(), pending: [] };

  function resetAttDraft(task) {
    attDraft.existing = task?.attachments ? [...task.attachments] : [];
    attDraft.removed = new Set();
    attDraft.pending = [];
    renderAttEditList();
  }

  const attCount = () => attDraft.existing.filter((a) => !attDraft.removed.has(a._id)).length + attDraft.pending.length;

  // Screenshots pasted from the clipboard arrive as "image.png"; give them a useful name
  function namePasted(file, index) {
    if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    return new File([file], `Pasted image ${stamp}${index ? ` (${index + 1})` : ''}.${ext}`, { type: file.type });
  }

  function addPendingFiles(fileList, { pasted = false } = {}) {
    const files = [...fileList];
    const skipped = [];
    files.forEach((raw, i) => {
      const file = pasted ? namePasted(raw, i) : raw;
      if (file.size > MAX_ATTACHMENT_BYTES) skipped.push(`“${file.name}” is larger than 10 MB`);
      else if (attCount() >= MAX_ATTACHMENTS) skipped.push(`“${file.name}”: a task can have at most ${MAX_ATTACHMENTS} files`);
      else attDraft.pending.push(file);
    });
    renderAttEditList();
    if (skipped.length) toast(skipped.length === 1 ? skipped[0] : `${skipped.length} files were skipped (10 MB / 10 file limit)`, 'error');
    else if (files.length) toast(`${files.length} file${files.length === 1 ? '' : 's'} ${pasted ? 'pasted' : 'added'}. Save to upload.`);
  }

  function attEditItemHtml({ name, size, mime, kind, key, isNew }) {
    return `
      <li class="att-item${isNew ? ' att-item--new' : ''}">
        <span class="att-item__thumb" aria-hidden="true">${fileIcon(mime, name)}</span>
        <span class="att-item__info">
          <span class="att-item__name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="att-item__meta">${fmtSize(size)}${isNew ? ' · <span class="att-item__new">New</span>' : ''}</span>
        </span>
        <button type="button" class="btn btn--ghost btn--icon btn--danger-ghost att-item__remove"
          data-remove-${kind}="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(name)}" title="Remove">✕</button>
      </li>`;
  }

  function renderAttEditList() {
    const kept = attDraft.existing.filter((a) => !attDraft.removed.has(a._id));
    $('#att-edit-list').innerHTML =
      kept.map((a) => attEditItemHtml({ name: a.originalName, size: a.size, mime: a.mimeType, kind: 'existing', key: a._id })).join('') +
      attDraft.pending.map((f, i) => attEditItemHtml({ name: f.name, size: f.size, mime: f.type, kind: 'pending', key: String(i), isNew: true })).join('');
    const count = attCount();
    $('#dropzone').classList.toggle('is-full', count >= MAX_ATTACHMENTS);
    $('#att-counter').textContent = `${count} / ${MAX_ATTACHMENTS}`;
    $('#att-counter').classList.toggle('is-full', count >= MAX_ATTACHMENTS);
  }

  $('#att-edit-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.att-item__remove');
    if (!btn) return;
    if (btn.dataset.removeExisting) attDraft.removed.add(btn.dataset.removeExisting);
    if (btn.dataset.removePending !== undefined) attDraft.pending.splice(Number(btn.dataset.removePending), 1);
    renderAttEditList();
  });

  $('#browse-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#file-input').click();
  });
  // The whole drop zone is a click target too (the button stays the keyboard-accessible control)
  $('#dropzone').addEventListener('click', (e) => {
    if (e.target.closest('button, kbd')) return;
    $('#file-input').click();
  });
  $('#file-input').addEventListener('change', (e) => {
    addPendingFiles(e.target.files);
    e.target.value = ''; // allow picking the same file again
  });

  // Drag & drop anywhere on the task form; the drop zone lights up while dragging
  const dropTarget = $('#task-form');
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  dropTarget.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('#dropzone').classList.add('is-dragover');
  });
  dropTarget.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  dropTarget.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropzone').classList.remove('is-dragover');
  });
  dropTarget.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropzone').classList.remove('is-dragover');
    addPendingFiles(e.dataTransfer.files);
  });

  // Paste files or screenshots anywhere in the dialog (text pastes are left alone)
  $('#task-dialog').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addPendingFiles(files, { pasted: true });
  });

  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('#dropzone kbd').textContent = 'Ctrl';

  async function saveAttachments(taskId) {
    for (const attId of [...attDraft.removed]) {
      await api.deleteAttachment(taskId, attId);
      attDraft.removed.delete(attId);
      attDraft.existing = attDraft.existing.filter((a) => a._id !== attId);
    }
    if (attDraft.pending.length) {
      const { task } = await api.uploadAttachments(taskId, attDraft.pending);
      attDraft.pending = [];
      attDraft.existing = [...task.attachments];
    }
    renderAttEditList();
  }

  /* Details view: list, thumbnails, open & download */

  function attDetailItemHtml(a) {
    const canOpen = PREVIEWABLE.has(a.mimeType);
    return `
      <li class="att-item" data-att-id="${a._id}">
        <span class="att-item__thumb" aria-hidden="true">${fileIcon(a.mimeType, a.originalName)}</span>
        <span class="att-item__info">
          <span class="att-item__name" title="${escapeHtml(a.originalName)}">${escapeHtml(a.originalName)}</span>
          <span class="att-item__meta">${fmtSize(a.size)} · ${escapeHtml(fmtDateSmart(a.uploadedAt))}</span>
        </span>
        <span class="att-item__actions">
          ${canOpen ? `<button type="button" class="btn btn--outline btn--sm" data-att-action="open" aria-label="Open ${escapeHtml(a.originalName)} in a new tab">Open</button>` : ''}
          <button type="button" class="btn btn--outline btn--sm" data-att-action="download" aria-label="Download ${escapeHtml(a.originalName)}">Download</button>
        </span>
      </li>`;
  }

  const thumbUrls = new Map(); // attId -> object URL, revoked when the details view closes

  function clearThumbs() {
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    thumbUrls.clear();
  }

  function loadThumbs(task) {
    (task.attachments || []).filter((a) => isImage(a.mimeType)).forEach(async (a) => {
      try {
        if (!thumbUrls.has(a._id)) {
          const blob = await api.attachmentBlob(task._id, a._id, { inline: true });
          thumbUrls.set(a._id, URL.createObjectURL(new Blob([blob], { type: a.mimeType })));
        }
        const slot = $(`#detail-content .att-item[data-att-id="${a._id}"] .att-item__thumb`);
        if (slot) slot.innerHTML = `<img src="${thumbUrls.get(a._id)}" alt="" />`;
      } catch { /* keep the generic icon */ }
    });
  }

  async function openAttachment(taskId, att) {
    // Open the tab synchronously so popup blockers allow it, then point it at the file
    const win = window.open('', '_blank');
    try {
      const blob = await api.attachmentBlob(taskId, att._id, { inline: true });
      const url = URL.createObjectURL(new Blob([blob], { type: att.mimeType }));
      if (win) win.location.href = url;
      else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      win?.close();
      toast(err.message, 'error');
    }
  }

  async function downloadAttachment(taskId, att) {
    try {
      const blob = await api.attachmentBlob(taskId, att._id);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: att.originalName });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  detailDialog.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-att-action]');
    if (!btn || !detailId) return;
    const task = findTask(detailId);
    const att = task?.attachments?.find((a) => a._id === btn.closest('[data-att-id]').dataset.attId);
    if (!att) return;
    if (btn.dataset.attAction === 'open') openAttachment(task._id, att);
    else downloadAttachment(task._id, att);
  });

  /* ---------------- Styled selects ---------------- */

  // Replaces a <select>'s native popup (which can't be styled) with a listbox that matches the
  // category picker. The <select> stays in the form, hidden, as the source of truth, so
  // FormData and form.reset() keep working. Call refresh() after changing its value in code.
  function enhanceSelect(select, { optionHtml }) {
    const wrap = document.createElement('div');
    wrap.className = 'select';
    select.before(wrap);
    wrap.append(select);
    select.classList.add('select__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select__trigger';
    trigger.id = `${select.id}-trigger`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${select.id}-listbox`);
    const label = document.querySelector(`label[for="${select.id}"]`);
    if (label) {
      label.id ||= `${select.id}-label`;
      label.htmlFor = trigger.id;
      trigger.setAttribute('aria-labelledby', `${label.id} ${trigger.id}`);
    }

    const list = document.createElement('ul');
    list.className = 'combo__list select__list';
    list.id = `${select.id}-listbox`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    wrap.append(trigger, list);

    const options = () => [...select.options];
    let active = -1;

    function renderList() {
      list.innerHTML = options().map((o, i) => `
        <li id="${select.id}-opt-${i}" class="combo__option select__option${i === active ? ' is-active' : ''}${o.selected ? ' is-selected' : ''}"
          role="option" aria-selected="${o.selected}" data-index="${i}">
          <span class="select__content">${optionHtml(o.value, o.textContent)}</span>
          <span class="combo__check" aria-hidden="true">${o.selected ? '✓' : ''}</span>
        </li>`).join('');
      trigger.setAttribute('aria-activedescendant', active >= 0 ? `${select.id}-opt-${active}` : '');
      $('.is-active', list)?.scrollIntoView({ block: 'nearest' });
    }

    function refresh() {
      const o = select.options[select.selectedIndex];
      trigger.innerHTML = `<span class="select__content">${o ? optionHtml(o.value, o.textContent) : ''}</span>
        <svg class="select__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
      if (!list.hidden) renderList();
    }

    function open() {
      if (!list.hidden) return;
      active = select.selectedIndex;
      list.hidden = false;
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      renderList();
      fitListInDialog(trigger, list, wrap);
    }

    function close() {
      list.hidden = true;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
    }

    function choose(i) {
      if (i < 0 || i >= select.options.length) return;
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
      refresh();
      trigger.focus();
    }

    trigger.addEventListener('click', () => (list.hidden ? open() : close()));
    trigger.addEventListener('keydown', (e) => {
      const n = select.options.length;
      const isOpen = !list.hidden;
      const move = (to) => { active = (to + n) % n; renderList(); };
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        if (!isOpen) return open();
        move(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' && isOpen) { e.preventDefault(); move(0); }
      else if (e.key === 'End' && isOpen) { e.preventDefault(); move(n - 1); }
      else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape' && isOpen) {
        e.preventDefault(); // close the list, not the dialog
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') close();
      else if (e.key.length === 1 && /\S/.test(e.key)) {
        // Type-ahead: jump to the next option starting with that letter
        const start = isOpen ? active : select.selectedIndex;
        for (let k = 1; k <= n; k++) {
          const i = (start + k) % n;
          if (select.options[i].textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) {
            if (isOpen) move(i); else choose(i);
            break;
          }
        }
      }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the trigger
    list.addEventListener('click', (e) => {
      const li = e.target.closest('.select__option');
      if (li) choose(Number(li.dataset.index));
    });
    document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) close(); });
    trigger.addEventListener('blur', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) close(); }, 120));

    refresh();
    return { refresh, close };
  }

  const STATUS_ICONS = {
    pending: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/></svg>',
    'in-progress': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/></svg>',
    completed: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/></svg>',
  };

  const taskSelects = [
    enhanceSelect($('#task-priority'), {
      optionHtml: (v, label) => `<span class="badge badge--${v}">${escapeHtml(label)}</span>`,
    }),
    enhanceSelect($('#task-status'), {
      optionHtml: (v, label) => `<span class="status-opt status-opt--${v}">${STATUS_ICONS[v] || ''}<span>${escapeHtml(label)}</span></span>`,
    }),
  ];

  /* ---------------- Filter dropdowns ---------------- */

  const svg16 = (paths, extra = '') => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
  const FILTER_STATUS_ICONS = {
    '': svg16('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
    active: svg16('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'),
    today: svg16('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none"/>'),
    overdue: svg16('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M5 3 2 6M19 3l3 3"/>'),
    deleted: ICONS.trash.replace('width="18" height="18"', 'width="16" height="16"'),
    ...STATUS_ICONS,
  };
  const SORT_ICONS = {
    newest: svg16('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    oldest: svg16('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    due: svg16('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    priority: svg16('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  };
  // Icons for the default categories; any other category gets a tag
  const CATEGORY_ICONS = {
    bills: svg16('<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2Z"/><path d="M9 8h6M9 12h6"/>'),
    family: svg16('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5"/>'),
    groceries: svg16('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2.5 3h3l2.5 12h11l2-8H6.5"/>'),
    health: svg16('<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1Z"/>'),
    interview: svg16('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>'),
    personal: svg16('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    purchase: svg16('<path d="M5 7h14l-1 14H6Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>'),
    study: svg16('<path d="M4 19.5V5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2h14"/>'),
    work: svg16('<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'),
    custom: svg16('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  };
  const plainOpt = (icon, label, cls = '') => `<span class="status-opt ${cls}">${icon}<span>${escapeHtml(label)}</span></span>`;

  const filterSelects = {
    status: enhanceSelect($('#filter-status'), {
      optionHtml: (v, label) => plainOpt(FILTER_STATUS_ICONS[v] || '', label, `status-opt--${v || 'all'}`),
    }),
    priority: enhanceSelect($('#filter-priority'), {
      optionHtml: (v, label) => (v ? `<span class="badge badge--${v}">${escapeHtml(label)}</span>` : plainOpt(FILTER_STATUS_ICONS[''], label, 'status-opt--all')),
    }),
    category: enhanceSelect($('#filter-category'), {
      optionHtml: (v, label) => (v
        ? plainOpt(CATEGORY_ICONS[v.toLowerCase()] || CATEGORY_ICONS.custom, label, 'status-opt--cat')
        : plainOpt(FILTER_STATUS_ICONS[''], label, 'status-opt--all')),
    }),
    month: enhanceSelect($('#filter-month'), {
      optionHtml: (v, label) => plainOpt(v ? SORT_ICONS.due : FILTER_STATUS_ICONS[''], label, v ? 'status-opt--sort' : 'status-opt--all'),
    }),
    sort: enhanceSelect($('#sort'), {
      optionHtml: (v, label) => plainOpt(SORT_ICONS[v] || '', label, 'status-opt--sort'),
    }),
  };

  /* ---------------- Status menu (task cards & details) ---------------- */

  function statusTriggerHtml(status, attrs) {
    return `<button type="button" class="status-trigger" ${attrs} aria-haspopup="listbox" aria-expanded="false">
      <span class="status-opt status-opt--${status}">${STATUS_ICONS[status]}<span>${STATUS_LABELS[status]}</span></span>
      <svg class="select__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>`;
  }

  // One shared listbox: cards re-render too often to give each its own
  const STATUS_KEYS = Object.keys(STATUS_LABELS);
  const statusMenu = document.createElement('ul');
  statusMenu.className = 'combo__list status-menu';
  statusMenu.id = 'status-menu';
  statusMenu.setAttribute('role', 'listbox');
  statusMenu.setAttribute('aria-label', 'Status');
  statusMenu.hidden = true;
  let statusMenuState = null; // { trigger, current, onPick, active }

  function renderStatusMenu() {
    const { current, active, trigger } = statusMenuState;
    statusMenu.innerHTML = STATUS_KEYS.map((v, i) => `
      <li id="status-menu-opt-${i}" class="combo__option select__option${i === active ? ' is-active' : ''}${v === current ? ' is-selected' : ''}"
        role="option" aria-selected="${v === current}" data-value="${v}">
        <span class="select__content"><span class="status-opt status-opt--${v}">${STATUS_ICONS[v]}<span>${STATUS_LABELS[v]}</span></span></span>
        <span class="combo__check" aria-hidden="true">${v === current ? '✓' : ''}</span>
      </li>`).join('');
    trigger.setAttribute('aria-activedescendant', `status-menu-opt-${active}`);
  }

  function placeStatusMenu() {
    const r = statusMenuState.trigger.getBoundingClientRect();
    const width = Math.max(r.width, 170);
    const h = statusMenu.offsetHeight;
    const up = innerHeight - r.bottom < h + 12 && r.top > h + 12;
    Object.assign(statusMenu.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`,
      top: `${up ? r.top - h - 6 : r.bottom + 6}px`,
    });
  }

  function openStatusMenu(trigger, current, onPick) {
    const reopening = statusMenuState?.trigger === trigger;
    closeStatusMenu();
    if (reopening) return; // second click on the same button closes it
    // Inside an open modal the menu must live in the dialog to render above it
    (trigger.closest('dialog') || document.body).append(statusMenu);
    statusMenuState = { trigger, current, onPick, active: STATUS_KEYS.indexOf(current) };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'status-menu');
    trigger.classList.add('is-open');
    statusMenu.hidden = false;
    renderStatusMenu();
    placeStatusMenu();
  }

  function closeStatusMenu() {
    if (!statusMenuState) return;
    const { trigger } = statusMenuState;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    trigger.classList.remove('is-open');
    statusMenu.hidden = true;
    statusMenuState = null;
  }

  function pickStatus(value) {
    const { onPick, current, trigger } = statusMenuState;
    closeStatusMenu();
    if (value !== current) onPick(value);
    else trigger.focus();
  }

  statusMenu.addEventListener('mousedown', (e) => e.preventDefault());
  statusMenu.addEventListener('click', (e) => {
    const li = e.target.closest('[data-value]');
    if (li) pickStatus(li.dataset.value);
  });
  document.addEventListener('mousedown', (e) => {
    if (statusMenuState && !statusMenu.contains(e.target) && !statusMenuState.trigger.contains(e.target)) closeStatusMenu();
  });
  // Capture phase so Escape closes the menu before an open dialog sees it
  document.addEventListener('keydown', (e) => {
    if (!statusMenuState) return;
    const n = STATUS_KEYS.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      statusMenuState.active = (statusMenuState.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderStatusMenu();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickStatus(STATUS_KEYS[statusMenuState.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const { trigger } = statusMenuState;
      closeStatusMenu();
      trigger.focus();
    } else if (e.key === 'Tab') {
      closeStatusMenu();
    }
  }, true);
  // Follow the button on scroll/resize; close once it's gone or scrolled out of view
  function followStatusTrigger() {
    if (!statusMenuState) return;
    const { trigger } = statusMenuState;
    const r = trigger.getBoundingClientRect();
    if (!trigger.isConnected || r.bottom < 0 || r.top > innerHeight) closeStatusMenu();
    else placeStatusMenu();
  }
  addEventListener('resize', followStatusTrigger);
  document.addEventListener('scroll', followStatusTrigger, true);

  /* ---------------- Task dialog ---------------- */

  const taskDialog = $('#task-dialog');
  const taskForm = $('#task-form');

  const DEFAULT_NEW_TASK_CATEGORY = 'Personal';

  const TASK_HEAD_ICONS = {
    add: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  };

  function setTaskDialogHeading(editing) {
    $('#task-dialog-title').textContent = editing ? 'Edit task' : 'New task';
    $('#task-dialog-sub').textContent = editing ? 'Update the details below' : 'Capture what you need to get done';
    $('#task-dialog-icon').innerHTML = TASK_HEAD_ICONS[editing ? 'edit' : 'add'];
  }

  function openTaskDialog(task = null) {
    state.editingId = task?._id || null;
    taskForm.reset();
    setFormError(taskForm);
    setTaskDialogHeading(Boolean(task));
    $('#task-submit').textContent = task ? 'Save changes' : 'Add task';
    resetAttDraft(task);
    closeCategoryList();
    if (!task) taskForm.category.value = DEFAULT_NEW_TASK_CATEGORY;
    if (task) {
      taskForm.title.value = task.title;
      taskForm.description.value = task.description || '';
      const due = toLocalInputs(task.dueDate);
      taskForm.dueDate.value = due.date;
      taskForm.dueTime.value = due.time;
      taskForm.category.value = task.category || '';
      taskForm.priority.value = task.priority;
      taskForm.status.value = task.status;
    }
    timeIsAuto = false;
    syncTimeChips();
    syncCategoryLead();
    taskSelects.forEach((sel) => { sel.close(); sel.refresh(); });
    taskDialog.showModal();
    taskForm.title.focus();
  }

  $('#new-task-btn').addEventListener('click', () => openTaskDialog());

  /* Due time: smart default + one-tap times */

  const QUICK_TIMES = ['10:00', '12:00', '18:00', '22:00'];
  const DEFAULT_DUE_TIME = '22:00'; // 10 PM: the task can be done any time that day
  const pad2 = (n) => String(n).padStart(2, '0');
  const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const isPast = (date, time) => new Date(`${date}T${time}`) <= new Date();

  // 10 PM, or for today once 10 PM has passed, the next full hour (11:59 PM late at night)
  function defaultTimeFor(date) {
    if (!isPast(date, DEFAULT_DUE_TIME)) return DEFAULT_DUE_TIME;
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return localDate(next) === date ? `${pad2(next.getHours())}:00` : '23:59';
  }

  const timeLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true }); // "9 AM", "6 PM"
  $('#time-chips').innerHTML = QUICK_TIMES.map((t) => {
    const [h, m] = t.split(':').map(Number);
    return `<button type="button" class="time-chip" data-time="${t}">${timeLabel.format(new Date(2000, 0, 1, h, m))}</button>`;
  }).join('');

  const time12 = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  // "Thu, 22 Oct" — the year is only added when it isn't the current one
  const fieldDateThisYear = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fieldDateOtherYear = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fieldDate = { format: (d) => (d.getFullYear() === new Date().getFullYear() ? fieldDateThisYear : fieldDateOtherYear).format(d) };
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtTime12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return time12.format(new Date(2000, 0, 1, h, m)); };

  // Keeps the quick buttons and the time field's text in step with the hidden date/time values
  function syncTimeChips() {
    const date = taskForm.dueDate.value;
    const time = taskForm.dueTime.value;
    const display = $('#task-due-time-text');
    display.textContent = time ? fmtTime12(time) : 'Select time';
    display.classList.toggle('is-placeholder', !time);
    const dateText = $('#task-due-date-text');
    dateText.textContent = date ? fieldDate.format(parseYmd(date)) : 'Select date';
    dateText.classList.toggle('is-placeholder', !date);
    // Small relative tag next to the date: Today / Tomorrow / In 5 days / Past
    const hint = $('#task-due-date-hint');
    const days = date ? Math.round((parseYmd(date) - parseYmd(localDate(new Date()))) / 86400000) : null;
    hint.hidden = days === null || days > 60;
    if (days !== null) {
      hint.textContent = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 0 ? 'Past' : `In ${days} days`;
      hint.className = `time-field__hint${days === 0 ? ' is-today' : ''}${days < 0 ? ' is-past' : ''}`;
    }
    $$('[data-quick-date]', $('#date-chips')).forEach((chip) => {
      const d = QUICK_DATES[chip.dataset.quickDate].date();
      const on = localDate(d) === date;
      chip.classList.toggle('is-active', on);
      chip.setAttribute('aria-pressed', String(on));
      chip.title = longDate.format(d);
    });
    $$('.time-chip', $('#time-chips')).forEach((chip) => {
      const t = chip.dataset.time;
      chip.classList.toggle('is-active', Boolean(t) && t === time);
      chip.setAttribute('aria-pressed', String(Boolean(t) && t === time));
      // Times already gone today would make the task overdue immediately
      const gone = Boolean(t) && date === localDate(new Date()) && isPast(date, t);
      chip.disabled = gone;
      chip.title = gone ? 'Already passed today' : t === time ? 'Click again to clear the time' : '';
    });
  }

  // True while the time field holds our suggested default rather than a time the user chose,
  // so changing the date can update it (e.g. Today's 23:59 becomes 22:00 for Tomorrow)
  let timeIsAuto = false;

  taskForm.dueDate.addEventListener('change', () => {
    const date = taskForm.dueDate.value;
    const time = taskForm.dueTime.value;
    if (date && (!time || timeIsAuto || isPast(date, time))) {
      taskForm.dueTime.value = defaultTimeFor(date);
      timeIsAuto = true;
    }
    syncTimeChips();
  });

  // One-tap dates: each returns a Date relative to today
  const QUICK_DATES = [
    { label: 'Today', date: () => new Date() },
    { label: 'Tomorrow', date: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d; } },
  ];
  const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  $('#date-chips').innerHTML = QUICK_DATES.map((q, i) =>
    `<button type="button" class="time-chip" data-quick-date="${i}">${q.label}</button>`).join('');

  $('#date-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick-date]');
    if (!chip) return;
    taskForm.dueDate.value = localDate(QUICK_DATES[chip.dataset.quickDate].date());
    taskForm.dueDate.dispatchEvent(new Event('change')); // applies the default time
    setFormError(taskForm);
  });

  $('#time-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.time-chip');
    if (!chip || chip.disabled) return;
    // Clicking the selected time again clears it
    const t = chip.dataset.time === taskForm.dueTime.value ? '' : chip.dataset.time;
    if (t && !taskForm.dueDate.value) {
      // No date yet: use today, or tomorrow if that time has already passed
      const d = new Date();
      if (isPast(localDate(d), t)) d.setDate(d.getDate() + 1);
      taskForm.dueDate.value = localDate(d);
    }
    taskForm.dueTime.value = t;
    timeIsAuto = false;
    setFormError(taskForm);
    syncTimeChips();
  });

  /* Clock-style time picker */

  const clockDialog = $('#clock-dialog');
  const clockFace = $('#clock-face');
  const CLOCK_SIZE = 208; // must match .clock__face in the CSS
  const CLOCK_RADIUS = 80; // px from the centre to the numbers
  const clock = { h: 10, m: 0, pm: true, mode: 'hour' };
  const to24 = () => (clock.h % 12) + (clock.pm ? 12 : 0);

  function clockPoint(deg) {
    const rad = (deg * Math.PI) / 180;
    const c = CLOCK_SIZE / 2;
    return { x: c + CLOCK_RADIUS * Math.sin(rad), y: c - CLOCK_RADIUS * Math.cos(rad) };
  }

  function renderClock() {
    const hourMode = clock.mode === 'hour';
    $('#clock-hour').textContent = clock.h;
    $('#clock-minute').textContent = pad2(clock.m);
    $('#clock-hour').classList.toggle('is-active', hourMode);
    $('#clock-minute').classList.toggle('is-active', !hourMode);
    $('#clock-am').classList.toggle('is-active', !clock.pm);
    $('#clock-pm').classList.toggle('is-active', clock.pm);
    $('#clock-am').setAttribute('aria-pressed', String(!clock.pm));
    $('#clock-pm').setAttribute('aria-pressed', String(clock.pm));

    const labels = hourMode ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
    const current = hourMode ? clock.h : clock.m;
    $('#clock-nums').innerHTML = labels.map((v, i) => {
      const { x, y } = clockPoint(i * 30);
      return `<span class="clock__num${v === current ? ' is-selected' : ''}" style="left:${x}px;top:${y}px">${hourMode ? v : pad2(v)}</span>`;
    }).join('');

    const deg = hourMode ? (clock.h % 12) * 30 : clock.m * 6;
    const knob = clockPoint(deg);
    $('#clock-hand').style.transform = `translateX(-50%) rotate(${deg}deg)`;
    Object.assign($('#clock-knob').style, { left: `${knob.x}px`, top: `${knob.y}px` });
    // Between the 5-minute labels the knob shrinks to a dot
    $('#clock-knob').classList.toggle('is-small', !hourMode && clock.m % 5 !== 0);

    clockFace.setAttribute('aria-label', hourMode ? 'Hour' : 'Minutes');
    clockFace.setAttribute('aria-valuemin', hourMode ? '1' : '0');
    clockFace.setAttribute('aria-valuemax', hourMode ? '12' : '59');
    clockFace.setAttribute('aria-valuenow', String(current));
    clockFace.setAttribute('aria-valuetext', fmtTime12(`${pad2(to24())}:${pad2(clock.m)}`));
  }

  function openClock() {
    const fallback = defaultTimeFor(taskForm.dueDate.value || localDate(new Date()));
    const [h, m] = (taskForm.dueTime.value || fallback).split(':').map(Number);
    Object.assign(clock, { h: h % 12 || 12, m, pm: h >= 12, mode: 'hour' });
    renderClock();
    clockDialog.showModal();
    clockFace.focus();
  }

  function closeClock(value) {
    if (value !== undefined) {
      if (value && !taskForm.dueDate.value) {
        // No date yet: use today, or tomorrow if that time has already passed
        const d = new Date();
        if (isPast(localDate(d), value)) d.setDate(d.getDate() + 1);
        taskForm.dueDate.value = localDate(d);
      }
      taskForm.dueTime.value = value;
      timeIsAuto = false;
      setFormError(taskForm);
      syncTimeChips();
    }
    clockDialog.close();
    $('#task-due-time-btn').focus();
  }

  function pickFromPointer(e) {
    const r = clockFace.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (clock.mode === 'hour') clock.h = Math.round(deg / 30) % 12 || 12;
    else clock.m = Math.round(deg / 6) % 60;
    renderClock();
  }

  let clockDragging = false;
  clockFace.addEventListener('pointerdown', (e) => {
    clockDragging = true;
    clockFace.setPointerCapture(e.pointerId);
    pickFromPointer(e);
  });
  clockFace.addEventListener('pointermove', (e) => { if (clockDragging) pickFromPointer(e); });
  clockFace.addEventListener('pointerup', () => {
    if (!clockDragging) return;
    clockDragging = false;
    // Like Android: after choosing the hour, move straight on to minutes
    if (clock.mode === 'hour') {
      clock.mode = 'minute';
      renderClock();
    }
  });

  clockFace.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      if (clock.mode === 'hour') clock.h = ((clock.h - 1 + step + 12) % 12) + 1;
      else clock.m = (clock.m + step * (e.shiftKey ? 5 : 1) + 60) % 60;
      renderClock();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (clock.mode === 'hour') { clock.mode = 'minute'; renderClock(); }
      else closeClock(`${pad2(to24())}:${pad2(clock.m)}`);
    }
  });

  $('#clock-hour').addEventListener('click', () => { clock.mode = 'hour'; renderClock(); clockFace.focus(); });
  $('#clock-minute').addEventListener('click', () => { clock.mode = 'minute'; renderClock(); clockFace.focus(); });
  $('#clock-am').addEventListener('click', () => { clock.pm = false; renderClock(); });
  $('#clock-pm').addEventListener('click', () => { clock.pm = true; renderClock(); });
  $('#clock-ok').addEventListener('click', () => closeClock(`${pad2(to24())}:${pad2(clock.m)}`));
  $('#clock-cancel').addEventListener('click', () => closeClock());
  $('#clock-clear').addEventListener('click', () => closeClock(''));
  $('#task-due-time-btn').addEventListener('click', openClock);

  /* Calendar date picker (same look as the clock) */

  const calDialog = $('#cal-dialog');
  const cal = { sel: new Date(), month: new Date(), view: 'days', yearStart: 0 };
  const YEARS_PER_PAGE = 12;
  const fmtMonthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const fmtHeaderDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtMonthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const fmtDayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const sameYmd = (a, b) => localDate(a) === localDate(b);
  const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  function renderCal({ focus = false } = {}) {
    const { sel, month, view } = cal;
    $('#cal-year').textContent = sel.getFullYear();
    $('#cal-year').classList.toggle('is-active', view === 'years');
    $('#cal-date').textContent = fmtHeaderDate.format(sel);
    const body = $('#cal-body');
    const today = new Date();
    body.className = `cal__body cal__body--${view}`;

    if (view === 'days') {
      $('#cal-label').innerHTML = `${fmtMonthYear.format(month)} ${CHEVRON_DOWN}`;
      $('#cal-label').setAttribute('aria-label', `${fmtMonthYear.format(month)}. Choose month`);
      $('#cal-prev').setAttribute('aria-label', 'Previous month');
      $('#cal-next').setAttribute('aria-label', 'Next month');
      const start = new Date(month.getFullYear(), month.getMonth(), 1);
      start.setDate(1 - start.getDay()); // back to Sunday
      const weekdays = Array.from({ length: 7 }, (_, i) => fmtWeekday.format(new Date(2023, 0, 1 + i))); // 1 Jan 2023 was a Sunday
      let html = weekdays.map((w) => `<span class="cal__weekday" aria-hidden="true">${w}</span>`).join('');
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const classes = ['cal__day'];
        if (d.getMonth() !== month.getMonth()) classes.push('is-outside');
        if (sameYmd(d, today)) classes.push('is-today');
        const selected = sameYmd(d, sel);
        if (selected) classes.push('is-selected');
        html += `<button type="button" class="${classes.join(' ')}" data-date="${localDate(d)}" tabindex="${selected ? 0 : -1}"
          aria-pressed="${selected}" aria-label="${fmtDayLabel.format(d)}${sameYmd(d, today) ? ' (today)' : ''}">${d.getDate()}</button>`;
      }
      body.innerHTML = html;
      if (focus) $('.cal__day.is-selected', body)?.focus();
    } else if (view === 'months') {
      $('#cal-label').innerHTML = `${month.getFullYear()} ${CHEVRON_DOWN}`;
      $('#cal-label').setAttribute('aria-label', `${month.getFullYear()}. Choose year`);
      $('#cal-prev').setAttribute('aria-label', 'Previous year');
      $('#cal-next').setAttribute('aria-label', 'Next year');
      body.innerHTML = Array.from({ length: 12 }, (_, m) => {
        const d = new Date(month.getFullYear(), m, 1);
        const on = m === sel.getMonth() && month.getFullYear() === sel.getFullYear();
        const now = m === today.getMonth() && month.getFullYear() === today.getFullYear();
        return `<button type="button" class="cal__cell${on ? ' is-selected' : ''}${now ? ' is-today' : ''}" data-month="${m}">${fmtMonthShort.format(d)}</button>`;
      }).join('');
      if (focus) $('.cal__cell', body)?.focus();
    } else {
      const from = cal.yearStart;
      $('#cal-label').textContent = `${from} – ${from + YEARS_PER_PAGE - 1}`;
      $('#cal-label').setAttribute('aria-label', `Years ${from} to ${from + YEARS_PER_PAGE - 1}`);
      $('#cal-prev').setAttribute('aria-label', 'Earlier years');
      $('#cal-next').setAttribute('aria-label', 'Later years');
      body.innerHTML = Array.from({ length: YEARS_PER_PAGE }, (_, i) => {
        const y = from + i;
        return `<button type="button" class="cal__cell${y === sel.getFullYear() ? ' is-selected' : ''}${y === today.getFullYear() ? ' is-today' : ''}" data-year="${y}">${y}</button>`;
      }).join('');
      if (focus) $('.cal__cell', body)?.focus();
    }
  }

  function showYears() {
    cal.view = 'years';
    cal.yearStart = cal.month.getFullYear() - (cal.month.getFullYear() % YEARS_PER_PAGE);
    renderCal({ focus: true });
  }

  function openCal() {
    const sel = taskForm.dueDate.value ? parseYmd(taskForm.dueDate.value) : new Date();
    Object.assign(cal, { sel, month: new Date(sel.getFullYear(), sel.getMonth(), 1), view: 'days' });
    renderCal();
    calDialog.showModal();
    $('.cal__day.is-selected', calDialog)?.focus();
  }

  function closeCal(value) {
    if (value !== undefined) {
      taskForm.dueDate.value = value;
      if (!value) {
        taskForm.dueTime.value = ''; // a time without a date isn't valid
        timeIsAuto = false;
      }
      taskForm.dueDate.dispatchEvent(new Event('change')); // applies the default time
      setFormError(taskForm);
      syncTimeChips();
    }
    calDialog.close();
    $('#task-due-date-btn').focus();
  }

  function selectDay(d, { focus = true } = {}) {
    cal.sel = d;
    cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCal({ focus });
  }

  $('#cal-body').addEventListener('click', (e) => {
    const day = e.target.closest('[data-date]');
    const month = e.target.closest('[data-month]');
    const year = e.target.closest('[data-year]');
    if (day) selectDay(parseYmd(day.dataset.date));
    else if (month) {
      // Keep the day, clamped to the new month's length
      const m = Number(month.dataset.month);
      const y = cal.month.getFullYear();
      const last = new Date(y, m + 1, 0).getDate();
      cal.view = 'days';
      selectDay(new Date(y, m, Math.min(cal.sel.getDate(), last)));
    } else if (year) {
      cal.month = new Date(Number(year.dataset.year), cal.month.getMonth(), 1);
      cal.view = 'months';
      renderCal({ focus: true });
    }
  });
  $('#cal-body').addEventListener('dblclick', (e) => {
    const day = e.target.closest('[data-date]');
    if (day) closeCal(day.dataset.date); // double-click picks and confirms
  });

  $('#cal-body').addEventListener('keydown', (e) => {
    if (cal.view !== 'days' || !e.target.closest('[data-date]')) return;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    const d = new Date(cal.sel);
    if (move) d.setDate(d.getDate() + move);
    else if (e.key === 'PageUp' || e.key === 'PageDown') d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
    else if (e.key === 'Home') d.setDate(d.getDate() - d.getDay());
    else if (e.key === 'End') d.setDate(d.getDate() + (6 - d.getDay()));
    else if (e.key === 'Enter') { e.preventDefault(); closeCal(localDate(cal.sel)); return; }
    else return;
    e.preventDefault();
    selectDay(d);
  });

  function stepCal(dir) {
    if (cal.view === 'days') cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + dir, 1);
    else if (cal.view === 'months') cal.month = new Date(cal.month.getFullYear() + dir, cal.month.getMonth(), 1);
    else cal.yearStart += dir * YEARS_PER_PAGE;
    renderCal();
  }

  $('#cal-prev').addEventListener('click', () => stepCal(-1));
  $('#cal-next').addEventListener('click', () => stepCal(1));
  $('#cal-label').addEventListener('click', () => {
    if (cal.view === 'days') { cal.view = 'months'; renderCal({ focus: true }); }
    else if (cal.view === 'months') showYears();
  });
  $('#cal-year').addEventListener('click', () => (cal.view === 'years' ? (cal.view = 'days', renderCal({ focus: true })) : showYears()));
  $('#cal-ok').addEventListener('click', () => closeCal(localDate(cal.sel)));
  $('#cal-cancel').addEventListener('click', () => closeCal());
  $('#cal-clear').addEventListener('click', () => closeCal(''));
  $('#task-due-date-btn').addEventListener('click', openCal);

  taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(taskForm));
    const title = data.title.trim();
    if (!title) {
      setFormError(taskForm, 'Title is required.');
      taskForm.title.focus();
      return;
    }
    if (data.dueTime && !data.dueDate) {
      setFormError(taskForm, 'Pick a due date to go with the time.');
      taskForm.dueDate.focus();
      return;
    }
    const payload = {
      title,
      description: data.description.trim(),
      category: data.category.trim(),
      priority: data.priority,
      status: data.status,
      // Date + time are interpreted in the user's local timezone, sent as UTC ISO.
      // A date with no time means "by the end of that day".
      dueDate: data.dueDate ? new Date(`${data.dueDate}T${data.dueTime || '23:59'}`).toISOString() : null,
    };

    const wasEditing = Boolean(state.editingId);
    let saved = null;
    try {
      await withBusy($('#task-submit'), async () => {
        saved = (state.editingId
          ? await api.updateTask(state.editingId, payload)
          : await api.createTask(payload)).task;
        // From here on a retry must update this task, not create a duplicate
        state.editingId = saved._id;
        await saveAttachments(saved._id);
      });
      toast(wasEditing ? 'Task updated' : 'Task added', 'success');
      taskDialog.close();
      loadTasks({ silent: true });
    } catch (err) {
      if (saved) {
        setTaskDialogHeading(true);
        $('#task-submit').textContent = 'Save changes';
        setFormError(taskForm, `Task saved, but attachments failed: ${err.message}`);
        loadTasks({ silent: true });
      } else {
        setFormError(taskForm, err.message);
      }
    }
  });

  /* ---------------- Profile dialog ---------------- */

  const profileDialog = $('#profile-dialog');

  $('#profile-btn').addEventListener('click', () => {
    $('#profile-name').value = state.user.name;
    $$('form', profileDialog).forEach((f) => setFormError(f));
    $('#password-form').reset();
    profileDialog.showModal();
  });

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = form.name.value.trim();
    if (!name) return setFormError(form, 'Display name is required.');
    setFormError(form);
    try {
      const data = await withBusy($('button[type=submit]', form), () => api.updateProfile({ name }));
      state.user = data.user;
      renderUser();
      toast('Display name updated', 'success');
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { currentPassword, newPassword } = Object.fromEntries(new FormData(form));
    if (!currentPassword || !newPassword) return setFormError(form, 'Both fields are required.');
    if (newPassword.length < 8) return setFormError(form, 'New password must be at least 8 characters.');
    setFormError(form);
    try {
      await withBusy($('button[type=submit]', form), () => api.changePassword({ currentPassword, newPassword }));
      form.reset();
      toast('Password updated', 'success');
    } catch (err) {
      setFormError(form, err.message);
    }
  });

  /* ---------------- Confirm dialog ---------------- */

  function confirmDialog({ title = 'Are you sure?', text, confirmLabel = 'Confirm' }) {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = confirmLabel;
    dlg.returnValue = '';
    dlg.showModal();
    $('button[value=cancel]', dlg).focus({ focusVisible: false });
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
    });
  }

  // Generic close buttons + click on backdrop
  $$('dialog').forEach((dlg) => {
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  });

  /* ---------------- Toolbar ---------------- */

  const onSearch = debounce((value) => {
    state.filters.search = value.trim();
    loadTasks();
  }, 300);
  $('#search').addEventListener('input', (e) => onSearch(e.target.value));

  [['#filter-status', 'status'], ['#filter-priority', 'priority'], ['#filter-category', 'category'], ['#filter-month', 'month'], ['#sort', 'sort']]
    .forEach(([sel, key]) => {
      $(sel).addEventListener('change', (e) => {
        state.filters[key] = e.target.value;
        if (key === 'status') syncStatButtons();
        loadTasks();
      });
    });

  $('#clear-filters').addEventListener('click', () => {
    Object.assign(state.filters, { search: '', status: 'today', priority: '', category: '', month: '' });
    $('#search').value = '';
    ['status', 'priority', 'category', 'month'].forEach((key) => {
      $(`#filter-${key}`).value = state.filters[key];
      filterSelects[key].refresh();
    });
    syncStatButtons();
    loadTasks();
    $('#search').focus();
  });

  // Phones: Upcoming is collapsed to its header; tapping the header opens it
  const remindersToggle = $('#reminders-toggle');
  function setRemindersOpen(open) {
    $('#reminders').classList.toggle('is-open', open);
    remindersToggle.setAttribute('aria-expanded', String(open));
    remindersToggle.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} upcoming tasks`);
  }
  $('#reminders .reminders__header').addEventListener('click', () => {
    if (getComputedStyle(remindersToggle).display === 'none') return; // desktop: always open
    setRemindersOpen(!$('#reminders').classList.contains('is-open'));
  });

  // Stat cards act as quick status filters and mirror the Status dropdown
  function syncStatButtons() {
    $$('.stat[data-filter]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.filter === state.filters.status));
    });
  }

  $$('.stat[data-filter]').forEach((b) => {
    b.addEventListener('click', () => {
      const { filter } = b.dataset;
      // Clicking the active card again goes back to showing everything
      state.filters.status = state.filters.status === filter ? '' : filter;
      $('#filter-status').value = state.filters.status;
      filterSelects.status.refresh();
      syncStatButtons();
      loadTasks();
      $('#task-list').closest('section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  /* ---------------- Keyboard shortcuts ---------------- */

  document.addEventListener('keydown', (e) => {
    if ($('#app-view').hidden || document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.key === 'n') { e.preventDefault(); openTaskDialog(); }
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  });

  /* ---------------- Password visibility ---------------- */

  const EYE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';

  function setPasswordVisible(input, btn, visible) {
    input.type = visible ? 'text' : 'password';
    btn.innerHTML = visible ? EYE_OFF_ICON : EYE_ICON;
    btn.setAttribute('aria-pressed', String(visible));
    btn.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    btn.title = visible ? 'Hide password' : 'Show password';
  }

  $$('input[type="password"]').forEach((input) => {
    const wrap = document.createElement('div');
    wrap.className = 'password-wrap';
    input.before(wrap);
    wrap.append(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-toggle';
    btn.setAttribute('aria-controls', input.id);
    wrap.append(btn);
    setPasswordVisible(input, btn, false);

    btn.addEventListener('click', () => {
      setPasswordVisible(input, btn, input.type === 'password');
      input.focus();
    });
    // Always re-hide when the form is cleared (e.g. after login or a password change)
    input.form?.addEventListener('reset', () => setPasswordVisible(input, btn, false));
  });

  /* ---------------- Init ---------------- */

  $$('[data-action="toggle-theme"]').forEach((b) => b.addEventListener('click', toggleTheme));
  syncThemeButtons();

  // Re-evaluate overdue state and the greeting every minute without refetching
  setInterval(() => {
    renderGreeting();
    const busy = document.querySelector('dialog[open]') || $('#task-list').contains(document.activeElement);
    if (!$('#app-view').hidden && !busy) {
      renderTasks();
      renderStats();
    }
  }, 60000);

  // Firebase restores the session on load and tells us whenever someone signs in or out
  api.onAuthChange((user) => {
    if (user) {
      state.user = user;
      showApp();
    } else if ($('#auth-view').hidden || !state.authShown) {
      state.authShown = true;
      showAuth();
    }
  });
  // Changes made on another device or tab show up here straight away
  api.onTasksChange(() => loadTasks({ silent: true }));
})();

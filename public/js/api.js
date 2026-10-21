// Thin wrapper around fetch that attaches the JWT and normalizes errors
const api = (() => {
  const TOKEN_KEY = 'taskflow-token';

  const getToken = () => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  };
  const setToken = (t) => {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
  };

  let onUnauthorized = () => {};

  async function request(path, { method = 'GET', body, keepalive = false } = {}) {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // FormData (file uploads) sets its own multipart Content-Type with the boundary
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        body: body === undefined || isForm ? body : JSON.stringify(body),
        keepalive, // lets a final save finish while the page is closing
      });
    } catch {
      throw new Error('Network error. Check your connection.');
    }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401 && token && !path.startsWith('/auth/login') && !path.startsWith('/auth/password')) {
        onUnauthorized();
      }
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    return data;
  }

  return {
    getToken,
    setToken,
    set onUnauthorized(fn) { onUnauthorized = fn; },

    register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
    login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
    me: () => request('/auth/me'),
    updateProfile: (payload) => request('/auth/profile', { method: 'PATCH', body: payload }),
    changePassword: (payload) => request('/auth/password', { method: 'PATCH', body: payload }),
    forgotPassword: (email) => request('/auth/forgot', { method: 'POST', body: { email } }),
    resetPassword: (token, password) => request('/auth/reset', { method: 'POST', body: { token, password } }),
    saveNote: (note, { keepalive = false } = {}) => request('/auth/note', { method: 'PATCH', body: { note }, keepalive }),

    listTasks: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
      return request(`/tasks${qs ? `?${qs}` : ''}`);
    },
    categories: () => request('/tasks/categories'),
    deleteCategory: (name) => request(`/tasks/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    createTask: (payload) => request('/tasks', { method: 'POST', body: payload }),
    updateTask: (id, payload) => request(`/tasks/${id}`, { method: 'PATCH', body: payload }),
    stats: () => request('/tasks/stats'),
    deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }), // moves to trash
    deleteTaskForever: (id) => request(`/tasks/${id}?permanent=true`, { method: 'DELETE' }),
    restoreTask: (id) => request(`/tasks/${id}/restore`, { method: 'POST' }),
    emptyTrash: () => request('/tasks/trash', { method: 'DELETE' }),

    uploadAttachments: (taskId, files) => {
      const form = new FormData();
      files.forEach((f) => form.append('files', f, f.name));
      return request(`/tasks/${taskId}/attachments`, { method: 'POST', body: form });
    },
    deleteAttachment: (taskId, attId) => request(`/tasks/${taskId}/attachments/${attId}`, { method: 'DELETE' }),
    // Downloads need the Authorization header, so they are fetched as a Blob instead of a plain link
    async attachmentBlob(taskId, attId, { inline = false } = {}) {
      let res;
      try {
        res = await fetch(`/api/tasks/${taskId}/attachments/${attId}${inline ? '?inline=1' : ''}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
      } catch {
        throw new Error('Network error. Check your connection.');
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) onUnauthorized();
        throw new Error(data.message || `Download failed (${res.status})`);
      }
      return res.blob();
    },
  };
})();

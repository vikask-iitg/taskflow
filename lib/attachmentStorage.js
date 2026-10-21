const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');

// Attachment files for <uid>/<taskId>, plus an index.json mapping attachment ids to stored files.
// The uid comes from the verified Firebase token, so a user can only ever reach their own folder.
//
// Two backends:
//   - Vercel Blob (private store) when BLOB_READ_WRITE_TOKEN is set, i.e. when deployed on Vercel
//   - Local disk under .data/uploads/ otherwise (development)
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/* ---------------- Vercel Blob ---------------- */

const blobPath = (uid, taskId, name) => `attachments/${uid}/${taskId}/${name}`;

const blobBackend = () => {
  const { put, get, del, list } = require('@vercel/blob');

  async function getStream(pathname) {
    try {
      const result = await get(pathname, { access: 'private', useCache: false });
      return result?.stream ? Readable.fromWeb(result.stream) : null;
    } catch (err) {
      if (err?.name === 'BlobNotFoundError') return null;
      throw err;
    }
  }

  return {
    async readIndex(uid, taskId) {
      const stream = await getStream(blobPath(uid, taskId, 'index.json'));
      if (!stream) return {};
      let text = '';
      for await (const chunk of stream) text += chunk;
      return JSON.parse(text);
    },
    async writeIndex(uid, taskId, index) {
      await put(blobPath(uid, taskId, 'index.json'), JSON.stringify(index), {
        access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
      });
    },
    async saveFile(uid, taskId, storedName, buffer, mimeType) {
      await put(blobPath(uid, taskId, storedName), buffer, { access: 'private', addRandomSuffix: false, contentType: mimeType });
    },
    openFile: (uid, taskId, storedName) => getStream(blobPath(uid, taskId, storedName)),
    async removeFile(uid, taskId, storedName) {
      await del(blobPath(uid, taskId, storedName));
    },
    async removeTask(uid, taskId) {
      let cursor;
      do {
        const page = await list({ prefix: blobPath(uid, taskId, ''), cursor });
        if (page.blobs.length) await del(page.blobs.map((b) => b.url));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    },
  };
};

/* ---------------- Local disk ---------------- */

const UPLOAD_ROOT = path.join(__dirname, '..', '.data', 'uploads');
const taskDir = (uid, taskId) => path.join(UPLOAD_ROOT, uid, taskId);

const diskBackend = () => ({
  async readIndex(uid, taskId) {
    try {
      return JSON.parse(await fsp.readFile(path.join(taskDir(uid, taskId), 'index.json'), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  },
  async writeIndex(uid, taskId, index) {
    await fsp.mkdir(taskDir(uid, taskId), { recursive: true });
    await fsp.writeFile(path.join(taskDir(uid, taskId), 'index.json'), JSON.stringify(index, null, 2));
  },
  async saveFile(uid, taskId, storedName, buffer) {
    await fsp.mkdir(taskDir(uid, taskId), { recursive: true });
    await fsp.writeFile(path.join(taskDir(uid, taskId), storedName), buffer);
  },
  async openFile(uid, taskId, storedName) {
    const file = path.join(taskDir(uid, taskId), storedName);
    try {
      await fsp.access(file);
    } catch {
      return null;
    }
    return fs.createReadStream(file);
  },
  async removeFile(uid, taskId, storedName) {
    await fsp.rm(path.join(taskDir(uid, taskId), storedName), { force: true });
  },
  async removeTask(uid, taskId) {
    await fsp.rm(taskDir(uid, taskId), { recursive: true, force: true });
  },
});

module.exports = { SAFE_ID, useBlob, ...(useBlob ? blobBackend() : diskBackend()) };

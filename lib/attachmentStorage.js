const fs = require('fs/promises');
const path = require('path');

// Files live in .data/uploads/<uid>/<taskId>/, next to an index.json that maps each
// attachment id to its stored file. The uid comes from the verified Firebase token,
// so a user can only ever reach their own folder.
const UPLOAD_ROOT = path.join(__dirname, '..', '.data', 'uploads');
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const taskDir = (uid, taskId) => path.join(UPLOAD_ROOT, uid, taskId);
const indexPath = (uid, taskId) => path.join(taskDir(uid, taskId), 'index.json');
const filePath = (uid, taskId, storedName) => path.join(taskDir(uid, taskId), storedName);

async function readIndex(uid, taskId) {
  try {
    return JSON.parse(await fs.readFile(indexPath(uid, taskId), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeIndex(uid, taskId, index) {
  await fs.mkdir(taskDir(uid, taskId), { recursive: true });
  await fs.writeFile(indexPath(uid, taskId), JSON.stringify(index, null, 2));
}

async function removeTask(uid, taskId) {
  await fs.rm(taskDir(uid, taskId), { recursive: true, force: true });
}

module.exports = { UPLOAD_ROOT, SAFE_ID, taskDir, filePath, readIndex, writeIndex, removeTask };

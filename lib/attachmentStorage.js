const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');

// Files live in .data/uploads/<taskId>/<random name>, next to the embedded database
const UPLOAD_ROOT = path.join(__dirname, '..', '.data', 'uploads');

const taskDir = (taskId) => path.join(UPLOAD_ROOT, String(taskId));
const filePath = (taskId, storedName) => path.join(taskDir(taskId), storedName);

async function removeFile(taskId, storedName) {
  await fs.rm(filePath(taskId, storedName), { force: true });
}

async function removeTaskFiles(taskIds) {
  await Promise.all([].concat(taskIds).map((id) => fs.rm(taskDir(id), { recursive: true, force: true })));
}

// Deletes files whose task no longer exists (e.g. purged from the trash by the TTL index)
// and files no task references (e.g. left over from an interrupted upload).
async function sweepOrphans() {
  const Task = mongoose.model('Task');
  let dirs;
  try {
    dirs = await fs.readdir(UPLOAD_ROOT);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const dir of dirs) {
    const task = mongoose.isValidObjectId(dir)
      ? await Task.findById(dir).select('attachments.storedName').lean()
      : null;
    if (!task) {
      await fs.rm(taskDir(dir), { recursive: true, force: true });
      continue;
    }
    const keep = new Set(task.attachments.map((a) => a.storedName));
    for (const file of await fs.readdir(taskDir(dir))) {
      if (!keep.has(file)) await fs.rm(filePath(dir, file), { force: true });
    }
  }
}

module.exports = { UPLOAD_ROOT, taskDir, filePath, removeFile, removeTaskFiles, sweepOrphans };

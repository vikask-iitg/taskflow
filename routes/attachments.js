const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const Task = require('../models/Task');
const requireAuth = require('../middleware/auth');
const storage = require('../lib/attachmentStorage');

const { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } = Task;
const router = express.Router({ mergeParams: true });

// Types the browser may display inline. Anything else (HTML, SVG, scripts…) is always a download.
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

router.use(requireAuth);

// Loads the caller's task into req.task. Only active tasks can be changed; files of
// tasks in the trash can still be viewed.
const loadTask = ({ includeDeleted = false } = {}) => async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Task not found' });
    const filter = { _id: req.params.id, userId: req.user._id };
    if (!includeDeleted) filter.deletedAt = null;
    req.task = await Task.findOne(filter);
    if (!req.task) return res.status(404).json({ message: 'Task not found' });
    next();
  } catch (err) {
    next(err);
  }
};

function findAttachment(req, res) {
  const att = mongoose.isValidObjectId(req.params.attId) && req.task.attachments.id(req.params.attId);
  if (!att) res.status(404).json({ message: 'Attachment not found' });
  return att;
}

// POST /api/tasks/:id/attachments (multipart, field "files")
router.post('/', loadTask(), (req, res, next) => {
  const remaining = MAX_ATTACHMENTS - req.task.attachments.length;
  if (remaining <= 0) {
    return res.status(400).json({ message: `A task can have at most ${MAX_ATTACHMENTS} attachments` });
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (r, file, cb) => {
        const dir = storage.taskDir(req.task._id);
        fs.promises.mkdir(dir, { recursive: true }).then(() => cb(null, dir), cb);
      },
      filename: (r, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
    }),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: remaining },
    defParamCharset: 'utf8', // keep non-ASCII file names intact
  }).array('files');

  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: `Each file must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller`,
        LIMIT_FILE_COUNT: `A task can have at most ${MAX_ATTACHMENTS} attachments`,
        LIMIT_UNEXPECTED_FILE: 'Unexpected upload field',
      };
      return res.status(400).json({ message: messages[err.code] || err.message });
    }
    if (err) return next(err);
    if (!req.files?.length) return res.status(400).json({ message: 'No files received' });

    try {
      for (const f of req.files) {
        req.task.attachments.push({
          originalName: f.originalname.slice(0, 255) || 'file',
          storedName: f.filename,
          mimeType: f.mimetype || 'application/octet-stream',
          size: f.size,
        });
      }
      await req.task.save();
      res.status(201).json({ task: req.task });
    } catch (e) {
      await Promise.all(req.files.map((f) => storage.removeFile(req.task._id, f.filename)));
      next(e);
    }
  });
});

// GET /api/tasks/:id/attachments/:attId[?inline=1]
router.get('/:attId', loadTask({ includeDeleted: true }), (req, res) => {
  const att = findAttachment(req, res);
  if (!att) return;

  const inline = req.query.inline === '1' && INLINE_SAFE.has(att.mimeType);
  res.attachment(att.originalName); // sets an RFC 5987-safe Content-Disposition
  if (inline) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
  res.set({
    'Content-Type': INLINE_SAFE.has(att.mimeType) ? att.mimeType : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'Cache-Control': 'private, no-store',
  });
  // dotfiles: 'allow' because the upload root lives under .data/; the path is built server-side
  res.sendFile(storage.filePath(req.task._id, att.storedName), { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ message: 'File is missing' });
  });
});

// DELETE /api/tasks/:id/attachments/:attId
router.delete('/:attId', loadTask(), async (req, res, next) => {
  try {
    const att = findAttachment(req, res);
    if (!att) return;
    const { storedName } = att;
    att.deleteOne();
    await req.task.save();
    await storage.removeFile(req.task._id, storedName);
    res.json({ task: req.task });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

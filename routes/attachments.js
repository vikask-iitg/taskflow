const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const requireFirebaseUser = require('../middleware/firebaseAuth');
const storage = require('../lib/attachmentStorage');

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Types the browser may display inline. Anything else (HTML, SVG, scripts…) is always a download.
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

const router = express.Router();
router.use(requireFirebaseUser);

router.param('taskId', (req, res, next, id) => (storage.SAFE_ID.test(id) ? next() : res.status(400).json({ message: 'Invalid task' })));
router.param('attId', (req, res, next, id) => (storage.SAFE_ID.test(id) ? next() : res.status(400).json({ message: 'Invalid attachment' })));

// POST /api/attachments/:taskId (multipart, field "files") -> { attachments: [...] }
router.post('/:taskId', async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const index = await storage.readIndex(req.uid, taskId);
    const remaining = MAX_ATTACHMENTS - Object.keys(index).length;
    if (remaining <= 0) return res.status(400).json({ message: `A task can have at most ${MAX_ATTACHMENTS} attachments` });

    const dir = storage.taskDir(req.uid, taskId);
    await fs.promises.mkdir(dir, { recursive: true });
    const upload = multer({
      storage: multer.diskStorage({
        destination: dir,
        filename: (r, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
      }),
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: remaining },
      defParamCharset: 'utf8',
    }).array('files');

    upload(req, res, async (err) => {
      if (err instanceof multer.MulterError) {
        const messages = {
          LIMIT_FILE_SIZE: `Each file must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller`,
          LIMIT_FILE_COUNT: `A task can have at most ${MAX_ATTACHMENTS} attachments`,
        };
        return res.status(400).json({ message: messages[err.code] || err.message });
      }
      if (err) return next(err);
      if (!req.files?.length) return res.status(400).json({ message: 'No files received' });

      const uploadedAt = new Date().toISOString();
      const added = req.files.map((f) => {
        const id = crypto.randomBytes(12).toString('hex');
        const meta = { originalName: f.originalname.slice(0, 255) || 'file', mimeType: (f.mimetype || 'application/octet-stream').slice(0, 150), size: f.size, uploadedAt };
        index[id] = { ...meta, storedName: f.filename };
        return { _id: id, ...meta };
      });
      await storage.writeIndex(req.uid, taskId, index);
      res.status(201).json({ attachments: added });
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/attachments/:taskId/:attId[?inline=1]
router.get('/:taskId/:attId', async (req, res, next) => {
  try {
    const { taskId, attId } = req.params;
    const att = (await storage.readIndex(req.uid, taskId))[attId];
    if (!att) return res.status(404).json({ message: 'Attachment not found' });
    const inline = req.query.inline === '1' && INLINE_SAFE.has(att.mimeType);
    res.attachment(att.originalName);
    if (inline) res.set('Content-Disposition', res.get('Content-Disposition').replace(/^attachment/, 'inline'));
    res.set({
      'Content-Type': INLINE_SAFE.has(att.mimeType) ? att.mimeType : 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'Cache-Control': 'private, no-store',
    });
    res.sendFile(storage.filePath(req.uid, taskId, att.storedName), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'File is missing' });
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/attachments/:taskId/:attId
router.delete('/:taskId/:attId', async (req, res, next) => {
  try {
    const { taskId, attId } = req.params;
    const index = await storage.readIndex(req.uid, taskId);
    const att = index[attId];
    if (!att) return res.status(404).json({ message: 'Attachment not found' });
    delete index[attId];
    await storage.writeIndex(req.uid, taskId, index);
    await fs.promises.rm(storage.filePath(req.uid, taskId, att.storedName), { force: true });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /api/attachments/:taskId -> removes every file of a task (used when it's deleted for good)
router.delete('/:taskId', async (req, res, next) => {
  try {
    await storage.removeTask(req.uid, req.params.taskId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;

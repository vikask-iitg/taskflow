const express = require('express');
const mongoose = require('mongoose');
const Task = require('../models/Task');
const requireAuth = require('../middleware/auth');
const { removeTaskFiles } = require('../lib/attachmentStorage');

const { STATUSES, PRIORITIES } = Task;
const router = express.Router();

router.use(requireAuth);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only these fields may be set by the client; userId and timestamps are server-controlled
function pickTaskFields(body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title);
  if (body.description !== undefined) out.description = String(body.description);
  if (body.status !== undefined) out.status = body.status;
  if (body.priority !== undefined) out.priority = body.priority;
  if (body.category !== undefined) out.category = String(body.category);
  if (body.dueDate !== undefined) {
    if (body.dueDate === null || body.dueDate === '') out.dueDate = null;
    else {
      const d = new Date(body.dueDate);
      if (Number.isNaN(d.getTime())) throw Object.assign(new Error('Invalid due date'), { status: 400 });
      out.dueDate = d;
    }
  }
  return out;
}

// Finds one of the caller's tasks. By default only active (not trashed) tasks match.
function findOwnTask(req, { deleted = false } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return Task.findOne({ _id: req.params.id, userId: req.user._id, deletedAt: deleted ? { $ne: null } : null });
}

// GET /api/tasks?search=&status=&priority=&category=&sort=
router.get('/', async (req, res, next) => {
  try {
    const { search, status, priority, category, sort = 'newest' } = req.query;
    const match = { userId: req.user._id, deletedAt: status === 'deleted' ? { $ne: null } : null };

    if (status === 'active') match.status = { $ne: 'completed' };
    else if (status === 'overdue') {
      match.status = { $ne: 'completed' };
      match.dueDate = { $ne: null, $lt: new Date() };
    } else if (STATUSES.includes(status)) match.status = status;

    if (PRIORITIES.includes(priority)) match.priority = priority;
    if (category) match.category = String(category);

    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      match.$or = [{ title: rx }, { description: rx }];
    }

    const pipeline = [{ $match: match }];
    switch (sort) {
      case 'oldest':
        pipeline.push({ $sort: { createdAt: 1 } });
        break;
      case 'due':
        // Tasks without a due date go last
        pipeline.push(
          { $addFields: { _noDue: { $cond: [{ $eq: [{ $ifNull: ['$dueDate', null] }, null] }, 1, 0] } } },
          { $sort: { _noDue: 1, dueDate: 1, createdAt: -1 } },
          { $project: { _noDue: 0 } }
        );
        break;
      case 'priority':
        pipeline.push(
          {
            $addFields: {
              _prio: { $switch: { branches: [
                { case: { $eq: ['$priority', 'high'] }, then: 0 },
                { case: { $eq: ['$priority', 'medium'] }, then: 1 },
              ], default: 2 } },
            },
          },
          { $sort: { _prio: 1, createdAt: -1 } },
          { $project: { _prio: 0 } }
        );
        break;
      default:
        pipeline.push({ $sort: { createdAt: -1 } });
    }

    const tasks = await Task.aggregate(pipeline);
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    const categories = await Task.distinct('category', { userId: req.user._id, deletedAt: null, category: { $ne: '' } });
    res.json({
      categories: categories.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      defaultCategories: Task.DEFAULT_CATEGORIES,
    });
  } catch (err) {
    next(err);
  }
});

// Removes a category from all of the caller's tasks (including trashed ones). Tasks are kept.
router.delete('/categories/:name', async (req, res, next) => {
  try {
    const name = String(req.params.name).trim();
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    if (Task.DEFAULT_CATEGORIES.some((c) => c.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ message: 'Default categories can’t be deleted' });
    }
    const result = await Task.updateMany({ userId: req.user._id, category: name }, { $set: { category: '' } });
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const now = new Date();
    const active = (cond) => ({ $sum: { $cond: [{ $and: ['$_active', cond] }, 1, 0] } });
    const [row = {}] = await Task.aggregate([
      { $match: { userId: req.user._id } },
      // A missing deletedAt counts as "not deleted"
      { $addFields: { _active: { $eq: [{ $ifNull: ['$deletedAt', null] }, null] } } },
      {
        $group: {
          _id: null,
          total: active(true),
          pending: active({ $eq: ['$status', 'pending'] }),
          inProgress: active({ $eq: ['$status', 'in-progress'] }),
          completed: active({ $eq: ['$status', 'completed'] }),
          overdue: active({ $and: [
            { $ne: ['$status', 'completed'] },
            { $gt: [{ $ifNull: ['$dueDate', null] }, null] },
            { $lt: ['$dueDate', now] },
          ] }),
          deleted: { $sum: { $cond: ['$_active', 0, 1] } },
        },
      },
    ]);
    const { _id, ...counts } = row;
    res.json({
      stats: { total: 0, pending: 0, inProgress: 0, completed: 0, overdue: 0, deleted: 0, ...counts },
      trashRetentionDays: Task.TRASH_RETENTION_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

// Permanently delete everything in the caller's trash
router.delete('/trash', async (req, res, next) => {
  try {
    const filter = { userId: req.user._id, deletedAt: { $ne: null } };
    const ids = await Task.find(filter).distinct('_id');
    const result = await Task.deleteMany({ _id: { $in: ids } });
    await removeTaskFiles(ids);
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const fields = pickTaskFields(req.body);
    const task = await Task.create({ ...fields, userId: req.user._id });
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const task = await findOwnTask(req);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

async function updateTask(req, res, next) {
  try {
    const task = await findOwnTask(req);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    task.set(pickTaskFields(req.body));
    await task.save();
    res.json({ task });
  } catch (err) {
    next(err);
  }
}

router.put('/:id', updateTask);
router.patch('/:id', updateTask);

// Restore a task from the trash
router.post('/:id/restore', async (req, res, next) => {
  try {
    const task = await findOwnTask(req, { deleted: true });
    if (!task) return res.status(404).json({ message: 'Task not found in trash' });
    task.deletedAt = null;
    await task.save();
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

// DELETE moves a task to the trash; DELETE ?permanent=true removes it for good
router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Task not found' });
    const filter = { _id: req.params.id, userId: req.user._id };

    if (req.query.permanent === 'true') {
      const result = await Task.deleteOne(filter);
      if (!result.deletedCount) return res.status(404).json({ message: 'Task not found' });
      await removeTaskFiles(req.params.id);
      return res.status(204).end();
    }

    const result = await Task.updateOne({ ...filter, deletedAt: null }, { $set: { deletedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ message: 'Task not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;

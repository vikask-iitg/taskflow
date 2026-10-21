require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { sweepOrphans } = require('./lib/attachmentStorage');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();

app.use(express.json({ limit: '100kb' }));
if (process.env.NODE_ENV !== 'production') {
  require('./lib/liveReload')(app, path.join(__dirname, 'public'));
}

// no-store so browsers always pick up the latest HTML/CSS/JS after a change
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/tasks/:id/attachments', require('./routes/attachments'));
app.use('/api/tasks', require('./routes/tasks'));

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof mongoose.Error.ValidationError) {
    const message = Object.values(err.errors).map((e) => e.message).join(', ');
    return res.status(400).json({ message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Malformed JSON' });
  if (err.status) return res.status(err.status).json({ message: err.message });
  console.error(err);
  res.status(500).json({ message: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;

// Removes files left behind by tasks that were purged from the trash
function runSweep() {
  sweepOrphans().catch((err) => console.error('Attachment cleanup failed:', err.message));
}

connectDB()
  .then(() => {
    runSweep();
    setInterval(runSweep, 6 * 60 * 60 * 1000).unref();
    app.listen(PORT, () => console.log(`TaskFlow running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

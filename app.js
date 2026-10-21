require('dotenv').config();
const path = require('path');
const express = require('express');

// Sign-in and data live in Firebase (Auth + Firestore, used directly from the browser).
// This app serves the website locally and handles attachment files.
// On Vercel the static site is served by Vercel's CDN and only /api runs here (see api/index.js).
const app = express();

if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') {
  require('./lib/liveReload')(app, path.join(__dirname, 'public'));
}

// no-store so browsers always pick up the latest HTML/CSS/JS after a change
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

app.use('/api/attachments', require('./routes/attachments'));
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ message: err.message });
  console.error(err);
  res.status(500).json({ message: 'Something went wrong' });
});

module.exports = app;

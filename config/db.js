const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// The previous server's database may still be closing after a restart; retry briefly
async function startEmbedded(MongoMemoryServer, dbPath, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      return await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } });
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function connectDB() {
  let uri = process.env.MONGODB_URI;

  // "memory" runs a local embedded MongoDB for development. Data is stored in .data/db
  // so it survives server restarts.
  if (!uri || uri === 'memory') {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const dbPath = path.join(__dirname, '..', '.data', 'db');
    fs.mkdirSync(dbPath, { recursive: true });
    const mem = await startEmbedded(MongoMemoryServer, dbPath);
    uri = mem.getUri('taskflow');

    // Shut the database down cleanly (keeping its data) so a restart, e.g. from
    // `node --watch`, can reopen the same folder
    const shutdown = async () => {
      await mongoose.disconnect().catch(() => {});
      await mem.stop({ doCleanup: false, force: false }).catch(() => {});
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.log(`Using embedded MongoDB (data stored in ${path.relative(process.cwd(), dbPath)})`);
  }

  await mongoose.connect(uri);
  console.log('MongoDB connected');
}

module.exports = connectDB;

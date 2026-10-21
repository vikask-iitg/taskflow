const fs = require('fs');

// Development helper: tells open browser tabs to reload when anything in `dir` changes.
// Tabs also reload after the server restarts (their event stream reconnects).
function liveReload(app, dir) {
  const clients = new Set();

  app.get('/__livereload', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  let timer;
  fs.watch(dir, { recursive: true }, () => {
    // Editors often write several times per save; reload once
    clearTimeout(timer);
    timer = setTimeout(() => clients.forEach((res) => res.write('data: reload\n\n')), 150);
  });

  // Keep idle connections open through proxies
  setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 25000).unref();
}

module.exports = liveReload;

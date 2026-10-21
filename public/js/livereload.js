// Development only: reloads the page when front-end files change or the server restarts
(() => {
  if (!['localhost', '127.0.0.1'].includes(location.hostname) || !window.EventSource) return;
  let connectedBefore = false;
  const events = new EventSource('/__livereload');
  events.onopen = () => {
    if (connectedBefore) location.reload(); // reconnected after a server restart
    connectedBefore = true;
  };
  events.onmessage = (e) => {
    if (e.data === 'reload') location.reload();
  };
})();

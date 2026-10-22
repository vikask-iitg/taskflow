// Development only: reloads the page when front-end files change or the server restarts
(() => {
  // This computer, or a phone/laptop opening the dev server over the local network
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(location.hostname);
  if (!isLocal || !window.EventSource) return;
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

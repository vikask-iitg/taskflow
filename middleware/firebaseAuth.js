const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

// Verifying ID tokens only needs the project ID (Google's public signing keys are fetched
// automatically), so no service-account key is required on the server.
if (!getApps().length) initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'task-flow-app-97462' });

// Requires a valid Firebase ID token and sets req.uid
async function requireFirebaseUser(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ message: 'Authentication required' });
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

module.exports = requireFirebaseUser;

// Verifies Firebase ID tokens as described in the Firebase docs
// ("Verify ID tokens using a third-party JWT library"): RS256 signature from Google's
// public keys, audience = project ID, issuer = securetoken.google.com/<project ID>,
// a non-empty subject (the user's uid) and an auth_time in the past.
// Using `jose` directly keeps this light and works on Vercel's serverless runtime.
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'task-flow-app-97462';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let verifier;
async function getVerifier() {
  if (!verifier) {
    const { createRemoteJWKSet, jwtVerify } = await import('jose'); // jose is ESM-only
    const keys = createRemoteJWKSet(new URL(JWKS_URL)); // fetched once, then cached and refreshed by jose
    verifier = (token) => jwtVerify(token, keys, {
      algorithms: ['RS256'],
      audience: PROJECT_ID,
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    });
  }
  return verifier;
}

// Requires a valid Firebase ID token and sets req.uid
async function requireFirebaseUser(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ message: 'Authentication required' });
  try {
    const { payload } = await (await getVerifier())(token);
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('bad subject');
    if (typeof payload.auth_time !== 'number' || payload.auth_time > now + 60) throw new Error('bad auth_time');
    req.uid = payload.sub;
    next();
  } catch {
    res.status(401).json({ message: 'Your session has expired. Please log in again.' });
  }
}

module.exports = requireFirebaseUser;

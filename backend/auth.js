'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const JWT_SECRET     = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!JWT_SECRET)      throw new Error('Missing env: JWT_SECRET');
if (!GOOGLE_CLIENT_ID) throw new Error('Missing env: GOOGLE_CLIENT_ID');

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Token helpers ─────────────────────────────────────────────────────────────

function signToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.username;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

async function verifyGoogleToken(credential) {
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload(); // { sub, email, name, picture, ... }
}

module.exports = { signToken, verifyToken, verifyGoogleToken, GOOGLE_CLIENT_ID };

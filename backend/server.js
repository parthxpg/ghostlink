'use strict';
require('dotenv').config();

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const path   = require('path');

const db = require('./database');
const { signToken, verifyToken, verifyGoogleToken } = require('./auth');

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow base64 pfp uploads
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 20 * 1024 * 1024, // 20 MB – allows encrypted image attachments
});

// username → socket.id
const activeConnections = new Map();

// ── Shared helper ─────────────────────────────────────────────────────────────

/** Emit `event` with `payload` to every member that is currently online. */
function broadcastToMembers(members, event, payload) {
  members.forEach(memberId => {
    const sid = activeConnections.get(memberId);
    if (sid) io.to(sid).emit(event, payload);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// Check username availability
app.get('/api/auth/check-username', async (req, res) => {
  const { name } = req.query;
  if (!name || name.length < 3 || name.length > 20 || !/^[a-z0-9_]+$/.test(name)) {
    return res.json({ available: false, reason: 'Username must be 3–20 chars, lowercase letters, numbers, underscores only' });
  }
  if (await db.isUsernameSimilar(name)) {
    return res.json({ available: false, reason: 'This username or a very similar one is taken' });
  }
  return res.json({ available: true });
});

// Email sign-up (creates pending account, username chosen next step)
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and password (min 6 chars) required' });
  }
  try {
    const { pendingId } = await db.registerEmailUser(email, password);
    return res.json({ token: signToken(pendingId), pendingId, needsUsername: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Email login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const user = await db.loginEmailUser(email, password);
    if (user.pending) {
      return res.json({ token: signToken(user.pendingId), pendingId: user.pendingId, needsUsername: true });
    }
    return res.json({ token: signToken(user.username), username: user.username, needsUsername: false });
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
});

// Google sign-in / sign-up
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Google credential required' });
  try {
    const { sub: googleId, email, name } = await verifyGoogleToken(credential);
    const { user } = await db.registerOrLoginGoogle(googleId, email, name);
    if (user.pending || !user.username) {
      return res.json({ token: signToken(user.pendingId), pendingId: user.pendingId, needsUsername: true });
    }
    return res.json({ token: signToken(user.username), username: user.username, needsUsername: false });
  } catch (err) {
    console.error('Google auth error:', err.message);
    return res.status(401).json({ error: 'Google sign-in failed: ' + err.message });
  }
});

// Claim username (for pending accounts)
app.post('/api/auth/set-username', verifyToken, async (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 3 || username.length > 20 || !/^[a-z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
  try {
    await db.setUsername(req.userId, username); // req.userId is the pendingId here
    return res.json({ token: signToken(username), username });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Register / refresh E2EE public keys (called after every login)
app.post('/api/auth/register-keys', verifyToken, async (req, res) => {
  const { keys } = req.body;
  if (!keys || !keys.identityKey || !keys.signedPreKey) {
    return res.status(400).json({ error: 'Invalid key bundle' });
  }
  try {
    await db.registerKeys(req.userId, keys);
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  PROFILE ROUTES
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/profile/me', verifyToken, async (req, res) => {
  const profile = await db.getProfile(req.userId);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  return res.json(profile);
});

app.patch('/api/profile/me', verifyToken, async (req, res) => {
  try {
    return res.json(await db.updateProfile(req.userId, req.body));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.patch('/api/profile/me/privacy', verifyToken, async (req, res) => {
  try {
    return res.json(await db.updatePrivacy(req.userId, req.body));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/profile/:username', async (req, res) => {
  const p = await db.getPublicProfile(req.params.username);
  if (!p) return res.status(404).json({ error: 'User not found' });
  return res.json(p);
});

app.post('/api/profile/change-username', verifyToken, async (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || newUsername.length < 3 || newUsername.length > 20 || !/^[a-z0-9_]+$/.test(newUsername)) {
    return res.status(400).json({ error: 'Username must be 3–20 chars, lowercase letters, numbers, underscores only' });
  }
  try {
    await db.changeUsername(req.userId, newUsername);
    return res.json({ token: signToken(newUsername), username: newUsername });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/profile/delete-account', verifyToken, async (req, res) => {
  try {
    await db.deleteAccount(req.userId);
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/profile/feedback', verifyToken, async (req, res) => {
  const { feedback } = req.body;
  if (!feedback) return res.status(400).json({ error: 'Feedback message is required' });
  console.log(`[FEEDBACK] from ${req.userId}: ${feedback}`);
  return res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════════
//  USER / KEY ROUTES
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/keys/:randomId', async (req, res) => {
  const bundle = await db.getKeyBundle(req.params.randomId);
  if (!bundle) return res.status(404).json({ error: 'User not found' });
  return res.json(bundle);
});

app.get('/api/users/search', async (req, res) => {
  return res.json(await db.searchUsers(req.query.q || ''));
});

app.get('/api/users/:randomId/chats', async (req, res) => {
  return res.json(await db.getUserChats(req.params.randomId));
});

// ════════════════════════════════════════════════════════════════════════════════
//  CHAT ROUTES
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/chats/create', async (req, res) => {
  const { members, type, name, bio, createdBy } = req.body;
  if (!members || !Array.isArray(members) || members.length < 2) {
    return res.status(400).json({ error: 'Invalid participants' });
  }
  try {
    const chat = await db.createChat(members, type, name, bio, createdBy);
    broadcastToMembers(members, 'chat_created', chat);
    return res.json(chat);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/chats/:chatId', async (req, res) => {
  const chat = await db.getChat(req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  return res.json(chat);
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  return res.json(await db.getChatMessages(req.params.chatId));
});

app.post('/api/chats/:chatId/admin', async (req, res) => {
  const { requesterId, targetId } = req.body;
  try {
    const chat = await db.makeAdmin(req.params.chatId, requesterId, targetId);
    broadcastToMembers(chat.members, 'group_updated', chat);
    return res.json(chat);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/add-member', async (req, res) => {
  const { requesterId, targetId } = req.body;
  try {
    const chat = await db.addMember(req.params.chatId, requesterId, targetId);
    broadcastToMembers(chat.members, 'group_updated', chat);
    return res.json(chat);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/join', async (req, res) => {
  const { targetId, token } = req.body;
  try {
    const chat = await db.joinViaInvite(req.params.chatId, targetId, token);
    broadcastToMembers(chat.members, 'group_updated', chat);
    return res.json(chat);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/reset-invite', async (req, res) => {
  const { requesterId } = req.body;
  try {
    return res.json(await db.resetInviteToken(req.params.chatId, requesterId));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/update', async (req, res) => {
  const { requesterId, name, bio, pfpBase64 } = req.body;
  try {
    const chat = await db.updateChatInfo(req.params.chatId, requesterId, { name, bio, pfpBase64 });
    broadcastToMembers(chat.members, 'group_updated', chat);
    return res.json(chat);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/kick', async (req, res) => {
  const { requesterId, targetId } = req.body;
  try {
    const chat = await db.kickMember(req.params.chatId, requesterId, targetId);
    // Notify kicked member too, so they see the removal in real-time
    broadcastToMembers([...chat.members, targetId], 'group_updated', { ...chat, kickedId: targetId });
    return res.json(chat);
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/delete', async (req, res) => {
  const { requesterId } = req.body;
  try {
    const { members, chatId } = await db.deleteGroup(req.params.chatId, requesterId);
    broadcastToMembers(members, 'group_deleted', { chatId });
    return res.json({ success: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

app.post('/api/chats/:chatId/leave', async (req, res) => {
  const { requesterId } = req.body;
  try {
    const result = await db.leaveGroup(req.params.chatId, requesterId);
    if (result.action === 'deleted') {
      // Group was empty and deleted
      return res.json({ success: true, deleted: true });
    } else {
      // Broadcast update to remaining members and the member who left (so they know they left)
      broadcastToMembers([...result.chat.members, requesterId], 'group_updated', { ...result.chat, kickedId: requesterId });
      return res.json({ success: true, chat: result.chat });
    }
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  let userSessionId = null;

  socket.on('register_session', async (randomId) => {
    if (!randomId || !await db.getUser(randomId)) {
      socket.emit('session_error', 'Invalid session');
      return;
    }
    userSessionId = randomId;
    activeConnections.set(randomId, socket.id);
    io.emit('peer_online', randomId);
    socket.emit('session_ready', { randomId, activePeers: Array.from(activeConnections.keys()) });
  });

  socket.on('send_encrypted_msg', async ({ chatId, encryptedPayload, recipientKeys }) => {
    if (!userSessionId || !chatId || !encryptedPayload || !recipientKeys) return;
    const chat = await db.getChat(chatId);
    if (!chat || !chat.members.includes(userSessionId)) return;
    try {
      const msg = await db.storeMessage({ chatId, senderId: userSessionId, encryptedPayload, recipientKeys });
      broadcastToMembers(chat.members, 'new_encrypted_msg', msg);
    } catch (err) {
      console.error('STORE_MSG_ERR:', err);
      socket.emit('session_error', 'Message send failed: ' + err.message);
    }
  });

  socket.on('screenshot_detected', async ({ chatId }) => {
    if (!userSessionId || !chatId) return;
    const chat = await db.getChat(chatId);
    if (!chat) return;
    broadcastToMembers(chat.members, 'screenshot_alert', { chatId, timestamp: Date.now(), detectorId: userSessionId });
  });

  socket.on('request_forward', async ({ messageId, receiverId, ownerId }) => {
    if (!userSessionId || !messageId || !receiverId || !ownerId) return;
    const fwdReq = await db.createForwardRequest(userSessionId, ownerId, messageId, receiverId);
    const ownerSid = activeConnections.get(ownerId);
    if (ownerSid) {
      io.to(ownerSid).emit('forward_approval_needed', {
        requestId: fwdReq.id, requesterId: userSessionId, messageId, receiverId,
      });
    }
  });

  socket.on('forward_decision', async ({ requestId, decision, wrappedKeyForForwarder }) => {
    if (!userSessionId) return;
    const updated = await db.updateForwardRequestStatus(requestId, decision);
    if (!updated) return;
    const requesterSid = activeConnections.get(updated.senderId);
    if (requesterSid) {
      io.to(requesterSid).emit('forward_decision_received', {
        requestId, messageId: updated.messageId, receiverId: updated.receiverId,
        decision, wrappedKeyForForwarder,
      });
    }
  });

  socket.on('pin_message', async ({ chatId, msgId, text, expiresAt }) => {
    if (!userSessionId || !chatId || !msgId) return;
    try {
      const pinData = { msgId, text, expiresAt };
      const chat = await db.pinMessage(chatId, userSessionId, pinData);
      broadcastToMembers(chat.members, 'message_pinned', { chatId, pinData });
    } catch (err) {
      console.error('PIN_ERR:', err);
    }
  });

  socket.on('unpin_message', async ({ chatId }) => {
    if (!userSessionId || !chatId) return;
    try {
      const chat = await db.unpinMessage(chatId, userSessionId);
      broadcastToMembers(chat.members, 'message_unpinned', { chatId });
    } catch (err) {
      console.error('UNPIN_ERR:', err);
    }
  });

  socket.on('disconnect', () => {
    if (userSessionId) {
      activeConnections.delete(userSessionId);
      io.emit('peer_offline', userSessionId);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
//  SERVER START
// ════════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
db.connect()
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Ghost Link server running on port ${PORT}`)))
  .catch(err => { console.error('❌ DB connection failed:', err.message); process.exit(1); });

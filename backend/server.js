const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));


const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Cache for active socket connections: RandomID -> SocketID
const activeConnections = new Map();

// --- REST Endpoints (Basic Setup) ---

// Register User Keys
app.post('/api/auth/register', (req, res) => {
  const { randomId, keys } = req.body;
  if (!randomId || !keys || !keys.identityKey || !keys.signedPreKey) {
    return res.status(400).json({ error: "Invalid registration payload. Public key bundles required." });
  }

  try {
    const result = db.registerUser(randomId, keys);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Fetch target prekey bundle for key agreement initialization
app.get('/api/keys/:randomId', (req, res) => {
  const { randomId } = req.params;
  const bundle = db.getKeyBundle(randomId);
  if (!bundle) {
    return res.status(404).json({ error: "Ghost ID not found" });
  }
  return res.json(bundle);
});

// Search active Ghost IDs
app.get('/api/users/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  return res.json(db.searchUsers(q));
});

// Fetch active chats for a user
app.get('/api/users/:randomId/chats', (req, res) => {
  const { randomId } = req.params;
  return res.json(db.getUserChats(randomId));
});

// Fetch message log for a chat (Encrypted base64 bubbles)
app.get('/api/chats/:chatId/messages', (req, res) => {
  const { chatId } = req.params;
  return res.json(db.getChatMessages(chatId));
});

// Create secure direct or group chat
app.post('/api/chats/create', (req, res) => {
  const { members, type, name } = req.body;
  if (!members || !Array.isArray(members) || members.length < 2) {
    return res.status(400).json({ error: "Invalid chat participants list" });
  }
  const chat = db.createChat(members, type, name);
  
  // Notify active users of the new chat
  members.forEach(memberId => {
    const socketId = activeConnections.get(memberId);
    if (socketId) {
      io.to(socketId).emit('chat_created', chat);
    }
  });

  return res.json(chat);
});

// --- Socket.io Real-Time Protocol ---
io.on('connection', (socket) => {
  let userSessionId = null;

  // 1. Establish session identity
  socket.on('register_session', (randomId) => {
    if (!randomId || !db.getUser(randomId)) {
      socket.emit('session_error', 'Invalid Ghost ID session');
      return;
    }
    userSessionId = randomId;
    activeConnections.set(randomId, socket.id);
    
    // Broadcast status to active users
    io.emit('peer_online', randomId);
    socket.emit('session_ready', { randomId, activePeers: Array.from(activeConnections.keys()) });
  });

  // 2. Messaging Relay with E2EE fields
  socket.on('send_encrypted_msg', (data) => {
    const { chatId, encryptedPayload, recipientKeys } = data;
    if (!userSessionId || !chatId || !encryptedPayload || !recipientKeys) return;

    const chat = db.getChat(chatId);
    if (!chat || !chat.members.includes(userSessionId)) return;

    // Store encrypted message in blind storage
    const msg = db.storeMessage({
      chatId,
      senderId: userSessionId,
      encryptedPayload,
      recipientKeys
    });

    // Relay to other chat members in real-time
    chat.members.forEach(memberId => {
      const socketId = activeConnections.get(memberId);
      if (socketId) {
        io.to(socketId).emit('new_encrypted_msg', msg);
      }
    });
  });

  // 3. Screenshot Alert Signal
  socket.on('screenshot_detected', (data) => {
    const { chatId } = data;
    if (!userSessionId || !chatId) return;

    const chat = db.getChat(chatId);
    if (!chat) return;

    // Send real-time warning to all participants in room
    chat.members.forEach(memberId => {
      const socketId = activeConnections.get(memberId);
      if (socketId) {
        io.to(socketId).emit('screenshot_alert', {
          chatId,
          timestamp: Date.now(),
          detectorId: userSessionId
        });
      }
    });
  });

  // 4. Forwarding Handshake Request
  // Sender (User A) -> Receiver (User B - Owner of message)
  socket.on('request_forward', (data) => {
    const { messageId, receiverId, ownerId } = data;
    if (!userSessionId || !messageId || !receiverId || !ownerId) return;

    // Log forward request
    const fwdReq = db.createForwardRequest(userSessionId, ownerId, messageId, receiverId);

    // Relay request to original message owner (Bob)
    const ownerSocket = activeConnections.get(ownerId);
    if (ownerSocket) {
      io.to(ownerSocket).emit('forward_approval_needed', {
        requestId: fwdReq.id,
        requesterId: userSessionId, // Alice
        messageId,
        receiverId // Charlie
      });
    }
  });

  // 5. Forwarding Handshake Decision
  // Owner (User B) -> Sender (User A)
  socket.on('forward_decision', (data) => {
    const { requestId, decision, wrappedKeyForForwarder } = data;
    if (!userSessionId) return;

    // Update status in blind database
    const updatedReq = db.updateForwardRequestStatus(requestId, decision);
    if (!updatedReq) return;

    // Relay decision back to requester (Alice)
    const requesterSocket = activeConnections.get(updatedReq.senderId);
    if (requesterSocket) {
      io.to(requesterSocket).emit('forward_decision_received', {
        requestId,
        messageId: updatedReq.messageId,
        receiverId: updatedReq.receiverId,
        decision, // 'approved' or 'denied'
        wrappedKeyForForwarder // Contains Bob's cryptographic authorization signature + wrapped key
      });
    }
  });

  // 6. Handle Disconnection
  socket.on('disconnect', () => {
    if (userSessionId) {
      activeConnections.delete(userSessionId);
      io.emit('peer_offline', userSessionId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ghost Link Secure Server running on port ${PORT}`);
});

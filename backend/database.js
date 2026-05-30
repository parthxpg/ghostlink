/**
 * Ghost Link - Secure Blind Storage Engine
 * 
 * Under the E2EE model, the server acts as a blind custodian:
 * 1. It only stores public key bundles (PreKeys, Identity Keys) of users.
 * 2. It relays and stores encrypted base64 message blobs and media references.
 * 3. It never receives or stores any private keys.
 * 
 * For simplicity of direct local testing and maximum portability, this implementation
 * uses an optimized, isolated in-memory blind store with an exportable database schema.
 */

class BlindStorage {
  constructor() {
    this.users = new Map(); // RandomID -> { passwordHash, keys: { identityKey, signedPreKey, preKeys } }
    this.chats = new Map(); // ChatID -> { name, type: 'direct' | 'group', members: Set[RandomID] }
    this.messages = [];     // Array of { id, chatId, senderId, timestamp, encryptedPayload, recipientKeys }
    this.forwardRequests = new Map(); // ReqID -> { senderId, targetId, messageId, receiverId, status: 'pending'|'approved'|'denied' }
  }

  // --- User Operations ---
  registerUser(randomId, keys) {
    if (this.users.has(randomId)) {
      throw new Error("Ghost ID already exists!");
    }
    this.users.set(randomId, {
      randomId,
      keys: {
        identityKey: keys.identityKey,
        signedPreKey: keys.signedPreKey,
        preKeys: keys.preKeys || []
      },
      createdAt: Date.now()
    });
    return { randomId, success: true };
  }

  getUser(randomId) {
    const user = this.users.get(randomId);
    if (!user) return null;
    return {
      randomId: user.randomId,
      keys: user.keys
    };
  }

  searchUsers(query) {
    const results = [];
    const searchStr = query.toLowerCase();
    for (const [id, user] of this.users.entries()) {
      if (id.toLowerCase().includes(searchStr)) {
        results.push({
          randomId: user.randomId,
          keys: user.keys
        });
      }
    }
    return results;
  }

  // --- Key Bundle Operations ---
  updatePreKeys(randomId, preKeys) {
    const user = this.users.get(randomId);
    if (!user) throw new Error("User not found");
    user.keys.preKeys = preKeys;
    return true;
  }

  // Retrieve key bundle to initiate encryption session
  getKeyBundle(randomId) {
    const user = this.users.get(randomId);
    if (!user) return null;
    
    // Pop a one-time pre-key if available (Signal Protocol style)
    const preKey = user.keys.preKeys.pop() || null;
    
    return {
      randomId: user.randomId,
      identityKey: user.keys.identityKey,
      signedPreKey: user.keys.signedPreKey,
      oneTimePreKey: preKey
    };
  }

  // --- Chat & Room Operations ---
  createChat(members, type = 'direct', name = '', bio = '', createdBy = '') {
    const chatId = 'chat_' + Math.random().toString(36).substring(2, 15);
    const creator = createdBy || members[0] || '';
    const chat = {
      id: chatId,
      name: name || (type === 'direct' ? 'Direct Message' : 'Secure Group'),
      bio: bio || '',
      type,
      members: new Set(members),
      createdBy: creator,
      admins: new Set([creator]),
      createdAt: Date.now()
    };
    this.chats.set(chatId, chat);
    return this._serialize(chat);
  }

  _serialize(chat) {
    return {
      ...chat,
      members: Array.from(chat.members),
      admins:  Array.from(chat.admins)
    };
  }

  getChat(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    return this._serialize(chat);
  }

  getUserChats(randomId) {
    const userChats = [];
    for (const chat of this.chats.values()) {
      if (chat.members.has(randomId)) {
        userChats.push(this._serialize(chat));
      }
    }
    return userChats;
  }

  makeAdmin(chatId, requesterId, targetId) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    if (!chat.admins.has(requesterId)) throw new Error('Only admins can promote members');
    if (!chat.members.has(targetId)) throw new Error('User is not in this group');
    chat.admins.add(targetId);
    return this._serialize(chat);
  }

  kickMember(chatId, requesterId, targetId) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    if (!chat.admins.has(requesterId)) throw new Error('Only admins can remove members');
    if (targetId === chat.createdBy) throw new Error('Cannot remove the group creator');
    chat.members.delete(targetId);
    chat.admins.delete(targetId);
    return this._serialize(chat);
  }

  addMember(chatId, requesterId, newMemberId) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');
    
    // Security check: Must be a current member of the group to add someone else
    if (!chat.members.has(requesterId)) {
      throw new Error('Only current members can add new users');
    }

    if (chat.members.has(newMemberId)) {
      throw new Error('User is already in this group');
    }

    chat.members.add(newMemberId);

    return this._serialize(chat);
  }

  // --- Encrypted Message Operations ---
  storeMessage({ chatId, senderId, encryptedPayload, recipientKeys }) {
    const message = {
      id: 'msg_' + Math.random().toString(36).substring(2, 15),
      chatId,
      senderId,
      timestamp: Date.now(),
      encryptedPayload, // Encrypted chat bubble text / content
      recipientKeys     // Map of recipientID -> encrypted symmetric key
    };
    this.messages.push(message);
    return message;
  }

  getChatMessages(chatId) {
    return this.messages.filter(m => m.chatId === chatId);
  }

  // --- Forward Request Handlers ---
  createForwardRequest(senderId, targetId, messageId, receiverId) {
    const requestId = 'fwd_' + Math.random().toString(36).substring(2, 15);
    const request = {
      id: requestId,
      senderId,     // Alice (who wants to forward)
      targetId,     // Bob (whose message is being forwarded)
      messageId,   // Original message ID
      receiverId,   // Charlie (the final recipient of forward)
      status: 'pending',
      timestamp: Date.now()
    };
    this.forwardRequests.set(requestId, request);
    return request;
  }

  updateForwardRequestStatus(requestId, status) {
    const request = this.forwardRequests.get(requestId);
    if (!request) return null;
    request.status = status; // 'approved' or 'denied'
    return request;
  }
}

module.exports = new BlindStorage();

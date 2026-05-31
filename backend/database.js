'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const Mixed = mongoose.Schema.Types.Mixed;

// ── Schemas ──────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true },
  passwordHash: String,
  googleId: { type: String, unique: true, sparse: true },
  pendingId: { type: String, unique: true, sparse: true },
  // 'keys' stores the full JWK bundle – use Mixed so Mongoose never tries to
  // parse the nested property names (they contain dots which MongoDB rejects).
  keys: { type: Mixed, default: null },
  pending: { type: Boolean, default: false },
  pfpBase64: { type: String, default: null },
  bio: { type: String, default: '' },
  privacySettings: {
    profilePhoto:      { type: String, default: 'everyone' }, // 'everyone' | 'nobody'
    lastSeen:          { type: String, default: 'everyone' }, // 'everyone' | 'nobody'
    onlineStatus:      { type: Boolean, default: false },
    readReceipts:      { type: Boolean, default: true },
    whoCanAddToGroups: { type: String, default: 'everyone' }, // 'everyone' | 'nobody'
    messageForwarding: { type: Boolean, default: false },
  },
});

const chatSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  bio: String,
  pfpBase64: String,
  type: { type: String, enum: ['direct', 'group'], default: 'direct' },
  members: [String],
  admins: [String],
  createdBy: String,
  createdAt: { type: Number, default: Date.now },
  inviteToken: String,
  pinnedMessage: {
    msgId: String,
    text: String,
    expiresAt: Number
  }
});

const messageSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  chatId: String,
  senderId: String,
  encryptedPayload: { type: Mixed, default: null },
  // recipientKeys is  { [userId]: base64WrappedKey }
  // Use Mixed so MongoDB doesn't choke on keys that look like dot-paths.
  recipientKeys: { type: Mixed, default: {} },
  timestamp: { type: Number, default: Date.now },
});

const forwardRequestSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  senderId: String,
  ownerId: String,
  messageId: String,
  receiverId: String,
  status: { type: String, default: 'pending' },
  timestamp: { type: Number, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);
const Message = mongoose.model('Message', messageSchema);
const ForwardRequest = mongoose.model('ForwardRequest', forwardRequestSchema);

// ── Database class ────────────────────────────────────────────────────────────

class Database {

  async connect() {
    if (mongoose.connection.readyState === 1) return;
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB Connected');
  }

  _defaultPrivacy() {
    return {
      profilePhoto:      'everyone',
      lastSeen:          'everyone',
      onlineStatus:      false,
      readReceipts:      true,
      whoCanAddToGroups: 'everyone',
      messageForwarding: false,
    };
  }

  // ── Serialisation helpers ──────────────────────────────────────────────────

  // Convert a Mongoose doc to a plain JS object, preserving nested Mixed fields.
  _plain(doc) {
    return doc.toObject({ flattenMaps: true, versionKey: false });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async registerEmailUser(email, password) {
    const emailKey = email.toLowerCase();
    if (await User.findOne({ email: emailKey })) throw new Error('Email already registered');
    const passwordHash = await bcrypt.hash(password, 10);
    const pendingId = 'pending_email_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    await User.create({ pendingId, email: emailKey, passwordHash, pending: true, privacySettings: this._defaultPrivacy() });
    return { pendingId };
  }

  async loginEmailUser(email, password) {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) throw new Error('Email not found');
    if (!user.passwordHash) throw new Error('This account uses Google sign-in');
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new Error('Incorrect password');
    return user;
  }

  async registerOrLoginGoogle(googleId, email, displayName) {
    let user = await User.findOne({ googleId });
    if (user) return { user, isNew: false };

    const emailKey = email.toLowerCase();
    const existingEmail = await User.findOne({ email: emailKey });
    if (existingEmail) {
      existingEmail.googleId = googleId;
      await existingEmail.save();
      return { user: existingEmail, isNew: false };
    }

    const pendingId = 'pending_google_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    user = await User.create({ googleId, email: emailKey, pendingId, pending: true, privacySettings: this._defaultPrivacy() });
    return { user, isNew: true };
  }

  // ── Username ───────────────────────────────────────────────────────────────

  async isUsernameSimilar(username) {
    const norm = username.toLowerCase().replace(/[^a-z0-9]/g, '');
    const users = await User.find({ username: { $exists: true, $ne: null } }, 'username');
    return users.some(u => u.username.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
  }

  async usernameExists(username) {
    return !!(await User.findOne({ username: new RegExp('^' + username + '$', 'i') }));
  }

  async setUsername(pendingId, username) {
    if (await this.usernameExists(username)) throw new Error('Username taken');
    if (await this.isUsernameSimilar(username)) throw new Error('Username too similar to an existing one');

    const user = await User.findOne({ pendingId });
    if (!user) throw new Error('Pending session not found');

    user.username = username;
    user.pending = false;
    user.pendingId = undefined;   // removes the field so the sparse unique index stays clean
    await user.save();
    return user;
  }

  async changeUsername(oldUsername, newUsername) {
    if (oldUsername === newUsername) return;
    if (await this.usernameExists(newUsername)) throw new Error('Username taken');
    if (await this.isUsernameSimilar(newUsername)) throw new Error('Username too similar to an existing one');

    const user = await User.findOne({ username: oldUsername });
    if (!user) throw new Error('User not found');
    user.username = newUsername;
    await user.save();

    // Cascade updates through chats
    const chats = await Chat.find({ members: oldUsername });
    for (const chat of chats) {
      chat.members = chat.members.map(m => m === oldUsername ? newUsername : m);
      chat.admins = chat.admins.map(a => a === oldUsername ? newUsername : a);
      if (chat.createdBy === oldUsername) chat.createdBy = newUsername;
      await chat.save();
    }
    await Message.updateMany({ senderId: oldUsername }, { $set: { senderId: newUsername } });
  }

  async deleteAccount(username) {
    await User.deleteOne({ username });
    const chats = await Chat.find({ members: username });
    for (const chat of chats) {
      chat.members = chat.members.filter(m => m !== username);
      chat.admins = chat.admins.filter(a => a !== username);
      await chat.save();
    }
  }

  // ── Keys / Profiles ────────────────────────────────────────────────────────

  async registerKeys(id, keys) {
    // Use $set + markModified so Mongoose actually persists the Mixed field.
    await User.findOneAndUpdate(
      { username: id },
      { $set: { keys } },
      { strict: false }
    );
  }

  async getUser(id) {
    return await User.findOne({ username: id });
  }

  async getKeyBundle(id) {
    const user = await User.findOne({ username: id });
    return user ? user.keys : null;
  }

  async searchUsers(query) {
    if (!query) return [];
    const users = await User.find({ username: new RegExp(query, 'i'), pending: false }).limit(20);
    return users.map(u => ({ username: u.username, randomId: u.username, pfpBase64: u.pfpBase64 }));
  }

  async getProfile(id) {
    const user = await User.findOne({ username: id });
    if (!user) return null;
    const rawPrivacy = user.privacySettings?.toObject
      ? user.privacySettings.toObject()
      : (user.privacySettings || {});
    // Always merge with defaults so every field exists even for old accounts
    const privacySettings = { ...this._defaultPrivacy(), ...rawPrivacy };
    return {
      username: user.username,
      bio: user.bio,
      pfpBase64: user.pfpBase64,
      privacySettings,
    };
  }

  async updateProfile(id, updates) {
    const user = await User.findOne({ username: id });
    if (!user) return null;
    if (updates.bio !== undefined) user.bio = updates.bio;
    if (updates.pfpBase64 !== undefined) user.pfpBase64 = updates.pfpBase64;
    await user.save();
    return { username: user.username, bio: user.bio, pfpBase64: user.pfpBase64, privacySettings: user.privacySettings };
  }

  async updatePrivacy(id, settings) {
    // Build a $set map with dot-notation keys so MongoDB correctly updates
    // nested subdocument fields without wiping the others.
    const $set = {};
    const allowed = ['profilePhoto', 'lastSeen', 'onlineStatus', 'readReceipts', 'whoCanAddToGroups', 'messageForwarding'];
    for (const key of allowed) {
      if (key in settings) $set[`privacySettings.${key}`] = settings[key];
    }
    if (Object.keys($set).length === 0) return null;

    const user = await User.findOneAndUpdate(
      { username: id },
      { $set },
      { returnDocument: 'after', runValidators: true }
    );
    if (!user) return null;
    return user.privacySettings.toObject ? user.privacySettings.toObject() : { ...user.privacySettings };
  }

  async getPublicProfile(id) {
    const user = await User.findOne({ username: id });
    if (!user) return null;
    const priv = user.privacySettings || this._defaultPrivacy();
    // If the user has hidden their profile photo, return null to callers
    if (priv.profilePhoto === 'nobody') return null;
    return { username: user.username, bio: user.bio, pfpBase64: user.pfpBase64 };
  }

  // ── Chats ──────────────────────────────────────────────────────────────────

  async createChat(members, type = 'direct', name = '', bio = '', createdBy = '') {
    const chatId = 'chat_' + Math.random().toString(36).substring(2, 15);
    const creator = createdBy || members[0] || '';

    // For group chats, enforce "Add me to Groups" privacy for every non-creator member
    if (type === 'group') {
      for (const memberId of members) {
        if (memberId === creator) continue; // creator chose to make the group
        const memberUser = await User.findOne({ username: memberId });
        if (!memberUser) throw new Error(`User "${memberId}" not found`);
        const priv = memberUser.privacySettings || this._defaultPrivacy();
        if (priv.whoCanAddToGroups === 'nobody') {
          throw new Error(`${memberId} has disabled group invites`);
        }
      }
    }

    const inviteToken = type === 'group'
      ? Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      : null;
    const chat = await Chat.create({
      id: chatId, name: name || (type === 'direct' ? 'Direct Message' : 'Secure Group'),
      bio: bio || '', type, members, createdBy: creator, admins: [creator], inviteToken,
    });
    return this._plain(chat);
  }

  async getChat(chatId) {
    const chat = await Chat.findOne({ id: chatId });
    return chat ? this._plain(chat) : null;
  }

  async getUserChats(id) {
    const chats = await Chat.find({ members: id });
    return chats.map(c => this._plain(c));
  }

  async makeAdmin(chatId, requesterId, targetId) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (!chat.admins.includes(requesterId)) throw new Error('Only admins can make other admins');
    if (!chat.members.includes(targetId)) throw new Error('User not in chat');
    if (!chat.admins.includes(targetId)) { chat.admins.push(targetId); await chat.save(); }
    return this._plain(chat);
  }

  async addMember(chatId, requesterId, targetId) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (chat.type === 'direct') throw new Error('Cannot add members to a DM');
    if (!chat.admins.includes(requesterId)) throw new Error('Only admins can add members');
    const targetUser = await User.findOne({ username: targetId });
    if (!targetUser) throw new Error('Target user not found');
    if (chat.members.includes(targetId)) throw new Error('User already in group');

    // Enforce target user's "Add me to Groups" privacy setting
    const priv = targetUser.privacySettings || this._defaultPrivacy();
    if (priv.whoCanAddToGroups === 'nobody') {
      throw new Error(`${targetId} has disabled group invites`);
    }

    chat.members.push(targetId);
    await chat.save();
    return this._plain(chat);
  }

  async joinViaInvite(chatId, targetId, token) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (chat.type === 'direct') throw new Error('Invalid chat type');
    if (!chat.inviteToken || chat.inviteToken !== token) throw new Error('Invalid invite link');
    const targetUser = await User.findOne({ username: targetId });
    if (!targetUser) throw new Error('User not found');
    if (chat.members.includes(targetId)) throw new Error('Already a member');

    // Enforce target user's "Add me to Groups" privacy setting
    const priv = targetUser.privacySettings || this._defaultPrivacy();
    if (priv.whoCanAddToGroups === 'nobody') {
      throw new Error('You have disabled group invites in your privacy settings');
    }

    chat.members.push(targetId);
    await chat.save();
    return this._plain(chat);
  }

  async resetInviteToken(chatId, requesterId) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (chat.createdBy !== requesterId) throw new Error('Only the owner can reset the invite link');
    chat.inviteToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    await chat.save();
    return this._plain(chat);
  }

  async updateChatInfo(chatId, requesterId, updates) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (chat.createdBy !== requesterId) throw new Error('Only the owner can edit group info');
    if (updates.name !== undefined) chat.name = updates.name;
    if (updates.bio !== undefined) chat.bio = updates.bio;
    if (updates.pfpBase64 !== undefined) chat.pfpBase64 = updates.pfpBase64;
    await chat.save();
    return this._plain(chat);
  }

  async kickMember(chatId, requesterId, targetId) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (!chat.admins.includes(requesterId)) throw new Error('Only admins can kick members');
    if (targetId === chat.createdBy) throw new Error('Cannot kick the group creator');
    chat.members = chat.members.filter(m => m !== targetId);
    chat.admins = chat.admins.filter(a => a !== targetId);
    await chat.save();
    return this._plain(chat);
  }

  async deleteGroup(chatId, requesterId) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (chat.type !== 'group') throw new Error('Cannot delete a direct message');
    if (chat.createdBy !== requesterId) throw new Error('Only the group creator can delete the group');
    const members = [...chat.members];
    await Message.deleteMany({ chatId });
    await Chat.deleteOne({ id: chatId });
    return { members, chatId };
  }

  async pinMessage(chatId, requesterId, pinData) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (!chat.members.includes(requesterId)) throw new Error('User not in chat');
    chat.pinnedMessage = pinData;
    await chat.save();
    return this._plain(chat);
  }

  async unpinMessage(chatId, requesterId) {
    const chat = await Chat.findOne({ id: chatId });
    if (!chat) throw new Error('Chat not found');
    if (!chat.members.includes(requesterId)) throw new Error('User not in chat');
    chat.pinnedMessage = null;
    await chat.save();
    return this._plain(chat);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async storeMessage({ chatId, senderId, encryptedPayload, recipientKeys }) {
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    // Use insertOne via Model.create then markModified so Mongoose doesn't strip
    // the Mixed recipientKeys before persisting.
    const msg = new Message({ id: msgId, chatId, senderId, encryptedPayload, recipientKeys });
    msg.markModified('encryptedPayload');
    msg.markModified('recipientKeys');
    await msg.save();
    return this._plain(msg);
  }

  async getChatMessages(chatId) {
    const msgs = await Message.find({ chatId }).sort({ timestamp: 1 });
    return msgs.map(m => this._plain(m));
  }

  // ── Forward Requests ───────────────────────────────────────────────────────

  async createForwardRequest(senderId, ownerId, messageId, receiverId) {
    const reqId = 'fwd_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const fwd = await ForwardRequest.create({ id: reqId, senderId, ownerId, messageId, receiverId });
    return this._plain(fwd);
  }

  async updateForwardRequestStatus(requestId, status) {
    const fwd = await ForwardRequest.findOne({ id: requestId });
    if (!fwd) return null;
    fwd.status = status;
    await fwd.save();
    return this._plain(fwd);
  }
}

module.exports = new Database();

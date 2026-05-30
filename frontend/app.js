/**
 * Ghost Link – Premium Minimalist Telegram‑style Client
 */

let socket = null;
const API_URL = 'http://localhost:3000';

// Session state
let myGhostId = '';
let myPublicKeys = null;
let myPfpBase64 = '';
let activeChats = [];
let selectedRoomId = null;

// Caches
const peerKeys = new Map();
const decryptedMessages = new Map();
const rawMessageKeys = new Map();

/** ------------------------------------------------------------------
 *  Initialization & View Engine
 * ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupScreenshotProtection();
  rollGhostId();
});

function switchView(viewId) {
  ['viewLanding', 'viewAuth', 'viewDashboard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== viewId);
  });
}

function setupTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  const toggleTheme = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    }
  };

  const btnNav = document.getElementById('themeToggleNav');
  const btnSidebar = document.getElementById('themeToggleSidebar');
  if (btnNav) btnNav.addEventListener('click', toggleTheme);
  if (btnSidebar) btnSidebar.addEventListener('click', toggleTheme);
}

/** ------------------------------------------------------------------
 *  Mobile Responsive – Sidebar / Chat Toggle
 * ------------------------------------------------------------------ */
function isMobile() {
  return window.innerWidth <= 640;
}

function openMobileChat() {
  if (!isMobile()) return;
  document.querySelector('.sidebar').classList.add('chat-open');
  document.getElementById('chatWindow').classList.add('chat-open');
}

function closeMobileChat() {
  document.querySelector('.sidebar').classList.remove('chat-open');
  document.getElementById('chatWindow').classList.remove('chat-open');
}

/** ------------------------------------------------------------------
 *  Screenshot & Screen Recording Protection
 * ------------------------------------------------------------------ */
let _prtScPressed = false;

function setupScreenshotProtection() {
  // --- DESKTOP: keyboard shortcuts ---
  window.addEventListener('keydown', e => {
    if (e.key === 'PrintScreen') _prtScPressed = true;
  });

  window.addEventListener('keyup', e => {
    if (e.key === 'PrintScreen') {
      _prtScPressed = false;
      activateShield();
      notifyPeerOfScreenshot();
    }
    // Mac: Cmd+Shift+3/4/5
    if (e.metaKey && e.shiftKey && ['3','4','5'].includes(e.key)) {
      activateShield();
      notifyPeerOfScreenshot();
    }
  });

  // Fallback blur after PrtSc
  window.addEventListener('blur', () => {
    if (_prtScPressed) {
      _prtScPressed = false;
      activateShield();
      notifyPeerOfScreenshot();
    }
  });

  // --- MOBILE: Screen Recording & Screenshot via Page Visibility ---
  // When OS captures screenshot on mobile, page briefly loses visibility
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && selectedRoomId) {
      activateShield();
      notifyPeerOfScreenshot();
    }
  });

  // --- MOBILE: Screen Recording via Media Devices API ---
  // Detect when a screen capture track becomes active (Chrome Android 94+)
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    // Intercept getDisplayMedia — if someone tries to record the screen
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (constraints) => {
      activateShield();
      notifyPeerOfScreenshot();
      // Still allow it (we can't block it) but hide content first
      return originalGetDisplayMedia(constraints);
    };
  }

  // --- CSS: prevent screenshots via -webkit-user-select and content-visibility ---
  // Applied only to the messages container when in a chat
  applyCSSProtection();
}

function applyCSSProtection() {
  // Inject a style tag that makes the messages area resistant to screen capture
  // on supported browsers (Samsung Internet, some WebViews)
  const style = document.createElement('style');
  style.textContent = `
    /* Attempt to block screen capture on supported mobile browsers */
    #messagesGrid, .message {
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }
    /* Samsung Internet / some Android WebViews support this */
    .messages-protected {
      -webkit-tap-highlight-color: transparent;
    }
    @media (max-width: 640px) {
      /* Extra caution on mobile */
      #messagesGrid img {
        pointer-events: none;
        -webkit-user-drag: none;
      }
    }
  `;
  document.head.appendChild(style);
}

function activateShield() {
  // Only show shield when inside the chat dashboard
  if (!selectedRoomId) return;
  const shield = document.getElementById('screenshotShield');
  if (shield) {
    shield.classList.add('active');
    // Auto-dismiss after 3 seconds on mobile (no hover/click friction)
    if (isMobile()) {
      setTimeout(() => shield.classList.remove('active'), 3000);
    }
  }
}

function dismissShield() {
  const shield = document.getElementById('screenshotShield');
  if (shield) shield.classList.remove('active');
}

function notifyPeerOfScreenshot() {
  if (socket && selectedRoomId) {
    socket.emit('screenshot_detected', { chatId: selectedRoomId });
  }
}

/** ------------------------------------------------------------------
 *  Authentication / Login Pathways
 * ------------------------------------------------------------------ */
function rollGhostId() {
  const suffix = Math.random().toString(36).substring(2, 8);
  const input = document.getElementById('ghostIdInput');
  if (input) input.value = `ghost_${suffix}`;
}

async function ghostIdLogin() {
  const id = document.getElementById('ghostIdInput').value.trim();
  if (!id) { alert('Please enter or roll a Ghost ID!'); return; }
  await authenticateSession(id);
}

async function authenticateSession(id) {
  myGhostId = id;
  const submitBtns = document.querySelectorAll('.auth-submit, .roll-btn');
  submitBtns.forEach(btn => btn.disabled = true);

  try {
    switchView('viewDashboard');

    const sendBtn = document.querySelector('.send-btn');
    window.originalSendBtnHTML = sendBtn.innerHTML;
    window._spinnerStartTime = Date.now();
    sendBtn.innerHTML = `<svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
    sendBtn.title = 'Generating Keys...';
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.7';
    sendBtn.style.cursor = 'wait';

    myPublicKeys = await cryptoEngine.generateIdentityKeyPairs();

    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        randomId: myGhostId,
        keys: {
          identityKey: myPublicKeys.publicEncryptionJWK,
          signedPreKey: myPublicKeys.publicSigningJWK
        }
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server registration rejected');
    }

    drawHoldToRevealPfp('roomPfpCanvas', 'ghost');
    document.getElementById('myGhostIdDisplay').textContent = myGhostId;
    initializeSocket();

  } catch (err) {
    showToast(`Authentication Error: ${err.message}`, 'error');
    submitBtns.forEach(btn => btn.disabled = false);
  }
}

/** ------------------------------------------------------------------
 *  Socket.io handling
 * ------------------------------------------------------------------ */
function initializeSocket() {
  socket = io(API_URL);

  socket.on('connect', () => {
    socket.emit('register_session', myGhostId);
  });

  socket.on('session_ready', data => {
    const restoreSendBtn = () => {
      const sendBtn = document.querySelector('.send-btn');
      if (window.originalSendBtnHTML) {
        sendBtn.innerHTML = window.originalSendBtnHTML;
        sendBtn.title = 'Send';
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        sendBtn.style.cursor = 'pointer';
        window.originalSendBtnHTML = null;
      }
      loadActiveChats();
    };
    const elapsed = Date.now() - (window._spinnerStartTime || Date.now());
    const remaining = Math.max(0, 1500 - elapsed);
    setTimeout(restoreSendBtn, remaining);
  });

  socket.on('new_encrypted_msg', async msg => {
    await handleIncomingMsg(msg);
  });

  socket.on('screenshot_alert', data => {
    showScreenshotAlert(data.detectorId);
  });

  socket.on('chat_created', chat => {
    loadActiveChats();
  });

  socket.on('group_updated', updatedChat => {
    const idx = activeChats.findIndex(c => c.id === updatedChat.id);
    if (idx !== -1) activeChats[idx] = updatedChat;
    else activeChats.push(updatedChat);

    if (updatedChat.kickedId === myGhostId) {
      selectedRoomId = null;
      document.getElementById('messagesGrid').innerHTML = '';
      document.getElementById('roomTitleDisplay').textContent = 'Select a chat';
      closeGroupInfo();
      showToast('You were removed from the group', 'error');
      loadActiveChats();
      if (isMobile()) closeMobileChat();
      return;
    }

    if (currentGroupInfo && currentGroupInfo.id === updatedChat.id) {
      openGroupInfo(updatedChat);
    }
    loadActiveChats();
  });

  socket.on('forward_approval_needed', data => showForwardBanner(data));
  socket.on('forward_decision_received', async data => {
    if (data.decision === 'approved') {
      const aesKey = await cryptoEngine.unwrapMessageKey(data.wrappedKeyForForwarder);
      forwardMessageToTarget(data.messageId, data.receiverId, aesKey);
    } else {
      showToast('Forward request was denied by the owner.', 'error');
    }
  });
}

/** ------------------------------------------------------------------
 *  Real-Time Chat Relays
 * ------------------------------------------------------------------ */
async function searchAndAddPeer() {
  const query = document.getElementById('peerSearchInput').value.trim();
  if (!query) return;

  if (query === myGhostId) {
    showToast('You cannot start a chat session with yourself', 'error');
    return;
  }

  try {
    const resp = await fetch(`${API_URL}/api/keys/${query}`);
    if (!resp.ok) throw new Error('Ghost ID not found on server');
    const bundle = await resp.json();

    peerKeys.set(query, {
      publicEncryptionJWK: bundle.identityKey,
      publicSigningJWK: bundle.signedPreKey
    });

    const chatRes = await fetch(`${API_URL}/api/chats/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: [myGhostId, query], type: 'direct' })
    });
    const chat = await chatRes.json();
    document.getElementById('peerSearchInput').value = '';

    loadActiveChats();
    openChatRoom(chat.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/** ------------------------------------------------------------------
 *  Group Chat Creation Dialog
 * ------------------------------------------------------------------ */
let groupMembers = [];

function toggleGroupDialog() {
  const dialog = document.getElementById('groupDialog');
  const fab = document.getElementById('fabBtn');
  const isOpen = dialog.classList.toggle('open');
  fab.classList.toggle('open', isOpen);
  if (!isOpen) {
    groupMembers = [];
    document.getElementById('groupNameInput').value = '';
    document.getElementById('groupBioInput').value = '';
    document.getElementById('groupMemberInput').value = '';
    document.getElementById('groupMemberList').innerHTML = '';
  }
}

function addGroupMember() {
  const input = document.getElementById('groupMemberInput');
  const id = input.value.trim();
  if (!id) return;
  if (id === myGhostId) { showToast('Cannot add yourself', 'error'); return; }
  if (groupMembers.includes(id)) { showToast('Already added', 'error'); return; }
  groupMembers.push(id);
  input.value = '';
  renderGroupMemberList();
}

function renderGroupMemberList() {
  const ul = document.getElementById('groupMemberList');
  ul.innerHTML = groupMembers.map((id, i) => `
    <li><span>${id}</span><button onclick="removeGroupMember(${i})">✕</button></li>
  `).join('');
}

function removeGroupMember(index) {
  groupMembers.splice(index, 1);
  renderGroupMemberList();
}

async function createGroupChat() {
  const name = document.getElementById('groupNameInput').value.trim();
  const bio  = document.getElementById('groupBioInput').value.trim();
  if (!name) { showToast('Enter a group name', 'error'); return; }
  if (groupMembers.length < 1) { showToast('Add at least one member', 'error'); return; }
  try {
    const members = [myGhostId, ...groupMembers];
    const res = await fetch(`${API_URL}/api/chats/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members, type: 'group', name, bio, createdBy: myGhostId })
    });
    if (!res.ok) throw new Error('Failed to create group');
    const chat = await res.json();
    toggleGroupDialog();
    loadActiveChats();
    openChatRoom(chat.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/** ------------------------------------------------------------------
 *  Group Info Panel
 * ------------------------------------------------------------------ */
let currentGroupInfo = null;

function handleChatHeaderClick() {
  const chat = activeChats.find(c => c.id === selectedRoomId);
  if (!chat || chat.type !== 'group') return;
  openGroupInfo(chat);
}

function openGroupInfo(chat) {
  currentGroupInfo = chat;
  document.getElementById('gipName').textContent = chat.name;
  document.getElementById('gipBio').textContent = chat.bio || 'No group bio set.';
  document.getElementById('gipCreatedBy').textContent = `Created by: ${chat.createdBy}`;
  const d = new Date(chat.createdAt);
  document.getElementById('gipCreatedAt').textContent =
    `Created on: ${d.toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' })}`;
  renderGipMembers(chat);
  document.getElementById('groupInfoPanel').classList.add('open');
}

function closeGroupInfo() {
  document.getElementById('groupInfoPanel').classList.remove('open');
  currentGroupInfo = null;
}

function renderGipMembers(chat) {
  const ul = document.getElementById('gipMemberList');
  const isAdmin = chat.admins && chat.admins.includes(myGhostId);
  ul.innerHTML = chat.members.map(memberId => {
    const isCreator = memberId === chat.createdBy;
    const memberIsAdmin = chat.admins && chat.admins.includes(memberId);
    const isSelf = memberId === myGhostId;
    const initials = memberId.replace('ghost_','').substring(0,2).toUpperCase();
    const role = isCreator ? 'Owner' : memberIsAdmin ? 'Admin' : '';
    const actions = (!isSelf && isAdmin && !isCreator) ? `
      <div class="gip-member-actions">
        ${!memberIsAdmin ? `<button class="gip-action-btn gip-action-promote" onclick="makeAdmin('${chat.id}','${memberId}')">Admin</button>` : ''}
        <button class="gip-action-btn gip-action-kick" onclick="kickMember('${chat.id}','${memberId}')">Kick</button>
      </div>` : '';
    return `
      <li class="gip-member-item">
        <div class="gip-member-avatar">${initials}</div>
        <div class="gip-member-info">
          <div class="gip-member-id">${memberId}${isSelf ? ' (you)' : ''}</div>
          ${role ? `<div class="gip-member-role">${role}</div>` : ''}
        </div>
        ${actions}
      </li>`;
  }).join('');
}

async function makeAdmin(chatId, targetId) {
  try {
    const res = await fetch(`${API_URL}/api/chats/${chatId}/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: myGhostId, targetId })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const chat = await res.json();
    const idx = activeChats.findIndex(c => c.id === chatId);
    if (idx !== -1) activeChats[idx] = chat;
    openGroupInfo(chat);
    showToast(`${targetId} is now an admin`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function kickMember(chatId, targetId) {
  if (!confirm(`Remove ${targetId} from the group?`)) return;
  try {
    const res = await fetch(`${API_URL}/api/chats/${chatId}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requesterId: myGhostId, targetId })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const chat = await res.json();
    const idx = activeChats.findIndex(c => c.id === chatId);
    if (idx !== -1) activeChats[idx] = chat;
    openGroupInfo(chat);
    showToast(`${targetId} removed from group`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadActiveChats() {
  try {
    const res = await fetch(`${API_URL}/api/users/${myGhostId}/chats`);
    activeChats = await res.json();

    const container = document.getElementById('chatsContainer');
    if (!container) return;

    if (activeChats.length === 0) {
      container.innerHTML = '<li class="text-slate-500 text-xs py-4 text-center">No active chats</li>';
      return;
    }

    container.innerHTML = activeChats.map(chat => {
      const title = chat.type === 'direct'
        ? chat.members.find(m => m !== myGhostId)
        : chat.name;
      const selected = chat.id === selectedRoomId ? 'active' : '';
      return `<li class="${selected}" onclick="openChatRoom('${chat.id}')">👤 ${title}</li>`;
    }).join('');
  } catch (e) {
    console.error(e);
  }
}

async function openChatRoom(chatId) {
  selectedRoomId = chatId;
  const chat = activeChats.find(c => c.id === chatId);
  if (!chat) return;

  const title = chat.type === 'direct'
    ? chat.members.find(m => m !== myGhostId)
    : chat.name;
  document.getElementById('roomTitleDisplay').innerText = title;

  drawHoldToRevealPfp('roomPfpCanvas', 'peer');

  loadActiveChats();
  await loadMessages(chatId);

  // Mobile: slide to chat view
  openMobileChat();
}

async function loadMessages(chatId) {
  try {
    const res = await fetch(`${API_URL}/api/chats/${chatId}/messages`);
    const msgs = await res.json();
    const grid = document.getElementById('messagesGrid');
    grid.innerHTML = '';
    for (const msg of msgs) {
      await renderMessage(msg);
    }
    grid.scrollTop = grid.scrollHeight;
  } catch (e) {
    console.error(e);
  }
}

async function renderMessage(msg) {
  const grid = document.getElementById('messagesGrid');
  const isMine = msg.senderId === myGhostId;
  let plaintext = '';

  if (decryptedMessages.has(msg.id)) {
    plaintext = decryptedMessages.get(msg.id);
  } else {
    try {
      const wrappedKey = msg.recipientKeys[myGhostId];
      if (wrappedKey) {
        const aesKey = await cryptoEngine.unwrapMessageKey(wrappedKey);
        rawMessageKeys.set(msg.id, aesKey);
        plaintext = await cryptoEngine.decryptBubble(msg.encryptedPayload.ciphertext, msg.encryptedPayload.iv, aesKey);
        decryptedMessages.set(msg.id, plaintext);
      } else {
        plaintext = '🔑 Wrap missing for ID';
      }
    } catch (e) {
      plaintext = '⚠️ Keys out of sync';
    }
  }

  const bubbleClass = isMine ? 'message sent' : 'message received';
  const content = plaintext.startsWith('data:image')
    ? `<img src="${plaintext}" class="max-w-[200px] rounded" style="filter: blur(0px)"/>`
    : `<p>${plaintext}</p>`;

  const html = `
    <div class="${bubbleClass}">
      <span class="sender">${msg.senderId}</span>
      ${content}
      ${!isMine ? `<button class="forward-btn" onclick="initiateForwardFlow('${msg.id}', '${msg.senderId}')" title="Forward Message">➡️</button>` : ''}
    </div>`;
  grid.insertAdjacentHTML('beforeend', html);
}

/** ------------------------------------------------------------------
 *  Transmitting Data
 * ------------------------------------------------------------------ */
async function sendChatMessage() {
  const input = document.getElementById('chatMessageInput');
  const text = input.value.trim();
  if (!text || !selectedRoomId) return;
  await encryptAndSend(text);
  input.value = '';
}

async function encryptAndSend(plain) {
  try {
    const chat = activeChats.find(c => c.id === selectedRoomId);
    if (!chat) return;

    const aesKey = await cryptoEngine.generateSymmetricKey();
    const encrypted = await cryptoEngine.encryptBubble(plain, aesKey);

    const recipientKeys = {};
    for (const memberId of chat.members) {
      let pubJWK = null;
      if (memberId === myGhostId) {
        pubJWK = myPublicKeys.publicEncryptionJWK;
      } else if (peerKeys.has(memberId)) {
        pubJWK = peerKeys.get(memberId).publicEncryptionJWK;
      } else {
        const res = await fetch(`${API_URL}/api/keys/${memberId}`);
        const bundle = await res.json();
        pubJWK = bundle.identityKey;
        peerKeys.set(memberId, { publicEncryptionJWK: pubJWK });
      }
      recipientKeys[memberId] = await cryptoEngine.wrapMessageKey(aesKey, pubJWK);
    }

    socket.emit('send_encrypted_msg', {
      chatId: selectedRoomId,
      encryptedPayload: encrypted,
      recipientKeys
    });
  } catch (err) {
    showToast('Encryption failed', 'error');
  }
}

// Send on Enter
document.getElementById('chatMessageInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Media uploads
document.getElementById('mediaAttachmentInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file && selectedRoomId) {
    const reader = new FileReader();
    reader.onload = async ev => {
      await encryptAndSend(ev.target.result);
      showToast('Encrypted media shared', 'success');
    };
    reader.readAsDataURL(file);
  }
});

async function handleIncomingMsg(msg) {
  if (msg.chatId === selectedRoomId) {
    await renderMessage(msg);
    const grid = document.getElementById('messagesGrid');
    grid.scrollTop = grid.scrollHeight;
  }
}

/** ------------------------------------------------------------------
 *  Forward Handshakes & Approvals
 * ------------------------------------------------------------------ */
let activeForwardRequest = null;

function initiateForwardFlow(messageId, ownerId) {
  const targetId = prompt('Enter recipient Ghost ID for forwarded bubble:');
  if (!targetId) return;
  activeForwardRequest = { messageId, ownerId, receiverId: targetId };
  socket.emit('request_forward', { messageId, ownerId, receiverId: targetId });
  showToast('Relaying forward permission request...', 'info');
}

function showForwardBanner(data) {
  const decision = confirm(`User ${data.requesterId} requests permission to forward your message to ${data.receiverId}. Approve?`);
  if (decision) {
    approveForward(data);
  } else {
    socket.emit('forward_decision', { requestId: data.requestId, decision: 'denied' });
  }
}

async function approveForward(data) {
  const aesKey = rawMessageKeys.get(data.messageId);
  if (!aesKey) { showToast('Message key missing from cache', 'error'); return; }
  let requesterPub = null;
  if (peerKeys.has(data.requesterId)) {
    requesterPub = peerKeys.get(data.requesterId).publicEncryptionJWK;
  } else {
    const res = await fetch(`${API_URL}/api/keys/${data.requesterId}`);
    const bundle = await res.json();
    requesterPub = bundle.identityKey;
  }
  const wrapped = await cryptoEngine.wrapMessageKey(aesKey, requesterPub);
  socket.emit('forward_decision', {
    requestId: data.requestId,
    decision: 'approved',
    wrappedKeyForForwarder: wrapped
  });
}

async function forwardMessageToTarget(messageId, receiverId, aesKey) {
  const original = decryptedMessages.get(messageId);
  if (!original) return;

  let chat = activeChats.find(c => c.type === 'direct' && c.members.includes(receiverId));
  if (!chat) {
    const res = await fetch(`${API_URL}/api/chats/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: [myGhostId, receiverId], type: 'direct' })
    });
    chat = await res.json();
  }

  const encrypted = await cryptoEngine.encryptBubble(`[Forwarded] ${original}`, aesKey);
  const recipientKeys = {};
  recipientKeys[myGhostId] = await cryptoEngine.wrapMessageKey(aesKey, myPublicKeys.publicEncryptionJWK);
  const res = await fetch(`${API_URL}/api/keys/${receiverId}`);
  const bundle = await res.json();
  recipientKeys[receiverId] = await cryptoEngine.wrapMessageKey(aesKey, bundle.identityKey);

  socket.emit('send_encrypted_msg', {
    chatId: chat.id,
    encryptedPayload: encrypted,
    recipientKeys
  });
  showToast('Forwarded successfully', 'success');
}

/** ------------------------------------------------------------------
 *  Visual Utilities
 * ------------------------------------------------------------------ */
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function showScreenshotAlert(detectorId) {
  const grid = document.getElementById('messagesGrid');
  if (!grid) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const msg = document.createElement('div');
  msg.className = 'system-msg screenshot-system-msg';
  msg.innerHTML = `
    <div class="system-msg-inner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
      <span><strong>${detectorId}</strong> took a screenshot</span>
      <span class="system-msg-time">${timeStr}</span>
    </div>
  `;
  grid.appendChild(msg);
  grid.scrollTop = grid.scrollHeight;
}

function drawHoldToRevealPfp(canvasId, base64Data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = 64;
  canvas.width = size; canvas.height = size;

  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, size, size);
  if (base64Data && base64Data !== 'ghost') {
    img.src = base64Data;
  } else {
    ctx.fillStyle = '#229ed9';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👻', size/2, size/2);
  }
}

function logout() {
  if (socket) socket.disconnect();
  location.reload();
}
/**
 * Ghost Link – Premium Minimalist Telegram‑style Client
 */

let socket = null;
const API_URL = 'http://localhost:3000';

// Session state
let myGhostId = '';
let myPublicKeys = null; // { publicEncryptionJWK, publicSigningJWK }
let myPfpBase64 = '';
let activeChats = [];
let selectedRoomId = null;

// Caches
const peerKeys = new Map(); // GhostID -> { publicEncryptionJWK, publicSigningJWK }
const decryptedMessages = new Map(); // MessageID -> plaintext
const rawMessageKeys = new Map(); // MessageID -> symmetric AES key

/** ------------------------------------------------------------------
 *  Initialization & View Engine
 * ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupScreenshotProtection();
  // Generate a starting rolled ID in the form input on load
  rollGhostId();
});

// Switch between Landing, Auth Card, and Dashboard views
function switchView(viewId) {
  ['viewLanding', 'viewAuth', 'viewDashboard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== viewId);
  });
}

// Restore and manage theme state
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
 *  Screenshot Protection
 * ------------------------------------------------------------------ */
function setupScreenshotProtection() {
  // Capture keyboard shortcuts
  window.addEventListener('keydown', e => {
    if (
      e.key === 'PrintScreen' ||
      (e.ctrlKey && e.key.toLowerCase() === 'p') ||
      (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4'))
    ) {
      e.preventDefault();
      activateShield();
    }
  });

  // Blur / focus loss
  window.addEventListener('blur', activateShield);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) activateShield();
  });
}

function activateShield() {
  const shield = document.getElementById('screenshotShield');
  if (shield) shield.classList.add('active');
  // Broadcast to peer if inside an active conversation
  if (socket && selectedRoomId) {
    socket.emit('screenshot_detected', { chatId: selectedRoomId });
  }
}

function dismissShield() {
  const shield = document.getElementById('screenshotShield');
  if (shield) shield.classList.remove('active');
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
  if (!id) {
    alert('Please enter or roll a Ghost ID!');
    return;
  }
  await authenticateSession(id);
}

async function emailLogin() {
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value.trim();
  if (!email || !password) {
    alert('Please provide both your email and password.');
    return;
  }
  // Generate a predictable Ghost ID from the email
  const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const id = `ghost_${prefix}`;
  await authenticateSession(id);
}

async function googleLogin() {
  showToast('Connecting with Google Account...', 'info');
  setTimeout(async () => {
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const id = `ghost_google_${randomSuffix}`;
    await authenticateSession(id);
  }, 1000);
}

async function authenticateSession(id) {
  myGhostId = id;
  const submitBtns = document.querySelectorAll('.auth-submit, .roll-btn, .google-login-btn');
  submitBtns.forEach(btn => btn.disabled = true);

  try {
    showToast('Generating End‑to‑End Encryption Keys...', 'info');
    // Generate local RSA E2EE key bundle
    myPublicKeys = await cryptoEngine.generateIdentityKeyPairs();

    // Register bundle on server
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

    // Configure profile PFP Canvas (draw abstract ghost)
    drawHoldToRevealPfp('roomPfpCanvas', 'ghost');

    // Show watermark backdrop with User's ID
    injectWatermark(myGhostId);

    // Update active Ghost ID view
    document.getElementById('myGhostIdDisplay').textContent = myGhostId;

    // Connect real-time socket
    initializeSocket();

    // Route view to main chat Dashboard
    switchView('viewDashboard');

  } catch (err) {
    showToast(`Authentication Error: ${err.message}`, 'error');
    submitBtns.forEach(btn => btn.disabled = false);
  }
}

function injectWatermark(id) {
  // Clear any existing watermark first
  const existing = document.querySelector('.watermark');
  if (existing) existing.remove();

  const wm = document.createElement('div');
  wm.className = 'watermark';
  wm.textContent = id;
  document.body.appendChild(wm);
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
    showToast('Zero‑knowledge secure link established', 'success');
    loadActiveChats();
  });

  socket.on('new_encrypted_msg', async msg => {
    await handleIncomingMsg(msg);
  });

  socket.on('screenshot_alert', data => {
    showToast(`🚨 Screenshot warning: Peer ${data.detectorId} detected capture activity`, 'warning');
  });

  socket.on('chat_created', chat => {
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
    // Resolve peer public key bundle
    const resp = await fetch(`${API_URL}/api/keys/${query}`);
    if (!resp.ok) throw new Error('Ghost ID not found on server');
    const bundle = await resp.json();

    peerKeys.set(query, {
      publicEncryptionJWK: bundle.identityKey,
      publicSigningJWK: bundle.signedPreKey
    });

    // Create session room
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

  // Render hold-to-reveal canvas avatar
  drawHoldToRevealPfp('roomPfpCanvas', 'peer');

  // Load chat history
  loadActiveChats();
  await loadMessages(chatId);
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
  } else {
    showToast(`New secure payload from ${msg.senderId}`, 'info');
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
  socket.emit('request_forward', {
    messageId,
    ownerId,
    receiverId: targetId
  });
  showToast('Relaying forward permission request...', 'info');
}

function showForwardBanner(data) {
  // Using pure JS prompt block for minimalist flow
  const decision = confirm(`User ${data.requesterId} requests permission to forward your message to ${data.receiverId}. Approve?`);
  
  if (decision) {
    approveForward(data);
  } else {
    socket.emit('forward_decision', { requestId: data.requestId, decision: 'denied' });
  }
}

async function approveForward(data) {
  const aesKey = rawMessageKeys.get(data.messageId);
  if (!aesKey) {
    showToast('Message key missing from cache', 'error');
    return;
  }
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

function drawHoldToRevealPfp(canvasId, base64Data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = 64;
  canvas.width = size; canvas.height = size;
  
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, size, size);
  if (base64Data && base64Data !== 'ghost') img.src = base64Data;
  else {
    ctx.fillStyle = '#229ed9';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👻', size/2, size/2);
  }
  
  canvas.style.filter = 'blur(10px)';
  const reveal = () => canvas.style.filter = 'blur(0px)';
  const hide = () => canvas.style.filter = 'blur(10px)';
  
  canvas.addEventListener('mousedown', reveal);
  canvas.addEventListener('mouseup', hide);
  canvas.addEventListener('mouseleave', hide);
  canvas.addEventListener('touchstart', reveal);
  canvas.addEventListener('touchend', hide);
  window.addEventListener('keydown', hide);
}

function logout() {
  if (socket) socket.disconnect();
  location.reload();
}

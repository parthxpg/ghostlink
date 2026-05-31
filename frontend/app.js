/**
 * Ghost Link – Premium Minimalist Telegram‑style Client
 */

let socket = null;
const API_URL = '';

// Session state
let myGhostId = '';
let myPublicKeys = null; // { publicEncryptionJWK, publicSigningJWK }
let myPfpBase64 = '';
let activeChats = [];
let selectedRoomId = null;
let unreadMessages = new Map(); // ChatID -> unread count

// Caches
const peerKeys = new Map(); // GhostID -> { publicEncryptionJWK, publicSigningJWK }
const decryptedMessages = new Map(); // MessageID -> plaintext
const rawMessageKeys = new Map(); // MessageID -> symmetric AES key

/** ------------------------------------------------------------------
 *  Initialization & View Engine
 * ------------------------------------------------------------------ */
function getAuthHeaders(extraHeaders = {}) {
  const token = localStorage.getItem('gl_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...extraHeaders
  };
}

window.initGoogleSignIn = function () {
  if (typeof google !== 'undefined') {
    google.accounts.id.initialize({
      client_id: "164131136399-80j017g3h3j8np5r0hp9fiun751mfaqb.apps.googleusercontent.com",
      callback: handleCredentialResponse
    });
    const btnContainer = document.getElementById("gsi-button");
    if (btnContainer) {
      google.accounts.id.renderButton(
        btnContainer,
        { theme: "outline", size: "large", width: 280 }
      );
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupScreenshotProtection();
  setupLiveSearch();
  setupMessageContextMenu();

  // Try to initialize immediately if Google client is loaded first
  initGoogleSignIn();

  // Auto-login if token is present
  const token = localStorage.getItem('gl_token');
  if (token) {
    fetch(`${API_URL}/api/profile/me`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(async profile => {
        if (profile && profile.username) {
          myGhostId = profile.username;
          await authenticateSession(profile.username);
        } else {
          localStorage.removeItem('gl_token');
          document.documentElement.classList.remove('auto-logging-in');
        }
      })
      .catch(() => {
        localStorage.removeItem('gl_token');
        document.documentElement.classList.remove('auto-logging-in');
      });
  } else {
    document.documentElement.classList.remove('auto-logging-in');
  }
  setupLiveSearch();
});

// Switch between Landing, Auth Card, and Dashboard views
function switchView(viewId) {
  document.documentElement.classList.remove('auto-logging-in');
  ['viewLanding', 'viewAuth', 'viewUsername', 'viewDashboard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== viewId);
  });

  // Lock scrolling on Auth and Dashboard views, permit standard scrolling on Landing
  if (viewId === 'viewLanding') {
    document.body.classList.remove('no-scroll');
    document.documentElement.classList.remove('no-scroll');
  } else {
    document.body.classList.add('no-scroll');
    document.documentElement.classList.add('no-scroll');
    // Reset any scroll position carried over from the landing page
    window.scrollTo(0, 0);
  }
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
 *  Screenshot Detection – Notifies peer silently, no local shield
 * ------------------------------------------------------------------ */
let _prtScPressed = false;

function setupScreenshotProtection() {
  // Flag on keydown (works even if OS captures the key first)
  window.addEventListener('keydown', e => {
    if (e.key === 'PrintScreen') {
      _prtScPressed = true;
    }
  });

  // keyup fires reliably on Windows in Chrome/Edge after OS captures PrintScreen
  window.addEventListener('keyup', e => {
    if (e.key === 'PrintScreen') {
      _prtScPressed = false;
      notifyPeerOfScreenshot();
    }
    // Mac screenshot shortcuts: Cmd+Shift+3/4/5
    if (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4' || e.key === '5')) {
      notifyPeerOfScreenshot();
    }
  });

  // Fallback: if window blurs immediately after PrtSc was pressed (some OS/browser combos)
  window.addEventListener('blur', () => {
    if (_prtScPressed) {
      _prtScPressed = false;
      notifyPeerOfScreenshot();
    }
  });
}

function notifyPeerOfScreenshot() {
  // Only emit if inside an active chat session
  if (socket && selectedRoomId) {
    socket.emit('screenshot_detected', { chatId: selectedRoomId });
  }
}

/** ------------------------------------------------------------------
 *  Authentication / Login Pathways
 * ------------------------------------------------------------------ */
function switchAuthTab(tab) {
  const isSignIn = tab === 'signIn';
  document.getElementById('tabSignIn').classList.toggle('active', isSignIn);
  document.getElementById('tabSignUp').classList.toggle('active', !isSignIn);
  document.getElementById('signInForm').classList.toggle('hidden', !isSignIn);
  document.getElementById('signUpForm').classList.toggle('hidden', isSignIn);
}

function checkEmailTypo(email) {
  const domain = email.split('@')[1];
  if (!domain) return null;
  const typos = {
    'gmil.com': 'gmail.com',
    'gmal.com': 'gmail.com',
    'gamil.com': 'gmail.com',
    'gmail.co': 'gmail.com',
    'gmail.con': 'gmail.com',
    'yaho.com': 'yahoo.com',
    'yahoo.co': 'yahoo.com',
    'yahoo.con': 'yahoo.com',
    'hotmail.co': 'hotmail.com',
    'hotmal.com': 'hotmail.com',
    'outlook.co': 'outlook.com'
  };
  return typos[domain.toLowerCase()] || null;
}
async function emailSignup() {
  const email = document.getElementById('emailSignUp').value.trim();
  const password = document.getElementById('passwordSignUp').value.trim();
  if (!email || !password) {
    showToast('Please enter an email and password!', 'error');
    return;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    showToast('Please enter a valid email address', 'error');
    return;
  }
  const typo = checkEmailTypo(email);
  if (typo) {
    showToast("Did you mean @" + typo + "?", 'error');
    return;
  }
  try {
    const res = await fetch(`${API_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Signup failed');
    }
    const data = await res.json();
    localStorage.setItem('gl_token', data.token);
    switchView('viewUsername');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function emailLogin() {
  const email = document.getElementById('emailSignIn').value.trim();
  const password = document.getElementById('passwordSignIn').value.trim();
  if (!email || !password) {
    showToast('Please enter your email and password!', 'error');
    return;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    showToast('Please enter a valid email address', 'error');
    return;
  }
  const typo = checkEmailTypo(email);
  if (typo) {
    showToast("Did you mean @" + typo + "?", 'error');
    return;
  }
  try {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    localStorage.setItem('gl_token', data.token);
    if (data.needsUsername) {
      switchView('viewUsername');
    } else {
      myGhostId = data.username;
      await authenticateSession(data.username);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleCredentialResponse(response) {
  try {
    const res = await fetch(`${API_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Google Login failed');
    }
    const data = await res.json();
    localStorage.setItem('gl_token', data.token);
    if (data.needsUsername) {
      switchView('viewUsername');
    } else {
      myGhostId = data.username;
      await authenticateSession(data.username);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

let usernameTimeout = null;
function onUsernameInput(val) {
  const status = document.getElementById('usernameStatus');
  const submitBtn = document.getElementById('usernameSubmitBtn');

  if (usernameTimeout) clearTimeout(usernameTimeout);

  const cleanVal = val.trim().toLowerCase();
  if (cleanVal.length < 3) {
    status.textContent = 'Minimum 3 characters';
    status.style.color = '#ef4444';
    submitBtn.disabled = true;
    return;
  }
  if (!/^[a-z0-9_]+$/.test(cleanVal)) {
    status.textContent = 'Only lowercase letters, numbers, underscores';
    status.style.color = '#ef4444';
    submitBtn.disabled = true;
    return;
  }

  status.textContent = 'Checking availability...';
  status.style.color = 'var(--text-tertiary)';

  usernameTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/check-username?name=${cleanVal}`);
      const data = await res.json();
      if (data.available) {
        status.textContent = '✓ Available';
        status.style.color = '#10b981';
        submitBtn.disabled = false;
      } else {
        status.textContent = data.reason || '✗ Already taken';
        status.style.color = '#ef4444';
        submitBtn.disabled = true;
      }
    } catch (err) {
      status.textContent = 'Error checking username';
      status.style.color = '#ef4444';
    }
  }, 400);
}

async function claimUsername() {
  const input = document.getElementById('usernameInput');
  const username = input.value.trim().toLowerCase();
  const submitBtn = document.getElementById('usernameSubmitBtn');
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/auth/set-username`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ username })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to set username');
    }
    const data = await res.json();
    localStorage.setItem('gl_token', data.token);
    myGhostId = data.username;
    await authenticateSession(data.username);
  } catch (err) {
    showToast(err.message, 'error');
    submitBtn.disabled = false;
  }
}

async function authenticateSession(username) {
  myGhostId = username;
  try {
    // Route view to main chat Dashboard early to show loading state
    switchView('viewDashboard');

    const chatWindow = document.getElementById('chatWindow');
    if (chatWindow) chatWindow.classList.add('no-chat-selected');

    const sendBtn = document.querySelector('.send-btn');
    window.originalSendBtnHTML = sendBtn.innerHTML;
    window._spinnerStartTime = Date.now(); // track when spinner started
    sendBtn.innerHTML = `<svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
    sendBtn.title = 'Generating End‑to‑End Encryption Keys...';
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.7';
    sendBtn.style.cursor = 'wait';

    // Try to load existing keys from localStorage first
    myPublicKeys = await cryptoEngine.loadKeys(username);

    if (myPublicKeys) {
      // Reuse existing keys — just re-register the same public keys on server
      // so the server always has the current session's public keys
    } else {
      // Brand-new user or keys were cleared — generate fresh keys
      myPublicKeys = await cryptoEngine.generateIdentityKeyPairs();
      // Persist immediately so future logins reuse them
      await cryptoEngine.saveKeys(username);
    }

    // Register (or re-confirm) public key bundle on server
    const res = await fetch(`${API_URL}/api/auth/register-keys`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        keys: {
          identityKey: myPublicKeys.publicEncryptionJWK,
          signedPreKey: myPublicKeys.publicSigningJWK
        }
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server E2EE registration rejected');
    }

    // Initialize the profile settings drawer module with our username
    await profileModule.init(username);

    // Update active Ghost ID view
    const myGhostIdDisplay = document.getElementById('myGhostIdDisplay');
    if (myGhostIdDisplay) myGhostIdDisplay.textContent = username;

    // Connect real-time socket
    initializeSocket();

    if (typeof checkInviteLink === 'function') checkInviteLink();

  } catch (err) {
    showToast(`Authentication Error: ${err.message}`, 'error');
    switchView('viewAuth');
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

    // Ensure spinner is visible for at least 1.5s
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
    // Update local chat cache
    const idx = activeChats.findIndex(c => c.id === updatedChat.id);
    if (idx !== -1) activeChats[idx] = updatedChat;
    else activeChats.push(updatedChat);

    // If kicked, close the chat and reload
    if (updatedChat.kickedId === myGhostId) {
      selectedRoomId = null;
      const chatWindow = document.getElementById('chatWindow');
      if (chatWindow) chatWindow.classList.add('no-chat-selected');
      document.body.classList.remove('chat-open');
      document.getElementById('messagesGrid').innerHTML = '';
      document.getElementById('roomTitleDisplay').textContent = 'Select a chat';
      closeGroupInfo();
      showToast('You were removed from the group', 'error');
      loadActiveChats();
      return;
    }

    // If group info panel is open for this chat, refresh it
    if (currentGroupInfo && currentGroupInfo.id === updatedChat.id) {
      openGroupInfo(updatedChat);
    }
    loadActiveChats();
  });

  socket.on('group_deleted', data => {
    const { chatId } = data;
    activeChats = activeChats.filter(c => c.id !== chatId);
    if (selectedRoomId === chatId) {
      selectedRoomId = null;
      const chatWindow = document.getElementById('chatWindow');
      if (chatWindow) chatWindow.classList.add('no-chat-selected');
      document.body.classList.remove('chat-open');
      document.getElementById('messagesGrid').innerHTML = '';
      document.getElementById('roomTitleDisplay').textContent = 'Select a chat';
      closeGroupInfo();
    }
    showToast('Group has been deleted', 'error');
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

  socket.on('message_pinned', data => {
    const { chatId, pinData } = data;
    
    // Update activeChats cache
    const chat = activeChats.find(c => c.id === chatId);
    if (chat) chat.pinnedMessage = pinData;

    if (chatId === selectedRoomId) {
      // Clear existing timer if any
      if (_pinTimer) clearTimeout(_pinTimer);

      const remainingMs = pinData.expiresAt - Date.now();
      if (remainingMs > 0) {
        _pinnedMsgId = pinData.msgId;
        const bar = document.getElementById('pinnedMessageBar');
        const textEl = document.getElementById('pinnedBarText');
        textEl.textContent = pinData.text;
        bar.classList.remove('hidden');

        _pinTimer = setTimeout(() => {
          unpinMessage(true); // Auto-unpin client-side
        }, remainingMs);
      } else {
        unpinMessage(true);
      }
    }
  });

  socket.on('message_unpinned', data => {
    const { chatId } = data;
    
    // Update activeChats cache
    const chat = activeChats.find(c => c.id === chatId);
    if (chat) chat.pinnedMessage = null;

    if (chatId === selectedRoomId) {
      _pinnedMsgId = null;
      document.getElementById('pinnedMessageBar').classList.add('hidden');
      if (_pinTimer) {
        clearTimeout(_pinTimer);
        _pinTimer = null;
      }
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
      headers: getAuthHeaders(),
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
  ul.innerHTML = groupMembers.map((id, i) => {
    const initials = id.substring(0, 2).toUpperCase();
    let bg = '#555';
    if (typeof profileModule !== 'undefined' && profileModule.avatarColor) {
      bg = profileModule.avatarColor(id);
    }
    return `
      <li class="group-member-chip">
        <div class="chip-avatar" style="background: ${bg}">${initials}</div>
        <span class="chip-name">${id}</span>
        <button class="chip-remove" onclick="removeGroupMember(${i})">✕</button>
      </li>
    `;
  }).join('');
}

function removeGroupMember(index) {
  groupMembers.splice(index, 1);
  renderGroupMemberList();
}

let _groupMemberSearchTimeout = null;

window.searchGroupMembers = function (val) {
  const query = val.trim().toLowerCase();
  const suggBox = document.getElementById('groupMemberSuggestions');

  if (_groupMemberSearchTimeout) clearTimeout(_groupMemberSearchTimeout);

  if (!query) {
    suggBox.classList.add('hidden');
    return;
  }

  _groupMemberSearchTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`${API_URL}/api/users/search?q=${query}`);
      const users = await res.json();

      // Filter out self and already added members
      const filtered = users.filter(u =>
        u.randomId !== myGhostId && !groupMembers.includes(u.randomId)
      ).slice(0, 4); // Max 4 people

      suggBox.innerHTML = '';
      suggBox.classList.remove('hidden');

      if (filtered.length === 0) {
        suggBox.innerHTML = '<div class="group-suggestion-empty">No person found</div>';
        return;
      }

      filtered.forEach(u => {
        const initials = u.randomId.substring(0, 2).toUpperCase();
        let bg = '#555';
        if (typeof profileModule !== 'undefined' && profileModule.avatarColor) {
          bg = profileModule.avatarColor(u.randomId);
        }

        const item = document.createElement('div');
        item.className = 'group-suggestion-item';
        item.onclick = () => {
          document.getElementById('groupMemberInput').value = u.randomId;
          suggBox.classList.add('hidden');
          addGroupMember();
        };

        item.innerHTML = `
          <div class="group-suggestion-avatar" style="background: ${bg}">${initials}</div>
          <div class="group-suggestion-name">${u.randomId}</div>
        `;
        suggBox.appendChild(item);
      });

    } catch (e) {
      console.error(e);
    }
  }, 200);
}

async function createGroupChat() {
  const name = document.getElementById('groupNameInput').value.trim();
  const bio = document.getElementById('groupBioInput').value.trim();
  if (!name) { showToast('Enter a group name', 'error'); return; }
  if (groupMembers.length < 1) { showToast('Add at least one member', 'error'); return; }
  try {
    const members = [myGhostId, ...groupMembers];
    const res = await fetch(`${API_URL}/api/chats/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ members, type: 'group', name, bio, createdBy: myGhostId })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to create group');
    }
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
  if (!chat) return;

  if (chat.type === 'direct') {
    openUserInfo(chat);
  } else {
    openGroupInfo(chat);
  }
}

// ── Contact Panel state ────────────────────────────────────────────
let _cpPeerId = null;
let _cpChatId = null;
let _cpCurrentTab = 'media';
let _cpCategorized = { media: [], links: [], docs: [], groups: [] };

// URL regex
const URL_REGEX = /https?:\/\/[^\s]+/gi;
// Image data prefix
const IMG_PREFIX = 'data:image';
// Document MIME extensions (in file names sent as text attachments)
const DOC_EXTS = /\.(pdf|doc|docx|txt|xls|xlsx|ppt|pptx|csv|zip|rar|7z)$/i;

function categorizeMessages(messages) {
  const result = { media: [], links: [], docs: [] };
  for (const msg of messages) {
    const text = typeof msg._plaintext === 'string' ? msg._plaintext : '';
    if (!text) continue;
    if (text.startsWith(IMG_PREFIX)) {
      result.media.push({ src: text, id: msg.id, ts: msg.timestamp });
    } else if (DOC_EXTS.test(text.trim())) {
      result.docs.push({ name: text.trim(), id: msg.id, ts: msg.timestamp });
    } else {
      const urls = text.match(URL_REGEX);
      if (urls) {
        urls.forEach(url => result.links.push({ url, id: msg.id, ts: msg.timestamp }));
      }
    }
  }
  return result;
}

async function openUserInfo(chat) {
  const peerId = chat.members.find(m => m !== myGhostId);
  if (!peerId) return;

  _cpPeerId = peerId;
  _cpChatId = chat.id;
  _cpCurrentTab = 'media';

  // Set avatar
  const avatarEl = document.getElementById('cpAvatar');
  if (typeof profileModule !== 'undefined') {
    profileModule.applyAvatar(avatarEl, peerId, null);
  } else {
    avatarEl.textContent = peerId.substring(0, 2).toUpperCase();
    avatarEl.style.background = '#229ed9';
  }

  document.getElementById('cpUsername').textContent = `@${peerId}`;

  // Restore notification pref
  const muted = localStorage.getItem(`gl_muted_${peerId}`) === '1';
  document.getElementById('cpNotifToggle').checked = !muted;

  // Scan cached messages for media/links/docs
  const msgs = decryptedMessages ? (() => {
    const arr = [];
    decryptedMessages.forEach((text, id) => arr.push({ id, _plaintext: text, timestamp: 0 }));
    return arr;
  })() : [];
  const cat = categorizeMessages(msgs);

  // Common groups
  const commonGroups = activeChats.filter(c =>
    c.type === 'group' && c.members.includes(peerId) && c.members.includes(myGhostId)
  );

  _cpCategorized = { ...cat, groups: commonGroups };

  // Update tab counts
  document.getElementById('cpCount-media').textContent = cat.media.length;
  document.getElementById('cpCount-links').textContent = cat.links.length;
  document.getElementById('cpCount-docs').textContent = cat.docs.length;
  document.getElementById('cpCount-groups').textContent = commonGroups.length;

  // Show first tab
  switchCpTab('media');

  document.getElementById('contactPanel').classList.add('open');
}

function closeContactPanel() {
  document.getElementById('contactPanel').classList.remove('open');
  _cpPeerId = null;
  _cpChatId = null;
}

function switchCpTab(tab) {
  _cpCurrentTab = tab;
  ['media', 'links', 'docs', 'groups'].forEach(t => {
    document.getElementById(`cpTab-${t}`).classList.toggle('active', t === tab);
  });
  renderCpContent(tab);
}

function renderCpContent(tab) {
  const content = document.getElementById('cpContent');
  if (!content) return;

  if (tab === 'media') {
    const items = _cpCategorized.media;
    if (items.length === 0) {
      content.innerHTML = `<div class="cp-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>No media shared yet</span>
      </div>`;
    } else {
      const grid = document.createElement('div');
      grid.className = 'cp-media-grid';
      items.forEach(item => {
        const thumb = document.createElement('div');
        thumb.className = 'cp-media-thumb';
        const img = document.createElement('img');
        img.src = item.src;
        img.alt = 'media';
        img.onclick = () => window.open(item.src, '_blank');
        thumb.appendChild(img);
        grid.appendChild(thumb);
      });
      content.innerHTML = '';
      content.appendChild(grid);
    }

  } else if (tab === 'links') {
    const items = _cpCategorized.links;
    if (items.length === 0) {
      content.innerHTML = `<div class="cp-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <span>No links shared yet</span>
      </div>`;
    } else {
      content.innerHTML = items.map(item => {
        let host = item.url;
        try { host = new URL(item.url).hostname; } catch { }
        return `<div class="cp-list-item" onclick="window.open('${item.url}','_blank')">
          <div class="cp-list-icon">🔗</div>
          <div class="cp-list-info">
            <div class="cp-list-name">${host}</div>
            <div class="cp-list-sub">${item.url}</div>
          </div>
        </div>`;
      }).join('');
    }

  } else if (tab === 'docs') {
    const items = _cpCategorized.docs;
    if (items.length === 0) {
      content.innerHTML = `<div class="cp-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
        </svg>
        <span>No documents shared yet</span>
      </div>`;
    } else {
      const iconFor = name => {
        if (/\.pdf$/i.test(name)) return '📄';
        if (/\.(xls|xlsx|csv)$/i.test(name)) return '📊';
        if (/\.(ppt|pptx)$/i.test(name)) return '📑';
        if (/\.(zip|rar|7z)$/i.test(name)) return '🗜️';
        return '📝';
      };
      content.innerHTML = items.map(item => `
        <div class="cp-list-item">
          <div class="cp-list-icon">${iconFor(item.name)}</div>
          <div class="cp-list-info">
            <div class="cp-list-name">${item.name}</div>
            <div class="cp-list-sub">Document</div>
          </div>
        </div>`).join('');
    }

  } else if (tab === 'groups') {
    const groups = _cpCategorized.groups;
    if (groups.length === 0) {
      content.innerHTML = `<div class="cp-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span>No common groups</span>
      </div>`;
    } else {
      content.innerHTML = groups.map(g => {
        const initials = (g.name || '?').substring(0, 2).toUpperCase();
        return `<div class="cp-list-item" onclick="closeContactPanel(); openChatRoom('${g.id}')">
          <div class="cp-list-icon" style="font-size:0.9rem;font-weight:700">${initials}</div>
          <div class="cp-list-info">
            <div class="cp-list-name">${g.name}</div>
            <div class="cp-list-sub">${g.members.length} members</div>
          </div>
        </div>`;
      }).join('');
    }
  }
}

function toggleContactNotif(checkbox) {
  if (!_cpPeerId) return;
  localStorage.setItem(`gl_muted_${_cpPeerId}`, checkbox.checked ? '0' : '1');
}

function closeUserInfoModal() { closeContactPanel(); }
function viewUserMedia() { }
function viewCommonGroups() { }

function openGroupInfo(chat) {
  currentGroupInfo = chat;
  const isAdmin = chat.admins && chat.admins.includes(myGhostId);

  // Set hero details
  const pfpContainer = document.getElementById('gipPfp');
  if (chat.pfpBase64) {
    pfpContainer.innerHTML = `<img src="${chat.pfpBase64}" alt="Group PFP">`;
    pfpContainer.style.background = 'transparent';
  } else {
    const initials = (chat.name || '?').substring(0, 2).toUpperCase();
    pfpContainer.innerHTML = initials;
    pfpContainer.style.background = 'var(--accent-light)';
  }

  document.getElementById('gipName').textContent = chat.name;
  document.getElementById('gipBio').textContent = chat.bio || 'No group bio set.';
  document.getElementById('gipCreatedBy').textContent = `Created by: ${chat.createdBy}`;
  const d = new Date(chat.createdAt);
  document.getElementById('gipCreatedAt').textContent =
    `Created on: ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const isOwner = chat.createdBy === myGhostId;
  const editBtn = document.getElementById('gipEditBtn');
  const deleteWrap = document.getElementById('gipDeleteWrap');
  if (isOwner) {
    editBtn.classList.remove('hidden');
    if(deleteWrap) deleteWrap.classList.remove('hidden');
  } else {
    editBtn.classList.add('hidden');
    if(deleteWrap) deleteWrap.classList.add('hidden');
  }

  const shareBtn = document.getElementById('gipShareBtn');
  if (isAdmin) shareBtn.classList.remove('hidden');
  else shareBtn.classList.add('hidden');

  const addMemberWrap = document.getElementById('gipAddMemberWrap');
  if (isAdmin) addMemberWrap.classList.remove('hidden');
  else addMemberWrap.classList.add('hidden');

  document.getElementById('gipCount-members').textContent = chat.members.length;

  // Categorize Media
  const msgs = decryptedMessages ? (() => {
    const arr = [];
    decryptedMessages.forEach((text, id) => arr.push({ id, _plaintext: text, timestamp: 0 }));
    return arr;
  })() : [];
  _cpCategorized = categorizeMessages(msgs);

  document.getElementById('gipCount-media').textContent = _cpCategorized.media.length;
  document.getElementById('gipCount-links').textContent = _cpCategorized.links.length;
  document.getElementById('gipCount-docs').textContent = _cpCategorized.docs.length;

  renderGipMembers(chat);
  switchGipTab('members');

  document.getElementById('groupInfoPanel').classList.add('open');
}

function closeGroupInfo() {
  document.getElementById('groupInfoPanel').classList.remove('open');
  currentGroupInfo = null;
}

async function deleteGroup() {
  if (!currentGroupInfo) return;
  const chat = currentGroupInfo;
  if (chat.createdBy !== myGhostId) {
    showToast('Only the group creator can delete this group', 'error');
    return;
  }
  if (!confirm(`Delete "${chat.name}"? This will permanently remove all messages and cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_URL}/api/chats/${chat.id}/delete`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ requesterId: myGhostId })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete group');
    }
    closeGroupInfo();
    selectedRoomId = null;
    const chatWindow = document.getElementById('chatWindow');
    if (chatWindow) chatWindow.classList.add('no-chat-selected');
    document.body.classList.remove('chat-open');
    document.getElementById('messagesGrid').innerHTML = '';
    document.getElementById('roomTitleDisplay').textContent = 'Select a chat';
    loadActiveChats();
    showToast('Group deleted successfully');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openEditGroupModal() {
  if (!currentGroupInfo) return;
  document.getElementById('editGroupNameInput').value = currentGroupInfo.name;
  document.getElementById('editGroupBioInput').value = currentGroupInfo.bio || '';
  _tempGroupPfpBase64 = null;

  const pfpWrap = document.getElementById('editGroupPfp');

  // Camera overlay template
  const cameraOverlay = `
    <div class="pfp-overlay">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </div>`;

  if (currentGroupInfo.pfpBase64) {
    pfpWrap.innerHTML = `<img src="${currentGroupInfo.pfpBase64}" id="editGroupPfpPreview">${cameraOverlay}`;
    pfpWrap.style.background = 'transparent';
  } else {
    const initials = (currentGroupInfo.name || '?').substring(0, 2).toUpperCase();
    let bg = '#555';
    if (typeof profileModule !== 'undefined' && profileModule.avatarColor) {
      bg = profileModule.avatarColor(currentGroupInfo.name || '?');
    }
    pfpWrap.style.background = bg;
    pfpWrap.innerHTML = `
      <div class="initials-fallback">${initials}</div>
      ${cameraOverlay}`;
  }

  document.getElementById('editGroupDialog').classList.remove('hidden');
}

function closeEditGroupModal() {
  document.getElementById('editGroupDialog').classList.add('hidden');
}

let _tempGroupPfpBase64 = null;
function triggerGroupPfpUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      _tempGroupPfpBase64 = ev.target.result;
      const wrap = document.getElementById('editGroupPfp');
      wrap.innerHTML = `<img src="${_tempGroupPfpBase64}" id="editGroupPfpPreview">`;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function submitGroupEdit() {
  if (!currentGroupInfo) return;
  const name = document.getElementById('editGroupNameInput').value.trim();
  const bio = document.getElementById('editGroupBioInput').value.trim();
  if (!name) { showToast('Group name required', 'error'); return; }

  const payload = { requesterId: myGhostId, name, bio };
  if (_tempGroupPfpBase64) payload.pfpBase64 = _tempGroupPfpBase64;
  // If user removed PFP but there's no UI for removing, we just don't send it unless changed

  try {
    const res = await fetch(`${API_URL}/api/chats/${currentGroupInfo.id}/update`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to update group');
    }
    showToast('Group updated', 'success');
    closeEditGroupModal();
    _tempGroupPfpBase64 = null;
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function renderGipMembers(chat) {
  const ul = document.getElementById('gipMemberList');
  const isAdmin = chat.admins && chat.admins.includes(myGhostId);
  ul.innerHTML = chat.members.map(memberId => {
    const isCreator = memberId === chat.createdBy;
    const memberIsAdmin = chat.admins && chat.admins.includes(memberId);
    const isSelf = memberId === myGhostId;
    const initials = memberId.replace('ghost_', '').substring(0, 2).toUpperCase();
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
      headers: getAuthHeaders(),
      body: JSON.stringify({ requesterId: myGhostId, targetId })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const chat = await res.json();
    // Update local cache
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
      headers: getAuthHeaders(),
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
    const res = await fetch(`${API_URL}/api/users/${myGhostId}/chats`, {
      headers: getAuthHeaders()
    });
    activeChats = await res.json();

    const container = document.getElementById('chatsContainer');
    if (!container) return;

    if (activeChats.length === 0) {
      container.innerHTML = '<li style="font-style: italic; color: var(--text-tertiary); padding: 40px 16px; text-align: center; font-size: 0.95rem;">this feels too alone<br>talk with someone</li>';
      return;
    }

    container.innerHTML = activeChats.map(chat => {
      const title = chat.type === 'direct'
        ? chat.members.find(m => m !== myGhostId)
        : chat.name;
      const selected = chat.id === selectedRoomId ? 'active' : '';
      const unreadCount = unreadMessages.get(chat.id) || 0;
      const unreadBadge = unreadCount > 0 ? `<span class="chat-unread-badge">${unreadCount}</span>` : '';

      let avatarHtml = '';
      if (chat.type !== 'direct' && chat.pfpBase64) {
        avatarHtml = `<div class="chat-item-avatar"><img src="${chat.pfpBase64}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;"></div>`;
      } else {
        const avatarColor = chat.type === 'direct' ?
          profileModule.avatarColor(title || '?') :
          profileModule.avatarColor(chat.name || '?');
        const initials = chat.type === 'direct' ?
          profileModule.initials(title || '?') :
          profileModule.initials(chat.name || '?');
        avatarHtml = `<div class="chat-item-avatar" style="background: ${avatarColor};">${initials}</div>`;
      }

      return `<li class="${selected}" onclick="openChatRoom('${chat.id}')">
        ${avatarHtml}
        <span class="chat-item-name">${title || chat.name}</span>
        ${unreadBadge}
      </li>`;
    }).join('');
  } catch (e) {
    console.error(e);
  }
}

function goBackToSidebar(e) {
  if (e) e.stopPropagation();
  selectedRoomId = null;
  const chatWindow = document.getElementById('chatWindow');
  if (chatWindow) chatWindow.classList.add('no-chat-selected');
  document.body.classList.remove('chat-open');
  document.getElementById('roomTitleDisplay').innerText = 'Select a chat';
  const canvas = document.getElementById('roomPfpCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  document.getElementById('messagesGrid').innerHTML = '';
  closeGroupInfo();
  loadActiveChats();
}

async function openChatRoom(chatId) {
  selectedRoomId = chatId;
  const chatWindow = document.getElementById('chatWindow');
  if (chatWindow) chatWindow.classList.remove('no-chat-selected');
  document.body.classList.add('chat-open');
  const chat = activeChats.find(c => c.id === chatId);
  if (!chat) return;

  const title = chat.type === 'direct'
    ? chat.members.find(m => m !== myGhostId)
    : chat.name;
  document.getElementById('roomTitleDisplay').innerText = title;

  // Clear unread messages for this chat
  unreadMessages.delete(chatId);

  // Render avatar
  const canvas = document.getElementById('roomPfpCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const size = 64;
    canvas.width = size;
    canvas.height = size;

    if (chat.type !== 'direct' && chat.pfpBase64) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.save();
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, 0, 0, size, size);
        ctx.restore();
      };
      img.src = chat.pfpBase64;
    } else {
      const avatarColor = profileModule.avatarColor(title || '?');
      const initials = profileModule.initials(title || '?');

      // Draw colored background
      ctx.fillStyle = avatarColor;
      ctx.fillRect(0, 0, size, size);

      // Draw initials
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, size / 2, size / 2);
    }
  }

  // Load chat history
  loadActiveChats();
  await loadMessages(chatId);
}

function saveLocalSysMsg(chatId, htmlStr, timestamp) {
  const msgs = JSON.parse(localStorage.getItem(`gl_sys_${chatId}`) || '[]');
  msgs.push({ isSysMsg: true, html: htmlStr, timestamp });
  localStorage.setItem(`gl_sys_${chatId}`, JSON.stringify(msgs));
}

async function loadMessages(chatId) {
  try {
    const res = await fetch(`${API_URL}/api/chats/${chatId}/messages`, {
      headers: getAuthHeaders()
    });
    const apiMsgs = await res.json();

    // Combine with local system messages
    const sysMsgs = JSON.parse(localStorage.getItem(`gl_sys_${chatId}`) || '[]');
    const combined = [...apiMsgs, ...sysMsgs].sort((a, b) => a.timestamp - b.timestamp);

    const grid = document.getElementById('messagesGrid');
    grid.innerHTML = '';

    for (const msg of combined) {
      if (msg.isSysMsg) {
        grid.insertAdjacentHTML('beforeend', msg.html);
      } else {
        await renderMessage(msg);
      }
    }
    grid.scrollTop = grid.scrollHeight;

    // Restore Pinned Message State from chat data
    const chat = activeChats.find(c => c.id === chatId);
    if (chat && chat.pinnedMessage) {
      const pinObj = chat.pinnedMessage;
      const remainingMs = pinObj.expiresAt - Date.now();
      if (remainingMs > 0) {
        _ctxMsgId = pinObj.msgId;
        _ctxMsgText = pinObj.text;
        _pinnedMsgId = pinObj.msgId;
        const bar = document.getElementById('pinnedMessageBar');
        document.getElementById('pinnedBarText').textContent = pinObj.text;
        bar.classList.remove('hidden');
        if (_pinTimer) clearTimeout(_pinTimer);
        _pinTimer = setTimeout(() => unpinMessage(true), remainingMs);
      } else {
        unpinMessage(true);
      }
    } else {
      unpinMessage(true);
    }
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

  // Check for reply format: [GL_REPLY:Sender|Snippet]Message
  let replyBlock = '';
  const replyMatch = plaintext.match(/^\[GL_REPLY:(.*?)\|(.*?)\](.*)$/s);
  if (replyMatch) {
    const replySender = replyMatch[1].replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const replySnippet = replyMatch[2].replace(/</g, '&lt;').replace(/>/g, '&gt;');
    plaintext = replyMatch[3]; // The actual message text

    replyBlock = `
      <div class="msg-reply-block">
        <div class="msg-reply-sender">${replySender}</div>
        <div class="msg-reply-text">${replySnippet}</div>
      </div>
    `;
  }

  let content;
  if (plaintext.startsWith('data:image')) {
    content = `<img src="${plaintext}" class="max-w-[200px] rounded" style="filter: blur(0px)"/>`;
  } else {
    content = `<p>${linkifyText(plaintext)}</p>`;
  }

  // Restore Local Reactions
  let reactionsHtml = '';
  const localReactions = JSON.parse(localStorage.getItem(`gl_rx_${selectedRoomId}`) || '{}');
  const rxList = localReactions[msg.id] || [];
  if (rxList.length > 0) {
    reactionsHtml = `<div class="msg-reactions">
      ${rxList.map(em => `<span class="msg-reaction-pill" onclick="event.stopPropagation(); removeLocalReaction('${msg.id}', '${em}', this)">${em}</span>`).join('')}
    </div>`;
  }

  const html = `
    <div class="${bubbleClass}" data-msg-id="${msg.id}">
      <span class="sender">${msg.senderId}</span>
      ${replyBlock}
      ${content}
      ${reactionsHtml}
    </div>`;
  grid.insertAdjacentHTML('beforeend', html);
}

window.removeLocalReaction = function (msgId, emoji, pillEl) {
  const rxMap = JSON.parse(localStorage.getItem(`gl_rx_${selectedRoomId}`) || '{}');
  if (rxMap[msgId]) {
    rxMap[msgId] = rxMap[msgId].filter(e => e !== emoji);
    if (rxMap[msgId].length === 0) delete rxMap[msgId];
    localStorage.setItem(`gl_rx_${selectedRoomId}`, JSON.stringify(rxMap));
  }
  const container = pillEl.parentElement;
  pillEl.remove();
  if (container.children.length === 0) container.remove();
};

/** Convert raw URLs in text into clickable <a> tags */
function linkifyText(text) {
  // Escape HTML entities first to prevent XSS
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Replace URLs with anchor tags
  return escaped.replace(
    /(https?:\/\/[^\s<>"]+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>'
  );
}

/** ------------------------------------------------------------------
 *  Transmitting Data
 * ------------------------------------------------------------------ */
async function sendChatMessage() {
  const input = document.getElementById('chatMessageInput');
  let text = input.value.trim();
  if (!text || !selectedRoomId) return;

  if (_activeReplyText) {
    // Format message with hidden reply metadata block: [GL_REPLY:SenderName|Snippet]MessageText
    const shortReply = _activeReplyText.length > 50 ? _activeReplyText.substring(0, 50) + '...' : _activeReplyText;
    const sender = _activeReplySender || 'Someone';
    text = `[GL_REPLY:${sender}|${shortReply}]${text}`;
    cancelReply();
  }

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
        const res = await fetch(`${API_URL}/api/keys/${memberId}`, {
          headers: getAuthHeaders()
        });
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

// Send on Enter key
document.getElementById('chatMessageInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Media uploads
document.getElementById('mediaAttachmentInput').addEventListener('change', e => {
  const file = e.target.files[0];
  // Reset input so the same file can be re-selected after an error
  e.target.value = '';

  if (!file || !selectedRoomId) return;

  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_BYTES) {
    showToast('File too large – max 10 MB', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      await encryptAndSend(ev.target.result);
      showToast('Encrypted media shared', 'success');
    } catch (err) {
      showToast('Failed to send file: ' + err.message, 'error');
    }
  };
  reader.onerror = () => showToast('Could not read file', 'error');
  reader.readAsDataURL(file);
});

async function handleIncomingMsg(msg) {
  if (msg.chatId === selectedRoomId) {
    await renderMessage(msg);
    const grid = document.getElementById('messagesGrid');
    grid.scrollTop = grid.scrollHeight;
  } else {
    // Track unread message
    const currentUnread = unreadMessages.get(msg.chatId) || 0;
    unreadMessages.set(msg.chatId, currentUnread + 1);
    loadActiveChats();
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
    const res = await fetch(`${API_URL}/api/keys/${data.requesterId}`, {
      headers: getAuthHeaders()
    });
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
      headers: getAuthHeaders(),
      body: JSON.stringify({ members: [myGhostId, receiverId], type: 'direct' })
    });
    chat = await res.json();
  }

  const encrypted = await cryptoEngine.encryptBubble(`[Forwarded] ${original}`, aesKey);
  const recipientKeys = {};
  recipientKeys[myGhostId] = await cryptoEngine.wrapMessageKey(aesKey, myPublicKeys.publicEncryptionJWK);

  const res = await fetch(`${API_URL}/api/keys/${receiverId}`, {
    headers: getAuthHeaders()
  });
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
  setTimeout(() => toast.remove(), 2000);
}
window.showToast = showToast;

function showScreenshotAlert(detectorId) {
  const grid = document.getElementById('messagesGrid');
  if (!grid) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const htmlStr = `
    <div class="system-msg screenshot-system-msg">
      <div class="system-msg-inner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        <span><strong>${detectorId}</strong> took a screenshot of this chat</span>
        <span class="system-msg-time">${timeStr}</span>
      </div>
    </div>
  `;

  if (selectedRoomId) saveLocalSysMsg(selectedRoomId, htmlStr, now.getTime());

  const msg = document.createElement('div');
  msg.innerHTML = htmlStr;
  grid.appendChild(msg.firstElementChild);
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
  if (base64Data && base64Data !== 'ghost') img.src = base64Data;
  else {
    ctx.fillStyle = '#229ed9';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('👻', size / 2, size / 2);
  }
}

function logout() {
  localStorage.removeItem('gl_token');
  if (socket) socket.disconnect();
  document.body.classList.remove('chat-open');
  location.reload();
}

/** ------------------------------------------------------------------
 *  Live Autocomplete Search Engine
 * ------------------------------------------------------------------ */
function setupLiveSearch() {
  const input = document.getElementById('peerSearchInput');
  if (!input) return;

  let searchTimeout = null;

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = input.value.trim();

    if (!query) {
      exitSearchMode();
      return;
    }

    searchTimeout = setTimeout(() => runSearch(query), 180);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      exitSearchMode();
      input.blur();
    }
  });
}

async function runSearch(query) {
  const chatList = document.getElementById('chatsContainer');
  if (!chatList) return;

  // Enter search mode
  chatList.classList.add('search-mode');
  chatList.innerHTML = `
    <li class="search-section-label">People</li>
    <li class="search-loading">
      <span class="search-spinner"></span>
      Searching…
    </li>`;

  try {
    const res = await fetch(`${API_URL}/api/users/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error();
    const users = await res.json();

    const activePeers = new Set(
      activeChats
        .filter(c => c.type === 'direct')
        .map(c => c.members.find(m => m !== myGhostId))
        .filter(Boolean)
    );

    const filtered = users
      .filter(u => u.randomId !== myGhostId)
      .sort((a, b) => {
        const aA = activePeers.has(a.randomId);
        const bA = activePeers.has(b.randomId);
        if (aA && !bA) return -1;
        if (!aA && bA) return 1;
        return a.randomId.localeCompare(b.randomId);
      })
      .slice(0, 5);

    // Also filter existing chats by name
    const q = query.toLowerCase();
    const matchedChats = activeChats.filter(c => {
      const title = c.type === 'direct'
        ? c.members.find(m => m !== myGhostId)
        : c.name;
      return title && title.toLowerCase().includes(q);
    });

    chatList.innerHTML = '';

    if (matchedChats.length > 0) {
      const chatLabel = document.createElement('li');
      chatLabel.className = 'search-section-label';
      chatLabel.textContent = 'Chats';
      chatList.appendChild(chatLabel);

      matchedChats.forEach(chat => {
        const title = chat.type === 'direct'
          ? chat.members.find(m => m !== myGhostId)
          : chat.name;
        const li = document.createElement('li');
        li.className = 'search-result-row';
        li.onclick = () => {
          document.getElementById('peerSearchInput').value = '';
          exitSearchMode();
          openChatRoom(chat.id);
        };

        const avatarEl = document.createElement('div');
        avatarEl.className = 'search-row-avatar';
        const initials = (title || '?').substring(0, 2).toUpperCase();
        avatarEl.textContent = initials;
        if (typeof profileModule !== 'undefined' && profileModule.avatarColor) {
          avatarEl.style.background = profileModule.avatarColor(title || '');
        }

        const info = document.createElement('div');
        info.className = 'search-row-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'search-row-name';
        nameEl.textContent = title;
        const subEl = document.createElement('div');
        subEl.className = 'search-row-sub';
        subEl.textContent = chat.type === 'group' ? 'Group' : 'Direct chat';
        info.appendChild(nameEl);
        info.appendChild(subEl);

        li.appendChild(avatarEl);
        li.appendChild(info);
        chatList.appendChild(li);
      });
    }

    if (filtered.length > 0) {
      const globalLabel = document.createElement('li');
      globalLabel.className = 'search-section-label';
      globalLabel.textContent = 'Global Search';
      chatList.appendChild(globalLabel);

      filtered.forEach(user => {
        const li = document.createElement('li');
        li.className = 'search-result-row';
        li.onclick = () => openSearchResultChat(user.randomId);

        const avatarEl = document.createElement('div');
        avatarEl.className = 'search-row-avatar';
        if (typeof profileModule !== 'undefined') {
          profileModule.applyAvatar(avatarEl, user.randomId, user.pfpBase64);
        } else {
          avatarEl.textContent = user.randomId.substring(0, 2).toUpperCase();
        }

        const info = document.createElement('div');
        info.className = 'search-row-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'search-row-name';
        nameEl.textContent = `@${user.randomId}`;
        const subEl = document.createElement('div');
        subEl.className = 'search-row-sub';
        subEl.textContent = activePeers.has(user.randomId) ? 'Chatting' : 'Ghost Link user';
        info.appendChild(nameEl);
        info.appendChild(subEl);

        li.appendChild(avatarEl);
        li.appendChild(info);
        chatList.appendChild(li);
      });
    }

    if (matchedChats.length === 0 && filtered.length === 0) {
      chatList.innerHTML = `<li class="search-empty">No results for "<strong>${query}</strong>"</li>`;
    }

  } catch (e) {
    chatList.innerHTML = `<li class="search-empty">Search failed. Try again.</li>`;
  }
}

function exitSearchMode() {
  const chatList = document.getElementById('chatsContainer');
  if (chatList) {
    chatList.classList.remove('search-mode');
  }
  loadActiveChats();
}

async function openSearchResultChat(username) {
  const input = document.getElementById('peerSearchInput');
  if (input) input.value = '';
  exitSearchMode();

  const existingChat = activeChats.find(c =>
    c.type === 'direct' && c.members.includes(username)
  );

  if (existingChat) {
    openChatRoom(existingChat.id);
    return;
  }

  try {
    const resp = await fetch(`${API_URL}/api/keys/${username}`);
    if (!resp.ok) throw new Error('Ghost ID not found');
    const bundle = await resp.json();

    peerKeys.set(username, {
      publicEncryptionJWK: bundle.identityKey,
      publicSigningJWK: bundle.signedPreKey
    });

    const chatRes = await fetch(`${API_URL}/api/chats/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ members: [myGhostId, username], type: 'direct' })
    });
    if (!chatRes.ok) throw new Error('Failed to create chat');
    const chat = await chatRes.json();

    await loadActiveChats();
    openChatRoom(chat.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ===================================================================
   EMOJI PICKER ENGINE
   =================================================================== */
const EMOJI_CATEGORIES = [
  { label: '😀', name: 'Smileys', emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕'] },
  { label: '👋', name: 'People', emojis: ['👋', '🤚', '🖐', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🦷', '👀', '👁', '👅', '💋', '💘', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎'] },
  { label: '🐶', name: 'Animals', emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦗', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🦣', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿', '🦔'] },
  { label: '🍎', name: 'Food', emojis: ['🍎', '🍊', '🍋', '🍇', '🍓', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🫑', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥮', '🍢', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🧃', '🥤', '🧋', '☕', '🍵', '🫖', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾'] },
  { label: '⚽', name: 'Activities', emojis: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸', '🥌', '🎿', '⛷', '🏂', '🪂', '🏋', '🤸', '🤺', '🏊', '🚴', '🤾', '🤼', '🤽', '🤹', '🧗', '🏇', '🤺', '🤼', '⛹️', '🏌️', '🏄'] },
  { label: '✈️', name: 'Travel', emojis: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎', '🚓', '🚑', '🚒', '🚐', '🚚', '🚛', '🚜', '🏍', '🛵', '🛺', '🚲', '🛴', '🛹', '🛼', '🚁', '🛸', '🚀', '✈️', '🛩', '🛫', '🛬', '🛼', '⛵', '🚤', '🛥', '🛳', '⛴', '🚢', '🚂', '🚃', '🚄', '🚅', '🚆', '🚇', '🚈', '🚉', '🚊', '🚝', '🚞', '🚋', '🚌', '🚍', '🚎', '🏎', '🚓', '🚑', '🚒', '🛻', '🚐', '🚚', '🚛', '🚜'] },
  { label: '💡', name: 'Objects', emojis: ['⌚', '📱', '💻', '⌨', '🖥', '🖨', '🖱', '🖲', '💾', '💿', '📀', '📷', '📸', '📹', '🎥', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙', '🎚', '🎛', '🧭', '⏱', '⏲', '⏰', '🕰', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯', '💡', '🧯', '💰', '💴', '💵', '💶', '💷', '💸', '💳', '🪙', '💎', '⚖️', '🧲', '🔧', '🪛', '🔩', '⚙️', '🔗', '⛓', '🪝', '🧰', '🪤', '🗡', '🔪', '🪃', '🛡', '🧱', '🪞', '🪟', '🚪', '🪣', '🧴', '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🫧', '🪥', '🧽', '🧯', '🛒'] },
  { label: '🎉', name: 'Symbols', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '🚫', '🚳', '🚭', '🚯', '🚱', '🚷', '📵', '🔞', '☢️', '☣️', '⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️', '↕️', '↔️', '↩️', '↪️', '⤴️', '⤵️', '🔃', '🔄', '🔙', '🔚', '🔛', '🔜', '🔝', '🛐', '⚛️', '🔱', '📛', '🔰', '⭕', '✅', '☑️', '✔️', '❎', '🔲', '🔳', '▪️', '▫️', '◾', '◽', '◼️', '◻️', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🔶', '🔷', '🔸', '🔹', '🔺', '🔻', '💠', '🔘', '🔲', '🔳'] },
];

let _emojiPickerOpen = false;
let _currentEmojiCat = 0;

function toggleEmojiPicker() {
  const panel = document.getElementById('emojiPickerPanel');
  _emojiPickerOpen = !_emojiPickerOpen;
  panel.classList.toggle('hidden', !_emojiPickerOpen);
  if (_emojiPickerOpen) {
    buildEmojiPicker();
    document.getElementById('emojiSearchInput').focus();
  }
}

function buildEmojiPicker() {
  const tabs = document.getElementById('emojiCategoryTabs');
  if (tabs.children.length === 0) {
    EMOJI_CATEGORIES.forEach((cat, i) => {
      const btn = document.createElement('button');
      btn.className = 'emoji-cat-tab' + (i === 0 ? ' active' : '');
      btn.textContent = cat.label;
      btn.title = cat.name;
      btn.onclick = () => showEmojiCategory(i);
      tabs.appendChild(btn);
    });
  }
  showEmojiCategory(_currentEmojiCat);
}

function showEmojiCategory(idx) {
  _currentEmojiCat = idx;
  const tabs = document.getElementById('emojiCategoryTabs');
  [...tabs.children].forEach((t, i) => t.classList.toggle('active', i === idx));
  renderEmojiGrid(EMOJI_CATEGORIES[idx].emojis);
}

function renderEmojiGrid(emojis) {
  const grid = document.getElementById('emojiGrid');
  grid.innerHTML = '';
  emojis.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn';
    btn.textContent = em;
    btn.onclick = () => insertEmoji(em);
    grid.appendChild(btn);
  });
}

function filterEmojis(query) {
  if (!query.trim()) {
    showEmojiCategory(_currentEmojiCat);
    return;
  }
  const all = EMOJI_CATEGORIES.flatMap(c => c.emojis);
  renderEmojiGrid(all);
}

function insertEmoji(emoji) {
  const input = document.getElementById('chatMessageInput');
  if (!input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  input.value = val.slice(0, start) + emoji + val.slice(end);
  const pos = start + emoji.length;
  input.setSelectionRange(pos, pos);
  input.focus();
}

// Close emoji picker when clicking outside
document.addEventListener('click', e => {
  if (!_emojiPickerOpen) return;
  const panel = document.getElementById('emojiPickerPanel');
  const btn = document.getElementById('emojiTriggerBtn');
  if (!panel.contains(e.target) && !btn.contains(e.target)) {
    _emojiPickerOpen = false;
    panel.classList.add('hidden');
  }
});

/* ===================================================================
   MESSAGE RIGHT-CLICK CONTEXT MENU
   =================================================================== */
let _ctxMsgId = null;
let _ctxMsgText = '';
let _ctxMsgSender = '';
let _activeReplyText = null;
let _activeReplySender = null;

function setupMessageContextMenu() {
  const grid = document.getElementById('messagesGrid');
  if (!grid) return;

  grid.addEventListener('contextmenu', e => {
    const bubble = e.target.closest('.message');
    if (!bubble) return;
    e.preventDefault();

    _ctxMsgId = bubble.dataset.msgId || null;
    _ctxMsgText = bubble.querySelector('p')?.textContent || '';
    _ctxMsgSender = bubble.querySelector('.sender')?.textContent || '';

    // Reset expanded emoji grid
    const gridEl = document.getElementById('msgCtxEmojiGrid');
    if (gridEl) {
      gridEl.classList.add('hidden');
      gridEl.innerHTML = '';
    }

    const menu = document.getElementById('msgContextMenu');
    menu.classList.remove('hidden');

    // Position menu
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = e.clientX, y = e.clientY;
    menu.style.left = '0px'; menu.style.top = '0px';
    // Measure after visible
    requestAnimationFrame(() => {
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      if (x + mw > vw) x = vw - mw - 8;
      if (y + mh > vh) y = vh - mh - 8;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
    });
  });

  document.addEventListener('click', (e) => {
    // If clicking inside context menu, don't close it unless it's a specific action button handled elsewhere
    if (e.target.closest('#msgContextMenu')) return;
    document.getElementById('msgContextMenu')?.classList.add('hidden');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('msgContextMenu')?.classList.add('hidden');
  });
}

function toggleContextMenuEmojis(event) {
  event.stopPropagation();
  const gridEl = document.getElementById('msgCtxEmojiGrid');
  if (!gridEl) return;

  const isHidden = gridEl.classList.contains('hidden');
  if (isHidden) {
    if (gridEl.innerHTML === '') {
      // Build grid
      const all = EMOJI_CATEGORIES.flatMap(c => c.emojis);
      all.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn';
        btn.textContent = em;
        btn.onclick = (e) => {
          e.stopPropagation();
          sendReaction(em);
        };
        gridEl.appendChild(btn);
      });
    }
    gridEl.classList.remove('hidden');
  } else {
    gridEl.classList.add('hidden');
  }
}

function ctxCopy() {
  if (_ctxMsgText) navigator.clipboard.writeText(_ctxMsgText).then(() => showToast('Copied!', 'success'));
  document.getElementById('msgContextMenu').classList.add('hidden');
}

function ctxReply() {
  const input = document.getElementById('chatMessageInput');
  if (input && _ctxMsgText) {
    _activeReplyText = _ctxMsgText;
    _activeReplySender = _ctxMsgSender;
    const bar = document.getElementById('replyPreviewBar');
    const titleEl = document.getElementById('replyPreviewTitle');
    const textEl = document.getElementById('replyPreviewText');

    titleEl.textContent = `Replying to ${_activeReplySender || 'Message'}`;
    textEl.textContent = _ctxMsgText;

    bar.classList.remove('hidden');
    input.focus();
  }
  document.getElementById('msgContextMenu').classList.add('hidden');
}

function cancelReply() {
  _activeReplyText = null;
  _activeReplySender = null;
  document.getElementById('replyPreviewBar').classList.add('hidden');
  document.getElementById('chatMessageInput')?.focus();
}

function ctxForward() {
  if (_ctxMsgId) initiateForwardFlow(_ctxMsgId, '');
  document.getElementById('msgContextMenu').classList.add('hidden');
}

let _pinTimer = null;
let _pinnedMsgId = null;

function ctxPin() {
  document.getElementById('msgContextMenu').classList.add('hidden');
  if (!_ctxMsgId || !_ctxMsgText) return;
  document.getElementById('pinDurationModal').classList.remove('hidden');
}

function closePinModal() {
  document.getElementById('pinDurationModal').classList.add('hidden');
  document.getElementById('customPinDate').value = '';
}

function confirmPinMessage(duration) {
  closePinModal();
  if (!_ctxMsgId || !selectedRoomId) return;

  let msDuration = 0;
  if (duration === '4h') msDuration = 4 * 60 * 60 * 1000;
  else if (duration === '10h') msDuration = 10 * 60 * 60 * 1000;
  else if (duration === '24h') msDuration = 24 * 60 * 60 * 1000;
  else if (duration === 'custom') {
    const val = document.getElementById('customPinDate').value;
    if (!val) return showToast('Please select a date', 'error');
    const targetDate = new Date(val).getTime();
    msDuration = targetDate - Date.now();
    if (msDuration <= 0) return showToast('Please select a future date', 'error');
  }

  const expiresAt = Date.now() + msDuration;

  // Emit pin request to the server
  socket.emit('pin_message', {
    chatId: selectedRoomId,
    msgId: _ctxMsgId,
    text: _ctxMsgText,
    expiresAt: expiresAt
  });

  // Add inline system message to chat
  let timeStr = '';
  if (duration === '4h') timeStr = '4 hours';
  else if (duration === '10h') timeStr = '10 hours';
  else if (duration === '24h') timeStr = '24 hours';
  else {
    const val = document.getElementById('customPinDate').value;
    const dateObj = new Date(val);
    timeStr = `until ${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  const sysMsgHtml = `
    <div class="system-msg screenshot-system-msg pin-system-msg">
      <div class="system-msg-inner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="12" y1="17" x2="12" y2="22"/>
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z"/>
        </svg>
        <span><strong>You</strong> pinned a message for ${timeStr}</span>
      </div>
    </div>
  `;
  if (selectedRoomId) saveLocalSysMsg(selectedRoomId, sysMsgHtml, Date.now());

  const grid = document.getElementById('messagesGrid');
  if (grid) {
    const sysMsg = document.createElement('div');
    sysMsg.innerHTML = sysMsgHtml;
    grid.appendChild(sysMsg.firstElementChild);
    grid.scrollTop = grid.scrollHeight;
  }

  showToast('Message pinned', 'success');
}

function unpinMessage(isAuto = false) {
  if (!isAuto && selectedRoomId) {
    socket.emit('unpin_message', { chatId: selectedRoomId });
  }

  _pinnedMsgId = null;
  document.getElementById('pinnedMessageBar').classList.add('hidden');
  if (_pinTimer) {
    clearTimeout(_pinTimer);
    _pinTimer = null;
  }
  if (!isAuto) showToast('Message unpinned', 'info');
}

function scrollToPinnedMessage() {
  if (!_pinnedMsgId) return;
  const el = document.querySelector(`.message[data-msg-id="${_pinnedMsgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Highlight animation
    el.style.transition = 'background 0.3s';
    const oldBg = el.style.background;
    el.style.background = 'var(--accent-light)';
    setTimeout(() => {
      el.style.background = oldBg || '';
    }, 1500);
  } else {
    showToast('Message not found in current view', 'error');
  }
}

function ctxDelete() {
  if (_ctxMsgId) {
    const el = document.querySelector(`.message[data-msg-id="${_ctxMsgId}"]`);
    if (el) el.remove();
    showToast('Message removed from view', 'info');
  }
  document.getElementById('msgContextMenu').classList.add('hidden');
}

function sendReaction(emoji) {
  if (_ctxMsgId) {
    // Save to local storage
    if (selectedRoomId) {
      const rxMap = JSON.parse(localStorage.getItem(`gl_rx_${selectedRoomId}`) || '{}');
      if (!rxMap[_ctxMsgId]) rxMap[_ctxMsgId] = [];
      if (!rxMap[_ctxMsgId].includes(emoji)) {
        rxMap[_ctxMsgId].push(emoji);
        localStorage.setItem(`gl_rx_${selectedRoomId}`, JSON.stringify(rxMap));
      } else {
        // Already reacted with this emoji
        document.getElementById('msgContextMenu').classList.add('hidden');
        return;
      }
    }

    const el = document.querySelector(`.message[data-msg-id="${_ctxMsgId}"]`);
    if (el) {
      let reactionContainer = el.querySelector('.msg-reactions');
      if (!reactionContainer) {
        reactionContainer = document.createElement('div');
        reactionContainer.className = 'msg-reactions';
        el.appendChild(reactionContainer);
      }
      const pill = document.createElement('span');
      pill.className = 'msg-reaction-pill';
      pill.textContent = emoji;
      // Tap again to remove
      pill.onclick = (e) => {
        e.stopPropagation();
        if (selectedRoomId) removeLocalReaction(_ctxMsgId, emoji, pill);
      };
      reactionContainer.appendChild(pill);
    }
  }
  document.getElementById('msgContextMenu').classList.add('hidden');
}

function switchGipTab(tab) {
  ['members', 'media', 'links', 'docs'].forEach(t => {
    const elTab = document.getElementById('gipTab-' + t);
    const elView = document.getElementById('gipView-' + t);
    if (elTab) elTab.classList.toggle('active', t === tab);
    if (elView) elView.classList.toggle('active', t === tab);
  });

  if (tab === 'media') renderGipMedia();
  else if (tab === 'links') renderGipLinks();
  else if (tab === 'docs') renderGipDocs();
}

function renderGipMedia() {
  const container = document.getElementById('gipMediaGrid');
  const items = _cpCategorized ? _cpCategorized.media : [];
  if (!items || items.length === 0) {
    container.className = '';
    container.innerHTML = '<div class="cp-empty"><span>No media shared yet</span></div>';
    return;
  }
  container.className = 'cp-media-grid';
  container.innerHTML = '';
  items.forEach(item => {
    const thumb = document.createElement('div');
    thumb.className = 'cp-media-thumb';
    const img = document.createElement('img');
    img.src = item.src;
    img.onclick = () => window.open(item.src, '_blank');
    thumb.appendChild(img);
    container.appendChild(thumb);
  });
}

function renderGipLinks() {
  const container = document.getElementById('gipLinksList');
  const items = _cpCategorized ? _cpCategorized.links : [];
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="cp-empty"><span>No links shared yet</span></div>';
    return;
  }
  container.innerHTML = items.map(item => {
    let host = item.url;
    try { host = new URL(item.url).hostname; } catch { }
    return `<div class="cp-list-item" onclick="window.open('${item.url}','_blank')">
      <div class="cp-list-icon">🔗</div>
      <div class="cp-list-info">
        <div class="cp-list-name">${host}</div>
        <div class="cp-list-sub">${item.url}</div>
      </div>
    </div>`;
  }).join('');
}

function renderGipDocs() {
  const container = document.getElementById('gipDocsList');
  const items = _cpCategorized ? _cpCategorized.docs : [];
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="cp-empty"><span>No documents shared yet</span></div>';
    return;
  }
  container.innerHTML = items.map(item =>
    '<div class="cp-list-item">' +
    '<div class="cp-list-icon">📄</div>' +
    '<div class="cp-list-info">' +
    '<div class="cp-list-name">' + item.name + '</div>' +
    '<div class="cp-list-sub">Document</div>' +
    '</div>' +
    '</div>').join('');
}

let _gipAddMemberTarget = null;
let _gipAddTimer = null;
async function searchAddGroupMember(query) {
  const sugg = document.getElementById('gipAddMemberSuggestions');
  clearTimeout(_gipAddTimer);
  _gipAddMemberTarget = null;
  if (!query) {
    sugg.innerHTML = '';
    sugg.classList.add('hidden');
    return;
  }
  _gipAddTimer = setTimeout(async () => {
    try {
      const res = await fetch(API_URL + '/api/users/search?q=' + encodeURIComponent(query));
      const users = await res.json();

      const filtered = users.filter(u =>
        u.randomId !== myGhostId &&
        (!currentGroupInfo || !currentGroupInfo.members.includes(u.randomId))
      ).slice(0, 4);

      if (filtered.length === 0) {
        sugg.innerHTML = `<div class="suggestion-item" style="color:var(--text-tertiary); text-align:center;">No person found</div>`;
        sugg.classList.remove('hidden');
        return;
      }

      sugg.innerHTML = filtered.map(u => {
        return `<div class="suggestion-item" onclick="selectGipAddMember('${u.randomId}')">${u.randomId}</div>`;
      }).join('');

      sugg.classList.remove('hidden');
    } catch (e) { console.error(e); }
  }, 300);
}

function selectGipAddMember(userId) {
  _gipAddMemberTarget = userId;
  document.getElementById('gipAddMemberInput').value = userId;
  document.getElementById('gipAddMemberSuggestions').classList.add('hidden');
}

async function submitAddMember() {
  if (!_gipAddMemberTarget || !currentGroupInfo) return;
  try {
    const res = await fetch(API_URL + '/api/chats/' + currentGroupInfo.id + '/add-member', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        requesterId: myGhostId,
        targetId: _gipAddMemberTarget
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add member');
    }
    showToast('Member added', 'success');
    document.getElementById('gipAddMemberInput').value = '';
    _gipAddMemberTarget = null;
  } catch (e) {
    showToast(e.message, 'error');
  }
}


function openShareModal() {
  if (!currentGroupInfo || currentGroupInfo.type !== 'group') return;
  const link = window.location.origin + '/?join=' + currentGroupInfo.id + '&t=' + (currentGroupInfo.inviteToken || 'N/A_PleaseReset');
  document.getElementById('shareLinkInput').value = link;

  const isOwner = currentGroupInfo.createdBy === myGhostId;
  const resetBtn = document.getElementById('shareResetBtn');
  if (isOwner) resetBtn.classList.remove('hidden');
  else resetBtn.classList.add('hidden');

  document.getElementById('shareGroupDialog').classList.remove('hidden');
}

function closeShareModal() {
  document.getElementById('shareGroupDialog').classList.add('hidden');
}

function copyInviteLink() {
  const input = document.getElementById('shareLinkInput');
  input.select();
  input.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(input.value);
  showToast('Link copied to clipboard', 'success');
}

async function resetInviteLink() {
  if (!currentGroupInfo) return;
  try {
    const res = await fetch(API_URL + '/api/chats/' + currentGroupInfo.id + '/reset-invite', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ requesterId: myGhostId })
    });
    if (!res.ok) throw new Error('Failed to reset link');
    const updatedChat = await res.json();
    currentGroupInfo = updatedChat;
    const link = window.location.origin + '/?join=' + currentGroupInfo.id + '&t=' + (currentGroupInfo.inviteToken || 'N/A_PleaseReset');
    document.getElementById('shareLinkInput').value = link;
    showToast('Invite link reset successfully', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function checkInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const joinId = params.get('join');
  const token = params.get('t');
  if (joinId && token && myGhostId) {
    try {
      const res = await fetch(API_URL + '/api/chats/' + joinId + '/join', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ targetId: myGhostId, token })
      });
      if (res.ok) {
        showToast('Successfully joined the group!', 'success');
      }
    } catch (e) { }
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}









/**
 * Ghost Link – Profile Module
 * Handles the Telegram-style profile drawer, avatar, bio, PFP upload, privacy settings.
 */

window.profileModule = (() => {
  const API = ''; // served from same origin
  let _profile = null; // cached profile data
  let _checkTimeout = null;

  // ── Avatar Helpers ─────────────────────────────────────────────────

  /** Generate a stable HSL color from any string */
  function avatarColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 45%)`;
  }

  /** Get initials (up to 2 chars) from a username */
  function initials(username) {
    if (!username) return '?';
    return username.replace(/[^a-z0-9]/gi, '').substring(0, 2).toUpperCase();
  }

  /** Apply avatar (initials or photo) to an element */
  function applyAvatar(el, username, pfpBase64) {
    if (!el) return;
    el.style.background = pfpBase64 ? 'transparent' : avatarColor(username || '?');
    if (pfpBase64) {
      el.innerHTML = `<img src="${pfpBase64}" alt="pfp" />`;
    } else {
      el.innerHTML = initials(username);
    }
  }

  /** Refresh the small sidebar avatar button */
  function refreshSidebarAvatar() {
    if (!_profile) return;
    const el = document.getElementById('sidebarAvatar');
    const nameEl = document.getElementById('profileBtnName');
    if (el) applyAvatar(el, _profile.username, _profile.pfpBase64);
    if (nameEl) nameEl.textContent = _profile.username;
  }

  // ── API Helpers ────────────────────────────────────────────────────

  function _defaultPrivacy() {
    return {
      profilePhoto:      'everyone',
      lastSeen:          'everyone',
      onlineStatus:      false,
      readReceipts:      true,
      whoCanAddToGroups: 'everyone',
      messageForwarding: false,
    };
  }

  function authHeaders() {
    const token = localStorage.getItem('gl_token');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async function fetchProfile() {
    const r = await fetch(`${API}/api/profile/me`, { headers: authHeaders() });
    if (!r.ok) return null;
    return r.json();
  }

  async function patchProfile(updates) {
    const r = await fetch(`${API}/api/profile/me`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(updates)
    });
    return r.ok ? r.json() : null;
  }

  async function patchPrivacy(settings) {
    const r = await fetch(`${API}/api/profile/me/privacy`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(settings)
    });
    return r.ok ? r.json() : null;
  }

  // ── Drawer Rendering ───────────────────────────────────────────────

  function renderDrawer() {
    if (!_profile) return;
    const { username, bio, pfpBase64, privacySettings: priv } = _profile;

    // Large avatar in header
    const avatarLg = document.getElementById('drawerAvatarLg');
    if (avatarLg) applyAvatar(avatarLg, username, pfpBase64);

    // Name
    const nameEl = document.getElementById('drawerUsername');
    if (nameEl) nameEl.textContent = username;

    // Copyable Details
    const detailUser = document.getElementById('detailUsername');
    const detailBio  = document.getElementById('detailBio');
    if (detailUser) detailUser.textContent = `@${username}`;
    if (detailBio)  detailBio.textContent  = bio || 'Please add bio';

    // Privacy toggles
    _setToggle('privPhoto',    priv.profilePhoto      === 'everyone');
    _setToggle('privLastSeen', priv.lastSeen           === 'everyone');
    _setToggle('privOnline',   priv.onlineStatus);
    _setToggle('privReceipts', priv.readReceipts);
    _setToggle('privGroups',   priv.whoCanAddToGroups  === 'everyone');
    _setToggle('privForward',  priv.messageForwarding);
  }

  function _setToggle(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
  }

  // ── Public API ─────────────────────────────────────────────────────

  async function init(username) {
    _profile = await fetchProfile();
    if (!_profile) {
      // Fallback: build minimal profile from username
      _profile = { username, bio: '', pfpBase64: null, privacySettings: _defaultPrivacy() };
    } else {
      // Merge defaults so old accounts missing new fields still work
      _profile.privacySettings = { ..._defaultPrivacy(), ..._profile.privacySettings };
    }
    refreshSidebarAvatar();
  }

  function open() {
    const drawer = document.getElementById('profileDrawer');
    if (drawer) {
      drawer.classList.add('open');
      renderDrawer();
      slidePanel('main'); // default to main panel
    }
  }

  function close() {
    const drawer = document.getElementById('profileDrawer');
    if (drawer) drawer.classList.remove('open');
  }

  function triggerPfpUpload() {
    const input = document.getElementById('pfpFileInput');
    if (input) input.click();
  }

  async function handlePfpUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    // Resize + convert to base64
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = await _resizeImage(e.target.result, 256);
      const updated = await patchProfile({ pfpBase64: base64 });
      if (updated) {
        _profile = updated;
        renderDrawer();
        refreshSidebarAvatar();
      }
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  function _resizeImage(dataUrl, maxSize) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale  = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width  = img.width  * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = dataUrl;
    });
  }

  async function savePrivacy(key, value) {
    if (!_profile) return;

    // Optimistically update local cache so toggle feels instant
    _profile.privacySettings = { ..._profile.privacySettings, [key]: value };

    const updated = await patchPrivacy({ [key]: value });
    if (updated) {
      // Merge server response back with defaults so no field is ever missing
      _profile.privacySettings = { ..._defaultPrivacy(), ...updated };
    } else {
      // Revert the optimistic update on failure
      _profile.privacySettings = { ..._profile.privacySettings, [key]: !value };
      if (typeof window.showToast === 'function') {
        window.showToast('Failed to save privacy setting', 'error');
      }
    }
  }

  /** Return the current pfpBase64 (for use in chat avatars etc.) */
  function getPfp() { return _profile ? _profile.pfpBase64 : null; }
  function getUsername() { return _profile ? _profile.username : null; }

  /** Apply avatar to any element by username (for chat list items etc.) */
  function applyAvatarExternal(el, username, pfpBase64) {
    applyAvatar(el, username, pfpBase64);
  }

  // ── Sliding Nested Panels & Custom Options ─────────────────────────

  function slidePanel(panelName) {
    const container = document.getElementById('profilePanelContainer');
    if (!container) return;
    let pct = 0;
    if (panelName === 'username') pct = -25;
    else if (panelName === 'privacy') pct = -50;
    else if (panelName === 'support') pct = -75;
    container.style.transform = `translateX(${pct}%)`;

    // Prefill fields when entering the Edit Profile subpanel
    if (panelName === 'username' && _profile) {
      const input = document.getElementById('changeUsernameInput');
      const bioInput = document.getElementById('editBioInput');
      const status = document.getElementById('changeUsernameStatus');
      const btn = document.getElementById('changeUsernameSubmitBtn');

      if (input) input.value = _profile.username;
      if (bioInput) bioInput.value = _profile.bio || '';
      if (status) {
        status.textContent = '';
        status.className = 'username-status';
      }
      if (btn) btn.disabled = false; // Enabled by default as existing is valid
    }
  }

  function checkUsername(name) {
    clearTimeout(_checkTimeout);
    const status = document.getElementById('changeUsernameStatus');
    const btn = document.getElementById('changeUsernameSubmitBtn');
    if (!status || !btn) return;

    if (!name || name.length < 3 || name.length > 20 || !/^[a-z0-9_]+$/.test(name)) {
      status.textContent = '3–20 chars, lowercase, numbers, underscores only';
      status.style.color = '#ef4444';
      btn.disabled = true;
      return;
    }

    if (name === _profile.username) {
      status.textContent = '';
      status.style.color = '#10b981';
      btn.disabled = false;
      return;
    }

    status.textContent = 'Checking availability...';
    status.style.color = 'var(--text-secondary)';
    btn.disabled = true;

    _checkTimeout = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/api/auth/check-username?name=${name}`);
        const data = await r.json();
        if (data.available) {
          status.textContent = `✓ @${name} is available!`;
          status.style.color = '#10b981';
          btn.disabled = false;
        } else {
          status.textContent = data.reason || `✕ @${name} is already taken`;
          status.style.color = '#ef4444';
          btn.disabled = true;
        }
      } catch (err) {
        status.textContent = 'Error checking username';
        status.style.color = '#ef4444';
      }
    }, 400);
  }

  async function submitProfileChanges() {
    const input = document.getElementById('changeUsernameInput');
    const bioInput = document.getElementById('editBioInput');
    if (!input || !bioInput || !_profile) return;

    const newUsername = input.value.trim();
    const newBio = bioInput.value.trim().slice(0, 120);

    try {
      // 1. If username changed, claim the new username
      if (newUsername && newUsername !== _profile.username) {
        const r = await fetch(`${API}/api/profile/change-username`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ newUsername })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed to update username');

        _profile.username = data.username;
        localStorage.setItem('gl_token', data.token);

        if (window.myGhostId !== undefined) {
          window.myGhostId = data.username;
        }
      }

      // 2. Always patch the bio
      const updated = await patchProfile({ bio: newBio });
      if (updated) {
        _profile = updated;
      }

      renderDrawer();
      refreshSidebarAvatar();
      slidePanel('main');

      if (typeof window.showToast === 'function') {
        window.showToast('Profile updated successfully!', 'success');
      } else {
        alert('Profile updated successfully!');
      }
    } catch (err) {
      alert(err.message);
    }
  }

  function copyDetail(type) {
    if (!_profile) return;
    let val = '';
    let label = '';
    if (type === 'username') {
      val = `@${_profile.username}`;
      label = 'Username';
    } else if (type === 'bio') {
      val = _profile.bio || '';
      label = 'Bio';
    }
    if (!val) return;

    navigator.clipboard.writeText(val).then(() => {
      if (typeof window.showToast === 'function') {
        window.showToast(`${label} copied to clipboard`, 'success');
      } else {
        alert(`${label} copied to clipboard`);
      }
    });
  }

  async function sendFeedback() {
    const ta = document.getElementById('feedbackTextarea');
    if (!ta) return;
    const feedback = ta.value.trim();
    if (!feedback) return;

    try {
      const r = await fetch(`${API}/api/profile/feedback`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ feedback })
      });
      if (!r.ok) throw new Error('Failed to send feedback');
      ta.value = '';
      alert('Thank you! Feedback received successfully.');
    } catch (err) {
      alert(err.message);
    }
  }

  function openDeleteModal() {
    const modal = document.getElementById('deleteAccountModal');
    if (modal) modal.style.display = 'flex';
  }

  function closeDeleteModal() {
    const modal = document.getElementById('deleteAccountModal');
    if (modal) modal.style.display = 'none';
  }

  async function confirmDeleteAccount() {
    closeDeleteModal();
    try {
      const r = await fetch(`${API}/api/profile/delete-account`, {
        method: 'POST',
        headers: authHeaders()
      });
      if (!r.ok) throw new Error('Failed to delete account');
      alert('Your account has been deleted successfully.');
      
      if (typeof window.logout === 'function') {
        window.logout();
      } else {
        localStorage.clear();
        window.location.reload();
      }
    } catch (err) {
      alert(err.message);
    }
  }

  return { 
    init, 
    open, 
    close, 
    triggerPfpUpload, 
    handlePfpUpload, 
    savePrivacy, 
    getPfp, 
    getUsername, 
    applyAvatar: applyAvatarExternal, 
    avatarColor, 
    initials,
    slidePanel,
    checkUsername,
    submitProfileChanges,
    copyDetail,
    sendFeedback,
    openDeleteModal,
    closeDeleteModal,
    confirmDeleteAccount,
    getPrivacySettings: () => _profile?.privacySettings || _defaultPrivacy()
  };
})();

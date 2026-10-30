(() => {
  'use strict';

  const API_URL = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || '').trim();
  const PASSWORD_KEY = 'mynotes.password';
  const THEME_KEY = 'mynotes.theme';
  const COLORS = ['default', 'yellow', 'green', 'blue', 'pink', 'purple'];
  const MAX_CONTENT = 49000;

  // Enkripsi sisi-klien
  const ENC_PREFIX = 'enc:v1:';
  const VAULT_CHECK_TEXT = 'my-notes-vault-v1';
  const PBKDF2_ITERATIONS = 600000;
  const AUTO_LOCK_MS = 10 * 60 * 1000;

  const PIN_ICON = '<svg viewBox="0 0 24 24"><path d="M16 3H8v2h1v6l-3 3v2h5v6l1 1 1-1v-6h5v-2l-3-3V5h1V3Z"/></svg>';
  const LOCKED_ICON = '<svg viewBox="0 0 24 24"><path d="M17 9V7A5 5 0 0 0 7 7v2H5v12h14V9h-2ZM9 7a3 3 0 0 1 6 0v2H9V7Zm4 9.7V19h-2v-2.3a2 2 0 1 1 2 0Z"/></svg>';
  const UNLOCKED_ICON = '<svg viewBox="0 0 24 24"><path d="M9 9V7a3 3 0 0 1 5.8-1.1l1.9-.6A5 5 0 0 0 7 7v2H5v12h14V9H9Zm4 7.7V19h-2v-2.3a2 2 0 1 1 2 0Z"/></svg>';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    loginView: $('#login-view'),
    loginForm: $('#login-form'),
    loginPassword: $('#login-password'),
    loginRemember: $('#login-remember'),
    loginError: $('#login-error'),
    loginBtn: $('#login-btn'),
    configWarning: $('#config-warning'),
    appView: $('#app-view'),
    search: $('#search'),
    tags: $('#tags'),
    notes: $('#notes'),
    loading: $('#loading'),
    empty: $('#empty'),
    lockBtn: $('#lock-btn'),
    editor: $('#editor'),
    editorForm: $('#editor-form'),
    title: $('#note-title'),
    content: $('#note-content'),
    tag: $('#note-tag'),
    tagList: $('#tag-list'),
    colors: $('#note-colors'),
    pinned: $('#note-pinned'),
    encrypted: $('#note-encrypted'),
    info: $('#editor-info'),
    saveBtn: $('#save-btn'),
    deleteBtn: $('#delete-btn'),
    vault: $('#vault'),
    vaultForm: $('#vault-form'),
    vaultTitle: $('#vault-title'),
    vaultDesc: $('#vault-desc'),
    vaultWarning: $('#vault-warning'),
    vaultPassword: $('#vault-password'),
    vaultConfirmField: $('#vault-confirm-field'),
    vaultConfirm: $('#vault-confirm'),
    vaultError: $('#vault-error'),
    vaultSubmit: $('#vault-submit'),
    toast: $('#toast'),
  };

  const state = {
    password: null,
    notes: [],
    query: '',
    tag: '',
    editingId: null,
    color: 'default',
    vault: null, // { salt, iterations, check } dari server
    key: null, // CryptoKey AES-GCM, hanya di memori
  };

  // ---------- Storage (bisa gagal di mode privat) ----------
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch { /* abaikan */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* abaikan */ } },
  };

  // ---------- API ----------
  async function api(action, payload = {}) {
    let res;
    try {
      // text/plain menghindari CORS preflight yang tidak didukung Apps Script.
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, password: state.password, ...payload }),
      });
    } catch {
      throw new Error(navigator.onLine
        ? 'Tidak dapat terhubung ke server. Periksa koneksi & API_URL.'
        : 'Anda sedang offline. Sambungkan internet lalu coba lagi.');
    }
    if (!res.ok) throw new Error(`Server error (HTTP ${res.status}).`);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('Respons server tidak valid. Pastikan Web App diakses "Anyone".');
    }
    if (!data.ok) {
      const err = new Error(data.error || 'Terjadi kesalahan.');
      err.code = data.code;
      throw err;
    }
    return data;
  }

  // ---------- Crypto (Web Crypto API) ----------
  const textEnc = new TextEncoder();
  const textDec = new TextDecoder();
  const cryptoAvailable = !!(window.crypto && crypto.subtle);

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', textEnc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(salt), iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptText(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEnc.encode(text)));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return bytesToB64(out);
  }

  async function decryptText(key, b64) {
    const data = b64ToBytes(b64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, key, data.subarray(12));
    return textDec.decode(pt);
  }

  // ---------- Model catatan ----------
  // Catatan terenkripsi disimpan di server dengan title kosong dan
  // content = ENC_PREFIX + base64(iv || ciphertext) dari JSON {title, content}.
  async function hydrate(raw) {
    const note = { ...raw, encrypted: false, locked: false, broken: false, cipher: null };
    if (String(raw.content).startsWith(ENC_PREFIX)) {
      Object.assign(note, { encrypted: true, locked: true, cipher: raw.content.slice(ENC_PREFIX.length), title: '', content: '' });
      if (state.key) await decryptNote(note);
    }
    return note;
  }

  async function decryptNote(note) {
    try {
      const data = JSON.parse(await decryptText(state.key, note.cipher));
      note.title = String(data.title || '');
      note.content = String(data.content || '');
      note.locked = false;
      note.broken = false;
    } catch {
      note.locked = true;
      note.broken = true;
    }
  }

  async function setNotes(rawNotes) {
    state.notes = await Promise.all(rawNotes.map(hydrate));
  }

  async function upsertRaw(raw) {
    const note = await hydrate(raw);
    const i = state.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.notes[i] = note;
    else state.notes.push(note);
  }

  async function buildPayload(fields) {
    const base = { id: fields.id, tag: fields.tag, color: fields.color, pinned: fields.pinned };
    if (!fields.encrypted) return { ...base, title: fields.title, content: fields.content };
    const cipher = await encryptText(state.key, JSON.stringify({ title: fields.title, content: fields.content }));
    return { ...base, title: '', content: ENC_PREFIX + cipher };
  }

  // ---------- Helpers ----------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const dateFmt = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  function formatDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : dateFmt.format(d);
  }

  let toastTimer;
  function toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', isError);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), isError ? 4000 : 2200);
  }

  function handleError(err) {
    if (err.code === 'UNAUTHORIZED') {
      logout();
      showLoginError('Sesi tidak valid. Silakan masuk lagi.');
      return;
    }
    toast(err.message, true);
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set(THEME_KEY, next);
  }

  // ---------- Auth ----------
  function showLoginError(msg) {
    els.loginError.textContent = msg;
    els.loginError.hidden = !msg;
  }

  function showLogin() {
    els.appView.hidden = true;
    els.loginView.hidden = false;
    els.loginPassword.value = '';
    els.loginPassword.focus();
  }

  function showApp() {
    els.loginView.hidden = true;
    els.appView.hidden = false;
    showLoginError('');
  }

  async function login(password, remember) {
    state.password = password;
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = 'Memeriksa…';
    try {
      const data = await api('list');
      state.vault = data.vault;
      await setNotes(data.notes);
      if (remember) store.set(PASSWORD_KEY, password);
      showApp();
      render();
      return true;
    } catch (err) {
      state.password = null;
      store.remove(PASSWORD_KEY);
      showLogin();
      showLoginError(err.message);
      return false;
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = 'Masuk';
    }
  }

  function logout() {
    lockVault(true);
    state.password = null;
    state.notes = [];
    state.vault = null;
    store.remove(PASSWORD_KEY);
    if (els.editor.open) els.editor.close();
    if (els.vault.open) els.vault.close();
    showLogin();
  }

  async function refresh() {
    els.loading.hidden = false;
    els.notes.innerHTML = '';
    els.empty.hidden = true;
    try {
      const data = await api('list');
      state.vault = data.vault;
      await setNotes(data.notes);
      toast('Catatan diperbarui');
    } catch (err) {
      handleError(err);
    } finally {
      els.loading.hidden = true;
      render();
    }
  }

  // ---------- Vault (master password) ----------
  let vaultResolve = null;
  let autoLockTimer = null;

  function showVaultError(msg) {
    els.vaultError.textContent = msg;
    els.vaultError.hidden = !msg;
  }

  /** Meminta master password. Resolve true jika berhasil dibuka. */
  function unlockVault() {
    if (state.key) return Promise.resolve(true);
    if (!cryptoAvailable) {
      toast('Browser tidak mendukung enkripsi (butuh HTTPS).', true);
      return Promise.resolve(false);
    }
    const setup = !state.vault;
    els.vaultTitle.textContent = setup ? 'Buat master password' : 'Buka catatan terenkripsi';
    els.vaultDesc.textContent = setup
      ? 'Master password dipakai untuk mengenkripsi catatan di browser Anda sebelum dikirim ke Spreadsheet.'
      : 'Masukkan master password untuk membuka catatan terenkripsi.';
    els.vaultWarning.hidden = !setup;
    els.vaultConfirmField.hidden = !setup;
    els.vaultConfirm.required = setup;
    els.vaultSubmit.textContent = setup ? 'Buat' : 'Buka';
    els.vaultPassword.value = '';
    els.vaultConfirm.value = '';
    showVaultError('');
    els.vault.showModal();
    els.vaultPassword.focus();
    return new Promise((resolve) => { vaultResolve = resolve; });
  }

  function finishVault(result) {
    if (els.vault.open) els.vault.close();
    if (vaultResolve) vaultResolve(result);
    vaultResolve = null;
  }

  async function submitVault() {
    const pwd = els.vaultPassword.value;
    const setup = !state.vault;
    if (setup) {
      if (pwd.length < 10) return showVaultError('Master password minimal 10 karakter.');
      if (pwd !== els.vaultConfirm.value) return showVaultError('Konfirmasi master password tidak sama.');
    }

    els.vaultSubmit.disabled = true;
    els.vaultSubmit.textContent = 'Memproses…';
    showVaultError('');
    try {
      let key;
      if (setup) {
        const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
        key = await deriveKey(pwd, salt, PBKDF2_ITERATIONS);
        const check = await encryptText(key, VAULT_CHECK_TEXT);
        const data = await api('initVault', { vault: { salt, iterations: PBKDF2_ITERATIONS, check } });
        state.vault = data.vault;
      } else {
        key = await deriveKey(pwd, state.vault.salt, state.vault.iterations);
        let ok = false;
        try { ok = (await decryptText(key, state.vault.check)) === VAULT_CHECK_TEXT; } catch { /* salah */ }
        if (!ok) {
          showVaultError('Master password salah.');
          return;
        }
      }

      state.key = key;
      await Promise.all(state.notes.filter((n) => n.encrypted).map(decryptNote));
      resetAutoLock();
      render();
      finishVault(true);
      toast(setup ? 'Master password dibuat' : 'Catatan terenkripsi dibuka');
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') {
        finishVault(false);
        handleError(err);
      } else {
        showVaultError(err.message || 'Gagal memproses master password.');
      }
    } finally {
      els.vaultSubmit.disabled = false;
      els.vaultSubmit.textContent = setup && !state.vault ? 'Buat' : 'Buka';
    }
  }

  function lockVault(silent = false) {
    if (!state.key) return;
    state.key = null;
    clearTimeout(autoLockTimer);
    state.notes.forEach((n) => {
      if (n.encrypted) Object.assign(n, { title: '', content: '', locked: true });
    });
    const editing = state.notes.find((n) => n.id === state.editingId);
    if (els.editor.open && (els.encrypted.checked || (editing && editing.encrypted))) els.editor.close();
    render();
    if (!silent) toast('Catatan terenkripsi dikunci');
  }

  function resetAutoLock() {
    if (!state.key) return;
    clearTimeout(autoLockTimer);
    autoLockTimer = setTimeout(() => lockVault(), AUTO_LOCK_MS);
  }

  function renderLockBtn() {
    const unlocked = !!state.key;
    const label = unlocked ? 'Kunci catatan terenkripsi' : 'Buka catatan terenkripsi';
    els.lockBtn.innerHTML = unlocked ? UNLOCKED_ICON : LOCKED_ICON;
    els.lockBtn.classList.toggle('unlocked', unlocked);
    els.lockBtn.title = label;
    els.lockBtn.setAttribute('aria-label', label);
  }

  // ---------- Render ----------
  function getTags() {
    return [...new Set(state.notes.map((n) => n.tag).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function renderTags() {
    const tags = getTags();
    if (state.tag && !tags.includes(state.tag)) state.tag = '';
    const chips = [{ label: 'Semua', value: '' }, ...tags.map((t) => ({ label: t, value: t }))];
    els.tags.innerHTML = chips
      .map((c) => `<button class="tag-chip" role="tab" data-tag="${escapeHtml(c.value)}" aria-selected="${c.value === state.tag}">${escapeHtml(c.label)}</button>`)
      .join('');
    els.tagList.innerHTML = tags.map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
  }

  function noteCard(n) {
    let title;
    let body;
    if (n.locked) {
      title = '<h3>🔒 Catatan terenkripsi</h3>';
      body = n.broken && state.key
        ? '<p>Gagal didekripsi dengan master password ini.</p>'
        : '<p>Klik untuk membuka dengan master password.</p>';
    } else {
      title = n.title ? `<h3>${escapeHtml(n.title)}</h3>` : '';
      body = n.content ? `<p>${escapeHtml(n.content)}</p>` : '';
    }
    const lockBadge = n.encrypted && !n.locked ? '<span class="note-lock" title="Terenkripsi">🔒</span> ' : '';
    const tag = n.tag ? `<span class="note-tag">${escapeHtml(n.tag)}</span>` : '<span></span>';
    return `
      <article class="note ${n.locked ? 'locked' : ''}" tabindex="0" data-id="${escapeHtml(n.id)}" data-color="${escapeHtml(n.color)}">
        <button class="icon-btn pin-btn ${n.pinned ? 'active' : ''}" data-action="pin"
          title="${n.pinned ? 'Lepas sematan' : 'Sematkan'}" aria-label="${n.pinned ? 'Lepas sematan' : 'Sematkan'}">${PIN_ICON}</button>
        ${title}${body}
        <div class="note-footer">${tag}<span>${lockBadge}<time>${formatDate(n.updatedAt)}</time></span></div>
      </article>`;
  }

  function render() {
    renderTags();
    renderLockBtn();

    const q = state.query.toLowerCase();
    const list = state.notes
      .filter((n) => !state.tag || n.tag === state.tag)
      .filter((n) => !q || `${n.title}\n${n.content}\n${n.tag}`.toLowerCase().includes(q))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    const pinned = list.filter((n) => n.pinned);
    const others = list.filter((n) => !n.pinned);

    let html = '';
    if (pinned.length) {
      html += `<div class="section-label">Disematkan</div><div class="notes">${pinned.map(noteCard).join('')}</div>`;
      if (others.length) html += '<div class="section-label">Lainnya</div>';
    }
    html += `<div class="notes">${others.map(noteCard).join('')}</div>`;
    els.notes.innerHTML = list.length ? html : '';

    els.empty.hidden = list.length > 0;
    if (!list.length) {
      els.empty.textContent = state.notes.length
        ? 'Tidak ada catatan yang cocok.'
        : 'Belum ada catatan. Klik "+ Catatan baru" untuk mulai menulis.';
    }
  }

  // ---------- Editor ----------
  function renderColors() {
    els.colors.innerHTML = COLORS.map((c) =>
      `<button type="button" class="swatch" role="radio" data-color="${c}" aria-checked="${c === state.color}"
        aria-label="${c}" title="${c}" style="background: var(--note-${c})"></button>`).join('');
    els.editor.dataset.color = state.color;
  }

  async function openEditor(note) {
    if (note && note.locked) {
      if (!(await unlockVault())) return;
      if (note.broken) {
        toast('Catatan ini tidak bisa didekripsi dengan master password ini.', true);
        return;
      }
    }
    state.editingId = note ? note.id : null;
    state.color = note ? note.color : 'default';
    els.title.value = note ? note.title : '';
    els.content.value = note ? note.content : '';
    els.tag.value = note ? note.tag : (state.tag || '');
    els.pinned.checked = note ? note.pinned : false;
    els.encrypted.checked = note ? note.encrypted : false;
    els.deleteBtn.hidden = !note;
    els.info.textContent = note
      ? `Dibuat ${formatDate(note.createdAt)} · Diubah ${formatDate(note.updatedAt)}`
      : '';
    els.info.hidden = !note;
    renderColors();
    els.editor.showModal();
    (note ? els.content : els.title).focus();
  }

  function setEditorBusy(busy) {
    els.saveBtn.disabled = busy;
    els.deleteBtn.disabled = busy;
    els.saveBtn.textContent = busy ? 'Menyimpan…' : 'Simpan';
  }

  async function saveNote() {
    const fields = {
      id: state.editingId,
      title: els.title.value.trim(),
      content: els.content.value,
      tag: els.tag.value.trim(),
      color: state.color,
      pinned: els.pinned.checked,
      encrypted: els.encrypted.checked,
    };
    if (!fields.title && !fields.content.trim()) {
      toast('Judul atau isi catatan wajib diisi.', true);
      return;
    }
    if (fields.encrypted && !(await unlockVault())) return;

    setEditorBusy(true);
    try {
      const note = await buildPayload(fields);
      if (note.content.length > MAX_CONTENT) {
        toast('Catatan terlalu panjang untuk disimpan.', true);
        return;
      }
      const data = await api(state.editingId ? 'update' : 'create', { note });
      await upsertRaw(data.note);
      els.editor.close();
      render();
      toast('Catatan tersimpan');
    } catch (err) {
      handleError(err);
    } finally {
      setEditorBusy(false);
    }
  }

  async function deleteNote() {
    if (!state.editingId || !confirm('Hapus catatan ini?')) return;
    setEditorBusy(true);
    try {
      await api('delete', { id: state.editingId });
      state.notes = state.notes.filter((n) => n.id !== state.editingId);
      els.editor.close();
      render();
      toast('Catatan dihapus');
    } catch (err) {
      handleError(err);
    } finally {
      setEditorBusy(false);
    }
  }

  async function togglePin(id) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;
    // Ciphertext lama dipakai ulang, jadi menyematkan tidak butuh master password.
    const payload = {
      id: note.id,
      tag: note.tag,
      color: note.color,
      pinned: !note.pinned,
      title: note.encrypted ? '' : note.title,
      content: note.encrypted ? ENC_PREFIX + note.cipher : note.content,
    };
    note.pinned = !note.pinned;
    render();
    try {
      const data = await api('update', { note: payload });
      await upsertRaw(data.note);
      render();
    } catch (err) {
      note.pinned = !note.pinned;
      render();
      handleError(err);
    }
  }

  // ---------- Events ----------
  function bindEvents() {
    els.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const pwd = els.loginPassword.value;
      if (pwd) login(pwd, els.loginRemember.checked);
    });

    $('#logout-btn').addEventListener('click', logout);
    $('#refresh-btn').addEventListener('click', refresh);
    $('#theme-btn').addEventListener('click', toggleTheme);
    $('#new-btn').addEventListener('click', () => openEditor(null));
    $('#cancel-btn').addEventListener('click', () => els.editor.close());
    els.deleteBtn.addEventListener('click', deleteNote);

    els.lockBtn.addEventListener('click', () => {
      if (state.key) lockVault();
      else unlockVault();
    });

    els.encrypted.addEventListener('change', async () => {
      if (els.encrypted.checked && !(await unlockVault())) els.encrypted.checked = false;
    });

    els.vaultForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitVault();
    });
    $('#vault-cancel').addEventListener('click', () => finishVault(false));
    els.vault.addEventListener('cancel', () => finishVault(false));

    els.search.addEventListener('input', () => {
      state.query = els.search.value.trim();
      render();
    });

    els.tags.addEventListener('click', (e) => {
      const chip = e.target.closest('.tag-chip');
      if (!chip) return;
      state.tag = chip.dataset.tag;
      render();
    });

    els.notes.addEventListener('click', (e) => {
      const card = e.target.closest('.note');
      if (!card) return;
      if (e.target.closest('[data-action="pin"]')) {
        e.stopPropagation();
        togglePin(card.dataset.id);
        return;
      }
      openEditor(state.notes.find((n) => n.id === card.dataset.id));
    });

    els.notes.addEventListener('keydown', (e) => {
      const card = e.target.closest('.note');
      if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openEditor(state.notes.find((n) => n.id === card.dataset.id));
      }
    });

    els.colors.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      state.color = sw.dataset.color;
      renderColors();
    });

    els.editorForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveNote();
    });

    els.editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveNote();
      }
    });

    // Klik di luar dialog menutup editor.
    els.editor.addEventListener('click', (e) => {
      if (e.target === els.editor) els.editor.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !els.appView.hidden && !els.editor.open && !els.vault.open
        && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        els.search.focus();
      }
    });

    // Aktivitas pengguna menunda kunci otomatis.
    ['pointerdown', 'keydown', 'input'].forEach((type) =>
      document.addEventListener(type, resetAutoLock, { passive: true }));
  }

  // ---------- PWA ----------
  function setupPwa() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => { /* tetap jalan tanpa SW */ });
      });
    }

    const installBtn = $('#install-btn');
    let installPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      installBtn.hidden = false;
    });
    installBtn.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      installBtn.hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      installBtn.hidden = true;
      toast('Aplikasi terpasang');
    });

    const offlineBar = $('#offline-bar');
    const updateOnline = () => { offlineBar.hidden = navigator.onLine; };
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    updateOnline();
  }

  // ---------- Init ----------
  async function init() {
    applyTheme(store.get(THEME_KEY));
    bindEvents();
    setupPwa();

    if (!API_URL) {
      els.configWarning.hidden = false;
      els.loginBtn.disabled = true;
      showLogin();
      return;
    }

    const saved = store.get(PASSWORD_KEY);
    if (saved) {
      els.appView.hidden = false;
      els.loading.hidden = false;
      await login(saved, true);
      els.loading.hidden = true;
    } else {
      showLogin();
    }
  }

  init();
})();

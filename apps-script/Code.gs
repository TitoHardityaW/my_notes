/**
 * My Notes - backend Google Apps Script.
 * Spreadsheet ini berfungsi sebagai database; semua request masuk lewat doPost.
 *
 * Wajib: atur Script Property "APP_PASSWORD" (Project Settings > Script Properties).
 */

const SHEET_NAME = 'Notes';
const HEADERS = ['id', 'title', 'content', 'tag', 'color', 'pinned', 'createdAt', 'updatedAt'];
const COLORS = ['default', 'yellow', 'green', 'blue', 'pink', 'purple'];
const MAX_TITLE = 200;
const MAX_TAG = 40;
const MAX_CONTENT = 49000; // batas sel Google Sheets 50.000 karakter

function doGet() {
  return json_({ ok: true, message: 'My Notes API berjalan. Gunakan POST.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Format request tidak valid.' });
  }

  const password = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!password) {
    return json_({ ok: false, error: 'APP_PASSWORD belum diatur di Script Properties.' });
  }
  if (body.password !== password) {
    return json_({ ok: false, code: 'UNAUTHORIZED', error: 'Password salah.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    switch (body.action) {
      case 'list':
        return json_({ ok: true, notes: listNotes_(), vault: getVault_() });
      case 'initVault':
        return json_({ ok: true, vault: initVault_(body.vault) });
      case 'create':
        return json_({ ok: true, note: createNote_(body.note) });
      case 'update':
        return json_({ ok: true, note: updateNote_(body.note) });
      case 'delete':
        deleteNote_(body.id);
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'Aksi tidak dikenal.' });
    }
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Jalankan sekali dari editor untuk membuat sheet & memberi izin akses. */
function setup() {
  getSheet_();
}

function listNotes_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet
    .getRange(2, 1, lastRow - 1, HEADERS.length)
    .getValues()
    .filter(row => row[0])
    .map(rowToNote_);
}

function createNote_(input) {
  const now = new Date().toISOString();
  const note = Object.assign({ id: Utilities.getUuid() }, sanitize_(input), {
    createdAt: now,
    updatedAt: now,
  });
  getSheet_().appendRow(noteToRow_(note));
  return note;
}

function updateNote_(input) {
  if (!input || !input.id) throw new Error('ID catatan wajib diisi.');
  const sheet = getSheet_();
  const row = findRow_(sheet, input.id);
  if (!row) throw new Error('Catatan tidak ditemukan.');

  const range = sheet.getRange(row, 1, 1, HEADERS.length);
  const existing = rowToNote_(range.getValues()[0]);
  const note = Object.assign({}, existing, sanitize_(input), {
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  range.setValues([noteToRow_(note)]);
  return note;
}

function deleteNote_(id) {
  if (!id) throw new Error('ID catatan wajib diisi.');
  const sheet = getSheet_();
  const row = findRow_(sheet, id);
  if (!row) throw new Error('Catatan tidak ditemukan.');
  sheet.deleteRow(row);
}

/**
 * Vault = parameter enkripsi sisi-klien (salt, iterasi, dan nilai pengecek).
 * Master password TIDAK pernah dikirim ke server; server hanya menyimpan data ini
 * agar browser bisa memverifikasi master password dan menurunkan kunci yang sama.
 */
function getVault_() {
  const raw = PropertiesService.getScriptProperties().getProperty('VAULT');
  return raw ? JSON.parse(raw) : null;
}

function initVault_(vault) {
  if (getVault_()) throw new Error('Master password sudah pernah dibuat.');
  if (!vault || typeof vault.salt !== 'string' || typeof vault.check !== 'string' || !(vault.iterations > 0)) {
    throw new Error('Data vault tidak valid.');
  }
  const clean = {
    v: 1,
    salt: vault.salt.slice(0, 100),
    iterations: Math.floor(vault.iterations),
    check: vault.check.slice(0, 500),
  };
  PropertiesService.getScriptProperties().setProperty('VAULT', JSON.stringify(clean));
  return clean;
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

function findRow_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

function sanitize_(input) {
  input = input || {};
  const title = String(input.title || '').trim().slice(0, MAX_TITLE);
  const content = String(input.content || '');
  if (content.length > MAX_CONTENT) {
    throw new Error('Isi catatan terlalu panjang (maks ' + MAX_CONTENT + ' karakter).');
  }
  if (!title && !content.trim()) throw new Error('Judul atau isi catatan wajib diisi.');
  return {
    title: title,
    content: content,
    tag: String(input.tag || '').trim().slice(0, MAX_TAG),
    color: COLORS.indexOf(input.color) >= 0 ? input.color : 'default',
    pinned: input.pinned === true,
  };
}

function rowToNote_(row) {
  const note = {};
  HEADERS.forEach((key, i) => {
    let value = row[i];
    if (value instanceof Date) value = value.toISOString();
    note[key] = key === 'pinned' ? value === true || value === 'TRUE' : String(value);
  });
  return note;
}

function noteToRow_(note) {
  // Awalan apostrof membuat Sheets menyimpan nilai sebagai teks biasa,
  // sehingga isi seperti "=SUM(...)" tidak dieksekusi sebagai formula.
  return HEADERS.map(key => (key === 'pinned' ? note.pinned === true : "'" + String(note[key] == null ? '' : note[key])));
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

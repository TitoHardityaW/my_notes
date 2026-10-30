# My Notes 📝

Aplikasi catatan berbasis web yang menggunakan **Google Spreadsheet sebagai database** dan bisa di-hosting gratis di **GitHub Pages**.

- Frontend: HTML + CSS + JavaScript murni (tanpa build step)
- Backend: Google Apps Script (Web App) yang membaca/menulis ke Spreadsheet
- Fitur: tambah/edit/hapus catatan, pencarian, tag, warna, sematkan (pin), mode gelap, dilindungi password

## Struktur

```
index.html          Halaman utama
style.css           Tampilan
app.js              Logika aplikasi
config.js           URL API (diisi sendiri)
manifest.webmanifest, sw.js, icons/   File PWA
apps-script/Code.gs Kode backend untuk Google Apps Script
```

## 1. Siapkan Google Spreadsheet + Apps Script

1. Buat Spreadsheet baru di [Google Sheets](https://sheets.new), beri nama mis. `My Notes DB`.
2. Buka menu **Extensions → Apps Script**.
3. Hapus isi `Code.gs` bawaan, lalu salin seluruh isi file [`apps-script/Code.gs`](apps-script/Code.gs) ke sana. Simpan.
4. Atur password aplikasi: klik **Project Settings** (ikon ⚙️) → **Script Properties** → **Add script property**
   - Property: `APP_PASSWORD`
   - Value: password pilihan Anda
5. Kembali ke editor, pilih fungsi `setup` lalu klik **Run**. Izinkan akses ketika diminta
   (klik *Advanced → Go to ... (unsafe)* jika muncul peringatan — ini script milik Anda sendiri).
   Sheet `Notes` dengan header akan dibuat otomatis.
6. Klik **Deploy → New deployment**:
   - Select type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Klik **Deploy**, lalu salin **Web app URL** (berakhiran `/exec`).

## 2. Hubungkan frontend

Buka `config.js` dan isi URL tadi:

```js
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec',
};
```

Untuk mencoba secara lokal, buka lewat XAMPP: `http://localhost/my_notes/`.

## 3. Publish ke GitHub Pages

1. Commit dan push ke GitHub:
   ```bash
   git add .
   git commit -m "Aplikasi catatan"
   git push origin main
   ```
2. Di repository GitHub: **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: `main`, folder `/ (root)` → **Save**
3. Tunggu 1–2 menit, aplikasi tersedia di `https://<username>.github.io/<nama-repo>/`.

## Install sebagai aplikasi (PWA)

My Notes adalah Progressive Web App, jadi bisa dipasang seperti aplikasi biasa:

- **Android / Chrome / Edge (desktop)**: klik ikon ⬇️ *Install* di pojok kanan atas aplikasi,
  atau menu browser → *Install app* / *Tambahkan ke layar utama*.
- **iPhone / iPad (Safari)**: tombol *Share* → *Add to Home Screen*.

Tampilan aplikasi di-cache oleh service worker ([`sw.js`](sw.js)), jadi tetap terbuka cepat walaupun jaringan lambat.
Data catatan **sengaja tidak di-cache**, supaya isinya tidak tertinggal di perangkat. Karena itu memuat dan menyimpan catatan tetap butuh internet.

Service worker memakai strategi *network-first*: saat online, versi terbaru selalu diambil dari GitHub Pages.
Jika menambah file baru yang perlu tersedia offline, tambahkan ke daftar `ASSETS` di `sw.js`
lalu naikkan versi `CACHE` (mis. `my-notes-v2`).

## Memperbarui kode Apps Script

Setelah mengubah `Code.gs`, buka **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
Dengan cara ini URL Web App tetap sama, sehingga `config.js` tidak perlu diubah.

## Struktur data & penghapusan

Sheet `Notes` berisi kolom: `id, title, content, tag, color, pinned, createdAt, updatedAt, deleted`.

Menghapus catatan **tidak menghapus baris** di Spreadsheet (*soft delete*). Yang berubah hanya kolom `deleted`:

| `deleted` | Arti |
|-----------|------|
| `0` | Aktif, tampil di aplikasi |
| `1` | Dihapus, disembunyikan dari aplikasi |

- Saat dihapus, `updatedAt` diisi waktu penghapusan.
- **Memulihkan catatan:** ubah `deleted` dari `1` menjadi `0` langsung di Spreadsheet, lalu klik muat ulang di aplikasi.
- Sheet lama tanpa kolom `deleted` otomatis mendapat kolom tersebut. Sel yang kosong dianggap `0` (aktif).

## Enkripsi catatan (untuk akun & password)

Centang **🔒 Enkripsi** di editor untuk mengenkripsi judul dan isi catatan **di browser** sebelum dikirim.
Di Spreadsheet yang tersimpan hanya teks acak seperti `enc:v1:KLk0Zbs93Ukk...`.

- Pertama kali dipakai, aplikasi meminta Anda membuat **master password** (minimal 10 karakter).
  Gunakan password yang **berbeda** dari password login.
- Master password **tidak pernah dikirim ke server**. Kunci enkripsi diturunkan di browser
  (PBKDF2-SHA256, 600.000 iterasi → AES-256-GCM) dan hanya disimpan di memori.
- Server hanya menyimpan salt dan nilai pengecek di Script Property `VAULT`, yang tidak bisa dipakai untuk membuka catatan.
- Catatan terenkripsi otomatis terkunci lagi setelah **10 menit tanpa aktivitas**, saat halaman di-reload,
  atau saat ikon gembok di kanan atas diklik.
- ⚠️ **Jika master password lupa, catatan terenkripsi tidak bisa dipulihkan.** Untuk memulai ulang,
  hapus Script Property `VAULT` dan baris catatan terenkripsi di Spreadsheet.
- Catatan terenkripsi tidak bisa dicari selama masih terkunci. Tag dan warna tidak dienkripsi,
  jadi jangan tulis informasi rahasia di tag.

## Catatan keamanan

- URL API di `config.js` akan terlihat publik, tetapi setiap request wajib menyertakan password yang
  dicek di server (`APP_PASSWORD`), jadi orang lain tidak bisa membaca/mengubah catatan tanpa password.
- **Password login tidak disimpan di perangkat.** Password hanya dikirim sekali saat login, lalu server memberi
  *session token* acak yang disimpan di memori browser saja. Setiap kali aplikasi dibuka atau di-reload, password harus dimasukkan lagi.
- **Logout otomatis** setelah 15 menit tanpa aktivitas, dengan peringatan 1 menit sebelumnya.
  Di server, token juga hangus setelah 30 menit tanpa request, atau maksimal 12 jam sejak login.
  Nilai ini bisa diubah lewat `SESSION_IDLE_MS` (di `app.js`) serta `SESSION_IDLE_SEC` dan `SESSION_MAX_MS` (di `Code.gs`).
- Gunakan password yang kuat. Untuk mengganti password, cukup ubah nilai `APP_PASSWORD` di Script Properties.
- Catatan **tanpa** enkripsi tersimpan sebagai teks biasa dan bisa dibaca siapa pun yang punya akses ke Spreadsheet.
- Enkripsi melindungi data di Spreadsheet, tetapi tidak dari perangkat yang sudah terinfeksi malware
  atau ekstensi browser yang berbahaya. Untuk kebutuhan keamanan tinggi, gunakan password manager khusus.

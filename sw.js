// Service worker tối giản: lưu sẵn trang khởi động và icon để app mở nhanh.
// Dữ liệu học vẫn luôn lấy trực tiếp từ Google Sheet, không bị lưu cache.
const CACHE = "climb-v2";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // web app trên script.google.com đi thẳng, không qua cache
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

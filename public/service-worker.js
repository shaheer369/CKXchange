'use strict';
const CACHE_NAME = 'ckxchange-static-v2-4-14';
const STATIC_ASSETS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/ckx-logo-192.png?v=2.4.14',
  '/icons/ckx-logo-512.png?v=2.4.14',
  '/icons/icon-192.png?v=2.4.14',
  '/icons/icon-512.png?v=2.4.14',
  '/app.js?v=2.4.14',
  '/theme-init.js?v=2.4.14'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache APIs, authenticated HTML, or any response that could contain financial data.
  if (url.pathname.startsWith('/api/') || url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/admin')) {
    if (request.mode === 'navigate') {
      event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    }
    return;
  }
  const cacheable = url.pathname === '/app.js' || url.pathname === '/theme-init.js' || url.pathname === '/offline.html' || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/');
  if (!cacheable) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    } catch (_) {
      return (await cache.match(request)) || (await cache.match(url.pathname));
    }
  })());
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = String(data.title || 'CKXchange notification').slice(0, 80);
  const options = {
    body: String(data.body || 'You have a new CKXchange update.').slice(0, 180),
    icon: '/icons/ckx-logo-192.png?v=2.4.14',
    badge: '/icons/ckx-logo-192.png?v=2.4.14',
    tag: String(data.tag || 'ckxchange-update').slice(0, 120),
    renotify: false,
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const relative = event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : '/';
  const target = new URL(relative.startsWith('/') && !relative.startsWith('//') ? relative : '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const match = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (match) return match.focus().then(client => client.navigate(target));
    return self.clients.openWindow(target);
  }));
});

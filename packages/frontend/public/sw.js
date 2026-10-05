const SHELL_CACHE = 'backit-shell-v2';
const FEED_CACHE = 'backit-feed-v2';
const DB_NAME = 'backit-offline-v1';
const STORE_NAME = 'actions';
const SHELL_URLS = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== FEED_CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(FEED_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || new Response(JSON.stringify({ items: [], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (/\/feed|\/calls/.test(url.pathname)) {
    event.respondWith(networkFirst(event.request));
  } else if (url.origin === self.location.origin) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readAll(database) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function removeEntry(database, id) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function replayQueue() {
  const database = await openQueue();
  const entries = (await readAll(database)).sort((a, b) => a.queuedAt - b.queuedAt);
  let synced = 0;
  for (const entry of entries) {
    if (!entry.url) continue;
    try {
      const response = await fetch(entry.url, { method: entry.method || 'POST', headers: entry.headers, body: entry.body, credentials: 'include' });
      if (!response.ok) break;
      await removeEntry(database, entry.id);
      synced += 1;
    } catch {
      break;
    }
  }
  database.close();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: 'offline-queue-updated', synced }));
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'backit-offline-queue') event.waitUntil(replayQueue());
});

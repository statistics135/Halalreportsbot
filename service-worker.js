importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAZ7MU2B58bWcu-8jH9Pvv5Ob9XGQyx4NU",
  authDomain: "halal-report-2.firebaseapp.com",
  projectId: "halal-report-2",
  storageBucket: "halal-report-2.firebasestorage.app",
  messagingSenderId: "242965792260",
  appId: "1:242965792260:web:8dd83989172924f8c5d751"
});

const fcm = firebase.messaging();
fcm.onBackgroundMessage((payload)=>{
  const title = (payload.notification && payload.notification.title) || 'መልእክት ደርሶዎታል';
  const body = (payload.notification && payload.notification.body) || (payload.data && payload.data.body) || '';
  self.registration.showNotification(title, {
    body,
    icon: 'icon-192.png',
    badge: 'icon-192.png'
  });
});

const CACHE_NAME = 'halal-report-v1.1.0';
const CORE_ASSETS = [
  './index.html', './customer.html', './manifest.json', './customer-manifest.json',
  './icon-192.png', './icon-512.png', './offline.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(()=>{})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for everything (this app is live data via Firestore/Telegram),
// falling back to cache, and finally to an offline page for full-page navigations.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(()=>{});
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate' || event.request.destination === 'document') {
          return caches.match('./offline.html');
        }
        return Response.error();
      })
  );
});

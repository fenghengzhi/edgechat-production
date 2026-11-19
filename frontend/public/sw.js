// EdgeChat PWA service worker. All app and API requests use the network.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never touch non-GET requests (PUT/POST/DELETE, WebSocket upgrades, etc.).
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Same-origin GET requests, including page navigations, pass through here;
  // API, uploads and cross-origin requests use the browser's default handling.
  if (url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/files')) {
    return;
  }

  // Pass-through response; no caching, so nothing goes stale.
  event.respondWith(fetch(request));
});

// Only display fixed strings on lock screens. Incoming payloads carry routing
// identifiers but no message text, sender names, or externally supplied URLs.
self.addEventListener('push', (event) => {
  let payload;
  try { payload = event.data?.json(); } catch { /* Still show a generic notification. */ }
  const roomId = Number(payload?.roomId);
  const recipientId = Number(payload?.recipientId);
  const valid = Number.isSafeInteger(roomId) && roomId > 0
    && Number.isSafeInteger(recipientId) && recipientId > 0
    && ['message', 'call'].includes(payload?.type);
  const data = valid ? { roomKind: 'dm', roomId, recipientId, type: payload.type } : {};
  const language = self.navigator?.language || 'en';
  const copy = /^zh-(TW|HK|MO|Hant)/i.test(language)
    ? ['新通知', '你有一則新私訊', '語音來電', '視訊來電', '未接來電']
    : /^zh/i.test(language) ? ['新通知', '你有一条新私聊消息', '语音来电', '视频来电', '未接来电']
      : ['New notification', 'New direct message', 'Incoming voice call', 'Incoming video call', 'Missed call'];
  let body = copy[0];
  if (data.type === 'message') body = copy[1];
  if (data.type === 'call') {
    body = Number(payload.expiresAt) <= Date.now() ? copy[4] : payload.media === 'video' ? copy[3] : copy[2];
  }
  event.waitUntil(self.registration.showNotification('EdgeChat', {
    body, icon: '/icon-192.png', badge: '/icon-192.png',
    tag: valid ? `edgechat:${recipientId}:dm:${roomId}:${data.type}` : 'edgechat:push', data
  }));
});

// Focus (or open) the app when a system notification is clicked, and tell the
// page which room it belongs to so it can navigate there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const client = clientList.find((c) => 'focus' in c);
        if (client) {
          client.postMessage({ type: 'edgechat:notification-click', data });
          return client.focus();
        }
        const url = new URL('/', self.location.origin);
        if (data.roomKind && Number.isSafeInteger(Number(data.roomId)) && Number(data.roomId) > 0) {
          url.searchParams.set('notificationRoomKind', data.roomKind);
          url.searchParams.set('notificationRoomId', String(data.roomId));
          if (data.recipientId) url.searchParams.set('notificationRecipient', String(data.recipientId));
        }
        return self.clients.openWindow(url.href);
      }),
  );
});

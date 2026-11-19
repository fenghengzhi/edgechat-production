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

const notificationCopy = {
  en: {
    generic: 'New notification', message: 'New direct message',
    voice: 'Incoming voice call', video: 'Incoming video call', missed: 'Missed call',
    missedVoice: 'Missed voice call', missedVideo: 'Missed video call',
    attachments: { image: 'Photo', voice: 'Voice message', audio: 'Audio', video: 'Video', file: 'File' }
  },
  zhCN: {
    generic: '新通知', message: '你有一条新私聊消息',
    voice: '语音来电', video: '视频来电', missed: '未接来电',
    missedVoice: '未接语音来电', missedVideo: '未接视频来电',
    attachments: { image: '图片', voice: '语音消息', audio: '音频', video: '视频', file: '文件' }
  },
  zhTW: {
    generic: '新通知', message: '你有一則新私訊',
    voice: '語音來電', video: '視訊來電', missed: '未接來電',
    missedVoice: '未接語音來電', missedVideo: '未接視訊來電',
    attachments: { image: '圖片', voice: '語音訊息', audio: '音訊', video: '影片', file: '檔案' }
  }
};

function notificationAvatar(path) {
  // Profile avatars use a single encoded file key and need no credentials.
  if (typeof path !== 'string' || !/^\/files\/[^/\\?#\s]+$/.test(path)) return '/icon-192.png';
  const url = new URL(path, self.location.origin);
  return url.pathname === path ? path : '/icon-192.png';
}

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
  const copy = /^zh-(TW|HK|MO|Hant)/i.test(language) ? notificationCopy.zhTW
    : /^zh/i.test(language) ? notificationCopy.zhCN : notificationCopy.en;
  const senderName = valid && typeof payload.senderName === 'string' ? payload.senderName.trim() : '';
  let body = copy.generic;
  if (data.type === 'message') {
    const preview = typeof payload.preview === 'string' ? payload.preview.trim() : '';
    const label = typeof payload.attachmentKind === 'string' && Object.hasOwn(copy.attachments, payload.attachmentKind)
      ? copy.attachments[payload.attachmentKind] : '';
    body = [label && `[${label}]`, preview].filter(Boolean).join(' ') || copy.message;
  }
  if (data.type === 'call') {
    body = payload.media === 'video' ? copy.video : copy.voice;
    if (Number(payload.expiresAt) <= Date.now()) {
      body = payload.media === 'video' ? copy.missedVideo : payload.media === 'audio' ? copy.missedVoice : copy.missed;
    }
  }
  event.waitUntil(self.registration.showNotification(senderName || 'EdgeChat', {
    body, icon: notificationAvatar(valid ? payload.avatarUrl : null), badge: '/icon-192.png',
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

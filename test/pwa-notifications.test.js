import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  parseNotificationRoomTarget,
  takeNotificationRoomTarget,
} from '../frontend/src/notification-target.js';

const swSource = readFileSync(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');

function runNotificationClick(clientList) {
  const listeners = new Map();
  const opened = [];
  const self = {
    location: { origin: 'https://chat.example' },
    addEventListener(name, listener) { listeners.set(name, listener); },
    clients: {
      async matchAll() { return clientList; },
      async openWindow(url) { opened.push(url); },
    },
  };
  runInNewContext(swSource, { self, URL, Number, fetch: () => {} });
  let completed;
  let closed = false;
  listeners.get('notificationclick')({
    notification: {
      data: { roomKind: 'dm', roomId: 42 },
      close() { closed = true; },
    },
    waitUntil(promise) { completed = promise; },
  });
  return { completed, opened, closed };
}

async function pushNotification(payload, language = 'en') {
  const listeners = new Map();
  const shown = [];
  const self = { navigator: { language }, addEventListener: (type, handler) => listeners.set(type, handler),
    registration: { async showNotification(title, options) { shown.push({ title, ...options }); } } };
  runInNewContext(swSource, { self, URL });
  let completed;
  listeners.get('push')({ data: { json: () => payload }, waitUntil(promise) { completed = promise; } });
  await completed;
  assert.equal(shown.length, 1);
  return shown[0];
}

test('background pushes show only generic text and route to the recipient’s DM', async () => {
  const data = { type: 'message', recipientId: 7, roomId: 42, title: 'private sender', body: 'private content', url: 'https://example.invalid' };
  const notification = await pushNotification(data);
  assert.equal(notification.title, 'EdgeChat');
  assert.equal(notification.body, 'New direct message');
  assert.equal(notification.data.roomKind, 'dm');
  assert.deepEqual(parseNotificationRoomTarget(notification.data), { kind: 'dm', id: 42, recipientId: 7 });
  assert.equal(notification.data.url, undefined);
  assert.deepEqual(Object.keys((await pushNotification({ type: 'message', roomId: -1 })).data), []);
});

test('background call pushes distinguish video, voice, and expired invitations', async () => {
  const payload = { type: 'call', recipientId: 7, roomId: 42, expiresAt: Date.now() + 30000 };
  assert.equal((await pushNotification(payload, 'zh-CN')).body, '语音来电');
  assert.equal((await pushNotification({ ...payload, media: 'video' }, 'zh-TW')).body, '視訊來電');
  assert.equal((await pushNotification({ ...payload, expiresAt: Date.now() - 5000 })).body, 'Missed call');
});

test('通知点击复用窗口时发送目标并聚焦', async () => {
  const messages = [];
  let focused = false;
  const client = {
    postMessage(message) { messages.push(message); },
    async focus() { focused = true; },
  };
  const result = runNotificationClick([client]);
  await result.completed;
  assert.equal(result.closed, true);
  assert.equal(focused, true);
  assert.deepEqual(result.opened, []);
  assert.equal(messages[0].type, 'edgechat:notification-click');
  assert.equal(messages[0].data.roomId, 42);
});

test('通知点击冷启动时在 URL 中保留会话，读取后清除参数', async () => {
  const result = runNotificationClick([]);
  await result.completed;
  const openedUrl = new URL(result.opened[0]);
  assert.equal(openedUrl.origin, 'https://chat.example');
  const browserWindow = {
    location: { href: `${openedUrl.href}#view` },
    history: {
      state: { scroll: 12 },
      replaceState(state, title, url) { this.replacement = { state, title, url }; },
    },
  };
  assert.deepEqual(takeNotificationRoomTarget(browserWindow), { kind: 'dm', id: 42 });
  assert.equal(browserWindow.history.replacement.url, '/#view');
  assert.deepEqual(browserWindow.history.replacement.state, { scroll: 12 });
});

test('拒绝无效通知目标，仍清除 URL 中的通知参数', () => {
  assert.equal(parseNotificationRoomTarget({ roomKind: 'admin', roomId: 2 }), null);
  assert.equal(parseNotificationRoomTarget({ roomKind: 'dm', roomId: -1 }), null);
  const browserWindow = {
    location: { href: 'https://chat.example/?keep=yes&notificationRoomKind=dm&notificationRoomId=oops' },
    history: {
      state: null,
      replaceState(_state, _title, url) { this.url = url; },
    },
  };
  assert.equal(takeNotificationRoomTarget(browserWindow), null);
  assert.equal(browserWindow.history.url, '/?keep=yes');
});

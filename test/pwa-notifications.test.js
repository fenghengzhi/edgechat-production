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
  const self = { location: { origin: 'https://chat.example' }, navigator: { language }, addEventListener: (type, handler) => listeners.set(type, handler),
    registration: { async showNotification(title, options) { shown.push({ title, ...options }); } } };
  runInNewContext(swSource, { self, URL });
  let completed;
  listeners.get('push')({ data: { json: () => payload }, waitUntil(promise) { completed = promise; } });
  await completed;
  assert.equal(shown.length, 1);
  return shown[0];
}

test('older pushes keep generic copy and route to the recipient’s DM', async () => {
  const data = { type: 'message', recipientId: 7, roomId: 42, title: 'private sender', body: 'private content', url: 'https://example.invalid' };
  const notification = await pushNotification(data);
  assert.equal(notification.title, 'EdgeChat');
  assert.equal(notification.body, 'New direct message');
  assert.equal(notification.data.roomKind, 'dm');
  assert.deepEqual(parseNotificationRoomTarget(notification.data), { kind: 'dm', id: 42, recipientId: 7 });
  assert.equal(notification.data.url, undefined);
  assert.deepEqual(Object.keys((await pushNotification({ type: 'message', roomId: -1 })).data), []);
});

test('direct messages use the sender, preview and local profile icon without copying personal data to the click target', async () => {
  const payload = { type: 'message', recipientId: 7, roomId: 42, senderName: '小林', preview: '周五见 👋',
    avatarUrl: '/files/2%2Fprofile.png' };
  const result = await pushNotification(payload, 'zh-CN');
  assert.equal(result.title, '小林');
  assert.equal(result.body, '周五见 👋');
  assert.equal(result.icon, payload.avatarUrl);
  assert.equal(result.badge, '/icon-192.png');
  assert.equal(result.tag, 'edgechat:7:dm:42:message');
  assert.deepEqual({ ...result.data }, { type: 'message', roomKind: 'dm', roomId: 42, recipientId: 7 });
  for (const avatarUrl of [undefined, 'https://outside.example/photo', '//outside.example/icon', '/files/../api/login',
    '/files/%2e%2e', '/files/image?token=private', '/files/\\outside.example']) {
    assert.equal((await pushNotification({ ...payload, avatarUrl })).icon, '/icon-192.png');
  }
  const invalid = await pushNotification({ ...payload, roomId: 0 });
  assert.deepEqual([invalid.title, invalid.body, invalid.icon], ['EdgeChat', 'New notification', '/icon-192.png']);
});

test('attachment previews use the device language and retain captions or filenames', async () => {
  const payload = { type: 'message', recipientId: 7, roomId: 42, senderName: 'Ann' };
  assert.equal((await pushNotification({ ...payload, attachmentKind: 'image', preview: '周末旅行' }, 'zh-CN')).body, '[图片] 周末旅行');
  assert.equal((await pushNotification({ ...payload, attachmentKind: 'voice' }, 'zh-Hant')).body, '[語音訊息]');
  assert.equal((await pushNotification({ ...payload, attachmentKind: 'file', preview: 'notes.pdf' })).body, '[File] notes.pdf');
  assert.equal((await pushNotification({ ...payload, attachmentKind: 'constructor' })).body, 'New direct message');
});

test('background call pushes distinguish video, voice, and expired invitations', async () => {
  const payload = { type: 'call', recipientId: 7, roomId: 42, expiresAt: Date.now() + 30000 };
  assert.equal((await pushNotification(payload, 'zh-CN')).body, '语音来电');
  assert.equal((await pushNotification({ ...payload, media: 'video' }, 'zh-TW')).body, '視訊來電');
  assert.equal((await pushNotification({ ...payload, expiresAt: Date.now() - 5000 })).body, 'Missed call');
  for (const [media, active, missed] of [['audio', '语音来电', '未接语音来电'], ['video', '视频来电', '未接视频来电']]) {
    const invite = { ...payload, senderName: '小陈', media, preview: 'ignored' };
    const result = await pushNotification(invite, 'zh-CN');
    assert.equal(result.title, '小陈');
    assert.equal(result.body, active);
    assert.equal((await pushNotification({ ...invite, expiresAt: Date.now() - 5000 }, 'zh-CN')).body, missed);
  }
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

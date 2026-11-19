import assert from 'node:assert/strict';
import test from 'node:test';
import { enableDevicePush, hasDevicePush, removeDevicePush } from '../frontend/src/web-push.js';

function device(t) {
  const values = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key), setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  } });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  const subscription = {
    endpoint: 'https://push.example/subscription',
    toJSON() { return { endpoint: this.endpoint, keys: { auth: 'auth', p256dh: 'client' } }; },
    unsubscribe: t.mock.fn(async () => true),
  };
  const pushManager = { subscribe: t.mock.fn(async () => subscription), getSubscription: async () => subscription };
  return { values, subscription, registration: { pushManager }, config: { publicKey: 'BAM' } };
}

test('explicit opt-in starts browser subscription during the click and syncs per-user DM mutes', async t => {
  const d = device(t);
  d.values.set('edgechat:browser-notifications:3', JSON.stringify({ mutedRooms: ['dm:8', 'public:2', 'dm:invalid'] }));
  const api = { savePushSubscription: t.mock.fn(async () => {}) };
  const pending = enableDevicePush(api, 3, { ...d, subscription: null });
  assert.equal(d.registration.pushManager.subscribe.mock.callCount(), 1);
  await pending;
  assert.deepEqual(d.registration.pushManager.subscribe.mock.calls[0].arguments[0],
    { userVisibleOnly: true, applicationServerKey: Uint8Array.of(4, 3) });
  assert.deepEqual(api.savePushSubscription.mock.calls[0].arguments[0], { ...d.subscription.toJSON(), mutedDmRoomIds: [8] });
  assert.equal(hasDevicePush(3), true);
  assert.equal(hasDevicePush(4), false);
  await removeDevicePush({ deletePushSubscription: async () => { throw new Error('offline'); } }, d.registration);
  assert.equal(d.subscription.unsubscribe.mock.callCount(), 1);
  assert.equal(hasDevicePush(3), false);
});

test('failed server registration unsubscribes the browser and leaves the device opted out', async t => {
  const d = device(t);
  await assert.rejects(enableDevicePush({ savePushSubscription: async () => { throw new Error('unavailable'); } },
    3, { ...d, subscription: null }), /unavailable/);
  assert.equal(d.subscription.unsubscribe.mock.callCount(), 1);
  assert.equal(hasDevicePush(3), false);
});

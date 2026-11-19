import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import initSqlJs from 'sql.js';
import worker from '../worker/src/index.js';
import { notifyDmDevices } from '../worker/src/web-push.js';
import { createD1Adapter, createKvAdapter } from './support/d1.js';

const SQL = await initSqlJs();
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
const origin = 'https://chat.example';
const vapid = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const message = { type: 'message', roomId: 10, messageId: 25, content: '## **发布**\n\n[说明](https://example.com/private-link)' };

function browser(name) {
  const ecdh = createECDH('prime256v1');
  const p256dh = ecdh.generateKeys().toString('base64url');
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + name,
    expirationTime: null, keys: { p256dh, auth: auth.toString('base64url') } } };
}

function fixture(t) {
  const database = new SQL.Database();
  t.after(() => database.close());
  database.exec(schema);
  database.run(`INSERT INTO users(id,username,display_name,password_hash,password_salt)
    VALUES(1,'one','One','h','s'),(2,'two','Two','h','s'),(3,'three','Three','h','s');
    INSERT INTO channels(id,name,kind,dm_key) VALUES(10,'dm','dm','1:2');
    INSERT INTO channel_members(channel_id,user_id) VALUES(10,1),(10,2);`);
  const env = { DB: createD1Adapter(database), SESSIONS: createKvAdapter(), WEB_PUSH_SUBJECT: origin,
    WEB_PUSH_VAPID_JWK: JSON.stringify(vapid), EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID: 'auto-v1',
    EDGECHAT_ENCRYPTION_KEY_1: randomBytes(32).toString('base64') };
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  env.SESSIONS.list = async ({ prefix }) => ({ keys: env.SESSIONS.values.has(prefix)
    ? [{ name: prefix, expiration: expiry }] : [] });
  const sessions = [1, 2, 3, 2].map((userId, index) => {
    const session = { userId, token: 'session-' + index, sessionVersion: 0 };
    env.SESSIONS.values.set(session.token, JSON.stringify(session));
    return session;
  });
  const request = (path, session, body, method = body ? 'POST' : 'GET') => worker.fetch(new Request(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), env, { waitUntil() {} });
  const subscribe = (session, device, extra = {}) => request('/api/push/subscription', session, { ...device.subscription, ...extra });
  const status = async (session, device) => (await (await request('/api/push/status', session, device.subscription)).json()).subscribed;
  return { database, env, expiry, sessions, request, subscribe, status };
}

// Independent receiver: decode the RFC 8188 record and derive the RFC 8291 CEK/nonce using Node primitives.
function decrypt(device, body) {
  const packet = Buffer.from(body);
  assert.equal(packet.readUInt32BE(16), 4096);
  assert.equal(packet[20], 65);
  const serverPublic = packet.subarray(21, 86);
  const salt = packet.subarray(0, 16);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), serverPublic]);
  const ikm = hkdfSync('sha256', device.ecdh.computeSecret(serverPublic), device.auth, info, 32);
  const key = hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(packet.subarray(-16));
  const padded = Buffer.concat([decipher.update(packet.subarray(86, -16)), decipher.final()]);
  let delimiter = padded.length - 1;
  while (padded[delimiter] === 0) delimiter--;
  assert.equal(padded[delimiter], 2);
  return JSON.parse(padded.subarray(0, delimiter));
}

test('authenticated push registration encrypts device keys, enforces ownership, and revokes only the current login on logout', async t => {
  const f = fixture(t);
  const [one, two, , otherLogin] = f.sessions;
  assert.equal((await f.request('/api/push/config')).status, 401);
  const config = await f.request('/api/push/config', two);
  assert.equal(config.headers.get('cache-control'), 'private, no-store');
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(vapid.x, 'base64url'), Buffer.from(vapid.y, 'base64url')]).toString('base64url');
  assert.deepEqual(await config.json(), { enabled: true, publicKey });
  const first = browser('first'), second = browser('second');
  assert.equal((await f.subscribe(two, first)).status, 200);
  assert.equal((await f.subscribe(otherLogin, second)).status, 200);
  assert.equal(await f.status(two, first), true);
  assert.equal(await f.status(otherLogin, first), false);
  const raw = f.database.exec('SELECT * FROM web_push_subscriptions')[0].values;
  assert.ok(raw.flat().includes(f.expiry * 1000));
  for (const secret of [first.subscription.endpoint, first.subscription.keys.auth, first.subscription.keys.p256dh, two.token]) {
    assert.equal(JSON.stringify(raw).includes(secret), false);
  }
  assert.equal((await f.subscribe(one, first)).status, 409);
  assert.equal((await f.request('/api/push/subscription', one, first.subscription, 'DELETE')).status, 200);
  assert.equal(await f.status(two, first), true);
  assert.equal((await f.request('/api/auth/logout', two, {})).status, 200);
  assert.equal(await f.status(otherLogin, second), true);
  assert.equal(f.database.exec('SELECT COUNT(*) FROM web_push_subscriptions')[0].values[0][0], 1);
});

test('only valid provider endpoints, P-256 keys and at most eight devices can register', async t => {
  const f = fixture(t);
  const user = f.sessions[0];
  const device = browser('device');
  for (const endpoint of ['https://example.test/push', 'http://fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a',
    'https://a@fcm.googleapis.com/path', 'https://fakeweb.push.apple.com/push', 'https://fcm.googleapis.com/path#fragment']) {
    assert.equal((await f.subscribe(user, device, { endpoint })).status, 400);
  }
  assert.equal((await f.subscribe(user, device, { keys: { auth: device.subscription.keys.auth, p256dh: 'bad' } })).status, 400);
  for (let n = 0; n < 8; n++) assert.equal((await f.subscribe(user, browser(String(n)))).status, 200);
  assert.equal((await f.subscribe(user, device)).status, 409);
});

test('only an active DM peer gets a decryptable standards-compliant payload; muting, blocks and expired subscriptions are respected', async t => {
  const f = fixture(t);
  const [one, two, outside] = f.sessions;
  const receiver = browser('receiver'), muted = browser('muted');
  f.database.run("INSERT INTO uploaded_files(object_key,owner_user_id,content_type) VALUES('1/avatar 图片.png',1,'image/png')");
  f.database.run("UPDATE users SET display_name='小林', avatar_key='1/avatar 图片.png' WHERE id=1");
  for (const [user, device] of [[one, browser('sender')], [outside, browser('outside')], [two, receiver]]) {
    assert.equal((await f.subscribe(user, device)).status, 200);
  }
  assert.equal((await f.subscribe(two, muted, { mutedDmRoomIds: [10] })).status, 200);
  const packets = [];
  const send = (endpoint, init) => { packets.push({ endpoint, init }); return new Response(null, { status: 201 }); };
  await notifyDmDevices(f.env, one.userId, message, send);
  assert.equal(packets.length, 1);
  const { endpoint, init } = packets[0];
  assert.equal(endpoint, receiver.subscription.endpoint);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers['content-encoding'], 'aes128gcm');
  const [matched, token] = /^vapid t=([^,]+), k=[\w-]+$/.exec(init.headers.authorization) ?? [];
  assert.ok(matched);
  const [header, payload, signature] = token.split('.');
  assert.ok(verify('sha256', Buffer.from(header + '.' + payload), { key: createPublicKey({ key: vapid, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).aud, 'https://fcm.googleapis.com');
  const identity = { senderName: '小林', avatarUrl: '/files/1%2Favatar%20%E5%9B%BE%E7%89%87.png' };
  assert.deepEqual(decrypt(receiver, init.body), {
    type: 'message', roomId: 10, messageId: 25, ...identity, preview: '发布 说明', recipientId: two.userId,
  });
  const call = { type: 'call', roomId: 10, callId: 'invite', media: 'video', expiresAt: Date.now() + 30_000 };
  await notifyDmDevices(f.env, one.userId, call, send);
  assert.equal(packets.length, 2);
  assert.ok(packets[1].init.headers.ttl <= 30);
  assert.equal(packets[1].init.headers.urgency, 'high');
  assert.equal(packets[1].endpoint, receiver.subscription.endpoint);
  assert.deepEqual(decrypt(receiver, packets[1].init.body), { ...call, ...identity, recipientId: two.userId });
  await notifyDmDevices(f.env, one.userId, { ...call, expiresAt: Date.now() - 1 }, send);
  await notifyDmDevices(f.env, one.userId, { ...message, roomId: 1 }, send);
  await notifyDmDevices(f.env, outside.userId, message, send);
  f.database.run('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES(2,1)');
  await notifyDmDevices(f.env, one.userId, message, send);
  f.database.run('DELETE FROM user_blocks; UPDATE users SET session_version=1 WHERE id=2');
  await notifyDmDevices(f.env, one.userId, message, send);
  assert.equal(packets.length, 2);
  f.database.run('UPDATE users SET session_version=0 WHERE id=2');
  await notifyDmDevices(f.env, one.userId, message, async () => new Response(null, { status: 410 }));
  assert.equal(await f.status(two, receiver), false);
  assert.equal(await f.status(two, muted), true);
});

test('encrypted previews bound text, use the account name as fallback, and describe attachments without sharing file URLs', async t => {
  const f = fixture(t);
  const [, recipient] = f.sessions;
  const device = browser('preview');
  await f.subscribe(recipient, device);
  f.database.run("INSERT INTO uploaded_files(object_key,owner_user_id,content_type) VALUES(?,1,'image/png')", ['界'.repeat(600)]);
  f.database.run("UPDATE users SET display_name=' ', avatar_key=? WHERE id=1", ['界'.repeat(600)]);
  const receive = async event => {
    let payload;
    await notifyDmDevices(f.env, 1, event, (_endpoint, init) => {
      payload = decrypt(device, init.body);
      return new Response(null, { status: 201 });
    });
    return payload;
  };
  for (const [attachment, kind, content, expected] of [
    [{ type: 'image/png' }, 'image', '**配图** 说明', '配图 说明'],
    [{ type: 'video/mp4' }, 'video', '', ''],
    [{ kind: 'voice', type: 'audio/webm' }, 'voice', '', ''],
    [{ type: 'audio/mpeg' }, 'audio', '', ''],
    [{ type: 'application/pdf', name: '报告.pdf' }, 'file', '', '报告.pdf'],
  ]) {
    const file = { ...attachment, key: 'private-object', url: '/files/private-object' };
    const payload = await receive({ ...message, content, attachment: file });
    assert.deepEqual(payload, {
      type: 'message', roomId: 10, recipientId: 2, messageId: 25, senderName: 'one', attachmentKind: kind, preview: expected,
    });
  }
  const long = await receive({ ...message, content: '🥁'.repeat(3000) });
  assert.equal(long.preview, '🥁'.repeat(119) + '…');
  const voice = { type: 'call', roomId: 10, media: 'audio', callId: 'c', expiresAt: Date.now() + 45_000 };
  assert.deepEqual(await receive(voice), { ...voice, senderName: 'one', recipientId: 2 });
});

test('one failed provider does not interrupt its sibling and a stale 410 cannot erase a renewed subscription', async t => {
  const f = fixture(t);
  const [, two] = f.sessions;
  const stale = browser('stale'), transient = browser('transient');
  for (const device of [stale, transient]) assert.equal((await f.subscribe(two, device)).status, 200);
  const contacted = [];
  const warning = t.mock.method(console, 'warn', () => {});
  await notifyDmDevices(f.env, 1, message, async endpoint => {
    contacted.push(endpoint);
    if (endpoint === stale.subscription.endpoint) {
      assert.equal((await f.subscribe(two, stale)).status, 200);
      return new Response(null, { status: 410 });
    }
    throw new Error('temporary connection failure');
  });
  assert.deepEqual(contacted.sort(), [stale.subscription.endpoint, transient.subscription.endpoint].sort());
  assert.equal(warning.mock.calls[0].arguments[0], 'web_push_delivery_failed');
  assert.ok(await f.status(two, stale));
  assert.ok(await f.status(two, transient));
});

import { buildPushPayload } from '@block65/webcrypto-web-push';
import { decryptSecretValue, encryptSecretValue } from './encryption.js';
import { ApiError } from './errors.js';
import { activeUserSql } from './user-status.js';
import { hashOpaqueToken } from './mobile-session.js';

const maxDevices = 8;

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value, length) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url key');
  }
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}

export function pushConfig(env) {
  if (!env.WEB_PUSH_VAPID_JWK || !env.WEB_PUSH_SUBJECT) return null;
  try {
    const key = JSON.parse(env.WEB_PUSH_VAPID_JWK);
    const subject = new URL(env.WEB_PUSH_SUBJECT);
    if (key.kty !== 'EC' || key.crv !== 'P-256' || !['https:', 'mailto:'].includes(subject.protocol)) return null;
    const publicKey = encode([4, ...decode(key.x, 32), ...decode(key.y, 32)]);
    decode(key.d, 32);
    return { publicKey, privateKey: key.d, subject: subject.href };
  } catch {
    return null;
  }
}

function validatedEndpoint(value) {
  if (typeof value === 'string' && value.length <= 2048) {
    try {
      const url = new URL(value);
      // Only browser-operated push services may receive requests from this Worker.
      const allowed = url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com'
        || url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.web.push.apple.com')
        || url.hostname.endsWith('.notify.windows.com');
      if (allowed && url.protocol === 'https:' && !url.username && !url.password && !url.port
        && !url.hash && url.pathname.length > 1) return url.href;
    } catch { /* Invalid URL. */ }
  }
  throw new ApiError('不支持此浏览器的推送服务地址', 400);
}

function subscriptionContext(userId, endpointId) {
  return `web-push:${userId}:${endpointId}`;
}

async function validateSubscription(body) {
  const endpoint = validatedEndpoint(body?.endpoint);
  try {
    const p256dh = decode(body.keys.p256dh, 65);
    if (p256dh[0] !== 4) throw new Error();
    await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    decode(body.keys.auth, 16);
  } catch {
    throw new ApiError('推送订阅密钥无效', 400);
  }
  const muted = body.mutedDmRoomIds ?? [];
  if (!Array.isArray(muted) || muted.length > 1024 || !muted.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new ApiError('静音会话列表无效', 400);
  }
  const expirationTime = body.expirationTime ?? null;
  if (expirationTime !== null && (!Number.isFinite(expirationTime) || expirationTime <= Date.now())) {
    throw new ApiError('推送订阅已失效', 400);
  }
  return { endpoint, expirationTime, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth }, mutedDmRoomIds: [...new Set(muted)] };
}

async function sessionExpiry(env, session) {
  const expiry = Date.parse(session.expiresAt);
  if (Number.isFinite(expiry)) return expiry;
  // Web sessions use a KV TTL. Only the absolute expiry and a hash are kept in D1.
  const { keys } = await env.SESSIONS.list({ prefix: session.token, limit: 1 });
  const kvKey = keys.find(key => key.name === session.token);
  if (!kvKey?.expiration) throw new ApiError('登录信息暂时无法确认，请稍后重试', 503);
  return kvKey.expiration * 1000;
}

export async function savePushSubscription(env, session, body) {
  if (!pushConfig(env)) throw new ApiError('服务器尚未配置 Web Push', 503);
  const subscription = await validateSubscription(body);
  const [endpointId, sessionHash, expiry] = await Promise.all([
    hashOpaqueToken(subscription.endpoint), hashOpaqueToken(session.token), sessionExpiry(env, session),
  ]);
  const sealed = await encryptSecretValue(env, JSON.stringify(subscription), subscriptionContext(session.userId, endpointId));
  const validUntil = Math.floor(Math.min(expiry, subscription.expirationTime ?? expiry));
  // Remove expired devices and enforce the per-account cap atomically even for concurrent registrations.
  const [, write] = await env.DB.batch([
    env.DB.prepare('DELETE FROM web_push_subscriptions WHERE user_id = ? AND (session_version != ? OR valid_until <= ?)')
      .bind(session.userId, session.sessionVersion, Date.now()),
    env.DB.prepare(`INSERT INTO web_push_subscriptions
      (endpoint_id, user_id, session_hash, session_version, valid_until, subscription, device_session_id)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE (SELECT COUNT(*) FROM web_push_subscriptions WHERE user_id = ?2) < ?8
        OR EXISTS (SELECT 1 FROM web_push_subscriptions WHERE endpoint_id = ?1 AND user_id = ?2)
      ON CONFLICT(endpoint_id) DO UPDATE SET session_hash = excluded.session_hash, session_version = excluded.session_version,
        valid_until = excluded.valid_until, subscription = excluded.subscription, device_session_id = excluded.device_session_id
        WHERE user_id = excluded.user_id`)
      .bind(endpointId, session.userId, sessionHash, session.sessionVersion, validUntil, sealed, session.deviceSessionId ?? null, maxDevices),
  ]);
  if (!write.meta.changes) throw new ApiError('该推送订阅已绑定其他账号或设备数量已达上限', 409);
}

export async function pushSubscriptionStatus(env, session, endpoint) {
  const endpointId = await hashOpaqueToken(validatedEndpoint(endpoint));
  const sessionHash = await hashOpaqueToken(session.token);
  const row = await env.DB.prepare(`SELECT 1 FROM web_push_subscriptions
    WHERE endpoint_id = ? AND user_id = ? AND session_hash = ? AND session_version = ? AND valid_until > ?`)
    .bind(endpointId, session.userId, sessionHash, session.sessionVersion, Date.now()).first();
  return Boolean(row);
}

export async function removePushSubscription(env, session, endpoint) {
  const endpointId = await hashOpaqueToken(validatedEndpoint(endpoint));
  await env.DB.prepare('DELETE FROM web_push_subscriptions WHERE endpoint_id = ? AND user_id = ?')
    .bind(endpointId, session.userId).run();
}

export async function removeSessionPushSubscriptions(env, session) {
  await env.DB.prepare('DELETE FROM web_push_subscriptions WHERE user_id = ? AND (session_hash = ? OR device_session_id = ?)')
    .bind(session.userId, await hashOpaqueToken(session.token), session.deviceSessionId ?? null).run();
}

async function deliver(env, row, event, vapid, send) {
  const subscription = JSON.parse(await decryptSecretValue(env, row.subscription, subscriptionContext(row.user_id, row.endpoint_id)));
  if (subscription.mutedDmRoomIds.includes(event.roomId)) return;
  const endpoint = validatedEndpoint(subscription.endpoint);
  const ttl = Math.min(3600, Math.floor((Math.min(row.valid_until, event.expiresAt ?? Infinity) - Date.now()) / 1000));
  if (ttl < 1) return;
  const init = await buildPushPayload({
    data: { ...event, recipientId: row.user_id },
    options: { ttl, urgency: event.type === 'call' ? 'high' : 'normal' },
  }, subscription, vapid);
  // workerd supports manual redirects. A 3xx is a delivery failure and must
  // never forward the signed payload to a location supplied by the provider.
  const response = await send(endpoint, { ...init, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare('DELETE FROM web_push_subscriptions WHERE endpoint_id = ? AND subscription = ?')
      .bind(row.endpoint_id, row.subscription).run();
  } else if (!response.ok) {
    throw new Error('Push service declined notification');
  }
}

export async function notifyDmDevices(env, senderId, event, send = fetch) {
  const vapid = pushConfig(env);
  if (!vapid) return;
  try {
    const { results } = await env.DB.prepare(`SELECT p.* FROM channels c
      JOIN channel_members sender ON sender.channel_id = c.id AND sender.user_id = ?2
      JOIN channel_members receiver ON receiver.channel_id = c.id AND receiver.user_id != sender.user_id
      JOIN users u ON u.id = receiver.user_id JOIN web_push_subscriptions p ON p.user_id = u.id
      WHERE c.id = ?1 AND c.kind = 'dm' AND c.deleted_at IS NULL
        AND (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) = 2
        AND u.deleted_at IS NULL AND ${activeUserSql('u')}
        AND p.session_version = u.session_version AND p.valid_until > ?3
        AND (p.device_session_id IS NULL OR EXISTS (SELECT 1 FROM device_sessions d WHERE d.id = p.device_session_id
          AND d.user_id = u.id AND d.revoked_at IS NULL AND d.session_version = u.session_version AND d.expires_at > CURRENT_TIMESTAMP))
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = sender.user_id AND b.blocked_id = u.id)
          OR (b.blocker_id = u.id AND b.blocked_id = sender.user_id)) LIMIT ?4`)
      .bind(event.roomId, senderId, Date.now(), maxDevices).all();
    const deliveries = await Promise.allSettled(results.map(row => deliver(env, row, event, vapid, send)));
    if (deliveries.some(result => result.status === 'rejected')) console.warn('web_push_delivery_failed');
  } catch {
    // Endpoints and message data must never appear in logs or interrupt a committed message/call.
    console.warn('web_push_dispatch_failed');
  }
}

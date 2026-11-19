const OWNER_KEY = 'edgechat:web-push-owner';

export function hasDevicePush(userId, storage = globalThis.localStorage) {
  return Boolean(userId) && storage?.getItem(OWNER_KEY) === String(userId);
}

export function supportsWebPush(browser = globalThis.window) {
  return Boolean(browser?.isSecureContext && browser.Notification && browser.PushManager && browser.navigator.serviceWorker);
}

function markSubscription(userId) {
  if (userId) globalThis.localStorage?.setItem(OWNER_KEY, String(userId));
  else globalThis.localStorage?.removeItem(OWNER_KEY);
}

async function activeRegistration() {
  const container = navigator.serviceWorker;
  const registration = await container.getRegistration('/');
  if (registration?.active) return registration;
  // Registration can fail (e.g. a disabled service worker). ready never rejects.
  let timer;
  try {
    return await Promise.race([
      container.ready,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('service_worker_unavailable')), 10000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadDevicePush(api, userId) {
  const [config, registration] = await Promise.all([api.pushConfig(), activeRegistration()]);
  const subscription = await registration.pushManager.getSubscription();
  const storedKey = subscription?.options?.applicationServerKey;
  const expectedKey = config.publicKey && applicationKey(config.publicKey);
  const keyMatches = !storedKey || !expectedKey || (storedKey.byteLength === expectedKey.length
    && new Uint8Array(storedKey).every((value, i) => value === expectedKey[i]));
  const active = Boolean(subscription && keyMatches && (await api.pushStatus(subscription.endpoint)).subscribed);
  markSubscription(active ? userId : null);
  return { config, active, registration, subscription };
}

function applicationKey(publicKey) {
  return Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

function subscriptionPayload(subscription, userId) {
  const preferences = globalThis.localStorage?.getItem(`edgechat:browser-notifications:${userId}`);
  let mutedRooms;
  try { mutedRooms = JSON.parse(preferences || '{}').mutedRooms; } catch { /* Discard damaged local preferences. */ }
  const mutedDmRoomIds = Array.isArray(mutedRooms) ? mutedRooms
    .filter(key => typeof key === 'string' && /^dm:[1-9]\d*$/.test(key))
    .map(key => Number(key.slice(3))).filter(Number.isSafeInteger).slice(0, 1024) : [];
  return { ...subscription.toJSON(), mutedDmRoomIds };
}

export async function enableDevicePush(api, userId, { registration, subscription: previous, config }) {
  // An existing but inactive subscription may belong to a previous account.
  if (previous) await previous.unsubscribe();
  // On first use subscribe() itself prompts, synchronously under user activation.
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: applicationKey(config.publicKey)
  });
  try {
    await api.savePushSubscription(subscriptionPayload(subscription, userId));
    markSubscription(userId);
    return true;
  } catch (error) {
    await subscription.unsubscribe().catch(() => {});
    throw error;
  }
}

export async function removeDevicePush(api, registration) {
  const reg = registration || await globalThis.navigator?.serviceWorker?.getRegistration('/');
  const subscription = await reg?.pushManager?.getSubscription();
  if (subscription) {
    // Either deletion stops delivery. Try both even if the network is offline.
    const attempts = await Promise.allSettled([
      subscription.unsubscribe(),
      ...(api ? [api.deletePushSubscription(subscription.endpoint)] : [])
    ]);
    if (attempts.every(attempt => attempt.status === 'rejected')) throw attempts[0].reason;
  }
  markSubscription(null);
  const displayed = await reg?.getNotifications?.();
  displayed?.forEach(notification => notification.close());
}

export async function reconcileDevicePush(api, userId) {
  const owner = globalThis.localStorage?.getItem(OWNER_KEY);
  if (!owner || !supportsWebPush()) return;
  if (owner !== String(userId)) {
    await removeDevicePush(null);
    return;
  }
  const registration = await activeRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    markSubscription(null);
  } else if (hasDevicePush(userId)) {
    // Renew rotated endpoints and reconcile room mutes changed while offline.
    await api.savePushSubscription(subscriptionPayload(subscription, userId));
  }
}

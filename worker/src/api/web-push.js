import { bodyLimit } from 'hono/body-limit';
import { ApiError } from '../errors.js';
import { pushConfig, pushSubscriptionStatus, removePushSubscription, savePushSubscription } from '../web-push.js';

export function registerWebPushRoutes(app) {
  app.use('/api/push/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    await next();
  }, bodyLimit({ maxSize: 24 * 1024, onError: () => { throw new ApiError('推送订阅数据过大', 413); } }));

  app.get('/api/push/config', c => {
    const vapid = pushConfig(c.env);
    return c.json({ enabled: Boolean(vapid), publicKey: vapid?.publicKey ?? '' });
  });
  app.post('/api/push/status', async c => {
    const { endpoint } = await c.req.json().catch(() => ({})) ?? {};
    return c.json({ subscribed: await pushSubscriptionStatus(c.env, c.get('session'), endpoint) });
  });
  app.post('/api/push/subscription', async c => {
    await savePushSubscription(c.env, c.get('session'), await c.req.json().catch(() => null));
    return c.json({ ok: true });
  });
  app.delete('/api/push/subscription', async c => {
    const { endpoint } = await c.req.json().catch(() => ({})) ?? {};
    await removePushSubscription(c.env, c.get('session'), endpoint);
    return c.json({ ok: true });
  });
}

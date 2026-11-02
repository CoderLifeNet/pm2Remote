import express from 'express';
import { fileURLToPath } from 'node:url';
import { browserAuth } from './browser-auth.js';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const visible = p => ({
  id: p.pm_id, name: p.name, status: p.pm2_env?.status ?? 'unknown',
  cpu: p.monit?.cpu ?? null, memory: p.monit?.memory ?? null,
  startedAt: p.pm2_env?.pm_uptime ?? null, restarts: p.pm2_env?.restart_time ?? null,
});

export function createApp({ pm2, config, audit = entry => console.log(JSON.stringify(entry)), limit = 60 }) {
  const app = express();
  const readHash = digest(config.readToken);
  const controlHash = digest(config.controlToken);
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.cookieSecure ? [] : null } } }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    res.on('finish', () => audit({
      time: new Date().toISOString(), requestId: req.requestId,
      method: req.method, route: req.route?.path ?? 'unmatched',
      processId: req.params?.id ?? null, role: req.role ?? 'anonymous',
      status: res.statusCode, peer: req.ip,
    }));
    next();
  });
  // Behind a proxy this intentionally uses one shared bucket, ignoring forwarded IPs.
  app.use(rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'rate_limited' } }));
  const browser = browserAuth(config);
  app.locals.sessionStore = browser.store;
  app.use(['/auth', '/v1'], browser.middleware, (req, res, next) => {
    if (req.session.user && Date.now() - req.session.createdAt > 8 * 60 * 60_000) {
      return req.session.destroy(err => err ? next(err) : res.status(401).json({ error: 'session_expired' }));
    }
    next();
  });
  app.use('/auth', browser.router);
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { etag: false, maxAge: 0 }));
  app.use((req, res, next) => {
    if (!req.get('authorization') && req.session?.user) {
      req.role = 'control';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return browser.csrf(req, res, next);
      return next();
    }
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') ?? '');
    const supplied = digest(match?.[1] ?? '');
    const isRead = timingSafeEqual(supplied, readHash);
    const isControl = timingSafeEqual(supplied, controlHash);
    if (!match || (!isRead && !isControl)) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.role = isControl ? 'control' : 'read';
    next();
  });
  const call = (method, ...args) => new Promise((resolve, reject) => {
    pm2[method](...args, (err, result) => err ? reject(err) : resolve(result));
  });
  const allowed = p => config.allowedNames.has(p.name) && p.pid !== process.pid;
  app.get('/v1/processes', async (req, res) => {
    const processes = await call('list');
    res.json({ processes: processes.filter(allowed).map(visible) });
  });
  app.post('/v1/processes/:id/:action', async (req, res) => {
    if (req.role !== 'control') return res.status(403).json({ error: 'forbidden' });
    const { id, action } = req.params;
    if (!/^(0|[1-9]\d{0,8})$/.test(id) || !['restart', 'reload', 'stop'].includes(action)) {
      return res.status(400).json({ error: 'invalid_process_or_action' });
    }
    if (req.get('transfer-encoding') || (req.get('content-length') && req.get('content-length') !== '0')) {
      return res.status(400).json({ error: 'body_not_allowed' });
    }
    const target = (await call('list')).find(p => p.pm_id === Number(id) && allowed(p));
    if (!target) return res.status(404).json({ error: 'process_not_found' });
    // Numeric IDs avoid PM2's special all, name, namespace and path selectors.
    await call(action, Number(id));
    res.json({ ok: true, id: Number(id), action });
  });
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body_too_large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    res.status(503).json({ error: 'service_unavailable', requestId: req.requestId });
  });
  return app;
}

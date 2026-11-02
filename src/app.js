import express from 'express';
import { fileURLToPath } from 'node:url';
import { createRootBackend } from './root-client.js';
import { createCommandRunner, parseInvocation, validateArgs, validateEnvironment } from './pm2-command.js';
import { browserAuth } from './browser-auth.js';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const visible = p => ({
  namespace: p.pm2_env?.namespace ?? 'default', mode: p.pm2_env?.exec_mode ?? 'fork_mode',
  id: p.pm_id, name: p.name, status: p.pm2_env?.status ?? 'unknown',
  cpu: p.monit?.cpu ?? null, memory: p.monit?.memory ?? null,
  startedAt: p.pm2_env?.pm_uptime ?? null, restarts: p.pm2_env?.restart_time ?? null,
});

export function createApp({ pm2, config, audit = entry => console.log(JSON.stringify(entry)), limit = 60, commandRunner, rootBackend }) {
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
      status: res.statusCode, peer: req.ip, action: req.auditAction ?? null, commandExitCode: req.commandExitCode ?? null, instance: req.instance ?? 'user',
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
  const call = (req, method, ...args) => new Promise((resolve, reject) => {
    req.backend.pm2[method](...args, (err, result) => err ? reject(err) : resolve(result));
  });
  const fullControl = config.managementMode === 'full';
  const runCommand = commandRunner ?? createCommandRunner(config);
  const backends = { user: { pm2, command: runCommand } };
  if (fullControl && config.rootSocket) backends.root = rootBackend ?? createRootBackend(config);
  app.use('/v1', (req, res, next) => {
    req.instance = req.get('x-pm2-instance') ?? 'user';
    if (!Object.hasOwn(backends, req.instance)) return res.status(400).json({ error: 'invalid_instance' });
    req.backend = backends[req.instance];
    next();
  });
  const commandBusy = new Set();
  const allowed = p => (fullControl || config.allowedNames.has(p.name)) && p.pid !== process.pid;
  const requireFullControl = (req, res, next) => {
    if (req.role !== 'control') return res.status(403).json({ error: 'forbidden' });
    if (!fullControl) return res.status(403).json({ error: 'full_control_disabled' });
    next();
  };
  app.get('/v1/capabilities', (req, res) => {
    res.json({ simulated: Boolean(config.simulated), managementMode: config.managementMode ?? 'restricted', role: req.role,
      fullControl: fullControl && req.role === 'control', scope: req.instance === 'root' ? '/root' : (config.commandHome ?? 'current service account'),
      instances: [{ id: 'user', label: config.commandHome?.split('/').pop() ?? 'Service user' }, ...(backends.root ? [{ id: 'root', label: 'root' }] : [])] });
  });
  app.post('/v1/pm2/command', requireFullControl, express.json({ limit: '24kb', strict: true }), async (req, res) => {
    if (!req.body || (Object.hasOwn(req.body, 'args') === Object.hasOwn(req.body, 'command')) ||
        Object.keys(req.body).some(key => !['args', 'command', 'environment'].includes(key))) {
      return res.status(400).json({ error: 'invalid_command' });
    }
    const invocation = Object.hasOwn(req.body, 'args') ? { args: validateArgs(req.body.args), environment: {} } : parseInvocation(req.body.command);
    const { args } = invocation;
    const environment = validateEnvironment({ ...invocation.environment, ...validateEnvironment(req.body.environment) });
    req.auditAction = args[0];
    if (commandBusy.has(req.instance)) return res.status(409).json({ error: 'command_in_progress' });
    commandBusy.add(req.instance);
    try {
      const result = await req.backend.command(args, environment);
      req.commandExitCode = result.exitCode;
      res.json(result);
    } finally { commandBusy.delete(req.instance); }
  });
  app.get('/v1/processes/:id/logs', requireFullControl, async (req, res) => {
    if (!/^(0|[1-9]\d{0,8})$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_process_or_action' });
    const target = (await call(req, 'list')).find(p => p.pm_id === Number(req.params.id) && allowed(p));
    if (!target) return res.status(404).json({ error: 'process_not_found' });
    // Snapshot avoids keeping a streaming CLI attached to a web request.
    res.json(await req.backend.command(['logs', req.params.id, '--nostream', '--lines', '100', '--raw']));
  });

  app.get('/v1/processes', async (req, res) => {
    const processes = await call(req, 'list');
    res.json({ processes: processes.filter(allowed).map(visible) });
  });
  app.post('/v1/processes/:id/:action', async (req, res) => {
    if (req.role !== 'control') return res.status(403).json({ error: 'forbidden' });
    const { id, action } = req.params;
    if (!/^(0|[1-9]\d{0,8})$/.test(id) || !['restart', 'reload', 'stop', ...(fullControl ? ['delete', 'reset'] : [])].includes(action)) {
      return res.status(400).json({ error: 'invalid_process_or_action' });
    }
    if (req.get('transfer-encoding') || (req.get('content-length') && req.get('content-length') !== '0')) {
      return res.status(400).json({ error: 'body_not_allowed' });
    }
    const target = (await call(req, 'list')).find(p => p.pm_id === Number(id) && allowed(p));
    if (!target) return res.status(404).json({ error: 'process_not_found' });
    // Numeric IDs avoid PM2's special all, name, namespace and path selectors.
    await call(req, action, Number(id));
    res.json({ ok: true, id: Number(id), action });
  });
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => {
    if (err.status === 400 && err.code === 'invalid_command') return res.status(400).json({ error: 'invalid_command' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'body_too_large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    res.status(503).json({ error: 'service_unavailable', requestId: req.requestId });
  });
  return app;
}

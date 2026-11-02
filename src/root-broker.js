// Private local helper. Never expose this socket through an HTTP reverse proxy.
import express from 'express';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createLocalBackend } from './local-backend.js';
import { validateArgs, validateEnvironment } from './pm2-command.js';
import path from 'node:path';
const socket = process.env.PM2_ROOT_SOCKET;
const token = process.env.PM2_ROOT_TOKEN;
if (process.getuid?.() !== 0 || !socket || !path.isAbsolute(socket) || !/^[a-f0-9]{64}$/.test(token ?? '')) {
  throw new Error('Root helper requires root, an absolute PM2_ROOT_SOCKET and a random PM2_ROOT_TOKEN.');
}
const digest = value => createHash('sha256').update(value).digest();
const expected = digest(`Bearer ${token}`);
const backend = createLocalBackend({ commandHome: '/root', commandUser: 'root', pm2Home: '/root/.pm2',
  cliPath: process.env.PM2_CLI_PATH, rootToken: token });
const app = express();
app.disable('x-powered-by');
let busy = false;
app.use((req, res, next) => {
  if (!timingSafeEqual(digest(req.get('authorization') ?? ''), expected)) return res.sendStatus(401);
  next();
});
app.post('/operation', express.json({ limit: '32kb' }), async (req, res) => {
  if (busy) return res.sendStatus(409);
  const body = req.body;
  if (!body || !['list', 'command'].includes(body.operation) ||
      Object.keys(body).some(key => !['operation', ...(body.operation === 'command' ? ['args', 'environment'] : [])].includes(key))) return res.sendStatus(400);
  if (body.operation === 'command') { validateArgs(body.args); validateEnvironment(body.environment); }
  busy = true;
  try {
    if (body.operation === 'list') {
      const processes = await new Promise((resolve, reject) => backend.pm2.list((err, data) => err ? reject(err) : resolve(data)));
      return res.json({ processes });
    }
    res.json(await backend.command(body.args, body.environment));
  } finally { busy = false; }
});
app.use((req, res) => res.sendStatus(404));
app.use((err, req, res, next) => res.status(err.status === 400 ? 400 : 503).json({ error: 'broker_operation_failed' }));
try {
  const existing = await lstat(socket);
  if (!existing.isSocket()) throw new Error('Refusing to replace a non-socket path.');
  await unlink(socket);
} catch (err) { if (err.code !== 'ENOENT') throw err; }
const server = app.listen(socket, async () => {
  await chmod(socket, 0o660);
  console.log('Root PM2 helper ready on private Unix socket.');
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close();
  setTimeout(() => process.exit(0), 5000).unref();
});

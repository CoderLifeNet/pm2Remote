// Isolated UI preview: uses .env login credentials, but never imports or connects to PM2.
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';
const secret = () => randomBytes(32).toString('hex');
const config = readConfig({
  ...process.env,
  // Keep preview sessions and API credentials independent from the live service.
  PM2_READ_TOKEN: secret(), PM2_CONTROL_TOKEN: secret(), SESSION_SECRET: secret(),
  PORT: '3110', PUBLIC_ORIGIN: 'http://localhost:3110', COOKIE_SECURE: 'false',
});
const processes = [...config.allowedNames].slice(0, 3).map((name, index) => ({
  pm_id: index, name, pid: -(index + 1),
  pm2_env: { status: index === 2 ? 'stopped' : 'online', restart_time: index },
  monit: { cpu: index === 2 ? 0 : 1.4, memory: index === 2 ? 0 : (91 - index * 27) * 1048576 },
}));
const pm2 = { list: cb => cb(null, processes) };
for (const action of ['restart', 'reload', 'stop']) pm2[action] = (id, cb) => {
  const p = processes.find(p => p.pm_id === id);
  p.pm2_env.status = action === 'stop' ? 'stopped' : 'online';
  if (action !== 'stop') p.pm2_env.restart_time++;
  cb(null, p);
};
const app = createApp({ pm2, config });
const server = app.listen(config.port, '127.0.0.1', () => console.log('SIMULATED UI PREVIEW http://localhost:3110 — sign in with your .env username and password. No real PM2 connection.'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { app.locals.sessionStore.stopInterval(); server.close(); });

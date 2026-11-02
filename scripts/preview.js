// Disposable simulator: uses .env login but never connects to either PM2 daemon.
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';
const secret = () => randomBytes(32).toString('hex');
const config = { ...readConfig({ ...process.env,
  PM2_READ_TOKEN: secret(), PM2_CONTROL_TOKEN: secret(), SESSION_SECRET: secret(),
  PM2_MANAGEMENT_MODE: 'full', PM2_COMMAND_HOME: '/home/dfren',
  PM2_ROOT_SOCKET: '/simulated/control.sock', PM2_ROOT_TOKEN: secret(),
  PORT: '3110', PUBLIC_ORIGIN: 'http://localhost:3110', COOKIE_SECURE: 'false',
}), simulated: true };
function simulator(names) {
  let nextId = 0;
  let processes = names.map(name => ({ pm_id: nextId++, name, pid: -nextId,
    pm2_env: { status: 'online', restart_time: 0 }, monit: { cpu: 1.4, memory: 64 * 1048576 } }));
  const pm2 = { list: cb => cb(null, processes) };
  for (const action of ['restart', 'reload', 'stop', 'delete', 'reset']) pm2[action] = (id, cb) => {
    const p = processes.find(p => p.pm_id === id);
    if (!p) return cb(new Error('Not found'));
    if (action === 'delete') processes = processes.filter(item => item !== p);
    else if (action === 'reset') p.pm2_env.restart_time = 0;
    else { p.pm2_env.status = action === 'stop' ? 'stopped' : 'online'; if (action !== 'stop') p.pm2_env.restart_time++; }
    cb(null);
  };
  const command = async args => {
    if (args[0] === 'start') {
      const nameIndex = args.indexOf('--name');
      processes.push({ pm_id: nextId++, name: nameIndex >= 0 ? args[nameIndex + 1] : 'new-process', pid: -nextId,
        pm2_env: { status: 'online', restart_time: 0 }, monit: { cpu: 0, memory: 32 * 1048576 } });
    }
    if (args[0] === 'delete') processes = args[1] === 'all' ? [] : processes.filter(p => p.name !== args[1] && String(p.pm_id) !== args[1]);
    return { ok: true, exitCode: 0, signal: null, timedOut: false, truncated: false,
      stdout: args[0] === 'list' || args[0] === 'jlist' ? JSON.stringify(processes.map(p => ({ id: p.pm_id, name: p.name, status: p.pm2_env.status })), null, 2) : `SIMULATED: pm2 ${args.join(' ')}\nNo real process was changed.`, stderr: '' };
  };
  return { pm2, command };
}
const user = simulator([...config.allowedNames].slice(0, 3));
const root = simulator(['root-demo-worker']);
const app = createApp({ pm2: user.pm2, commandRunner: user.command, rootBackend: root, config });
const server = app.listen(config.port, '127.0.0.1', () => console.log('SIMULATED UI PREVIEW http://localhost:3110 — use your .env login. Both PM2 instances are simulated.'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { app.locals.sessionStore.stopInterval(); server.close(); });

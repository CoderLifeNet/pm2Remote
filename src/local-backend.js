import { createCommandRunner } from './pm2-command.js';

export const processSummary = p => ({
  pm_id: p.pm_id, name: p.name, pid: p.pid,
  monit: { cpu: p.monit?.cpu, memory: p.monit?.memory },
  pm2_env: { status: p.pm2_env?.status, namespace: p.pm2_env?.namespace,
    exec_mode: p.pm2_env?.exec_mode, pm_uptime: p.pm2_env?.pm_uptime,
    restart_time: p.pm2_env?.restart_time },
});

export function createLocalBackend(config) {
  const command = createCommandRunner(config);
  const listCommand = createCommandRunner(config, { maxBytes: 4 * 1024 * 1024 });
  const pm2 = { list: callback => {
    listCommand(['jlist']).then(result => {
      if (!result.ok || result.truncated) throw new Error('PM2 list failed.');
      const processes = JSON.parse(result.stdout);
      if (!Array.isArray(processes)) throw new Error('Invalid PM2 list.');
      callback(null, processes.map(processSummary));
    }).catch(callback);
  } };
  for (const action of ['restart', 'reload', 'stop', 'delete', 'reset']) pm2[action] = (id, callback) => {
    command([action, String(id)]).then(result => {
      if (!result.ok) throw new Error('PM2 action failed.');
      callback(null);
    }).catch(callback);
  };
  return { pm2, command };
}

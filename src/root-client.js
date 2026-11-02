import http from 'node:http';
export function createRootBackend(config) {
  const request = payload => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ socketPath: config.rootSocket, path: '/operation', method: 'POST',
      headers: { authorization: `Bearer ${config.rootToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let text = '';
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 2 * 1024 * 1024) req.destroy(new Error('Broker response too large.'));
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Root PM2 helper unavailable.'));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid broker response.')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(40_000, () => req.destroy(new Error('Broker timed out.')));
    req.on('error', reject);
    req.end(data);
  });
  const command = (args, environment = {}) => request({ operation: 'command', args, environment });
  const pm2 = { list: callback => request({ operation: 'list' }).then(data => callback(null, data.processes), callback) };
  for (const action of ['restart', 'reload', 'stop', 'delete', 'reset']) pm2[action] = (id, callback) => {
    command([action, String(id)]).then(result => {
      if (!result.ok) throw new Error('Root PM2 action failed.');
      callback(null);
    }).catch(callback);
  };
  return { pm2, command };
}

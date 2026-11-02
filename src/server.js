import pm2 from 'pm2';
import { readConfig } from './config.js';
import { createApp } from './app.js';

const config = readConfig();
pm2.connect(err => {
  if (err) {
    console.error('Unable to connect to PM2. Check the service user and PM2_HOME.');
    pm2.disconnect();
    process.exitCode = 1;
    return;
  }
  const server = createApp({ pm2, config }).listen(config.port, '127.0.0.1', () => {
    console.log(`PM2 control API listening on 127.0.0.1:${config.port}`);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('error', () => {
    console.error('Unable to start HTTP listener.');
    pm2.disconnect();
    process.exitCode = 1;
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      clearTimeout(deadline);
      pm2.disconnect();
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});

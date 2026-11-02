import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseInvocation, validateArgs, createCommandRunner, commandEnvironment } from '../src/pm2-command.js';

test('command parsing preserves quotes, escaped spaces and literal variables without shell expansion', () => {
  assert.deepEqual(parseInvocation('NODE_ENV=production pm2 start "/path with spaces/app.js" -- --literal=\'$HOME\''), {
    args: ['start', '/path with spaces/app.js', '--', '--literal=$HOME'], environment: { NODE_ENV: 'production' },
  });
  for (const text of ['pm2 list; id', 'pm2 list | cat', 'pm2 list > /tmp/file', 'pm2 "unterminated', 'sudo pm2 list\nwhoami']) assert.throws(() => parseInvocation(text));
  assert.deepEqual(validateArgs(['startOrRestart', '/srv/ecosystem.config.js']), ['startOrRestart', '/srv/ecosystem.config.js']);
  assert.throws(() => validateArgs(['list', '\0']));
  assert.throws(() => validateArgs(['list', 'x'.repeat(4097)]));
});
test('subprocess environment is explicit and contains no dashboard login secrets', () => {
  const env = commandEnvironment({ commandHome: '/home/operator', pm2Home: '/home/operator/.pm2' });
  assert.equal(env.HOME, '/home/operator');
  assert.equal(env.PM2_HOME, '/home/operator/.pm2');
  assert.equal(env.PM2_SILENT, undefined);
  assert.equal(commandEnvironment({ silent: true }).PM2_SILENT, 'true');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LOGNAME', 'NO_COLOR', 'PATH', 'PM2_HOME', 'TERM', 'USER'].sort());
});
function childFixture() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
  return child;
}
test('runner uses a fixed executable with shell disabled, redacts secrets and bounds output', async () => {
  const child = childFixture();
  const run = createCommandRunner({ readToken: 'sensitive-token', cliPath: '/trusted/pm2', commandHome: '/home/operator' }, {
    maxBytes: 64, spawnProcess(executable, args, options) {
      assert.equal(executable, process.execPath); assert.deepEqual(args, ['/trusted/pm2', 'list']);
      assert.equal(options.shell, false); assert.equal(options.env.APP_MODE, 'test');
      queueMicrotask(() => { child.stdout.write('sensitive-token'); child.stderr.write('x'.repeat(100)); child.emit('close', 0, null); });
      return child;
    },
  });
  const result = await run(['list'], { APP_MODE: 'test' });
  assert.equal(result.ok, true); assert.equal(result.truncated, true);
  assert.equal(result.stdout, '[redacted]');
  assert.ok(result.stderr.length <= 64);
});
test('runner terminates stuck clients and reports an uncertain outcome instead of success', async () => {
  const child = childFixture();
  const run = createCommandRunner({}, { timeoutMs: 10, spawnProcess: () => child });
  const result = await run(['logs']);
  assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.signal, 'SIGTERM');
});

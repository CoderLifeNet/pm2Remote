import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/password.js';
import { readConfig } from '../src/config.js';

const testPassword = randomBytes(24).toString('hex');
const env = { PM2_READ_TOKEN: 'a'.repeat(64), PM2_CONTROL_TOKEN: 'b'.repeat(64), PM2_ALLOWED_NAMES: 'api,controller' };
Object.assign(env, { UI_USERNAME: 'admin', UI_PASSWORD_HASH: await hashPassword(testPassword), SESSION_SECRET: 'c'.repeat(64), PUBLIC_ORIGIN: 'http://localhost:3100', COOKIE_SECURE: 'false' });
const config = readConfig(env);
async function setup(t, options = {}) {
  const calls = [], logs = [];
  const pm2 = {
    list: cb => cb(null, [
      { pm_id: 0, name: 'api', pid: -1, pm2_env: { status: 'online', env: { PASSWORD: 'secret' } } },
      { pm_id: 1, name: 'private', pid: -2 },
      { pm_id: 2, name: 'controller', pid: process.pid },
    ]),
    ...Object.fromEntries(['restart', 'reload', 'stop'].map(action => [action, (id, cb) => { calls.push([action, id]); cb(null, { secret: 'hidden' }); }])),
    ...options.pm2,
  };
  const app = createApp({ pm2, config: options.config ?? config, audit: x => logs.push(x), limit: options.limit ?? 1000 });
  t.after(() => app.locals.sessionStore.stopInterval());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (path, { token = env.PM2_CONTROL_TOKEN, method = 'GET', ...rest } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...rest,
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  };
  return { request, calls, logs, store: app.locals.sessionStore };
}
test('fails closed for missing, identical or malformed credentials and empty allowlist', () => {
  for (const override of [{ PM2_READ_TOKEN: '' }, { PM2_CONTROL_TOKEN: env.PM2_READ_TOKEN }, { PM2_CONTROL_TOKEN: 'short' }, { PM2_ALLOWED_NAMES: '' }, { PM2_ALLOWED_NAMES: 'all' }, { PORT: '0' }]) {
    assert.throws(() => readConfig({ ...env, ...override }));
  }
});
test('all routes require authentication; query tokens do not work', async t => {
  const { request, calls } = await setup(t);
  for (const token of [null, 'c'.repeat(64), 'short']) {
    assert.equal((await request('/v1/processes', { token })).status, 401);
  }
  assert.equal((await request(`/v1/processes?token=${env.PM2_CONTROL_TOKEN}`, { token: null })).status, 401);
  assert.deepEqual(calls, []);
});
test('list restricts processes and strips PM2 environment and internal details', async t => {
  const { request, logs } = await setup(t);
  const result = await request('/v1/processes', { token: env.PM2_READ_TOKEN });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.processes.map(p => p.id), [0]);
  assert.equal(JSON.stringify(result.body).includes('secret'), false);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-powered-by'), null);
  assert.equal(JSON.stringify(logs).includes(env.PM2_READ_TOKEN), false);
});
test('read token cannot mutate; control token acts only on numeric allowlisted IDs', async t => {
  const { request, calls } = await setup(t);
  assert.equal((await request('/v1/processes/0/restart', { method: 'POST', token: env.PM2_READ_TOKEN })).status, 403);
  for (const id of ['1', '2', '999']) {
    assert.equal((await request(`/v1/processes/${id}/stop`, { method: 'POST' })).status, 404);
  }
  for (const id of ['all', 'api', '-1', '0;whoami', '00']) {
    assert.equal((await request(`/v1/processes/${id}/restart`, { method: 'POST' })).status, 400);
  }
  for (const action of ['delete', 'start', 'kill']) {
    assert.equal((await request(`/v1/processes/0/${action}`, { method: 'POST' })).status, 400);
  }
  assert.deepEqual(calls, []);
  for (const action of ['restart', 'reload', 'stop']) {
    assert.equal((await request(`/v1/processes/0/${action}`, { method: 'POST' })).status, 200);
  }
  assert.deepEqual(calls, [['restart', 0], ['reload', 0], ['stop', 0]]);
});
test('rejects bodies and wrong methods without invoking PM2 control', async t => {
  const { request, calls } = await setup(t);
  assert.equal((await request('/v1/processes/0/restart', { method: 'POST', body: '{"script":"evil.js"}' })).status, 400);
  assert.equal((await request('/v1/processes/0/restart')).status, 404);
  assert.deepEqual(calls, []);
});
test('PM2 failures return sanitized errors', async t => {
  const { request } = await setup(t, { pm2: { list: cb => cb(new Error('PASSWORD=secret')) } });
  const result = await request('/v1/processes');
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'service_unavailable');
  assert.equal(JSON.stringify(result.body).includes('secret'), false);
});
test('action failures are not reported as successful', async t => {
  const { request } = await setup(t, { pm2: { restart: (id, cb) => cb(new Error('secret path')) } });
  assert.equal((await request('/v1/processes/0/restart', { method: 'POST' })).status, 503);
});
test('rate limits requests including failed authentication', async t => {
  const { request } = await setup(t, { limit: 2 });
  await request('/v1/processes', { token: null });
  await request('/v1/processes', { token: null });
  assert.equal((await request('/v1/processes')).status, 429);
});

async function loginBrowser(request) {
  const initial = await request('/auth/session', { token: null });
  const oldCookie = initial.headers.get('set-cookie').split(';')[0];
  const result = await request('/auth/login', { token: null, method: 'POST', headers: {
    cookie: oldCookie, origin: config.publicOrigin, 'x-csrf-token': initial.body.csrfToken, 'content-type': 'application/json',
  }, body: JSON.stringify({ username: 'admin', password: testPassword }) });
  assert.equal(result.status, 200);
  return { cookie: result.headers.get('set-cookie').split(';')[0], csrf: result.body.csrfToken,
    oldCookie, oldCsrf: initial.body.csrfToken, result };
}
test('public login shell has CSP but exposes no secrets; private routes remain protected', async t => {
  const { request } = await setup(t);
  const result = await request('/', { token: null });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(result.body.includes(config.controlToken), false);
  assert.equal((await request('/.env', { token: null })).status, 401);
  assert.equal((await request('/v1/processes/0/stop', { token: null, method: 'POST' })).status, 401);
});
test('login rotates session ID and CSRF token; session authorizes list and guarded actions', async t => {
  const { request, calls } = await setup(t);
  const session = await loginBrowser(request);
  assert.notEqual(session.cookie, session.oldCookie);
  assert.notEqual(session.csrf, session.oldCsrf);
  assert.match(session.result.headers.get('set-cookie'), /HttpOnly/);
  assert.match(session.result.headers.get('set-cookie'), /SameSite=Strict/);
  const headers = { cookie: session.cookie };
  assert.equal((await request('/v1/processes', { token: null, headers })).status, 200);
  for (const override of [{}, { origin: 'https://evil.example', 'x-csrf-token': session.csrf },
    { origin: config.publicOrigin, 'x-csrf-token': session.oldCsrf }]) {
    assert.equal((await request('/v1/processes/0/stop', { token: null, method: 'POST', headers: { ...headers, ...override } })).status, 403);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request('/v1/processes/0/restart', { token: null, method: 'POST', headers: {
    ...headers, origin: config.publicOrigin, 'x-csrf-token': session.csrf,
  } })).status, 200);
  assert.deepEqual(calls, [['restart', 0]]);
  assert.equal((await request('/v1/processes', { token: null, headers: { cookie: session.oldCookie } })).status, 401);
});
test('failed login does not authenticate and cross-origin login is blocked', async t => {
  const { request } = await setup(t);
  const initial = await request('/auth/session', { token: null });
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: config.publicOrigin, 'x-csrf-token': initial.body.csrfToken, 'content-type': 'application/json' };
  for (const credentials of [{ username: 'admin', password: 'wrong' }, { username: 'wrong-user', password: testPassword }]) {
    const result = await request('/auth/login', { token: null, method: 'POST', headers, body: JSON.stringify(credentials) });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'invalid_login' });
  }
  assert.equal((await request('/auth/login', { token: null, method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await request('/v1/processes', { token: null, headers: { cookie } })).status, 401);
});
test('logout revokes copied cookies and cookie tampering fails', async t => {
  const { request } = await setup(t);
  const { cookie, csrf } = await loginBrowser(request);
  assert.equal((await request('/auth/logout', { token: null, method: 'POST', headers: { cookie } })).status, 403);
  assert.equal((await request('/auth/logout', { token: null, method: 'POST', headers: { cookie, origin: config.publicOrigin, 'x-csrf-token': csrf } })).status, 200);
  assert.equal((await request('/v1/processes', { token: null, headers: { cookie } })).status, 401);
  assert.equal((await request('/v1/processes', { token: null, headers: { cookie: cookie + 'tampered' } })).status, 401);
});
test('an expired absolute session cannot read or mutate even if its cookie remains', async t => {
  const { request, store, calls } = await setup(t);
  const { cookie, csrf } = await loginBrowser(request);
  const sessions = await new Promise((resolve, reject) => store.all((err, value) => err ? reject(err) : resolve(value)));
  const [id, record] = Object.entries(sessions).find(([, value]) => value.user);
  record.createdAt = Date.now() - 9 * 60 * 60_000;
  await new Promise((resolve, reject) => store.set(id, record, err => err ? reject(err) : resolve()));
  assert.equal((await request('/v1/processes/0/stop', { token: null, method: 'POST', headers: { cookie, origin: config.publicOrigin, 'x-csrf-token': csrf } })).status, 401);
  assert.deepEqual(calls, []);
});
test('login attempts are limited independently of API requests', async t => {
  const { request } = await setup(t);
  // CSRF failures count too; no expensive password checks needed for this test.
  for (let i = 0; i < 10; i++) assert.equal((await request('/auth/login', { token: null, method: 'POST' })).status, 403);
  assert.equal((await request('/auth/login', { token: null, method: 'POST' })).status, 429);
});
test('production cookies require HTTPS, use Host prefix and cannot be downgraded', async t => {
  for (const override of [{ PUBLIC_ORIGIN: 'http://example.com', COOKIE_SECURE: 'false' }, { PUBLIC_ORIGIN: 'http://localhost:3100', COOKIE_SECURE: 'true' },
    { PUBLIC_ORIGIN: 'https://example.com/', COOKIE_SECURE: 'true' }, { SESSION_SECRET: env.PM2_READ_TOKEN }, { UI_PASSWORD_HASH: 'plaintext' }]) {
    assert.throws(() => readConfig({ ...env, ...override }));
  }
  const production = readConfig({ ...env, PUBLIC_ORIGIN: 'https://example.com', COOKIE_SECURE: 'true' });
  const { request } = await setup(t, { config: production });
  const response = await request('/auth/session', { token: null, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(response.headers.get('set-cookie'), /^__Host-pm2.sid=/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
});
test('malformed and oversized login bodies do not authenticate or leak parser details', async t => {
  const { request } = await setup(t);
  const initial = await request('/auth/session', { token: null });
  const headers = { cookie: initial.headers.get('set-cookie').split(';')[0], origin: config.publicOrigin,
    'x-csrf-token': initial.body.csrfToken, 'content-type': 'application/json' };
  assert.equal((await request('/auth/login', { token: null, method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await request('/auth/login', { token: null, method: 'POST', headers, body: JSON.stringify({ password: 'x'.repeat(3000) }) })).status, 413);
});

test('login identity comes from environment configuration with no fallback credentials', async t => {
  for (const field of ['UI_USERNAME', 'UI_PASSWORD_HASH', 'SESSION_SECRET']) {
    assert.throws(() => readConfig({ ...env, [field]: '' }));
  }
  const username = 'custom-operator';
  const password = randomBytes(24).toString('hex');
  const custom = readConfig({ ...env, UI_USERNAME: username, UI_PASSWORD_HASH: await hashPassword(password) });
  const { request } = await setup(t, { config: custom });
  const initial = await request('/auth/session', { token: null });
  const headers = { cookie: initial.headers.get('set-cookie').split(';')[0], origin: custom.publicOrigin,
    'x-csrf-token': initial.body.csrfToken, 'content-type': 'application/json' };
  assert.equal((await request('/auth/login', { token: null, method: 'POST', headers,
    body: JSON.stringify({ username: 'admin', password: testPassword }) })).status, 401);
  const result = await request('/auth/login', { token: null, method: 'POST', headers, body: JSON.stringify({ username, password }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.username, username);
});

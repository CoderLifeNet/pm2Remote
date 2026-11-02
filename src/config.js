import { validPasswordHash } from './password.js';
export function readConfig(env = process.env) {
  const readToken = env.PM2_READ_TOKEN;
  const controlToken = env.PM2_CONTROL_TOKEN;
  for (const token of [readToken, controlToken]) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      throw new Error('Set both PM2 tokens to independent random 32-byte lowercase hex values.');
    }
  }
  if (readToken === controlToken) throw new Error('Read and control tokens must differ.');
  const allowedNames = new Set((env.PM2_ALLOWED_NAMES ?? '').split(',').map(s => s.trim()).filter(Boolean));
  if (!allowedNames.size || allowedNames.has('all')) throw new Error('Explicit allowed process names are required; all is forbidden.');
  const port = Number(env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(env.UI_USERNAME ?? '') || !validPasswordHash(env.UI_PASSWORD_HASH)) {
    throw new Error('Configure UI_USERNAME and a scrypt UI_PASSWORD_HASH with npm run setup.');
  }
  if (!/^[a-f0-9]{64}$/.test(env.SESSION_SECRET ?? '') || [readToken, controlToken].includes(env.SESSION_SECRET)) {
    throw new Error('SESSION_SECRET must be an independent random 32-byte hex value.');
  }
  let origin;
  try { origin = new URL(env.PUBLIC_ORIGIN); } catch { throw new Error('PUBLIC_ORIGIN must be an exact http(s) origin.'); }
  if (origin.origin !== env.PUBLIC_ORIGIN || !['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('PUBLIC_ORIGIN must be an exact http(s) origin without a trailing slash.');
  }
  if (env.COOKIE_SECURE !== undefined && !['true', 'false'].includes(env.COOKIE_SECURE)) throw new Error('COOKIE_SECURE must be true or false.');
  const cookieSecure = env.COOKIE_SECURE !== 'false';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((!cookieSecure && (!local || origin.protocol !== 'http:')) || (cookieSecure && origin.protocol !== 'https:')) {
    throw new Error('Use HTTPS and secure cookies, or explicitly use HTTP loopback with COOKIE_SECURE=false for an SSH tunnel.');
  }
  return { readToken, controlToken, allowedNames, port, username: env.UI_USERNAME,
    passwordHash: env.UI_PASSWORD_HASH, sessionSecret: env.SESSION_SECRET,
    publicOrigin: origin.origin, cookieSecure };
}

import express from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { verifyPassword } from './password.js';
const MemoryStore = createMemoryStore(session);
const digest = text => createHash('sha256').update(text).digest();
const same = (a, b) => timingSafeEqual(digest(a ?? ''), digest(b ?? ''));

export function browserAuth(config) {
  // Bounded, expiring single-instance store. Restarting the service revokes all logins.
  const store = new MemoryStore({ checkPeriod: 60_000, max: 1000, ttl: 30 * 60_000 });
  const cookieName = config.cookieSecure ? '__Host-pm2.sid' : 'pm2.sid';
  const cookie = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: 30 * 60_000 };
  const middleware = session({ name: cookieName, secret: config.sessionSecret, store,
    resave: false, saveUninitialized: false, rolling: true, cookie,
    // Listener is loopback-only; only a trusted local TLS proxy may reach it in HTTPS mode.
    proxy: config.cookieSecure });
  const csrf = (req, res, next) => {
    if (req.get('origin') !== config.publicOrigin || !req.session.csrf || !same(req.get('x-csrf-token'), req.session.csrf)) {
      return res.status(403).json({ error: 'invalid_csrf' });
    }
    next();
  };
  const router = express.Router();
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10,
    standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'login_rate_limited' } });
  router.get('/session', (req, res) => {
    req.session.csrf ??= randomBytes(32).toString('hex');
    res.json({ authenticated: Boolean(req.session.user), username: req.session.user ?? null,
      csrfToken: req.session.csrf, role: req.session.user ? 'control' : null });
  });
  router.post('/login', loginLimit, csrf, express.json({ limit: '2kb', strict: true }), async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || password.length > 256) {
        return res.status(400).json({ error: 'invalid_login' });
      }
      const passwordOK = await verifyPassword(password, config.passwordHash);
      if (!same(username, config.username) || !passwordOK) return res.status(401).json({ error: 'invalid_login' });
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      req.session.user = config.username;
      req.session.createdAt = Date.now();
      req.session.csrf = randomBytes(32).toString('hex');
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      res.json({ authenticated: true, username: config.username, role: 'control', csrfToken: req.session.csrf });
    } catch (err) { next(err); }
  });
  router.post('/logout', csrf, (req, res, next) => {
    req.session.destroy(err => {
      if (err) return next(err);
      res.clearCookie(cookieName, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
      res.json({ ok: true });
    });
  });
  return { middleware, router, csrf, store };
}

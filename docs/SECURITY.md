# Security and deployment notes

## Credentials

Production and preview login credentials come from `.env`: `UI_USERNAME` and `UI_PASSWORD_HASH`. There is no built-in login password or fallback account. Tests generate their own temporary password. The setup and hash-password helpers hide password input and use salted scrypt hashes; neither saves the plaintext password.

`.env`, `.env` backups, dependencies, private key files, and logs are ignored by Git. `.env.example` contains empty credentials and example configuration only. Keep local `.env` permissions restricted to its owner. Startup fails if required credentials are missing or malformed.

The read token, control token, and session secret must be independent random 32-byte lowercase hex strings. Setup generates them separately. Changing credentials requires a service restart. Restarting also revokes all browser sessions. Rotate API tokens when automation access changes.

## Browser sessions

Cookies are HttpOnly, SameSite=Strict, and path `/`. HTTPS mode adds Secure and the `__Host-` prefix. HTTP mode is allowed only with an explicitly configured HTTP loopback origin for local/SSH access. `PUBLIC_ORIGIN` must match exactly.

Login rotates the session ID and CSRF token. Browser writes require both an exact Origin match and the current CSRF token. Logout deletes the server session. Sessions expire after 30 minutes of inactivity or 8 hours total.

Sessions use a bounded, expiring memory store with up to 1,000 entries. Restarting loses sessions. Run one controller instance; multiple instances need shared session storage and distributed rate limits. There is one configured operator account, with no public registration or remote password reset.

## Listener and proxy

Express binds to `127.0.0.1`. Keep the raw listener private. Use an SSH tunnel or HTTPS through a trusted local reverse proxy. In HTTPS mode the session middleware trusts the local proxy's protocol header to issue Secure cookies; that proxy must overwrite client-supplied values. Local users and the proxy are part of the trust boundary.

Express ignores forwarded IPs. Limits are 60 requests per minute per peer plus 10 login attempts per 15 minutes. A local proxy or SSH tunnel makes these shared limits. Add per-client proxy limits if needed. In-memory limits reset at service restart.

Helmet supplies browser security headers and a Content Security Policy. Responses are not cached. Audit records include method, route, process ID, role, status, peer, timestamp and request ID. They exclude passwords, authorization headers, cookie values, request bodies and query strings.

## PM2 access

The API uses PM2's Node interface with numeric IDs. It does not execute shell commands. Only explicit app names in `PM2_ALLOWED_NAMES` may be listed or controlled. Keep every controller instance out of that list; the currently running controller PID is also excluded as a guard.

An API allowlist does not provide OS isolation: the service account can reach its whole PM2 daemon. Run as an unprivileged user, protect the account and credentials, and use a separate OS account and PM2 daemon for workloads that need stronger isolation. A PM2 namespace alone is not a security boundary.

Lookup and action are separate daemon calls. Avoid deleting/replacing PM2 processes concurrently with API actions. A hung PM2 callback can leave an action pending; refresh to check state before retrying. Success confirms PM2 accepted the action, not that application health checks passed.

## Verification

Automated tests use local HTTP requests with a fake PM2 adapter. They cover bearer and session authentication, role restrictions, CSRF, login limits, session rotation/expiration, logout, cookie flags, allowlists, and sanitized failures. They do not prove live daemon behavior or production proxy configuration.

Before rollout, verify HTTPS or SSH transport and exercise a disposable allowlisted app under the intended server user and PM2_HOME.

References: [PM2 Node API](https://pm2.keymetrics.io/docs/usage/pm2-api/), [Express security](https://expressjs.com/advanced/best-practice-security/), [Express sessions](https://expressjs.com/en/resources/middleware/session/).

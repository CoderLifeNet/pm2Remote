# API guide

All `/v1` routes require either a bearer API token or an authenticated browser session. Authentication and process restrictions are enforced by Express, including for clients that skip the dashboard.

| Method | Path | Bearer role | Result |
| --- | --- | --- | --- |
| GET | `/v1/processes` | Read or control | List allowed process summaries |
| POST | `/v1/processes/:id/restart` | Control | Restart one allowed PM2 ID |
| POST | `/v1/processes/:id/reload` | Control | Reload one allowed PM2 ID |
| POST | `/v1/processes/:id/stop` | Control | Stop one allowed PM2 ID |

Send API tokens in `Authorization: Bearer <token>`. Actions accept no request body. Use numeric process IDs returned by the list endpoint. Special selectors such as `all`, names, namespaces, and script paths are rejected. In restricted mode, creation, deletion and other advanced operations are unavailable. Full mode adds the command API below.

A list response contains only summaries:

```json
{
  "processes": [
    {
      "id": 0,
      "name": "my-api",
      "status": "online",
      "cpu": 0,
      "memory": 123456,
      "startedAt": 1793664000000,
      "restarts": 0
    }
  ]
}
```

Memory is bytes. `startedAt` is Unix milliseconds. Missing metrics are null. Process environments, paths, and raw PM2 errors are excluded.

A successful action returns:

```json
{ "ok": true, "id": 0, "action": "restart" }
```

This confirms PM2's callback succeeded. It does not establish application health. Avoid automatically retrying a timed-out action because it may already have run.

## Browser login

The dashboard uses these same-origin routes automatically:

1. `GET /auth/session` establishes a pre-login cookie and returns `{ authenticated, username, role, csrfToken }`.
2. `POST /auth/login` accepts `{ username, password }` JSON, up to 2 KB. Include the pre-login cookie, the exact configured `Origin`, and an `X-CSRF-Token` header matching the response above.
3. Successful login rotates the session ID and CSRF token and returns the authenticated session summary.
4. For session-authenticated process actions, include the cookie, exact `Origin`, and current CSRF token. No body is accepted.
5. `POST /auth/logout` with the cookie, exact `Origin`, and CSRF token destroys the session and clears the cookie.

The configured browser account has control access to allowlisted processes. A supplied invalid bearer header never falls back to cookie authentication. Bearer requests do not require browser CSRF headers.

## Errors

Errors return `{ "error": "code" }`. Service failures also include a request ID.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, malformed JSON, unsupported action, or unexpected action body |
| 401 | Missing or invalid credentials, or expired session |
| 403 | Insufficient role or invalid CSRF token/Origin |
| 404 | Missing/disallowed process or unknown authenticated route |
| 413 | Login body exceeds 2 KB |
| 429 | Request or login limit reached |
| 503 | Service or PM2 operation failed; outcome may be uncertain |

The full contract is in [openapi.json](../openapi.json).

## Full management API

Set `PM2_MANAGEMENT_MODE=full` to enable these routes. Every command/log route requires the control token or an authenticated browser session. Session writes still require exact Origin and CSRF validation.

Set `X-PM2-Instance: user` (default) or `X-PM2-Instance: root` on `/v1` requests. Root requires the separately configured private helper. Unknown instances are rejected; they never fall back to another account. `/v1/processes` lists every process in the selected instance in full mode. The API does not apply the restricted-mode name allowlist to the command console.

- `GET /v1/capabilities`: returns mode, role, fullControl, available instances, and current scope.
- `GET /v1/processes/:id/logs`: last 100 lines as a bounded non-streaming CLI result.
- `POST /v1/processes/:id/delete` and `/reset`: bodyless process actions, full mode only.
- `POST /v1/pm2/command`: run a PM2 command, with JSON up to 24 KB.

Use exactly one of `args` or `command`. Optional `environment` overrides must be string-valued objects:

```json
{
  "args": ["start", "/srv/my-app/server.js", "--name", "my-app"],
  "environment": { "NODE_ENV": "production", "PORT": "3000" }
}
```

Or:

```json
{ "command": "NODE_ENV=production pm2 restart my-app --update-env" }
```

Quotes and backslashes group arguments; variables are literal. Shell operators and expansion are unsupported. HOME, USER, LOGNAME, PATH, PM2_*, UI_*, SESSION_SECRET, NODE_OPTIONS, NODE_PATH and loader injection variables are reserved so a request cannot override its selected instance or CLI runtime. Pass interpreter settings using PM2's explicit flags instead.

Results are `{ ok, exitCode, signal, timedOut, truncated, stdout, stderr }`. HTTP 200 means the command ran: always inspect `ok` and `timedOut`. Outputs are plain text; rendering must use textContent rather than HTML. Console output may contain the selected account's process secrets (for example, `pm2 env`), so it is restricted to control access and is never audited. Known dashboard credential values are redacted from output.

A second concurrent command for the same instance returns 409. The CLI client is terminated after 30 seconds, with a 2-second forced-stop fallback. Output is limited to 128 KB. A timeout is an uncertain outcome, not a promise that the underlying daemon operation was cancelled. Commands use a minimal explicit environment, not the dashboard's login/token environment.

All actions, including command verb and selected instance, are audited without command arguments or supplied environment values. The root helper independently requires its private bearer credential on its Unix socket.

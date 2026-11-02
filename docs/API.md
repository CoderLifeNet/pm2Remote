# API guide

All `/v1` routes require either a bearer API token or an authenticated browser session. Authentication and process restrictions are enforced by Express, including for clients that skip the dashboard.

| Method | Path | Bearer role | Result |
| --- | --- | --- | --- |
| GET | `/v1/processes` | Read or control | List allowed process summaries |
| POST | `/v1/processes/:id/restart` | Control | Restart one allowed PM2 ID |
| POST | `/v1/processes/:id/reload` | Control | Reload one allowed PM2 ID |
| POST | `/v1/processes/:id/stop` | Control | Stop one allowed PM2 ID |

Send API tokens in `Authorization: Bearer <token>`. Actions accept no request body. Use numeric process IDs returned by the list endpoint. Special selectors such as `all`, names, namespaces, and script paths are rejected. Process creation, deletion, arbitrary commands, environment overrides and daemon shutdown are unavailable.

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

# pm2Remote

Manage your PM2 apps from a browser or API. Sign in, see which processes are running, check CPU and memory use, and restart, reload, or stop approved apps.

**You choose the login credentials.** The username and password hash live in your private `.env` file. There is no default password, and `.env` is excluded from Git.

## What you need

- A server with Node.js 22 or newer, npm, Git, and your apps already running under PM2.
- SSH access to that server.
- The same server user that owns your PM2 apps. Avoid running this as root.

Start with an SSH tunnel below. You do not need a domain or an HTTPS certificate for that option.

## 1. Download and install

Connect to your server and run:

```sh
git clone git@github.com:CoderLifeNet/pm2Remote.git
cd pm2Remote
npm ci
```

If the server does not have a GitHub SSH key, use HTTPS instead:

```sh
git clone https://github.com/CoderLifeNet/pm2Remote.git
cd pm2Remote
npm ci
```

## 2. Create your login and settings

Check the names of the PM2 apps you want to manage:

```sh
pm2 list
```

Then run:

```sh
npm run setup
```

Setup asks for:

1. **Username** — the name you will use to sign in.
2. **Password** — choose at least 16 characters. Input is hidden; type it again to confirm.
3. **Allowed PM2 names** — enter app names exactly as shown in `pm2 list`, separated by commas. Example: `my-api,my-worker`.
4. **Dashboard origin** — press Enter to use `http://localhost:3100` with an SSH tunnel. For an HTTPS domain, enter its full origin, such as `https://pm2.example.com`, without a trailing slash.

Setup creates `.env` with your username, a salted password hash, and randomly generated API tokens and a session secret. The file is readable and writable only by its owner on Unix systems. Setup refuses to overwrite an existing `.env`.

In the default restricted mode, only allowlisted process names appear in the dashboard. Do not add pm2Remote itself to that list.

## 3. Start the server

```sh
npm start
```

Leave it running. The service listens only on `127.0.0.1:3100` on the server.

If your apps use a custom `PM2_HOME`, add the same value to `.env` before starting:

```dotenv
PM2_HOME=/home/your-user/.pm2
```

## 4. Open the dashboard remotely

On **your computer**, open another terminal and run:

```sh
ssh -N -L 3100:127.0.0.1:3100 your-user@your-server
```

Replace `your-user` and `your-server` with your SSH details. Keep this terminal open while using the dashboard.

Open **[http://localhost:3100](http://localhost:3100)** in your browser and sign in with the credentials you chose during setup.

Use that exact URL. `localhost` and `127.0.0.1` are different origins for browser security checks.

If the service runs on your own computer, you can open the dashboard directly without a tunnel.

## 5. Use it

- **Refresh** updates the process list and metrics.
- **Restart** restarts the selected process. It can also resume an existing stopped process.
- **Reload** asks PM2 to reload the process. Behavior depends on the app's PM2 mode.
- **Stop** stops the selected process until you restart it.
- **Sign out** ends your browser session.

Each control action asks for confirmation. Process actions can interrupt requests, so choose the intended app and ID carefully. Cluster instances have separate PM2 IDs and are controlled individually.

Sessions expire after 30 minutes without activity or 8 hours total. Restarting pm2Remote signs out everyone.

## Full PM2 management

To manage every process in the service user's PM2 instance, add this to `.env` and restart the service:

```dotenv
PM2_MANAGEMENT_MODE=full
# Use absolute paths appropriate to your server:
PM2_COMMAND_HOME=/home/dfren
PM2_CLI_PATH=/usr/local/lib/node_modules/pm2/bin/pm2
```

`PM2_CLI_PATH` is optional. Point it to your existing PM2 CLI to match the daemon version; otherwise the bundled CLI is used. Full mode shows all processes for the selected instance and enables:

- **Add process**: supply an existing server script or ecosystem file, working directory, arguments, interpreter, environment variables and cluster size.
- **More actions**: view logs, inspect process details or environment, scale a cluster, reset restart counts, or delete a process.
- **All processes**: restart, reload, stop or delete every process in the selected instance.
- **Save list**: save the current process list for restoration.
- **PM2 command console**: run other non-interactive PM2 commands, with output shown below the command.

Examples for the console:

```text
pm2 start /home/dfren/www/my-app/server.js --name my-app
pm2 start /home/dfren/www/my-app/ecosystem.config.js --env production
NODE_ENV=production pm2 restart my-app --update-env
pm2 scale my-app 2
pm2 logs my-app --lines 100 --nostream
pm2 save
pm2 resurrect
pm2 reset my-app
pm2 delete my-app
pm2 --help
```

Commands and bulk actions affect **only the selected PM2 instance**. Full mode intentionally includes starting server code as that account. Protect the login and control token accordingly. Read tokens cannot run commands.

For **both `dfren` and root**, install the private helper described in [the deployment guide](docs/DEPLOYMENT.md). A selector then appears at the top of the dashboard. Root commands require typing `root` into the confirmation dialog. The web service stays unprivileged; the helper listens only on a private Unix socket.

The console executes PM2 directly. It is not an interactive SSH shell: no `sudo` prefix, pipelines, redirects, shell expansion, password prompts or terminal attachment. Use the instance selector for root, the dashboard for metrics, and `--nostream` for log snapshots. Commands have a 30-second deadline and return at most 128 KB of output. If a command times out, check the state before retrying; a daemon operation or deployment may continue after the client exits.

For full mode, run the dashboard as a separate systemd service so `pm2 kill`, daemon updates, and bulk actions do not stop the dashboard itself. See [deployment](docs/DEPLOYMENT.md).

## Change your login or settings

Edit `.env` on the server. A simplified example looks like this:

```dotenv
UI_USERNAME=your-username
UI_PASSWORD_HASH='paste-the-generated-scrypt-hash-here'
PM2_ALLOWED_NAMES=my-api,my-worker
PUBLIC_ORIGIN=http://localhost:3100
COOKIE_SECURE=false
PORT=3100
```

This excerpt shows the login and common settings. Keep the `SESSION_SECRET`, `PM2_READ_TOKEN`, and `PM2_CONTROL_TOKEN` values generated by setup in the same file. The complete template is in [`.env.example`](.env.example).

To change your password:

```sh
npm run hash-password
```

Enter the new password twice. Copy the generated `UI_PASSWORD_HASH='...'` line into `.env`, replacing the old one. Keep the single quotes. Change `UI_USERNAME` there too if needed.

**Restart the service after changing `.env`.** If you started it with `npm start`, press Ctrl+C, then run `npm start` again. This also revokes old browser sessions.

The password itself is never saved by these helpers. Do not add a plaintext `UI_PASSWORD` setting; the application expects `UI_PASSWORD_HASH`.

## Keep it running after you disconnect

Once the foreground setup works, stop it with Ctrl+C and run the controller under PM2 as the same user:

```sh
pm2 start src/server.js --name pm2-remote --node-args="--env-file=.env" --cwd "$PWD"
pm2 save
```

Keep `pm2-remote` out of `PM2_ALLOWED_NAMES`.

After changing `.env`, restart the controller:

```sh
pm2 restart pm2-remote
```

To restore your processes after a server reboot, run `pm2 startup` and follow the command PM2 prints for your operating system. Then run `pm2 save` again.

## Optional: use an HTTPS domain

To access the dashboard without an SSH tunnel, put an HTTPS reverse proxy such as Nginx on the same server. Obtain a valid TLS certificate for your domain and set these values in `.env`:

```dotenv
PUBLIC_ORIGIN=https://pm2.example.com
COOKIE_SECURE=true
```

Inside an existing Nginx HTTPS server block, use:

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For "";
    client_max_body_size 32k;
    proxy_read_timeout 45s;
}
```

Replace the example domain with yours, redirect public HTTP to HTTPS, reload Nginx, and restart pm2Remote. Open your HTTPS domain and sign in.

Keep port 3100 private. The frontend and API must share the same origin. Use `COOKIE_SECURE=false` only for HTTP loopback access locally or through an SSH tunnel.

## Use the API

Automation clients use the random tokens stored in `.env`:

- `PM2_READ_TOKEN` can list approved processes.
- `PM2_CONTROL_TOKEN` can list and control approved processes.

Set `READ_TOKEN` or `CONTROL_TOKEN` in your client's environment from the corresponding `.env` value. Keep them private. For the SSH tunnel setup:

```sh
curl --fail-with-body http://localhost:3100/v1/processes \
  -H "Authorization: Bearer $READ_TOKEN"

# Replace 0 with an allowed ID returned by the list request.
curl --fail-with-body -X POST http://localhost:3100/v1/processes/0/restart \
  -H "Authorization: Bearer $CONTROL_TOKEN"
```

For a domain, replace `http://localhost:3100` with your HTTPS origin. Never send tokens over public plain HTTP. The browser handles its own session login; you do not paste API tokens into the dashboard.

See [the API guide](docs/API.md) for all endpoints and [openapi.json](openapi.json) for the machine-readable contract.

## Preview without touching real processes

After creating `.env`, run:

```sh
npm run preview
```

Open **[http://localhost:3110](http://localhost:3110)** and use the same username and password from setup. If previewing on a remote server, forward port 3110 through SSH as you did for port 3100.

This mode simulates both service-user and root instances, using up to three names from your allowlist for the service user. It never connects to PM2, and its actions affect only temporary sample data. Its API tokens and session secret are generated afresh for each preview. Stop it with Ctrl+C.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `.env` is missing | Run `npm run setup` from the project folder. |
| Setup says `.env` already exists | Edit the existing file. Use `npm run hash-password` to change the password. |
| No processes appear | Run `pm2 list` as the same user. Check exact names in `PM2_ALLOWED_NAMES` and the correct `PM2_HOME`. |
| Login does not work | Check `UI_USERNAME`, replace the hash using `npm run hash-password`, then restart. |
| Login works but actions are rejected | Open exactly `PUBLIC_ORIGIN`, including its scheme and port. Reload the page to renew the CSRF token. |
| HTTPS login will not stay signed in | Set `COOKIE_SECURE=true` and make sure your local proxy overwrites `X-Forwarded-Proto` with `https`. |
| Too many requests | Wait a minute. Failed sign-in attempts have a separate 10-attempt limit per 15 minutes. |
| Request times out | Refresh to check the current process state before retrying; an action may already have completed. |
| Port already in use | Change `PORT`, the matching `PUBLIC_ORIGIN`, and your SSH tunnel or proxy destination. |

## Checks and security details

```sh
npm test
npm audit --omit=dev
```

Tests use a fake PM2 adapter and do not control your apps. Browser checks have covered login, a simulated restart, confirmation, and logout. Test live actions against a disposable allowlisted app before production use.

This version supports one operator account and one dashboard service instance, optionally connected to a separate root helper. See [the security notes](docs/SECURITY.md) for session behavior, rate limits, and deployment boundaries.

# Full-mode deployment with user and root instances

The supplied [systemd units](../deploy/) use the existing server layout:

- Application: `/opt/pm2remote/app`
- Dedicated Node runtime: `/opt/pm2remote/node/bin/node`
- Main service account: `dfren`, home `/home/dfren`
- User daemon: `/home/dfren/.pm2`
- Root daemon: `/root/.pm2`
- Existing PM2 CLI: `/usr/local/lib/node_modules/pm2/bin/pm2`

Adapt these paths and account names for another server. Keep application code and service definitions owned by root so the web account cannot replace them.

## User instance

Set these values in the application's private `.env`, alongside its existing login and API secrets:

```dotenv
PM2_MANAGEMENT_MODE=full
PM2_HOME=/home/dfren/.pm2
PM2_COMMAND_HOME=/home/dfren
PM2_CLI_PATH=/usr/local/lib/node_modules/pm2/bin/pm2
```

The service account must own its PM2 daemon. Use the daemon's existing CLI version when possible. The full-mode backend uses short-lived CLI clients, so the dashboard can connect again after daemon commands. Listing an absent daemon can start a fresh empty daemon, just as `pm2 list` can from SSH.

## Optional root instance

Enabling this grants dashboard operators root PM2 access, including starting code as root. Keep this disabled unless those operators should have that privilege.

As root, create `/etc/pm2remote` with mode 700. Generate a separate random token:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put it in `/etc/pm2remote/root-broker.env`:

```dotenv
PM2_ROOT_SOCKET=/run/pm2remote-root/control.sock
PM2_ROOT_TOKEN=your-generated-token
PM2_CLI_PATH=/usr/local/lib/node_modules/pm2/bin/pm2
```

Make that file root-owned, mode 600. Add the same socket path and token to the application's private `.env`:

```dotenv
PM2_ROOT_SOCKET=/run/pm2remote-root/control.sock
PM2_ROOT_TOKEN=the-same-generated-token
```

These are placeholders, not default credentials. Never commit either private file. Keep the application `.env` owned by its service account with mode 600.

Install the provided service units:

```sh
sudo cp deploy/pm2remote-root.service /etc/systemd/system/
sudo cp deploy/pm2remote.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pm2remote-root
sudo systemctl enable --now pm2remote
```

The root helper creates a private Unix socket in `/run/pm2remote-root`. It has no public port. Never add that socket to Nginx. Nginx continues proxying only the main service on `127.0.0.1:3100`.

Use a 32 KB Nginx body limit and a 45-second proxy read timeout. Express separately limits login bodies to 2 KB and command bodies to 24 KB.

## Verify and operate

```sh
sudo systemctl status pm2remote pm2remote-root
sudo journalctl -u pm2remote -u pm2remote-root -n 100 --no-pager
sudo stat /run/pm2remote-root/control.sock
```

Sign in, select `dfren` or `root`, and start with `pm2 list`. Root commands require typing `root` to confirm in the interface. Read tokens cannot access the command console for either account.

Test new lifecycle features with disposable processes. Avoid testing `delete all`, `kill`, `resurrect`, `update`, or startup changes against production workloads. Commands may stop or replace apps and saved state.

After updating source, run `npm ci`, `npm test`, then restart both services:

```sh
sudo systemctl restart pm2remote-root pm2remote
```

Restarting the main service signs out browser sessions. To disable root access, remove PM2_ROOT_SOCKET and PM2_ROOT_TOKEN from the app `.env`, restart the main service, and stop/disable the helper.

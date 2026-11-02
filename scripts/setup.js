import { createPrompt, askPassword } from './prompt.js';
import { writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/password.js';

try { await access(new URL('../.env', import.meta.url)); console.error('.env already exists. Edit it or move it aside before setup; no changes made.'); process.exit(1); } catch (err) { if (err.code !== 'ENOENT') throw err; }
let prompt;
try {
  prompt = createPrompt();
  const { ask } = prompt;
  const username = (await ask('Admin username: ')).trim();
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(username)) throw new Error('Use 1–80 letters, digits, _, ., @ or - for the username.');
  const password = await askPassword(ask);
  const names = (await ask('Allowed PM2 names (comma-separated): ')).trim();
  if (!names || /[\r\n#"']/.test(names) || names.split(',').map(x => x.trim()).includes('all')) throw new Error('Provide explicit PM2 names without quotes or #.');
  const origin = (await ask('Dashboard origin [http://localhost:3100 for local/SSH access]: ')).trim() || 'http://localhost:3100';
  const parsed = new URL(origin);
  const secure = parsed.protocol === 'https:';
  if (parsed.origin !== origin || (!secure && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('Use an HTTPS origin or HTTP loopback origin, without a trailing slash.');
  const random = () => randomBytes(32).toString('hex');
  const content = `PM2_READ_TOKEN=${random()}\nPM2_CONTROL_TOKEN=${random()}\nPM2_ALLOWED_NAMES=${names}\nPORT=3100\nUI_USERNAME=${username}\nUI_PASSWORD_HASH='${await hashPassword(password)}'\nSESSION_SECRET=${random()}\nPUBLIC_ORIGIN=${origin}\nCOOKIE_SECURE=${secure}\n`;
  await writeFile(new URL('../.env', import.meta.url), content, { mode: 0o600, flag: 'wx' });
  console.log('Created private .env with a password hash and independent random secrets. Run npm start.');
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { prompt?.close(); }

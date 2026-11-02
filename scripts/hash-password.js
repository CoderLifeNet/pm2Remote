import { createPrompt, askPassword } from './prompt.js';
import { hashPassword } from '../src/password.js';
let prompt;
try {
  prompt = createPrompt();
  const password = await askPassword(prompt.ask);
  console.log('\nPaste this line into .env, then restart the service:\n');
  console.log(`UI_PASSWORD_HASH='${await hashPassword(password)}'`);
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { prompt?.close(); }

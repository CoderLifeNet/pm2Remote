import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function createPrompt() {
  if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal. Password input is hidden.');
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, done) {
    if (!hidden) process.stdout.write(chunk);
    done();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (prompt, secret = false) => {
    process.stdout.write(prompt);
    hidden = secret;
    try { return await rl.question(''); }
    finally { hidden = false; if (secret) process.stdout.write('\n'); }
  };
  return { ask, close: () => rl.close() };
}

export async function askPassword(ask) {
  const password = await ask('Password (at least 16 characters): ', true);
  const confirmation = await ask('Repeat password: ', true);
  if (password.length < 16 || password.length > 256 || password !== confirmation) {
    throw new Error('Passwords must match and contain 16–256 characters.');
  }
  return password;
}

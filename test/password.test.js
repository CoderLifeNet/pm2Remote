import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, validPasswordHash } from '../src/password.js';
import { askPassword } from '../scripts/prompt.js';

test('password hashing salts each hash and rejects wrong passwords and malformed hashes', async () => {
  const password = randomBytes(24).toString('hex');
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(validPasswordHash(first), true);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password + 'wrong', first), false);
  assert.equal(await verifyPassword(password, 'invalid'), false);
});

test('credential helpers require matching strong passwords and hide both prompts', async () => {
  const password = randomBytes(24).toString('hex');
  const answers = [password, password];
  assert.equal(await askPassword(async (prompt, hidden) => { assert.equal(hidden, true); return answers.shift(); }), password);
  for (const answers of [['short', 'short'], [password, password + 'different'], ['x'.repeat(257), 'x'.repeat(257)]]) {
    await assert.rejects(askPassword(async () => answers.shift()));
  }
});

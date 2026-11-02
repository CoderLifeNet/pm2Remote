import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

export function validateArgs(args) {
  if (!Array.isArray(args) || args.length < 1 || args.length > 128 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
      args.reduce((size, arg) => size + arg.length, 0) > 16_384 ||
      !/^(?:[A-Za-z][A-Za-z0-9-]*|--help|--version|-h|-v)$/.test(args[0])) {
    const error = new Error('Invalid PM2 arguments.');
    error.status = 400; error.code = 'invalid_command'; throw error;
  }
  return args;
}

// Quotes and backslashes group arguments. Shell expansion, pipelines and redirects
// are intentionally unavailable: the only executable is the configured PM2 CLI.
function parseTokens(command) {
  if (typeof command !== 'string' || command.length > 16_384) return validateArgs(null);
  const args = [];
  let word = '', quote = '', escaped = false, started = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/[;|&<>`\r\n]/.test(char)) return validateArgs(null);
    if (/\s/.test(char)) { if (started) { args.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quote || escaped) return validateArgs(null);
  if (started) args.push(word);
  return args;
}


export function validateEnvironment(environment = {}) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.keys(environment).length > 100 ||
      Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        /^(?:PM2_|UI_|SESSION_SECRET$)/.test(key) || ['HOME', 'USER', 'LOGNAME', 'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', '__proto__', 'constructor', 'prototype'].includes(key) ||
        typeof value !== 'string' || value.length > 4096 || value.includes('\0')) ||
      JSON.stringify(environment).length > 16_384) {
    const error = new Error('Invalid environment overrides.'); error.status = 400; error.code = 'invalid_command'; throw error;
  }
  return environment;
}
export function parseInvocation(command) {
  const args = parseTokens(command);
  const environment = {};
  while (args[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
    const item = args.shift(), index = item.indexOf('=');
    Object.defineProperty(environment, item.slice(0, index), { value: item.slice(index + 1), enumerable: true });
  }
  if (args[0] === 'pm2') args.shift();
  return { args: validateArgs(args), environment: validateEnvironment(environment) };
}
export const parseCommand = command => parseInvocation(command).args;

export function commandEnvironment(config) {
  const home = config.commandHome ?? homedir();
  return {
    HOME: home, USER: config.commandUser ?? process.env.USER ?? '', LOGNAME: config.commandUser ?? process.env.USER ?? '',
    PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', ...(config.silent ? { PM2_SILENT: 'true' } : {}),
    PM2_HOME: config.pm2Home ?? path.join(home, '.pm2'),
  };
}

export function createCommandRunner(config, { spawnProcess = spawn, timeoutMs = 30_000, maxBytes = 128 * 1024 } = {}) {
  const cliPath = config.cliPath ?? fileURLToPath(new URL('../node_modules/pm2/bin/pm2', import.meta.url));
  const secrets = [config.readToken, config.controlToken, config.sessionSecret, config.passwordHash, config.rootToken].filter(Boolean);
  const clean = text => {
    let result = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    return result;
  };
  return async (args, environment = {}) => {
    validateArgs(args);
    validateEnvironment(environment);
    return new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, [cliPath, ...args], {
        cwd: config.commandHome ?? homedir(), env: { ...commandEnvironment(config), ...environment }, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = [], stderr = [], size = 0, truncated = false, timedOut = false;
      const capture = destination => chunk => {
        const remaining = maxBytes - size;
        if (remaining > 0) { const part = chunk.subarray(0, remaining); destination.push(part); size += part.length; }
        if (chunk.length > remaining) truncated = true;
      };
      child.stdout.on('data', capture(stdout));
      child.stderr.on('data', capture(stderr));
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
      const killTimer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs + 2000);
      const finish = () => { clearTimeout(timer); clearTimeout(killTimer); };
      child.on('error', err => { finish(); reject(err); });
      child.on('close', (exitCode, signal) => {
        finish();
        resolve({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, truncated,
          stdout: clean(Buffer.concat(stdout).toString('utf8')), stderr: clean(Buffer.concat(stderr).toString('utf8')) });
      });
    });
  };
}

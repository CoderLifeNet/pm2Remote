const $ = id => document.getElementById(id);
let csrfToken = '';
let busy = false;
let currentUser = null;
let activeInstance = 'user';
let capabilities = null;
let scaleProcess = null;
const messages = {
  invalid_login: 'The username or password is incorrect.', unauthorized: 'Please sign in to continue.',
  session_expired: 'Your session has expired. Please sign in again.',
  invalid_csrf: 'Your session changed. Reload this page and try again.',
  login_rate_limited: 'Too many sign-in attempts. Please wait 15 minutes before trying again.',
  rate_limited: 'Too many requests. Please wait a minute before trying again.',
  service_unavailable: 'The service could not complete this request. Refresh to check the current process state before retrying.',
  full_control_disabled: 'Full PM2 management is disabled in the server configuration.',
  invalid_instance: 'This PM2 instance is unavailable. Select another instance and refresh.',
  command_in_progress: 'Another command is running for this instance. Wait for it to finish.',
  invalid_command: 'Invalid PM2 command or environment. Use PM2 arguments without shell operators; instance and runtime environment settings are reserved.',
  process_not_found: 'This process is no longer available or allowed. Refresh the list.',
};
async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal, ...options,
      headers: { 'X-CSRF-Token': csrfToken, 'X-PM2-Instance': activeInstance, ...options.headers } });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/login') showLogin();
      throw new Error(messages[result.error] ?? 'The request could not be completed. Please refresh and try again.');
    }
    return result;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The request timed out. Refresh to check the current process state before retrying.');
    if (err instanceof TypeError) throw new Error('Cannot reach the server. Check your connection and refresh before retrying.');
    throw err;
  } finally { clearTimeout(timer); }
}
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}
function showLogin() {
  currentUser = null;
  $('dashboard').hidden = true;
  $('login-view').hidden = false;
  $('process-list').replaceChildren();
  $('password').value = '';
  $('command-input').value = '';
  $('command-output').textContent = 'Output will appear here.';
  $('process-env').value = '';
  capabilities = null;
  activeInstance = 'user';
}
function showDashboard(username) {
  currentUser = username;
  $('operator-name').textContent = username;
  $('login-view').hidden = true;
  $('dashboard').hidden = false;
  $('password').value = '';
  notice('');
}
const memory = bytes => bytes == null ? '—' : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
function render(processes) {
  const rows = processes.map(p => {
    const row = $('process-template').content.cloneNode(true);
    row.querySelector('.process-name').textContent = p.name;
    row.querySelector('.process-id').textContent = `PM2 ID · ${p.id}`;
    const badge = row.querySelector('.status-badge');
    badge.textContent = p.status;
    badge.classList.toggle('offline', p.status !== 'online');
    row.querySelector('.cpu-value').textContent = p.cpu == null ? '—' : `${p.cpu}%`;
    row.querySelector('.memory-value').textContent = memory(p.memory);
    row.querySelector('.restarts-value').textContent = p.restarts ?? '—';
    for (const button of row.querySelectorAll('[data-action]')) {
      button.setAttribute('aria-label', `${button.textContent} ${p.name}, process ${p.id}`);
      button.addEventListener('click', () => control(p, button.dataset.action));
    }
    const more = row.querySelector('.action-select');
    more.hidden = !capabilities?.fullControl;
    more.setAttribute('aria-label', `More actions for ${p.name}, process ${p.id}`);
    more.addEventListener('change', () => {
      const action = more.value; more.value = '';
      if (action === 'logs') loadLogs(p);
      else if (action === 'describe' || action === 'env') executeCommand({ args: [action, String(p.id)] }, `pm2 ${action} ${p.id}`);
      else if (action === 'scale') { scaleProcess = p; $('scale-title').textContent = `Scale ${p.name}`; $('scale-dialog').showModal(); }
      else if (action) control(p, action);
    });
    return row;
  });
  $('process-list').replaceChildren(...rows);
  $('total-count').textContent = processes.length;
  $('nav-count').textContent = processes.length;
  $('online-count').textContent = processes.filter(p => p.status === 'online').length;
  $('memory-total').textContent = processes.some(p => p.memory != null) ? memory(processes.reduce((sum, p) => sum + (p.memory ?? 0), 0)) : '—';
  $('table-count').textContent = `${processes.length} process${processes.length === 1 ? '' : 'es'}`;
  $('empty-state').hidden = Boolean(processes.length);
  $('last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('connection').textContent = 'Connected';
  $('connection').classList.add('ready');
}
async function refresh() {
  const target = activeInstance;
  $('refresh').disabled = true;
  try { const result = await api('/v1/processes'); if (currentUser && target === activeInstance) render(result.processes); }
  catch (err) {
    $('connection').textContent = 'Unavailable';
    $('connection').classList.remove('ready');
    notice(err.message, true);
    throw err;
  } finally { $('refresh').disabled = false; }
}
async function control(process, action) {
  if (busy) return;
  busy = true;
  const label = action[0].toUpperCase() + action.slice(1);
  $('confirm-title').textContent = `${label} ${process.name}?`;
  $('confirm-message').textContent = `This will ${action} PM2 process ${process.id}. ${action === 'stop' ? 'It will remain stopped until restarted.' : 'Active requests may be interrupted.'}`;
  $('confirm-action').textContent = `${label} process`;
  const confirmed = await confirmAction(`${label} ${process.name} on ${instanceLabel()}?`, $('confirm-message').textContent, `${label} process`, action === 'delete');
  if (!confirmed) { busy = false; return; }
  document.querySelectorAll('[data-action]').forEach(button => { button.disabled = true; });
  $('refresh').disabled = true;
  try {
    await api(`/v1/processes/${process.id}/${action}`, { method: 'POST' });
    notice(`${label} request completed for ${process.name}.`);
    await refresh();
  } catch (err) { notice(err.message, true); }
  finally {
    busy = false;
    $('refresh').disabled = false;
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = false; });
  }
}
$('toggle-password').addEventListener('click', () => {
  const show = $('password').type === 'password';
  $('password').type = show ? 'text' : 'password';
  $('toggle-password').textContent = show ? 'Hide password' : 'Show password';
  $('toggle-password').setAttribute('aria-pressed', String(show));
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-submit').disabled = true;
  $('login-error').textContent = '';
  try {
    if (!csrfToken) csrfToken = (await api('/auth/session')).csrfToken;
    const result = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    csrfToken = result.csrfToken;
    showDashboard(result.username);
    await loadWorkspace().catch(() => {});
  } catch (err) { $('login-error').textContent = err.message; }
  finally { $('password').value = ''; $('login-submit').disabled = false; }
});
$('refresh').addEventListener('click', () => { if (!busy) { notice(''); refresh().catch(() => {}); } });
$('logout').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
    csrfToken = '';
    showLogin();
    $('username').focus();
  } catch (err) { notice(err.message, true); }
});
(async () => {
  try {
    const result = await api('/auth/session');
    csrfToken = result.csrfToken;
    if (result.authenticated) { showDashboard(result.username); await loadWorkspace().catch(() => {}); }
  } catch (err) { $('login-error').textContent = err.message; }
})();

function instanceLabel() {
  return capabilities?.instances.find(item => item.id === activeInstance)?.label ?? activeInstance;
}
async function loadWorkspace() {
  const target = activeInstance;
  const result = await api('/v1/capabilities');
  if (!currentUser || target !== activeInstance) return;
  capabilities = result;
  $('instance-select').replaceChildren(...capabilities.instances.map(instance => {
    const option = document.createElement('option'); option.value = instance.id; option.textContent = instance.label; return option;
  }));
  $('instance-select').value = activeInstance;
  $('total-label').textContent = capabilities.managementMode === 'full' ? 'Processes in instance' : 'Allowed processes';
  $('scope-footer').textContent = capabilities.managementMode === 'full' ? `All processes in ${instanceLabel()}'s PM2 instance` : 'Only approved processes are shown';
  $('empty-state').textContent = capabilities.managementMode === 'full' ? 'No processes in this instance. Add a process or resurrect a saved list.' : 'No allowed processes found. Check your process allowlist and PM2 daemon.';
  for (const id of ['add-process', 'bulk-action', 'save-processes', 'command-section']) $(id).hidden = !capabilities.fullControl;
  $('scope-note').hidden = !capabilities.fullControl;
  $('scope-note').textContent = `${capabilities.simulated ? 'SIMULATED PREVIEW · ' : ''}Managing ${instanceLabel()}'s PM2 instance. ${activeInstance === 'root' ? 'Commands run as root and can change the server.' : 'Commands run as this service account.'}`;
  $('scope-note').classList.toggle('root-scope', activeInstance === 'root');
  await refresh();
}
async function confirmAction(title, message, buttonLabel, destructive = false) {
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-action').textContent = buttonLabel;
  const guarded = activeInstance === 'root' || destructive;
  const phrase = activeInstance === 'root' ? 'root' : 'confirm';
  $('confirm-guard-label').hidden = !guarded;
  $('confirm-guard').hidden = !guarded;
  $('confirm-guard-label').textContent = `Type ${phrase} to confirm`;
  $('confirm-guard').value = '';
  $('confirm-action').disabled = guarded;
  $('confirm-guard').oninput = () => { $('confirm-action').disabled = guarded && $('confirm-guard').value !== phrase; };
  const dialog = $('confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  $('confirm-action').disabled = false;
  return result;
}
function output(result, label) {
  $('command-result').textContent = `${instanceLabel()} · ${label} · ${result.timedOut ? 'Timed out; outcome may be uncertain' : result.ok ? 'Completed' : 'Failed'}${result.exitCode !== null && result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ''}${result.truncated ? ' · Output truncated' : ''}`;
  $('command-output').textContent = [result.stdout, result.stderr].filter(Boolean).join('\n') || '(No output)';
  $('command-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function executeCommand(payload, label) {
  if (busy) return;
  busy = true;
  const target = activeInstance;
  try {
    if (!await confirmAction(`Run PM2 on ${instanceLabel()}?`, label, 'Run command', true)) return;
    $('run-command').disabled = true;
    $('instance-select').disabled = true;
    $('command-result').textContent = `Running on ${instanceLabel()}…`;
    // Server command deadline is 30 seconds; allow time for graceful termination.
    const result = await api('/v1/pm2/command', { method: 'POST', timeoutMs: 40_000,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!currentUser || activeInstance !== target) return;
    output(result, label);
    if (result.ok) notice(`PM2 command completed on ${instanceLabel()}.`);
    else notice(result.timedOut ? 'Command timed out. Check the current state before retrying.' : 'PM2 reported an error. See command output for details.', true);
    if (activeInstance === target) await refresh().catch(() => {});
  } catch (err) { notice(err.message, true); }
  finally { busy = false; $('run-command').disabled = false; $('instance-select').disabled = false; }
}
async function loadLogs(process) {
  if (busy) return;
  busy = true;
  const target = activeInstance;
  try { const result = await api(`/v1/processes/${process.id}/logs`, { timeoutMs: 40_000 }); if (currentUser && target === activeInstance) output(result, `Log snapshot for ${process.name}`); }
  catch (err) { notice(err.message, true); }
  finally { busy = false; }
}
$('instance-select').addEventListener('change', async () => {
  if (busy) { $('instance-select').value = activeInstance; return; }
  activeInstance = $('instance-select').value;
  $('process-list').replaceChildren();
  $('command-output').textContent = 'Output will appear here.';
  $('command-result').textContent = 'No command executed.';
  $('command-input').value = '';
  notice('');
  try { await loadWorkspace(); } catch (err) { notice(err.message, true); }
});
$('command-form').addEventListener('submit', event => {
  event.preventDefault();
  executeCommand({ command: $('command-input').value }, $('command-input').value);
});
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => {
  $('command-input').value = button.dataset.command;
  executeCommand({ command: button.dataset.command }, button.dataset.command);
});
$('save-processes').addEventListener('click', () => executeCommand({ args: ['save', '--force'] }, 'Save the current process list for this instance, replacing its previous saved list.'));
$('bulk-action').addEventListener('change', () => {
  const action = $('bulk-action').value; $('bulk-action').value = '';
  if (action) executeCommand({ args: [action, 'all'] }, `${action} ALL processes in ${instanceLabel()}'s PM2 instance`);
});
$('add-process').addEventListener('click', () => {
  if (busy) return;
  $('add-instance-note').textContent = `This process will run as ${instanceLabel()}. Files must already exist on the server.`;
  $('add-error').textContent = '';
  $('add-dialog').showModal();
});
$('add-cancel').addEventListener('click', () => $('add-dialog').close());
$('add-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const name = $('process-name').value;
    const script = $('process-script').value.trim();
    const cwd = $('process-cwd').value.trim();
    if (!script.startsWith('/') || (cwd && !cwd.startsWith('/'))) throw new Error('Use absolute server paths for the script and working directory.');
    const scriptArgs = JSON.parse($('process-args').value || '[]');
    const environment = JSON.parse($('process-env').value || '{}');
    if (!Array.isArray(scriptArgs) || scriptArgs.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
    if (!environment || Array.isArray(environment) || typeof environment !== 'object' || Object.values(environment).some(value => typeof value !== 'string')) throw new Error('Environment must be a JSON object with string values.');
    const args = ['start', script, '--name', name];
    if (cwd) args.push('--cwd', cwd);
    if ($('process-interpreter').value.trim()) args.push('--interpreter', $('process-interpreter').value.trim());
    if ($('process-mode').value === 'cluster') args.push('--instances', $('process-instances').value);
    if (scriptArgs.length) args.push('--', ...scriptArgs);
    $('add-dialog').close();
    await executeCommand({ args, environment }, `Start ${name} from ${script} as ${instanceLabel()}`);
    $('process-env').value = '';
  } catch (err) { $('add-error').textContent = err.message; }
});
$('scale-cancel').addEventListener('click', () => $('scale-dialog').close());
$('scale-form').addEventListener('submit', event => {
  event.preventDefault(); $('scale-dialog').close();
  executeCommand({ args: ['scale', scaleProcess.name, $('scale-count').value] }, `Scale every cluster instance named ${scaleProcess.name} to ${$('scale-count').value} processes.`);
});

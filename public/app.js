const $ = id => document.getElementById(id);
let csrfToken = '';
let busy = false;
let currentUser = null;
const messages = {
  invalid_login: 'The username or password is incorrect.', unauthorized: 'Please sign in to continue.',
  session_expired: 'Your session has expired. Please sign in again.',
  invalid_csrf: 'Your session changed. Reload this page and try again.',
  login_rate_limited: 'Too many sign-in attempts. Please wait 15 minutes before trying again.',
  rate_limited: 'Too many requests. Please wait a minute before trying again.',
  service_unavailable: 'The service could not complete this request. Refresh to check the current process state before retrying.',
  process_not_found: 'This process is no longer available or allowed. Refresh the list.',
};
async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal, ...options,
      headers: { 'X-CSRF-Token': csrfToken, ...options.headers } });
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
  $('refresh').disabled = true;
  try { render((await api('/v1/processes')).processes); }
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
  const dialog = $('confirm-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  const confirmed = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
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
    await refresh().catch(() => {});
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
    if (result.authenticated) { showDashboard(result.username); await refresh().catch(() => {}); }
  } catch (err) { $('login-error').textContent = err.message; }
})();

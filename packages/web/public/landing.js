// landing 页：注册 / 登录（会话走 HttpOnly cookie，成功后进 /app）。
import { injectIcons } from './icons.js';
injectIcons();
const $ = (id) => document.getElementById(id);
let mode = 'login';

async function boot() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    const { user } = await res.json();
    $('welcome').hidden = false;
    $('welcome-text').textContent = `${user.name}，门后的墙上还有你的名字。`;
    if (user.is_admin) $('welcome-text').textContent += '（管理员）';
    return;
  }
  $('authbox').hidden = false;
}

function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-signup').classList.toggle('active', m === 'signup');
  $('btn-submit').textContent = m === 'login' ? '进入围城' : '写下名字，住进去';
  $('f-password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('auth-hint').textContent = m === 'login' ? '还没住进来？点「注册」写下你的名字。' : '名字 2–24 个字母或汉字；口令至少 6 位。';
  $('auth-error').hidden = true;
}
$('tab-login').addEventListener('click', () => setMode('login'));
$('tab-signup').addEventListener('click', () => setMode('signup'));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-submit');
  btn.disabled = true;
  $('auth-error').hidden = true;
  try {
    const res = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('f-username').value.trim(), password: $('f-password').value })
    });
    const r = await res.json().catch(() => ({}));
    if (res.ok) { location.href = '/app'; return; }
    const err = $('auth-error');
    err.textContent = r.error || '出了点问题，再试一次。';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('btn-enter').addEventListener('click', () => { location.href = '/app'; });
$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

boot();

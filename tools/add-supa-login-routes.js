/**
 * 为 supabase-data.js 补齐登录通道（扫码 / 手机号 / 账号）。
 *
 * 背景：换到 Supabase 数据层后，登录页一提交就报「接口不存在」——
 * 上一轮只给 local-data.js 补过，supabase-data.js 漏了。
 * 用 tools/check-routes.js 可以查出这类缺口。
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'core', 'supabase-data.js');
let src = fs.readFileSync(FILE, 'utf8');

if (src.indexOf("'/api/auth/register'") !== -1) {
  console.log('Supabase 登录通道已存在，跳过。');
  process.exit(0);
}

const MARK = "on('GET', '/api/auth/me', async () => currentUser());";
if (src.indexOf(MARK) === -1) {
  console.error('未找到插入点，schema 可能已变化，请手动检查。');
  process.exit(1);
}

const ADD = `
/* ---- 扫码登录 ----
   票据存在 meta 表里（Supabase 没有内存态可用）。
   真实跨设备扫码确认需要应用自己校验二维码内容并调用 bind，
   这里提供完整的票据生命周期，前端逻辑与 local 模式一致。 */

on('POST', '/api/auth/qr/ticket', async () => {
  const ticket = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const expiresAt = Date.now() + 30 * 60 * 1000;
  await insertRow('meta', {
    id: 'ticket:' + ticket,
    kind: 'ticket',
    status: 'waiting',
    nickname: null,
    createdAt: Date.now(),
    expiresAt: expiresAt,
  });
  return {
    ticket: ticket,
    expiresAt: expiresAt,
    url: location.origin + location.pathname + '#/ticket?t=' + ticket,
  };
});

on('GET', '/api/auth/qr/poll', async (params, body, query) => {
  const rows = await selectAll('meta', 'id=eq.' + encodeURIComponent('ticket:' + String(query.t || '')));
  const row = rows[0];
  if (!row) return { status: 'invalid' };
  if (row.expiresAt && Date.now() > row.expiresAt) {
    await patchRow('meta', row.id, { status: 'expired' });
    return { status: 'expired' };
  }
  if (row.status === 'confirmed') return { status: 'confirmed', nickname: row.nickname || '扫码进来的你' };
  return { status: row.status || 'waiting' };
});

on('POST', '/api/auth/qr/confirm', async (params, body) => {
  const key = 'ticket:' + String(body.ticket || '');
  const rows = await selectAll('meta', 'id=eq.' + encodeURIComponent(key));
  if (!rows[0]) throw new Error('票据不存在或已失效');
  await patchRow('meta', key, { status: 'confirmed' });
  return { status: 'confirmed' };
});

/** 手机扫一扫打开票据页后调用：把身份绑定到当前浏览器 */
on('POST', '/api/auth/qr/bind', async (params, body) => {
  const key = 'ticket:' + String(body.ticket || '');
  const rows = await selectAll('meta', 'id=eq.' + encodeURIComponent(key));
  const row = rows[0];
  if (!row) throw new Error('票据不存在或已失效');
  if (row.expiresAt && Date.now() > row.expiresAt) throw new Error('票据已过期，请刷新二维码');

  const nickname = String(body.nickname || '').trim() || '扫码进来的你';
  const identity = 'scan:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const created = await insertRow('users', rowForNewUser(nickname, identity));
  const user = publicUser(created);
  cacheMe(user);
  await patchRow('meta', key, { status: 'confirmed', nickname: nickname, boundIdentity: identity });
  return { token: identity, user: user };
});

/* ---- 手机验证码 ---- */

/** 演示环境固定验证码；接真实短信只需替换这里与下方 login 的校验 */
const DEMO_SMS_CODE = '8888';

on('POST', '/api/auth/phone/code', async (params, body) => {
  const phone = String(body.phone || '').trim();
  if (!/^1[3-9]\\d{9}$/.test(phone)) throw new Error('请输入 11 位手机号');
  const key = 'sms:' + phone;
  const existing = await selectAll('meta', 'id=eq.' + encodeURIComponent(key));
  if (existing.length) {
    await patchRow('meta', key, { code: DEMO_SMS_CODE, sentAt: Date.now(), tries: 0 });
  } else {
    await insertRow('meta', {
      id: key, kind: 'sms', code: DEMO_SMS_CODE,
      sentAt: Date.now(), tries: 0, createdAt: Date.now(),
    });
  }
  return { sent: true, demo: true, code: DEMO_SMS_CODE };
});

on('POST', '/api/auth/phone/login', async (params, body) => {
  const phone = String(body.phone || '').trim();
  const code = String(body.code || '').trim();
  if (!/^1[3-9]\\d{9}$/.test(phone)) throw new Error('请输入 11 位手机号');

  const key = 'sms:' + phone;
  const rows = await selectAll('meta', 'id=eq.' + encodeURIComponent(key));
  const row = rows[0];
  if (!row) throw new Error('验证码不正确');
  if (String(row.code) !== code) {
    await patchRow('meta', key, { tries: (row.tries || 0) + 1 });
    throw new Error('验证码不正确');
  }

  const identity = 'phone:' + phone;
  let found = await selectAll('users', 'identity=eq.' + encodeURIComponent(identity));
  let user;
  if (found.length) {
    user = found[0];
  } else {
    user = await insertRow('users', rowForNewUser('手机用户' + phone.slice(-4), identity));
  }
  const pub = publicUser(user);
  cacheMe(pub);
  return { token: identity, user: pub };
});

/* ---- 账号密码 ---- */

/**
 * 密码哈希。
 * 纯前端没有服务端 salt，安全性有限 —— 但足以避免明文存密码。
 * 真正的安全性依赖 RLS；若需要强认证，应接入 Supabase Auth。
 */
function hashPw(pw, salt) {
  const combo = (salt || 'tb') + '::' + String(pw);
  let h = 5381;
  for (let i = 0; i < combo.length; i++) h = ((h << 5) + h + combo.charCodeAt(i)) >>> 0;
  return String(h);
}

on('POST', '/api/auth/register', async (params, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const nickname = String(body.nickname || '').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('用户名需 3-20 位字母数字下划线');
  if (password.length < 6) throw new Error('密码至少 6 位');
  if (!nickname) throw new Error('请填一个昵称');

  const identity = 'acct:' + username;
  const exists = await selectAll('users', 'identity=eq.' + encodeURIComponent(identity));
  if (exists.length) throw new Error('该用户名已被注册');

  const row = rowForNewUser(nickname, identity);
  row.password = hashPw(password, username);
  const created = await insertRow('users', row);
  const user = publicUser(created);
  cacheMe(user);
  return { token: identity, user: user };
});

on('POST', '/api/auth/login', async (params, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const identity = 'acct:' + username;
  const found = await selectAll('users', 'identity=eq.' + encodeURIComponent(identity));
  const user = found[0];
  if (!user || !user.password) throw new Error('用户名或密码不正确');
  if (user.password !== hashPw(password, username)) throw new Error('用户名或密码不正确');
  const pub = publicUser(user);
  cacheMe(pub);
  return { token: identity, user: pub };
});

/* ---- 票据/验证码容器 ---- */
on('DELETE', '/api/auth/ticket', async (params, body) => {
  await deleteRow('meta', 'ticket:' + String(body.ticket || ''));
  return { done: true };
});
`;

src = src.replace(MARK, ADD + '\n' + MARK);
fs.writeFileSync(FILE, src, 'utf8');
console.log('已向 supabase-data.js 追加登录通道实现');
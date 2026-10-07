/**
 * 为本地数据层（静态部署）补齐登录通道。
 *
 * 背景：local-data.js 原本只实现了 login-local / guest，
 * 但登录页还有扫码、手机验证码、账号密码三条通道，
 * 静态部署下调用它们会返回「接口不存在」。
 *
 * 静态环境的固有限制：没有服务端，无法跨设备确认身份。
 * 因此扫码通道降级为「本机确认」，界面会明确告知用户。
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'core', 'local-data.js');
let src = fs.readFileSync(FILE, 'utf8');

if (src.indexOf('/api/auth/qr/ticket') !== -1) {
  console.log('登录通道已存在，跳过。');
  process.exit(0);
}

const ADD = `
/* ---- 扫码登录（静态环境降级为本机确认）----
   真实扫码需要服务端：手机扫一扫 → 另一个设备上的会话。
   纯静态环境没有服务端，做不到跨设备，因此这里只签发一张本机票据，
   「扫码确认」等于在本机点一下。等接上 Supabase 后端后，
   同一套接口可换成真实跨设备流程，前端无需改动。 */

route('POST', '/api/auth/qr/ticket', async () => {
  const ticket = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await insert('meta', {
    id: 'ticket:' + ticket,
    kind: 'ticket',
    status: 'waiting',
    createdAt: nowMs(),
  });
  // 30 分钟过期，和真实票据一致的时效
  const expiresAt = nowMs() + 30 * 60 * 1000;
  await update('meta', 'ticket:' + ticket, { expiresAt: expiresAt });
  return {
    ticket: ticket,
    expiresAt: expiresAt,
    url: location.origin + location.pathname + '#/ticket?t=' + ticket,
  };
});

route('GET', '/api/auth/qr/poll', async (params, body, query) => {
  const key = 'ticket:' + String(query.t || '');
  const row = await findById('meta', key);
  if (!row) return { status: 'invalid' };
  if (row.expiresAt && nowMs() > row.expiresAt) {
    await update('meta', key, { status: 'expired' });
    return { status: 'expired' };
  }
  if (row.status === 'confirmed') {
    return { status: 'confirmed', nickname: row.nickname || '扫码进来的你' };
  }
  return { status: row.status || 'waiting' };
});

route('POST', '/api/auth/qr/confirm', async (params, body) => {
  const key = 'ticket:' + String(body.ticket || '');
  const row = await findById('meta', key);
  if (!row) throw new HttpError('票据不存在或已失效', 404);
  await update('meta', key, { status: 'confirmed' });
  return { status: 'confirmed' };
});

/** 确认票据并把身份绑定到当前浏览器 */
route('POST', '/api/auth/qr/bind', async (params, body) => {
  const key = 'ticket:' + String(body.ticket || '');
  const row = await findById('meta', key);
  if (!row) throw new HttpError('票据不存在或已失效', 404);
  if (row.expiresAt && nowMs() > row.expiresAt) throw new HttpError('票据已过期，请刷新二维码', 400);

  const nickname = String(body.nickname || '').trim() || '扫码进来的你';
  const identity = 'scan:' + Date.now().toString(36);
  const user = await ensureUser(identity, nickname);
  await setIdentity(identity);
  await update('meta', key, { status: 'confirmed', nickname: nickname, boundIdentity: identity });
  return { token: identity, user: publicUser(user) };
});

/* ---- 手机验证码 ---- */

/** 演示环境验证码固定 8888。接真实短信只需替换这里。 */
const DEMO_SMS_CODE = '8888';

route('POST', '/api/auth/phone/code', async (params, body) => {
  const phone = String(body.phone || '').trim();
  if (!/^1[3-9]\\d{9}$/.test(phone)) throw new HttpError('请输入 11 位手机号', 400);
  // 把验证码写进票据，登录时校验
  const key = 'sms:' + phone;
  const existing = await findById('meta', key);
  const code = DEMO_SMS_CODE;
  if (existing) {
    await update('meta', key, { code: code, sentAt: nowMs(), tries: 0 });
  } else {
    await insert('meta', {
      id: key, kind: 'sms', code: code, sentAt: nowMs(), tries: 0, createdAt: nowMs(),
    });
  }
  return { sent: true, demo: true, code: code };
});

route('POST', '/api/auth/phone/login', async (params, body) => {
  const phone = String(body.phone || '').trim();
  const code = String(body.code || '').trim();
  if (!/^1[3-9]\\d{9}$/.test(phone)) throw new HttpError('请输入 11 位手机号', 400);

  const key = 'sms:' + phone;
  const row = await findById('meta', key);
  if (!row) throw new HttpError('验证码不正确', 400);
  if (String(row.code) !== code) {
    row.tries = (row.tries || 0) + 1;
    await persist('meta');
    throw new HttpError('验证码不正确', 400);
  }

  const identity = 'phone:' + phone;
  let user = await findWhere('users', (u) => u.identity === identity);
  if (!user) {
    user = await ensureUser(identity, '手机用户' + phone.slice(-4));
  }
  await setIdentity(identity);
  return { token: identity, user: publicUser(user) };
});

/* ---- 账号密码 ---- */

function hashPw(pw, salt) {
  const combo = (salt || 'tb') + '::' + String(pw);
  let h = 5381;
  for (let i = 0; i < combo.length; i++) h = ((h << 5) + h + combo.charCodeAt(i)) >>> 0;
  return String(h);
}

route('POST', '/api/auth/register', async (params, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const nickname = String(body.nickname || '').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new HttpError('用户名需 3-20 位字母数字下划线', 400);
  }
  if (password.length < 6) throw new HttpError('密码至少 6 位', 400);
  if (!nickname) throw new HttpError('请填一个昵称', 400);

  const identity = 'acct:' + username;
  const exists = await findWhere('users', (u) => u.identity === identity);
  if (exists) throw new HttpError('该用户名已被注册', 400);

  const user = await ensureUser(identity, nickname);
  user.password = hashPw(password, username);
  user.bio = '';
  await persist('users');
  await setIdentity(identity);
  return { token: identity, user: publicUser(user) };
});

route('POST', '/api/auth/login', async (params, body) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const identity = 'acct:' + username;
  const user = await findWhere('users', (u) => u.identity === identity);
  if (!user || !user.password) throw new HttpError('用户名或密码不正确', 400);
  if (user.password !== hashPw(password, username)) {
    throw new HttpError('用户名或密码不正确', 400);
  }
  await setIdentity(identity);
  return { token: identity, user: publicUser(user) };
});

/* ---- 清空本机数据（设置里的「清除缓存」）---- */
route('POST', '/api/data/reset', async () => {
  for (const s of STORES) {
    cache[s] = [];
    await persist(s);
  }
  return { done: true };
});

/* ============ 首次运行的种子数据 ============ */`;

// 插到最后一段种子数据注释之前
const marker = '/* ============ 首次运行的种子数据 ============ */';
if (src.indexOf(marker) === -1) {
  console.error('未找到插入点，schema 可能已变化，请手动检查。');
  process.exit(1);
}
src = src.replace(marker, ADD + '\n\n');

fs.writeFileSync(FILE, src, 'utf8');
console.log('已向local-data.js 追加登录通道实现');
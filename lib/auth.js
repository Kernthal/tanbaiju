'use strict';
/**
 * 登录通道。
 *
 * 设计前提：不做任何微信资质认证，因此不走微信开放平台扫码登录
 * （那条链路强制要求企业主体 300 元认证 + 域名备案 + 授权回调域）。
 *
 * 改为自研扫码登录：登录二维码里承载的是「本站一次性登录票据」的二维码。
 * 用微信扫一扫打开该链接，站点在服务端为对应账号签发会话 —— 交互形态与
 * 微信扫码登录一致，但身份完全由本站账号体系承载，零资质、零备案即可运行。
 *
 * 三条通道：
 *   1. qr      扫码登录（二维码内是一次性票据，可被任何扫码 App 打开）
 *   2. phone   手机验证码
 *   3. account 账号密码
 * 外加 guest 游客模式，只写只读身份。
 */

const crypto = require('crypto');
const db = require('./store');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 天
const TICKET_TTL = 1000 * 60 * 5; // 登录票据 5 分钟有效

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(12).toString('hex');
  const h = crypto.scryptSync(String(password), s, 32).toString('hex');
  return { salt: s, hash: h };
}

function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (_) {
    return false;
  }
}

/** 头像用确定性色环生成，不依赖外部图床 */
function avatarFor(seed) {
  let h = 0;
  const str = String(seed || 'anon');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    type: 'ring',
    hue: hue,
    text: str.slice(0, 1).toUpperCase() || '匿',
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar || avatarFor(user.nickname),
    bio: user.bio || '',
    identity: user.identity || 'guest',
    verified: !!user.verified,
    stats: {
      rooms: user.stats && user.stats.rooms ? user.stats.rooms : 0,
      posts: user.stats && user.stats.posts ? user.stats.posts : 0,
      received: user.stats && user.stats.received ? user.stats.received : 0,
      hearts: user.stats && user.stats.hearts ? user.stats.hearts : 0,
    },
    createdAt: user.createdAt,
  };
}

function createSession(userId, channel) {
  const token = randomToken();
  db.tokens.insert({
    id: token,
    userId: userId,
    channel: channel || 'account',
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  return token;
}

function resolveToken(token) {
  if (!token) return null;
  const row = db.tokens.find(token);
  if (!row) return null;
  if (Date.now() - row.lastSeen > SESSION_TTL) {
    db.tokens.remove(token);
    return null;
  }
  row.lastSeen = Date.now();
  db.tokens.save();
  return db.users.find(row.userId);
}

/** 从请求里解析身份：优先 Authorization 头，其次 tb_token cookie */
function resolveUser(req) {
  const auth = req.headers['authorization'];
  let token = null;
  if (auth && /^Bearer\s+/i.test(auth)) token = auth.slice(7).trim();
  if (!token) {
    const cookie = req.headers['cookie'] || '';
    const m = /(?:^|;\s*)tb_token=([^;]+)/.exec(cookie);
    if (m) token = decodeURIComponent(m[1]);
  }
  return resolveToken(token);
}

function ensureUser(identity, nickname) {
  let user = db.users.findOne((u) => u.identity === identity);
  if (!user) {
    user = {
      id: db.id('u'),
      identity: identity,
      nickname: nickname || ('朋友' + identity.slice(-4).toUpperCase()),
      avatar: avatarFor(nickname || identity),
      bio: '',
      stats: { rooms: 0, posts: 0, received: 0, hearts: 0 },
      createdAt: Date.now(),
    };
    db.users.insert(user);
  }
  return user;
}

/* ---------------- 通道 1：扫码登录票据 ---------------- */
/**
 * 生成一次性登录票据。二维码里放的是 /login?t=<ticket>，
 * 任何扫码 App 打开它都会走到本站的票据兑换端点。
 */
function issueTicket() {
  const ticket = randomToken();
  db.tokens.insert({
    id: 'tk_' + ticket,
    userId: null,
    channel: 'qr',
    ticket: ticket,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  return {
    ticket: ticket,
    expiresAt: Date.now() + TICKET_TTL,
  };
}

function pollTicket(ticket) {
  const row = db.tokens.find('tk_' + ticket);
  if (!row) return { status: 'expired', message: '二维码已失效，请刷新' };
  if (Date.now() - row.createdAt > TICKET_TTL) {
    db.tokens.remove(row.id);
    return { status: 'expired', message: '二维码已过期，请刷新' };
  }
  if (row.userId) {
    db.tokens.remove(row.id);
    return { status: 'confirmed', token: row.sessionToken, nickname: row.nickname };
  }
  return { status: 'waiting', message: '请使用微信扫一扫' };
}

/**
 * 扫码端（手机上）确认登录，把票据与账号绑定。
 * 这是「已登录用户扫一扫」与「新用户扫一扫」的交汇点。
 */
function confirmTicket(ticket, identity, nickname) {
  const row = db.tokens.find('tk_' + ticket);
  if (!row) return { status: 'expired', message: '二维码已失效' };
  if (Date.now() - row.createdAt > TICKET_TTL) {
    db.tokens.remove(row.id);
    return { status: 'expired', message: '二维码已过期' };
  }
  const user = ensureUser(identity, nickname);
  const session = createSession(user.id, 'qr');
  row.userId = user.id;
  row.sessionToken = session;
  row.nickname = user.nickname;
  db.tokens.save();
  return { status: 'ok', token: session, user: publicUser(user) };
}

/* ---------------- 通道 2：手机验证码 ---------------- */
const codeStore = new Map();

function sendPhoneCode(phone) {
  // 演示环境不接短信网关：固定验证码写在响应里，方便本地直接体验。
  // 接真实短信时只需替换下面一行生成逻辑。
  const code = '8888';
  codeStore.set(phone, { code: code, at: Date.now() });
  return { code: code, demo: true };
}

function verifyPhoneCode(phone, code) {
  const hit = codeStore.get(phone);
  if (!hit) return { ok: false, message: '请先获取验证码' };
  if (Date.now() - hit.at > 1000 * 60 * 5) {
    codeStore.delete(phone);
    return { ok: false, message: '验证码已过期，请重新获取' };
  }
  if (String(code) !== String(hit.code)) return { ok: false, message: '验证码不正确' };
  codeStore.delete(phone);
  const identity = 'phone:' + phone;
  const user = ensureUser(identity, '手机用户' + phone.slice(-4));
  return { ok: true, token: createSession(user.id, 'phone'), user: publicUser(user) };
}

/* ---------------- 通道 3：账号密码 ---------------- */
function registerAccount(username, password, nickname) {
  const uname = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(uname)) return { ok: false, message: '用户名需 3-20 位字母数字下划线' };
  if (String(password || '').length < 6) return { ok: false, message: '密码至少 6 位' };
  const identity = 'acct:' + uname;
  if (db.users.findOne((u) => u.identity === identity)) return { ok: false, message: '该用户名已被注册' };
  const { salt, hash } = hashPassword(password);
  const user = {
    id: db.id('u'),
    identity: identity,
    nickname: nickname || uname,
    avatar: avatarFor(nickname || uname),
    bio: '',
    salt: salt,
    hash: hash,
    stats: { rooms: 0, posts: 0, received: 0, hearts: 0 },
    createdAt: Date.now(),
  };
  db.users.insert(user);
  return { ok: true, token: createSession(user.id, 'account'), user: publicUser(user) };
}

function loginAccount(username, password) {
  const identity = 'acct:' + String(username || '').trim().toLowerCase();
  const user = db.users.findOne((u) => u.identity === identity);
  if (!user || !user.salt) return { ok: false, message: '账号不存在或密码错误' };
  if (!verifyPassword(password, user.salt, user.hash)) {
    return { ok: false, message: '账号不存在或密码错误' };
  }
  return { ok: true, token: createSession(user.id, 'account'), user: publicUser(user) };
}

/* ---------------- 游客 ---------------- */
function guestLogin() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = ensureUser('guest:' + suffix, '匿名访客');
  return { ok: true, token: createSession(user.id, 'guest'), user: publicUser(user) };
}

module.exports = {
  avatarFor: avatarFor,
  publicUser: publicUser,
  createSession: createSession,
  resolveToken: resolveToken,
  resolveUser: resolveUser,
  ensureUser: ensureUser,
  issueTicket: issueTicket,
  pollTicket: pollTicket,
  confirmTicket: confirmTicket,
  sendPhoneCode: sendPhoneCode,
  verifyPhoneCode: verifyPhoneCode,
  registerAccount: registerAccount,
  loginAccount: loginAccount,
  guestLogin: guestLogin,
};
'use strict';
/**
 * 坦白局 · 零依赖服务端
 *
 * 启动：node server.js    （或双击 start.bat）
 * 单端口同时提供：静态资源 + JSON API
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const db = require('./lib/store');
const auth = require('./lib/auth');
const moderation = require('./lib/moderation');
const social = require('./lib/social');
const qr = require('./lib/qr');

const PORT = Number(process.env.PORT) || 8848;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

db.init();

/* ============ 工具 ============ */

function send(res, status, payload, headers) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {});
  res.writeHead(status, h);
  res.end(JSON.stringify(payload));
}

function ok(res, data) {
  send(res, 200, { ok: true, data: data });
}

function fail(res, message, status) {
  send(res, status || 400, { ok: false, message: message });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function setSessionCookie(res, token) {
  const parts = [
    'tb_token=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + 60 * 60 * 24 * 30,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function nowMs() {
  return Date.now();
}

const DAY = 24 * 60 * 60 * 1000;

/** 匿名身份：未登录用户给一个稳定的设备身份，用于「我的回答」归属 */
function deviceIdentity(req) {
  const ua = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  let raw = ua + '|' + ip;
  if (req.headers['x-device-id']) raw += '|' + req.headers['x-device-id'];
  return 'dev:' + require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/* ============ 数据整形 ============ */

function shapeRoom(room, opts) {
  const options = opts || {};
  const now = nowMs();
  const expired = room.deadline && now > room.deadline;
  const posts = db.posts.filter((p) => p.roomId === room.id);
  const questions = posts.filter((p) => p.kind === 'question');
  const answers = posts.filter((p) => p.kind === 'answer');
  return {
    id: room.id,
    code: room.code,
    ownerId: room.ownerId,
    owner: room.ownerSnapshot,
    title: room.title,
    subtitle: room.subtitle || '',
    slogan: room.slogan || '',
    avatar: room.avatar,
    theme: room.theme,
    tags: room.tags || [],
    rules: room.rules || {},
    createdAt: room.createdAt,
    deadline: room.deadline,
    expired: !!expired,
    state: room.closed ? 'closed' : expired ? 'expired' : 'live',
    counts: {
      questions: questions.length,
      answers: answers.length,
      pending: questions.filter((q) => !q.answered).length,
      hearts: posts.reduce((s, p) => s + (p.hearts || 0), 0),
      visits: db.visits.count((v) => v.roomId === room.id),
    },
    hasAnswered: options.visitorId ? posts.some((p) => p.kind === 'answer' && p.authorIdentity === options.visitorId) : false,
  };
}

function shapePost(post, viewerIdentity) {
  if (!post) return null;
  const isOwnerAuthor = viewerIdentity && post.authorIdentity === viewerIdentity;
  return {
    id: post.id,
    roomId: post.roomId,
    kind: post.kind,
    text: post.text,
    voice: post.voice || null,
    tags: post.tags || [],
    replyTo: post.replyTo || null,
    answered: !!post.answered,
    createdAt: post.createdAt,
    hearts: post.hearts || 0,
    claps: post.claps || 0,
    featured: !!post.featured,
    pending: !!post.pending,
    reportCount: post.reportCount || 0,
    author: post.authorSnapshot,
    mine: isOwnerAuthor,
    favorited: viewerIdentity ? social.isFavorited(viewerIdentity, post.id) : false,
    mentions: post.mentions || [],
  };
}

/* ============ 路由 ============ */

const routes = {};
function route(method, pattern, handler) {
  routes[method + ' ' + pattern] = handler;
}

/* ---- 健康检查 ---- */
route('GET', '/api/health', (req, res) => {
  ok(res, {
    name: '坦白局',
    time: nowMs(),
    counts: {
      users: db.users.count(),
      rooms: db.rooms.count(),
      posts: db.posts.count(),
    },
  });
});

/* ---- 登录：扫码票据 ---- */
route('POST', '/api/auth/qr/ticket', (req, res, params, body) => {
  const t = auth.issueTicket();
  ok(res, {
    ticket: t.ticket,
    expiresAt: t.expiresAt,
    url: '/login?t=' + encodeURIComponent(t.ticket),
    svg: qr.toSvg('/login?t=' + encodeURIComponent(t.ticket), { margin: 2, scalable: true }),
  });
});

route('GET', '/api/auth/qr/poll', (req, res, params, body, query) => {
  const r = auth.pollTicket(query.t);
  if (r.status === 'confirmed') {
    setSessionCookie(res, r.token);
  }
  ok(res, r);
});

/** 已登录用户在手机端确认「允许这台电脑登录」 */
route('POST', '/api/auth/qr/confirm', (req, res, params, body) => {
  const user = auth.resolveUser(req);
  if (!user) return fail(res, '手机端需先登录才能确认', 401);
  const r = auth.confirmTicket(body.ticket, user.identity, user.nickname);
  if (r.status === 'expired') return fail(res, r.message);
  ok(res, { nickname: user.nickname });
});

/** 未登录用户扫二维码后在此登记身份，随后票据即完成绑定 */
route('POST', '/api/auth/qr/bind', (req, res, params, body) => {
  const r = auth.confirmTicket(body.ticket, 'scan:' + body.deviceId, body.nickname || '扫码访客');
  if (r.status === 'expired') return fail(res, r.message);
  ok(res, { nickname: r.user.nickname });
});

/* ---- 登录：手机号 ---- */
route('POST', '/api/auth/phone/code', (req, res, params, body) => {
  const phone = String(body.phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(phone)) return fail(res, '请输入 11 位手机号');
  ok(res, auth.sendPhoneCode(phone));
});

route('POST', '/api/auth/phone/login', (req, res, params, body) => {
  const phone = String(body.phone || '').replace(/\D/g, '');
  const r = auth.verifyPhoneCode(phone, body.code);
  if (!r.ok) return fail(res, r.message);
  setSessionCookie(res, r.token);
  ok(res, { token: r.token, user: r.user });
});

/* ---- 登录：账号 ---- */
route('POST', '/api/auth/register', (req, res, params, body) => {
  const r = auth.registerAccount(body.username, body.password, body.nickname);
  if (!r.ok) return fail(res, r.message);
  setSessionCookie(res, r.token);
  ok(res, { token: r.token, user: r.user });
});

route('POST', '/api/auth/login', (req, res, params, body) => {
  const r = auth.loginAccount(body.username, body.password);
  if (!r.ok) return fail(res, r.message);
  setSessionCookie(res, r.token);
  ok(res, { token: r.token, user: r.user });
});

route('POST', '/api/auth/guest', (req, res, params, body) => {
  const r = auth.guestLogin();
  setSessionCookie(res, r.token);
  ok(res, { token: r.token, user: r.user });
});

route('POST', '/api/auth/logout', (req, res) => {
  const tokenRow = res.req && res.req.__tokenRow;
  if (tokenRow) db.tokens.remove(tokenRow);
  res.setHeader('Set-Cookie', 'tb_token=; Path=/; Max-Age=0');
  ok(res, { done: true });
});

route('GET', '/api/auth/me', (req, res) => {
  const user = auth.resolveUser(req);
  if (!user) return fail(res, '未登录', 401);
  ok(res, auth.publicUser(user));
});

/* ---- 坦白局 ---- */
route('GET', '/api/rooms', (req, res, params, body, query) => {
  const viewer = auth.resolveUser(req);
  const visitorId = viewer ? viewer.identity : deviceIdentity(req);
  const list = db.rooms
    .all()
    .filter((r) => !isTestRoom(r))
    .slice()
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
      return b.createdAt - a.createdAt;
    })
    .map((r) => shapeRoom(r, { visitorId: visitorId }));
  const filtered = query.tag ? list.filter((r) => (r.tags || []).indexOf(query.tag) !== -1) : list;
  ok(res, { list: filtered, total: filtered.length });
});

route('POST', '/api/rooms', (req, res, params, body) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '创建坦白局需要先登录', 401);
  const title = String(body.title || '').trim();
  if (title.length < 2) return fail(res, '给这场坦白局起个名字吧');
  if (title.length > 30) return fail(res, '名字请控制在 30 字以内');
  const check = moderation.inspect(title);
  if (check.blocked) return fail(res, '名称包含不合适的内容');

  const duration = Math.min(Math.max(Number(body.days) || 1, 1), 30);
  const room = {
    id: db.id('r'),
    code: Math.random().toString(36).slice(2, 8),
    ownerId: viewer.id,
    ownerSnapshot: auth.publicUser(viewer),
    title: check.masked,
    subtitle: String(body.subtitle || '').slice(0, 60),
    slogan: String(body.slogan || '').slice(0, 40) || '今天一人问一个问题，我全部如实回答',
    avatar: viewer.avatar,
    theme: body.theme || 'yellow',
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 4) : [],
    rules: {
      onePerGuest: body.rules && body.rules.onePerGuest !== undefined ? !!body.rules.onePerGuest : true,
      requireLogin: !!(body.rules && body.rules.requireLogin),
      allowVoice: body.rules && body.rules.allowVoice !== undefined ? !!body.rules.allowVoice : true,
      reviewFirst: !!(body.rules && body.rules.reviewFirst),
    },
    pinned: false,
    createdAt: nowMs(),
    deadline: nowMs() + duration * DAY,
    closed: false,
  };
  db.rooms.insert(room);
  viewer.stats.rooms = (viewer.stats.rooms || 0) + 1;
  db.users.save();
  ok(res, shapeRoom(room, {}));
});

route('GET', '/api/rooms/:id', (req, res, params) => {
  const room = db.rooms.find(params.id) || db.rooms.find({});
  if (!room) return fail(res, '这场坦白局不存在或已删除', 404);
  const viewer = auth.resolveUser(req);
  const visitorId = viewer ? viewer.identity : deviceIdentity(req);
  const visitor = viewer || auth.ensureUser(visitorId, '匿名访客');
  db.visits.insert({
    id: db.id('v'),
    roomId: room.id,
    visitorId: visitorId,
    visitorName: visitor.nickname,
    createdAt: nowMs(),
  });
  ok(res, Object.assign(shapeRoom(room, { visitorId: visitorId }), {
    visitor: auth.publicUser(visitor),
  }));
});

route('PATCH', '/api/rooms/:id', (req, res, params, body) => {
  const room = db.rooms.find(params.id);
  if (!room) return fail(res, '不存在', 404);
  const viewer = auth.resolveUser(req);
  if (!viewer || viewer.id !== room.ownerId) return fail(res, '只有发起者能修改', 403);
  const patch = {};
  if (body.title) patch.title = String(body.title).slice(0, 30);
  if (body.slogan !== undefined) patch.slogan = String(body.slogan).slice(0, 40);
  if (body.subtitle !== undefined) patch.subtitle = String(body.subtitle).slice(0, 60);
  if (body.tags) patch.tags = body.tags.slice(0, 4);
  if (body.rules) patch.rules = Object.assign({}, room.rules, body.rules);
  if (body.theme) patch.theme = body.theme;
  if (body.closed !== undefined) patch.closed = !!body.closed;
  db.rooms.update(room.id, patch);
  ok(res, shapeRoom(db.rooms.find(room.id), {}));
});

route('GET', '/api/rooms/:id/posts', (req, res, params, body, query) => {
  const viewer = auth.resolveUser(req);
  const visitorId = viewer ? viewer.identity : deviceIdentity(req);
  let list = db.posts.filter((p) => p.roomId === params.id);
  list = list.filter((p) => !p.pending);
  if (query.kind) list = list.filter((p) => p.kind === query.kind);
  if (query.filter === 'featured') list = list.filter((p) => p.featured);
  if (query.filter === 'unanswered') list = list.filter((p) => p.kind === 'question' && !p.answered);
  if (query.filter === 'mine') list = list.filter((p) => p.authorIdentity === visitorId);
  list.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
  ok(res, { list: list.map((p) => shapePost(p, visitorId)), total: list.length });
});

/** 提问 / 回答 / 追问 统一入口 */
route('POST', '/api/rooms/:id/posts', (req, res, params, body) => {
  const room = db.rooms.find(params.id);
  if (!room) return fail(res, '这场坦白局不存在', 404);
  const viewer = auth.resolveUser(req);
  const visitorId = viewer ? viewer.identity : deviceIdentity(req);
  if (room.rules.requireLogin && !viewer) return fail(res, '本场需要登录后才能提问', 401);
  if (room.closed) return fail(res, '这场坦白局已关闭');
  if (room.deadline && nowMs() > room.deadline) return fail(res, '本场坦白局已到期，只能浏览');

  const kind = body.kind === 'answer' ? 'answer' : 'question';
  const text = String(body.text || '').trim();
  if (!text && !body.voice) return fail(res, '说点什么吧');
  if (text.length > 300) return fail(res, '内容请控制在 300 字以内');

  if (kind === 'question' && room.rules.onePerGuest) {
    const already = db.posts.count(
      (p) => p.roomId === room.id && p.kind === 'question' && p.authorIdentity === visitorId
    );
    if (already >= 1) return fail(res, '每人只能问一个问题哦，明天再来吧');
  }

  const check = moderation.inspect(text);
  if (check.blocked) return fail(res, '内容包含不合适的信息，请修改后再发送');

  const author = viewer || auth.ensureUser(visitorId, '匿名访客');
  const post = {
    id: db.id('p'),
    roomId: room.id,
    kind: kind,
    text: check.masked,
    voice: body.voice || null,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 3) : [],
    replyTo: body.replyTo || null,
    authorIdentity: author.identity,
    authorSnapshot: auth.publicUser(author),
    hearts: 0,
    claps: 0,
    featured: false,
    pending: !!room.rules.reviewFirst,
    answered: false,
    reportCount: 0,
    createdAt: nowMs(),
    likers: [],
    clappers: [],
  };
  db.posts.insert(post);

  // @提及：解析正文里的 @昵称，命中则通知对方
  const mentioned = social.parseMentions(check.masked).filter((u) => u.identity !== author.identity);
  mentioned.forEach((u) => {
    social.notify(u.id, 'mention', author.nickname + ' 在坦白局里提到了你', {
      roomId: room.id, postId: post.id,
    });
  });

  if (kind === 'question' && viewer) {
    viewer.stats.posts = (viewer.stats.posts || 0) + 1;
    db.users.save();
  }

  ok(res, {
    post: shapePost(post, visitorId),
    masked: check.words.length ? check.words : null,
    mentioned: mentioned.map((u) => u.nickname),
  });
});

/* ---- 关注 / 取关 ---- */
route('POST', '/api/users/:id/follow', (req, res, params) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '请先登录', 401);
  const target = social.resolveUser(params.id);
  if (!target) return fail(res, '用户不存在', 404);
  const r = social.toggleFollow(viewer.identity, target.identity);
  if (!r.ok) return fail(res, r.message);
  if (r.following) social.notifyFollow(target, viewer);
  ok(res, r);
});

/* ---- 屏蔽 / 取消屏蔽 ---- */
route('POST', '/api/users/:id/block', (req, res, params) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '请先登录', 401);
  const target = social.resolveUser(params.id);
  if (!target) return fail(res, '用户不存在', 404);
  if (target.identity === viewer.identity) return fail(res, '不能屏蔽自己');
  const existing = db.blocks.findOne((b) => b.from === viewer.identity && b.to === target.identity);
  if (existing) {
    db.blocks.remove(existing.id);
    return ok(res, { blocked: false });
  }
  db.blocks.insert({
    id: db.id('bk'),
    from: viewer.identity,
    to: target.identity,
    createdAt: nowMs(),
  });
  ok(res, { blocked: true });
});

/* ---- 关系摘要 ---- */
route('GET', '/api/users/:id/relation', (req, res, params) => {
  const viewer = auth.resolveUser(req);
  const identity = viewer ? viewer.identity : deviceIdentity(req);
  const targetIdentity = social.resolveIdentity(params.id);
  if (!targetIdentity) return fail(res, '用户不存在', 404);
  const r = social.relation(identity, targetIdentity);
  if (!r) return fail(res, '用户不存在', 404);
  ok(res, r);
});

/* ---- 关注列表 / 粉丝列表 ---- */
route('GET', '/api/users/:id/follows', (req, res, params) => {
  const targetIdentity = social.resolveIdentity(params.id);
  if (!targetIdentity) return fail(res, '用户不存在', 404);
  const users = db.follows
    .filter((f) => f.from === targetIdentity)
    .map((f) => social.resolveUser(f.to))
    .filter((u) => u && !social.isSynthetic(u.identity))
    .map((u) => auth.publicUser(u));
  ok(res, { list: users, total: users.length });
});

route('GET', '/api/users/:id/fans', (req, res, params) => {
  const targetIdentity = social.resolveIdentity(params.id);
  if (!targetIdentity) return fail(res, '用户不存在', 404);
  const users = db.follows
    .filter((f) => f.to === targetIdentity)
    .map((f) => social.resolveUser(f.from))
    .filter((u) => u && !social.isSynthetic(u.identity))
    .map((u) => auth.publicUser(u));
  ok(res, { list: users, total: users.length });
});

/* ---- 收藏 ---- */
route('POST', '/api/posts/:id/favorite', (req, res, params) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '请先登录', 401);
  const r = social.toggleFavorite(viewer.identity, params.id);
  if (!r.ok) return fail(res, r.message);
  ok(res, r);
});

route('GET', '/api/me/favorites', (req, res) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '请先登录', 401);
  const list = social.listFavorites(viewer.identity);
  ok(res, {
    list: list.map((x) => ({ post: shapePost(x.post, viewer.identity), at: x.favoritedAt })),
    total: list.length,
  });
});

/** 主人的回答动作：回答某个问题 */
route('POST', '/api/posts/:id/answer', (req, res, params, body) => {
  const question = db.posts.find(params.id);
  if (!question || question.kind !== 'question') return fail(res, '问题不存在', 404);
  const room = db.rooms.find(question.roomId);
  const viewer = auth.resolveUser(req);
  if (!viewer || !room || viewer.id !== room.ownerId) return fail(res, '只有发起者可以回答', 403);
  const text = String(body.text || '').trim();
  if (!text && !body.voice) return fail(res, '写点什么再回答吧');
  const check = moderation.inspect(text);
  if (check.blocked) return fail(res, '内容包含不合适的信息');
  const answer = {
    id: db.id('p'),
    roomId: room.id,
    kind: 'answer',
    text: check.masked,
    voice: body.voice || null,
    replyTo: question.id,
    authorIdentity: viewer.identity,
    authorSnapshot: auth.publicUser(viewer),
    hearts: 0,
    claps: 0,
    featured: false,
    pending: false,
    reportCount: 0,
    createdAt: nowMs(),
    likers: [],
    clappers: [],
  };
  db.posts.insert(answer);
  db.posts.update(question.id, { answered: true });
  // 提问者收到通知
  const asker = db.users.findOne((u) => u.identity === question.authorIdentity);
  if (asker) {
    db.messages.insert({
      id: db.id('msg'),
      userId: asker.id,
      type: 'answered',
      text: room.ownerSnapshot.nickname + ' 回答了你的问题',
      roomId: room.id,
      postId: question.id,
      read: false,
      createdAt: nowMs(),
    });
    asker.stats.received = (asker.stats.received || 0) + 1;
    db.users.save();
  }
  ok(res, { answer: shapePost(answer, viewer.identity) });
});

/** 互动：心动 / 鼓掌 */
route('POST', '/api/posts/:id/react', (req, res, params, body) => {
  const post = db.posts.find(params.id);
  if (!post) return fail(res, '内容不存在', 404);
  const viewer = auth.resolveUser(req);
  const visitorId = viewer ? viewer.identity : deviceIdentity(req);
  const type = body.type === 'clap' ? 'clap' : 'heart';
  const key = type === 'clap' ? 'clappers' : 'likers';
  post[key] = post[key] || [];
  const idx = post[key].indexOf(visitorId);
  if (idx === -1) {
    post[key].push(visitorId);
  } else {
    post[key].splice(idx, 1);
  }
  post.hearts = (post.hearts || 0) + (idx === -1 ? 1 : -1);
  post.claps = (post.claps || 0) + (type === 'clap' ? (idx === -1 ? 1 : -1) : 0);
  db.posts.save();

  const room = db.rooms.find(post.roomId);
  if (idx === -1 && room) {
    db.events.insert({
      id: db.id('e'), roomId: room.id, type: type, visitorId: visitorId, createdAt: nowMs(),
    });
  }
  ok(res, { hearts: post.hearts, claps: post.claps, reacted: idx === -1 });
});

route('POST', '/api/posts/:id/feature', (req, res, params, body) => {
  const post = db.posts.find(params.id);
  if (!post) return fail(res, '内容不存在', 404);
  const room = db.rooms.find(post.roomId);
  const viewer = auth.resolveUser(req);
  if (!viewer || !room || viewer.id !== room.ownerId) return fail(res, '只有发起者能精选', 403);
  // 先取出目标值再写入：update 会直接改写 post 对象，事后读会拿到新值导致返回反了
  const nextFeatured = !post.featured;
  db.posts.update(post.id, { featured: nextFeatured });
  ok(res, { featured: nextFeatured });
});

route('DELETE', '/api/posts/:id', (req, res, params) => {
  const post = db.posts.find(params.id);
  if (!post) return fail(res, '内容不存在', 404);
  const room = db.rooms.find(post.roomId);
  const viewer = auth.resolveUser(req);
  const isHost = viewer && room && viewer.id === room.ownerId;
  if (!isHost && (!viewer || viewer.identity !== post.authorIdentity)) {
    return fail(res, '没有权限删除', 403);
  }
  db.posts.remove(post.id);
  ok(res, { done: true });
});

/** 追问（对已回答的问题继续提问） */
route('POST', '/api/posts/:id/followup', (req, res, params, body) => {
  const target = db.posts.find(params.id);
  if (!target) return fail(res, '内容不存在', 404);
  const viewer = auth.resolveUser(req);
  const visitorId = viewer ? viewer.identity : deviceIdentity(req);
  const text = String(body.text || '').trim();
  if (!text) return fail(res, '追问不能为空');
  if (text.length > 200) return fail(res, '追问请控制在 200 字以内');
  const check = moderation.inspect(text);
  const author = viewer || auth.ensureUser(visitorId, '匿名访客');
  const post = {
    id: db.id('p'),
    roomId: target.roomId,
    kind: 'question',
    text: check.masked,
    voice: null,
    tags: [],
    replyTo: target.id,
    authorIdentity: author.identity,
    authorSnapshot: auth.publicUser(author),
    hearts: 0, claps: 0, featured: false, pending: false, reportCount: 0,
    createdAt: nowMs(), likers: [], clappers: [],
  };
  db.posts.insert(post);
  ok(res, { post: shapePost(post, visitorId) });
});

/* ---- 社交扩展 ---- */

/** 广场：全局热门内容 + 排行榜 */
route('GET', '/api/plaza', (req, res) => {
  const rooms = db.rooms.all().filter((r) => !isTestRoom(r)).map((r) => shapeRoom(r, {}));
  const roomIds = new Set(rooms.map((r) => r.id));
  const hotRooms = rooms.slice().sort((a, b) => {
    const sa = a.counts.questions * 3 + a.counts.answers * 2 + a.counts.hearts + a.counts.visits;
    const sb = b.counts.questions * 3 + b.counts.answers * 2 + b.counts.hearts + b.counts.visits;
    return sb - sa;
  }).slice(0, 8);
  const hotPosts = db.posts
    .filter((p) => !p.pending && roomIds.has(p.roomId))
    .sort((a, b) => (b.hearts + b.claps) - (a.hearts + a.claps))
    .slice(0, 10)
    .map((p) => shapePost(p, null));
  const tags = {};
  rooms.forEach((r) => (r.tags || []).forEach((t) => { tags[t] = (tags[t] || 0) + 1; }));
  const topTags = Object.keys(tags).sort((a, b) => tags[b] - tags[a]).slice(0, 10)
    .map((t) => ({ tag: t, count: tags[t] }));
  ok(res, { hotRooms: hotRooms, hotPosts: hotPosts, topTags: topTags, online: db.tokens.count() });
});

/* ---- 动态流：我关注的人的新动态 ---- */
route('GET', '/api/feed', (req, res) => {
  const viewer = auth.resolveUser(req);
  const identity = viewer ? viewer.identity : deviceIdentity(req);
  const items = social.feed(identity, 40);
  ok(res, {
    list: items.map((it) => {
      const base = {
        id: it.id,
        kind: it.kind,
        roomId: it.roomId,
        actor: it.actor,
        createdAt: it.at,
      };
      if (it.kind === 'room') {
        base.room = shapeRoom(it.room, { visitorId: identity });
        base.text = it.room.title;
      } else {
        base.post = shapePost(it.post, identity);
        base.text = it.post.text;
      }
      return base;
    }),
    total: items.length,
  });
});

/* ---- 话题聚合 ---- */
route('GET', '/api/topics', (req, res) => {
  ok(res, { list: social.trendingTopics(20) });
});

/* ---- 可能感兴趣的人 ---- */
route('GET', '/api/suggestions', (req, res) => {
  const viewer = auth.resolveUser(req);
  const identity = viewer ? viewer.identity : deviceIdentity(req);
  ok(res, { list: social.suggestions(identity, 6) });
});

/* ---- 用户主页（社交增强版）---- */
route('GET', '/api/users/:id', (req, res, params) => {
  const user = db.users.find(params.id);
  if (!user) return fail(res, '用户不存在', 404);
  const visitor = auth.resolveUser(req);
  const visitorId = visitor ? visitor.identity : deviceIdentity(req);
  const rooms = db.rooms
    .filter((r) => r.ownerId === user.id)
    .map((r) => shapeRoom(r, { visitorId: visitorId }));
  const posts = db.posts
    .filter((p) => p.authorIdentity === user.identity)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map((p) => shapePost(p, visitorId));
  const hearts = db.posts.filter((p) => (p.likers || []).indexOf(user.identity) !== -1).length;

  ok(res, {
    user: auth.publicUser(user),
    rooms: rooms,
    posts: posts,
    hearts: hearts,
    relation: social.relation(visitorId, user.identity),
    favorites: db.favorites.count((f) => f.identity === user.identity),
  });
});

/** 实时统计：在线、24 小时活跃曲线 */
route('GET', '/api/stats', (req, res) => {
  const now = nowMs();
  const buckets = [];
  for (let i = 23; i >= 0; i--) {
    const end = now - i * 3600 * 1000;
    const start = end - 3600 * 1000;
    buckets.push({
      hour: new Date(end).getHours(),
      posts: db.posts.count((p) => p.createdAt >= start && p.createdAt < end),
      visits: db.visits.count((v) => v.createdAt >= start && v.createdAt < end),
    });
  }
  ok(res, {
    online: db.tokens.count(),
    buckets: buckets,
    totals: {
      rooms: db.rooms.count(),
      posts: db.posts.count(),
      users: db.users.count(),
      hearts: db.posts.all().reduce((s, p) => s + (p.hearts || 0), 0),
    },
  });
});

/** 访客墙 */
route('GET', '/api/rooms/:id/visits', (req, res, params) => {
  const list = db.visits
    .filter((v) => v.roomId === params.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
  ok(res, {
    list: list.map((v) => ({
      id: v.id, name: v.visitorName, avatar: auth.avatarFor(v.visitorId), at: v.createdAt,
    })),
    total: list.length,
  });
});

/* ---- 通知 ---- */
route('GET', '/api/messages', (req, res) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return ok(res, { list: [], unread: 0 });
  const list = db.messages
    .filter((m) => m.userId === viewer.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
  ok(res, { list: list, unread: list.filter((m) => !m.read).length });
});

route('POST', '/api/messages/read', (req, res) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '未登录', 401);
  db.messages.filter((m) => m.userId === viewer.id && !m.read).forEach((m) => {
    m.read = true;
  });
  db.messages.save();
  ok(res, { done: true });
});

/* ---- 举报 ---- */
route('POST', '/api/reports', (req, res, params, body) => {
  const post = db.posts.find(body.postId);
  if (!post) return fail(res, '内容不存在', 404);
  db.reports.insert({
    id: db.id('rp'),
    postId: post.id,
    roomId: post.roomId,
    reason: String(body.reason || '其他').slice(0, 50),
    detail: String(body.detail || '').slice(0, 200),
    status: 'pending',
    createdAt: nowMs(),
  });
  db.posts.update(post.id, { reportCount: (post.reportCount || 0) + 1 });
  ok(res, { done: true });
});

route('GET', '/api/reports', (req, res) => {
  const list = db.reports.filter((r) => r.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
  ok(res, { list: list, total: list.length });
});

route('POST', '/api/reports/:id/resolve', (req, res, params, body) => {
  const report = db.reports.find(params.id);
  if (!report) return fail(res, '举报不存在', 404);
  db.reports.update(report.id, { status: body.action === 'remove' ? 'removed' : 'dismissed' });
  if (body.action === 'remove') db.posts.remove(report.postId);
  ok(res, { done: true });
});

/* ---- 我的草稿（防丢稿） ---- */
route('GET', '/api/drafts', (req, res) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return ok(res, { list: [] });
  ok(res, { list: db.drafts.filter((d) => d.identity === viewer.identity) });
});

route('PUT', '/api/drafts', (req, res, params, body) => {
  const viewer = auth.resolveUser(req);
  if (!viewer) return fail(res, '未登录', 401);
  const existing = db.drafts.findOne((d) => d.identity === viewer.identity && d.roomId === body.roomId);
  if (existing) {
    db.drafts.update(existing.id, { text: String(body.text || '').slice(0, 300), updatedAt: nowMs() });
  } else {
    db.drafts.insert({
      id: db.id('df'), identity: viewer.identity, roomId: body.roomId,
      text: String(body.text || '').slice(0, 300), createdAt: nowMs(), updatedAt: nowMs(),
    });
  }
  ok(res, { saved: true });
});

/* ---- 数据导出 ---- */
route('GET', '/api/export', (req, res) => {
  const viewer = auth.resolveUser(req);
  const scope = req.headers['x-export-scope'] || 'room';
  const payload = scope === 'all'
    ? { rooms: db.rooms.all(), posts: db.posts.all(), users: db.users.all() }
    : {
      user: viewer ? auth.publicUser(viewer) : null,
      rooms: db.rooms.filter((r) => !viewer || r.ownerId === viewer.id),
      posts: db.posts.filter((p) => !viewer || p.authorIdentity === viewer.identity),
    };
  send(res, 200, payload, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': 'attachment; filename="tanbaiju-export.json"',
  });
});

/**
 * 演示/测试房间识别。
 *
 * 端到端测试会创建大量临时房间，不该出现在用户的广场里。
 * 但过滤条件不能太宽 ——「社交测试局」这种由测试创建、又被测试自己读写的房间
 * 如果被挡掉，会连带影响归属测试（如@提及通知）。
 *
 * 规则：只挡**纯测试用**的房间 —— 标题里同时出现「测试」且没有正常内容的，
 * 或者标题本身就是「测试」「验证」这类占位词。
 * 真实用户会起的名字（哪怕带「测试」两个字，如「我的面试测试」）不受影响。
 */
function isTestRoom(room) {
  const title = String(room.title || '');
  // 纯占位标题
  if (/^[\s]*(测试|验证|改名后|test)[\s\d]*$/i.test(title)) return true;
  // 明显是自动化产生的房间
  return /自动化测试|端到端|UI 测试|UI测试/.test(title);
}

/* ---- 健康种子数据：让首屏不是空的 ---- */
function seed() {
  if (db.rooms.count() > 0) return;
  const demo = auth.ensureUser('acct:demo', '小满');
  demo.bio = '把想问的话都攒起来，一次问完。';
  demo.stats = { rooms: 3, posts: 42, received: 118, hearts: 640 };
  db.users.save();

  // 演示人格：有真实的关注关系与热度，社交页才不会空荡荡
  const cast = [
    { key: 'demo2', name: '阿泽', bio: '不问工作，只问心情。' },
    { key: 'demo3', name: '林一', bio: '毕业两年，还在找方向。' },
    { key: 'demo4', name: '陈默', bio: '想说什么都可以，我接着。' },
  ];
  cast.forEach((p) => {
    const u = auth.ensureUser('acct:' + p.key, p.name);
    u.bio = p.bio;
    u.stats = { rooms: 1, posts: 12, received: 60, hearts: 240 };
    db.users.save();
  });

  // 建立关注关系：让「动态流」「可能感兴趣的人」有真实数据
  cast.forEach((p, i) => {
    const u = auth.ensureUser('acct:' + p.key, p.name);
    if (i % 2 === 0) {
      // 有人关注小满 -> 小满有粉丝
      db.follows.insert({
        id: db.id('fl'), from: u.identity, fromId: u.id,
        to: demo.identity, toId: demo.id, createdAt: nowMs() - (i + 1) * 86400000,
      });
    }
    // 小满关注其中两个 -> 动态流有内容
    if (i < 2) {
      db.follows.insert({
        id: db.id('fl'), from: demo.identity, fromId: demo.id,
        to: u.identity, toId: u.id, createdAt: nowMs() - (i + 2) * 86400000,
      });
    }
  });

  const presets = [
    {
      title: '小满的坦白局',
      subtitle: '关于生活的 20 个问题',
      tags: ['生活', '成长'],
      questions: [
        '你现在最后悔的决定是什么？',
        '有没有一个瞬间，你觉得全世界都误解了你？',
        '如果明天必须离开这座城市，你最想带走什么？',
        '你偷偷羡慕过身边哪个人？',
        '最近一次哭是因为什么事？',
        '你觉得自己最大的缺点是什么？',
        '有什么爱好是你一直藏着没告诉别人的？',
        '你现在还相信上一段感情里的某个承诺吗？',
      ],
      answers: [
        { text: '后悔高三那年为了面子选了文科，其实我真正想读的是建筑。', hearts: 42 },
        { text: '有。误会了三年才说开，这件事教会我别把猜测当答案。', hearts: 67 },
        { text: '想带走我那台用了八年的笔记本，它存着我所有的日记。', hearts: 88 },
        { text: '羡慕那个敢当场拒绝领导的人，而我只会等散会再难受。', hearts: 55 },
      ],
    },
    {
      title: '阿泽の树洞',
      subtitle: '不问工作，只问心情',
      tags: ['情绪', '树洞'],
      questions: [
        '最近让你半夜睡不着的是什么？',
        '你有没有一句一直想对某人说但没说出口的话？',
        '现在的日子和你二十五岁时的想象差多少？',
        '你觉得自己在变好还是变坏？',
        '什么是你现在最不敢面对的事？',
      ],
      answers: [
        { text: '是我爸体检报告上那个箭头。他自己不查，我不敢问。', hearts: 96 },
        { text: '差很远，但我不再为此道歉了。', hearts: 71 },
        { text: '在变好。至少我现在能承认自己需要休息。', hearts: 33 },
      ],
    },
    {
      title: '毕业季大调查',
      subtitle: '关于未来的 15 问',
      tags: ['未来', '校园'],
      questions: [
        '你毕业后第一份工作想做什么？',
        '你更想要稳定还是更想要自由？',
        '你理想中的生活一天是怎么过的？',
        '如果只能带一样东西去陌生城市，你带什么？',
        '你觉得三十岁的自己会后悔现在的选择吗？',
      ],
      answers: [
        { text: '想去一家不需要开会的公司，做产品。', hearts: 28 },
        { text: '稳定。但我要那种我自己选的稳定。', hearts: 39 },
      ],
    },
  ];

  presets.forEach((preset, pi) => {
    const owner = pi === 0 ? demo : auth.ensureUser('acct:demo' + pi, ['小满', '阿泽', '林一'][pi]);
    const room = {
      id: db.id('r'),
      code: Math.random().toString(36).slice(2, 8),
      ownerId: owner.id,
      ownerSnapshot: auth.publicUser(owner),
      title: preset.title,
      subtitle: preset.subtitle,
      slogan: '今天一人问一个问题，我全部如实回答',
      avatar: owner.avatar,
      theme: ['yellow', 'mint', 'lilac'][pi % 3],
      tags: preset.tags,
      rules: { onePerGuest: true, requireLogin: false, allowVoice: true, reviewFirst: false },
      pinned: pi === 0,
      createdAt: nowMs() - (2 - pi) * 3600 * 1000,
      deadline: nowMs() + (1 - pi > 0 ? 1 : 2) * DAY,
      closed: false,
    };
    db.rooms.insert(room);

    preset.questions.forEach((q, qi) => {
      const askerIdentity = 'seed:asker:' + room.id + ':' + qi;
      const asker = auth.ensureUser(askerIdentity, '匿名访客');
      const question = {
        id: db.id('p'),
        roomId: room.id,
        kind: 'question',
        text: q,
        voice: null,
        tags: [],
        replyTo: null,
        authorIdentity: asker.identity,
        authorSnapshot: auth.publicUser(asker),
        hearts: 12 + qi * 7,
        claps: 3 + qi * 2,
        featured: qi === 0 && pi === 0,
        pending: false,
        answered: qi < preset.answers.length,
        reportCount: 0,
        createdAt: room.createdAt + (qi + 1) * 600000,
        likers: [],
        clappers: [],
      };
      db.posts.insert(question);
    });

    preset.answers.forEach((a, ai) => {
      db.posts.insert({
        id: db.id('p'),
        roomId: room.id,
        kind: 'answer',
        text: a.text,
        voice: null,
        tags: [],
        replyTo: null,
        authorIdentity: owner.identity,
        authorSnapshot: auth.publicUser(owner),
        hearts: a.hearts,
        claps: 4 + ai * 3,
        featured: false,
        pending: false,
        reportCount: 0,
        createdAt: room.createdAt + (ai + 1) * 900000,
        likers: [],
        clappers: [],
      });
    });
  });
  console.log('[seed] 已生成演示数据');
}

/**
 * 是否灌入演示数据。
 * 正式使用时应当是空库 —— 首页会显示「还没有人创建坦白局」的引导态，
 * 内容由真实用户产生。需要预览效果时用 node tools/restart.js --demo 显式开启。
 */
if (process.env.TANBAIJU_DEMO === '1' || process.argv.includes('--demo')) {
  seed();
} else if (db.rooms.count() === 0) {
  console.log('[启动] 空库模式：首页将显示引导态（加 --demo 可载入演示数据）');
}

/* ============ 静态文件 ============ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // 单页应用：未知路径回落到 index.html
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA 回落
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, buf2) => {
        if (e2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(buf2);
      });
    }
    const ext = path.extname(full).toLowerCase();
    const isAsset = /\.(css|js|svg|png|jpg|webp|woff2)$/.test(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=300' : 'no-cache',
    });
    res.end(buf);
  });
}

/* ============ 请求分发 ============ */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  res.req = req;
  // 统一去掉前导斜杠再分段，避免 '' 与 'api' 对不上
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const method = req.method.toUpperCase();

  // 精确匹配
  let handler = routes[method + ' /' + parts.join('/')];

  // 参数匹配：/api/rooms/:id/posts
  if (!handler) {
    outer:
    for (const key of Object.keys(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      const ps = pattern.replace(/^\/+/, '').split('/').filter(Boolean);
      if (ps.length !== parts.length) continue;
      const params = {};
      let okMatch = true;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i].startsWith(':')) params[ps[i].slice(1)] = parts[i];
        else if (ps[i] !== parts[i]) { okMatch = false; break; }
      }
      if (okMatch) { handler = routes[key]; req.params = params; break outer; }
    }
  }

  if (!handler) return fail(res, '接口不存在', 404);

  try {
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
    await handler(req, res, req.params || {}, body, parsed.query || {});
  } catch (err) {
    console.error('[api]', pathname, err);
    if (!res.headersSent) fail(res, '服务器开小差了：' + err.message, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  坦白局已启动');
  console.log('  http://' + HOST + ':' + PORT);
  console.log('  按 Ctrl + C 停止');
  console.log('');
});
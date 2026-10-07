/**
 * 浏览器端本地数据层（离线兜底）。
 *
 * 整个文件包在 IIFE 里：classic script 会共享全局作用域，
 * 顶层若声明了与 router.js 等同名变量（如 const routes）会导致后加载的文件整体失效、
 * 页面白屏。这里用闭包彻底隔离。
 */
(function () {
/**
 * 浏览器端数据层 —— 让整个应用可以跑在纯静态环境（GitHub Pages）。
 *
 * 为什么要这个：
 *   GitHub Pages 只能托管静态文件，不能跑 Node 服务端。
 *   若把逻辑留在 server.js，部署后所有接口都会 404。
 *   因此把服务端的数据与业务逻辑整体搬到浏览器，
 *   用 IndexedDB 持久化（比 localStorage 能放更多、且是异步）。
 *
 * 关键设计：接口签名与 server.js 完全一致。
 *   前端 api.xxx() 不用改任何一行，
 *   api.js 只需判断当前环境决定走 fetch 还是走本地实现。
 *
 * 数据边界（务必清楚）：
 *   静态部署下，每个访客的数据只存在自己的浏览器里，
 *   彼此不互通。这不是缺陷，是 Pages 的固有限制。
 *   想让多人真正共享数据，需要接一个后端（Supabase / LeanCloud 等）。
 */

const DB_NAME = 'tanbaiju';
const DB_VERSION = 1;
const STORES = [
  'users', 'rooms', 'posts', 'messages', 'reports',
  'visits', 'events', 'drafts', 'follows', 'blocks', 'favorites', 'meta',
];

/* ============ IndexedDB 封装 ============ */

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // 极端环境（如隐私模式禁用 IDB）退回内存存储，至少不崩
      const mem = {};
      STORES.forEach((s) => (mem[s] = []));
      const shim = {
        get: (s) => mem[s],
        put: (s, rows) => { mem[s] = rows; },
        add: (s, row) => { mem[s].push(row); },
        del: (s, id) => { mem[s] = mem[s].filter((r) => r.id !== id); },
        all: (s) => mem[s],
        clear: (s) => { mem[s] = []; },
      };
      return resolve(shim);
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      STORES.forEach((s) => {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[data] IndexedDB 打开失败，退回内存存储');
      const mem = {};
      STORES.forEach((s) => (mem[s] = []));
      resolve({
        get: (s) => mem[s],
        put: (s, rows) => { mem[s] = rows; },
        add: (s, row) => { mem[s].push(row); },
        del: (s, id) => { mem[s] = mem[s].filter((r) => r.id !== id); },
        all: (s) => mem[s],
        clear: (s) => { mem[s] = []; },
      });
    };
  });
  return dbPromise;
}

async function tx(store, mode) {
  const db = await openDB();
  return db.transaction(store, mode).objectStore(store);
}

/** 读整表（数据量小，直接全量读换实现简单可靠） */
async function readAll(store) {
  const os = await tx(store, 'readonly');
  return new Promise((resolve) => {
    const req = os.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function writeAll(store, rows) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    os.clear();
    rows.forEach((r) => os.put(r));
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

/* ============ 集合操作 ============ */

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const cache = {};

async function coll(name) {
  if (!cache[name]) cache[name] = await readAll(name);
  return cache[name];
}

async function persist(name) {
  await writeAll(name, cache[name] || []);
}

async function insert(name, row) {
  const rows = await coll(name);
  rows.push(row);
  await persist(name);
  return row;
}

async function update(name, id, patch) {
  const rows = await coll(name);
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  Object.assign(row, patch);
  await persist(name);
  return row;
}

async function remove(name, id) {
  const rows = await coll(name);
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return false;
  rows.splice(i, 1);
  await persist(name);
  return true;
}

async function findById(name, id) {
  const rows = await coll(name);
  return rows.find((r) => r.id === id) || null;
}

async function findWhere(name, fn) {
  const rows = await coll(name);
  return rows.find(fn) || null;
}

async function filter(name, fn) {
  const rows = await coll(name);
  return rows.filter(fn);
}

async function count(name, fn) {
  const rows = await coll(name);
  return fn ? rows.filter(fn).length : rows.length;
}

/* ============ 工具 ============ */

function nowMs() { return Date.now(); }
const DAY = 86400000;

function hashCode(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function avatarFor(seed) {
  const str = String(seed || 'anon');
  return { type: 'ring', hue: hashCode(str) % 360, text: str.slice(0, 1).toUpperCase() || '匿' };
}

/** 简单哈希代替 scrypt：纯前端环境下安全性不是重点，能区分密码即可 */
function hashPassword(pw, salt) {
  const s = salt || Math.random().toString(36).slice(2, 12);
  let h = 5381;
  const combo = s + '::' + String(pw);
  for (let i = 0; i < combo.length; i++) h = ((h << 5) + h + combo.charCodeAt(i)) >>> 0;
  return { salt: s, hash: String(h) };
}

function verifyPassword(pw, salt, hash) {
  return hashPassword(pw, salt).hash === hash;
}

function isSynthetic(identity) {
  return typeof identity === 'string' &&
    (identity.indexOf('seed:') === 0 || identity.indexOf('dev:') === 0);
}

function isTestRoom(room) {
  return /测试|验证|改名后/.test(room.title || '');
}

/* ============ 敏感词 ============ */

const CATEGORIES = {
  insult: ['白痴', '智障', '废物', '垃圾玩意'],
  porn: ['约炮', '裸聊', '开房', '涩图'],
  contact: ['加微信', '私聊我', '留电话', '扣扣'],
  ad: ['免费送', '点击链接', '刷单', '代开发票'],
};

const WORDS = [];
Object.keys(CATEGORIES).forEach((cat) => {
  CATEGORIES[cat].forEach((w) => WORDS.push({ word: w, category: cat }));
});

function inspect(text) {
  const src = String(text || '');
  let masked = src;
  const hits = [];
  WORDS.forEach((item) => {
    const w = item.word.toLowerCase();
    const idx = masked.toLowerCase().indexOf(w);
    if (idx === -1) return;
    hits.push({ word: item.word, category: item.category });
    masked = masked.slice(0, idx) + '*'.repeat(item.word.length) +
             masked.slice(idx + item.word.length);
  });
  return {
    hit: hits.length > 0,
    category: hits.length ? hits[0].category : null,
    words: hits.map((h) => h.word),
    masked: masked,
    blocked: hits.some((h) => h.category === 'insult' || h.category === 'porn'),
  };
}

/* ============ 用户与会话 ============ */

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar || avatarFor(u.nickname),
    bio: u.bio || '',
    identity: u.identity || 'guest',
    verified: !!u.verified,
    stats: {
      rooms: (u.stats && u.stats.rooms) || 0,
      posts: (u.stats && u.stats.posts) || 0,
      received: (u.stats && u.stats.received) || 0,
      hearts: (u.stats && u.stats.hearts) || 0,
    },
    createdAt: u.createdAt,
  };
}

async function ensureUser(identity, nickname) {
  let u = await findWhere('users', (x) => x.identity === identity);
  if (!u) {
    u = {
      id: uid('u'),
      identity: identity,
      nickname: nickname || ('朋友' + identity.slice(-4).toUpperCase()),
      avatar: avatarFor(nickname || identity),
      bio: '',
      stats: { rooms: 0, posts: 0, received: 0, hearts: 0 },
      createdAt: nowMs(),
    };
    await insert('users', u);
  }
  return u;
}

/** 当前会话身份：存在 meta 表里，游客也有 */
async function currentIdentity() {
  const rows = await coll('meta');
  const row = rows.find((r) => r.id === 'session');
  if (row && row.identity) {
    const u = await findWhere('users', (x) => x.identity === row.identity);
    if (u) return u;
  }
  // 没有会话则自动创建游客身份，保证提问等功能开箱可用
  const suffix = Math.random().toString(36).slice(2, 10);
  const guest = await ensureUser('guest:' + suffix, '匿名访客');
  await insert('meta', { id: 'session', identity: guest.identity, createdAt: nowMs() });
  return guest;
}

async function setIdentity(identity) {
  const rows = await coll('meta');
  const i = rows.findIndex((r) => r.id === 'session');
  const row = { id: 'session', identity: identity, createdAt: nowMs() };
  if (i === -1) rows.push(row); else rows[i] = row;
  await persist('meta');
}

async function me() {
  return publicUser(await currentIdentity());
}

/* ============ 数据整形（与 server.js 保持一致） ============ */

async function shapeRoom(room, visitorId) {
  const vId = visitorId || (await currentIdentity()).identity;
  const posts = await filter('posts', (p) => p.roomId === room.id);
  const questions = posts.filter((p) => p.kind === 'question');
  const answers = posts.filter((p) => p.kind === 'answer');
  const visits = await filter('visits', (v) => v.roomId === room.id);
  const expired = room.deadline && nowMs() > room.deadline;
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
      visits: visits.length,
    },
    hasAnswered: posts.some((p) => p.kind === 'answer' && p.authorIdentity === vId),
  };
}

async function isFavorited(identity, postId) {
  const hit = await findWhere('favorites', (f) => f.identity === identity && f.postId === postId);
  return !!hit;
}

async function shapePost(post, viewerIdentity) {
  if (!post) return null;
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
    mine: !!viewerIdentity && post.authorIdentity === viewerIdentity,
    favorited: viewerIdentity ? await isFavorited(viewerIdentity, post.id) : false,
    mentions: post.mentions || [],
  };
}

/* ============ 社交 ============ */

async function isFollowing(a, b) {
  if (!a || !b) return false;
  return (await count('follows', (f) => f.from === a && f.to === b)) > 0;
}

async function relation(viewer, target) {
  const t = await findWhere('users', (u) => u.identity === target);
  if (!t) return null;
  const followers = await count('follows', (f) => f.to === target);
  const followingCount = await count('follows', (f) => f.from === target);
  return {
    following: await isFollowing(viewer, target),
    followsYou: await isFollowing(target, viewer),
    friend: (await isFollowing(viewer, target)) && (await isFollowing(target, viewer)),
    blocked: (await count('blocks', (b) => b.from === viewer && b.to === target)) > 0,
    followers: followers,
    followingCount: followingCount,
    posts: await count('posts', (p) => p.authorIdentity === target),
    rooms: await count('rooms', (r) => r.ownerId === t.id),
    favorites: await count('favorites', (f) => f.identity === target),
  };
}

async function notify(userId, type, text, extra) {
  if (!userId) return;
  await insert('messages', {
    id: uid('msg'),
    userId: userId,
    type: type,
    text: text,
    roomId: (extra && extra.roomId) || null,
    postId: (extra && extra.postId) || null,
    read: false,
    createdAt: nowMs(),
  });
}

async function parseMentions(text) {
  const re = /@([^\s@，,。.!！?？:：;；]{1,16})/g;
  const out = [];
  const users = await coll('users');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const hit = users.find((u) => u.nickname === m[1]);
    if (hit) out.push(hit);
  }
  return out;
}

/* ============ 路由表 ============ */
/* 键为 'METHOD /path'，路径参数用 :name，与 server.js 的 route() 同构 */

const routes = {};

function route(method, path, handler) {
  routes[method + ' ' + path] = handler;
}

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/* ---- 健康 ---- */
route('GET', '/api/health', async () => ({
  name: '坦白局', time: nowMs(),
  counts: {
    users: await count('users'),
    rooms: await count('rooms'),
    posts: await count('posts'),
  },
}));

/* ---- 登录：本地身份（静态环境无跨设备能力，见 README 说明） ---- */
route('POST', '/api/auth/login-local', async (body) => {
  const nickname = String(body.nickname || '').trim() || '匿名访客';
  const identity = 'local:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const u = await ensureUser(identity, nickname);
  u.bio = String(body.bio || '').slice(0, 60);
  await persist('users');
  await setIdentity(identity);
  return { token: identity, user: publicUser(u) };
});

route('POST', '/api/auth/guest', async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const guest = await ensureUser('guest:' + suffix, '匿名访客');
  await setIdentity(guest.identity);
  return { token: guest.identity, user: publicUser(guest) };
});

route('GET', '/api/auth/me', async () => publicUser(await currentIdentity()));

route('POST', '/api/auth/logout', async () => {
  await setIdentity((await ensureUser('guest:' + Math.random().toString(36).slice(2, 10), '匿名访客')).identity);
  return { done: true };
});

/** 更新个人资料 */
route('PATCH', '/api/auth/profile', async (body) => {
  const u = await currentIdentity();
  if (body.nickname !== undefined) u.nickname = String(body.nickname).slice(0, 16) || u.nickname;
  if (body.bio !== undefined) u.bio = String(body.bio).slice(0, 60);
  await persist('users');
  return publicUser(u);
});

/* ---- 坦白局 ---- */
route('GET', '/api/rooms', async (params, body, query) => {
  const viewer = await currentIdentity();
  let list = (await coll('rooms'))
    .filter((r) => !isTestRoom(r))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
  if (query.tag) list = list.filter((r) => (r.tags || []).indexOf(query.tag) !== -1);
  const shaped = [];
  for (const r of list) shaped.push(await shapeRoom(r, viewer.identity));
  return { list: shaped, total: shaped.length };
});

route('POST', '/api/rooms', async (params, body) => {
  const viewer = await currentIdentity();
  const title = String(body.title || '').trim();
  if (title.length < 2) throw new HttpError('给这场坦白局起个名字吧', 400);
  if (title.length > 30) throw new HttpError('名字请控制在 30 字以内', 400);
  const check = inspect(title);
  if (check.blocked) throw new HttpError('名称包含不合适的内容', 400);

  const days = Math.min(Math.max(Number(body.days) || 1, 1), 30);
  const room = {
    id: uid('r'),
    code: Math.random().toString(36).slice(2, 8),
    ownerId: viewer.id,
    ownerSnapshot: publicUser(viewer),
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
    deadline: nowMs() + days * DAY,
    closed: false,
  };
  await insert('rooms', room);
  viewer.stats.rooms = (viewer.stats.rooms || 0) + 1;
  await persist('users');
  return shapeRoom(room, viewer.identity);
});

route('GET', '/api/rooms/:id', async (params) => {
  const room = await findById('rooms', params.id) ||
    await findWhere('rooms', (r) => r.code === params.id);
  if (!room) throw new HttpError('这场坦白局不存在或已删除', 404);
  const viewer = await currentIdentity();
  await insert('visits', {
    id: uid('v'), roomId: room.id, visitorId: viewer.identity,
    visitorName: viewer.nickname, createdAt: nowMs(),
  });
  const shaped = await shapeRoom(room, viewer.identity);
  shaped.visitor = publicUser(viewer);
  return shaped;
});

route('PATCH', '/api/rooms/:id', async (params, body) => {
  const room = await findById('rooms', params.id);
  if (!room) throw new HttpError('不存在', 404);
  const viewer = await currentIdentity();
  if (viewer.id !== room.ownerId) throw new HttpError('只有发起者能修改', 403);
  if (body.title) room.title = String(body.title).slice(0, 30);
  if (body.slogan !== undefined) room.slogan = String(body.slogan).slice(0, 40);
  if (body.subtitle !== undefined) room.subtitle = String(body.subtitle).slice(0, 60);
  if (body.tags) room.tags = body.tags.slice(0, 4);
  if (body.rules) room.rules = Object.assign({}, room.rules, body.rules);
  if (body.theme) room.theme = body.theme;
  if (body.closed !== undefined) room.closed = !!body.closed;
  await persist('rooms');
  return shapeRoom(room, viewer.identity);
});

route('GET', '/api/rooms/:id/posts', async (params, body, query) => {
  const viewer = await currentIdentity();
  let list = await filter('posts', (p) => p.roomId === params.id && !p.pending);
  if (query.kind) list = list.filter((p) => p.kind === query.kind);
  if (query.filter === 'featured') list = list.filter((p) => p.featured);
  if (query.filter === 'unanswered') list = list.filter((p) => p.kind === 'question' && !p.answered);
  if (query.filter === 'mine') list = list.filter((p) => p.authorIdentity === viewer.identity);
  list.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
  const shaped = [];
  for (const p of list) shaped.push(await shapePost(p, viewer.identity));
  return { list: shaped, total: shaped.length };
});

/* ---- 内容 ---- */
route('POST', '/api/rooms/:id/posts', async (params, body) => {
  const room = await findById('rooms', params.id);
  if (!room) throw new HttpError('这场坦白局不存在', 404);
  const viewer = await currentIdentity();
  if (room.closed) throw new HttpError('这场坦白局已关闭', 400);
  if (room.deadline && nowMs() > room.deadline) throw new HttpError('本场坦白局已到期，只能浏览', 400);

  const kind = body.kind === 'answer' ? 'answer' : 'question';
  const text = String(body.text || '').trim();
  if (!text && !body.voice) throw new HttpError('说点什么吧', 400);
  if (text.length > 300) throw new HttpError('内容请控制在 300 字以内', 400);

  if (kind === 'question' && room.rules.onePerGuest) {
    const already = await count('posts', (p) =>
      p.roomId === room.id && p.kind === 'question' && p.authorIdentity === viewer.identity);
    if (already >= 1) throw new HttpError('每人只能问一个问题哦，明天再来吧', 400);
  }

  const check = inspect(text);
  if (check.blocked) throw new HttpError('内容包含不合适的信息，请修改后再发送', 400);

  const post = {
    id: uid('p'),
    roomId: room.id,
    kind: kind,
    text: check.masked,
    voice: body.voice || null,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 3) : [],
    replyTo: body.replyTo || null,
    authorIdentity: viewer.identity,
    authorSnapshot: publicUser(viewer),
    hearts: 0, claps: 0, featured: false,
    pending: !!room.rules.reviewFirst,
    answered: false, reportCount: 0,
    createdAt: nowMs(),
    likers: [], clappers: [],
  };
  await insert('posts', post);

  const mentioned = (await parseMentions(check.masked)).filter((u) => u.identity !== viewer.identity);
  for (const u of mentioned) {
    await notify(u.id, 'mention', viewer.nickname + ' 在坦白局里提到了你', { roomId: room.id, postId: post.id });
  }

  if (kind === 'question') {
    viewer.stats.posts = (viewer.stats.posts || 0) + 1;
    await persist('users');
  }
  return { post: await shapePost(post, viewer.identity), masked: check.words.length ? check.words : null, mentioned: mentioned.map((u) => u.nickname) };
});

route('POST', '/api/posts/:id/answer', async (params, body) => {
  const question = await findById('posts', params.id);
  if (!question || question.kind !== 'question') throw new HttpError('问题不存在', 404);
  const room = await findById('rooms', question.roomId);
  const viewer = await currentIdentity();
  if (!room || viewer.id !== room.ownerId) throw new HttpError('只有发起者可以回答', 403);
  const text = String(body.text || '').trim();
  if (!text && !body.voice) throw new HttpError('写点什么再回答吧', 400);
  const check = inspect(text);
  if (check.blocked) throw new HttpError('内容包含不合适的信息', 400);

  const answer = {
    id: uid('p'), roomId: room.id, kind: 'answer', text: check.masked,
    voice: body.voice || null, tags: [], replyTo: question.id,
    authorIdentity: viewer.identity, authorSnapshot: publicUser(viewer),
    hearts: 0, claps: 0, featured: false, pending: false, reportCount: 0,
    createdAt: nowMs(), likers: [], clappers: [],
  };
  await insert('posts', answer);
  await update('posts', question.id, { answered: true });

  const asker = await findWhere('users', (u) => u.identity === question.authorIdentity);
  if (asker) {
    await notify(asker.id, 'answered', room.ownerSnapshot.nickname + ' 回答了你的问题', { roomId: room.id, postId: question.id });
    asker.stats.received = (asker.stats.received || 0) + 1;
    await persist('users');
  }
  return { answer: await shapePost(answer, viewer.identity) };
});

route('POST', '/api/posts/:id/react', async (params, body) => {
  const post = await findById('posts', params.id);
  if (!post) throw new HttpError('内容不存在', 404);
  const viewer = await currentIdentity();
  const type = body.type === 'clap' ? 'clap' : 'heart';
  post.likers = post.likers || [];
  post.clappers = post.clappers || [];
  const key = type === 'clap' ? 'clappers' : 'likers';
  const i = post[key].indexOf(viewer.identity);
  if (i === -1) {
    post[key].push(viewer.identity);
    post.hearts = (post.hearts || 0) + (type === 'heart' ? 1 : 0);
    post.claps = (post.claps || 0) + (type === 'clap' ? 1 : 0);
  } else {
    post[key].splice(i, 1);
    post.hearts = Math.max(0, (post.hearts || 0) - (type === 'heart' ? 1 : 0));
    post.claps = Math.max(0, (post.claps || 0) - (type === 'clap' ? 1 : 0));
  }
  await persist('posts');
  const room = await findById('rooms', post.roomId);
  if (i === -1 && room) {
    await insert('events', { id: uid('e'), roomId: room.id, type: type, visitorId: viewer.identity, createdAt: nowMs() });
  }
  return { hearts: post.hearts || 0, claps: post.claps || 0, reacted: i === -1 };
});

route('POST', '/api/posts/:id/feature', async (params) => {
  const post = await findById('posts', params.id);
  if (!post) throw new HttpError('内容不存在', 404);
  const room = await findById('rooms', post.roomId);
  const viewer = await currentIdentity();
  if (!room || viewer.id !== room.ownerId) throw new HttpError('只有发起者能精选', 403);
  const next = !post.featured;
  post.featured = next;
  await persist('posts');
  return { featured: next };
});

route('DELETE', '/api/posts/:id', async (params) => {
  const post = await findById('posts', params.id);
  if (!post) throw new HttpError('内容不存在', 404);
  const room = await findById('rooms', post.roomId);
  const viewer = await currentIdentity();
  const isHost = room && viewer.id === room.ownerId;
  if (!isHost && post.authorIdentity !== viewer.identity) throw new HttpError('没有权限删除', 403);
  await remove('posts', post.id);
  return { done: true };
});

route('POST', '/api/posts/:id/followup', async (params, body) => {
  const target = await findById('posts', params.id);
  if (!target) throw new HttpError('内容不存在', 404);
  const viewer = await currentIdentity();
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError('追问不能为空', 400);
  if (text.length > 200) throw new HttpError('追问请控制在 200 字以内', 400);
  const check = inspect(text);
  const post = {
    id: uid('p'), roomId: target.roomId, kind: 'question', text: check.masked,
    voice: null, tags: [], replyTo: target.id,
    authorIdentity: viewer.identity, authorSnapshot: publicUser(viewer),
    hearts: 0, claps: 0, featured: false, pending: false, reportCount: 0,
    createdAt: nowMs(), likers: [], clappers: [],
  };
  await insert('posts', post);
  return { post: await shapePost(post, viewer.identity) };
});

route('POST', '/api/posts/:id/favorite', async (params) => {
  const viewer = await currentIdentity();
  const post = await findById('posts', params.id);
  if (!post) throw new HttpError('内容不存在', 404);
  const hit = await findWhere('favorites', (f) => f.identity === viewer.identity && f.postId === post.id);
  if (hit) {
    await remove('favorites', hit.id);
    return { favorited: false };
  }
  await insert('favorites', { id: uid('fv'), identity: viewer.identity, postId: post.id, roomId: post.roomId, createdAt: nowMs() });
  return { favorited: true };
});

route('GET', '/api/me/favorites', async () => {
  const viewer = await currentIdentity();
  const favs = (await filter('favorites', (f) => f.identity === viewer.identity))
    .sort((a, b) => b.createdAt - a.createdAt);
  const list = [];
  for (const f of favs) {
    const p = await findById('posts', f.postId);
    if (p) list.push({ post: await shapePost(p, viewer.identity), at: f.createdAt });
  }
  return { list: list, total: list.length };
});

/* ---- 社交 ---- */
route('POST', '/api/users/:id/follow', async (params) => {
  const viewer = await currentIdentity();
  const target = await findById('users', params.id) || await findWhere('users', (u) => u.identity === params.id);
  if (!target) throw new HttpError('用户不存在', 404);
  if (target.identity === viewer.identity) throw new HttpError('不能关注自己', 400);
  const existing = await findWhere('follows', (f) => f.from === viewer.identity && f.to === target.identity);
  if (existing) {
    await remove('follows', existing.id);
    return { following: false, followers: await count('follows', (f) => f.to === target.identity) };
  }
  await insert('follows', {
    id: uid('fl'), from: viewer.identity, fromId: viewer.id,
    to: target.identity, toId: target.id, createdAt: nowMs(),
  });
  await notify(target.id, 'follow', viewer.nickname + ' 关注了你', {});
  return { following: true, followers: await count('follows', (f) => f.to === target.identity) };
});

route('POST', '/api/users/:id/block', async (params) => {
  const viewer = await currentIdentity();
  const target = await findById('users', params.id) || await findWhere('users', (u) => u.identity === params.id);
  if (!target) throw new HttpError('用户不存在', 404);
  if (target.identity === viewer.identity) throw new HttpError('不能屏蔽自己', 400);
  const existing = await findWhere('blocks', (b) => b.from === viewer.identity && b.to === target.identity);
  if (existing) {
    await remove('blocks', existing.id);
    return { blocked: false };
  }
  await insert('blocks', { id: uid('bk'), from: viewer.identity, to: target.identity, createdAt: nowMs() });
  return { blocked: true };
});

route('GET', '/api/users/:id/relation', async (params) => {
  const viewer = await currentIdentity();
  const target = await findById('users', params.id) || await findWhere('users', (u) => u.identity === params.id);
  if (!target) throw new HttpError('用户不存在', 404);
  return relation(viewer.identity, target.identity);
});

route('GET', '/api/users/:id/follows', async (params) => {
  const viewer = await currentIdentity();
  const list = (await filter('follows', (f) => f.from === viewer.identity))
    .map((f) => f.to)
    .filter((i) => !isSynthetic(i));
  const users = [];
  for (const identity of list) {
    const u = await findWhere('users', (x) => x.identity === identity);
    if (u) users.push(publicUser(u));
  }
  return { list: users, total: users.length };
});

route('GET', '/api/users/:id/fans', async (params) => {
  const viewer = await currentIdentity();
  const target = await findById('users', params.id) || await findWhere('users', (u) => u.identity === params.id);
  if (!target) throw new HttpError('用户不存在', 404);
  const list = (await filter('follows', (f) => f.to === target.identity))
    .map((f) => f.from)
    .filter((i) => !isSynthetic(i));
  const users = [];
  for (const identity of list) {
    const u = await findWhere('users', (x) => x.identity === identity);
    if (u) users.push(publicUser(u));
  }
  return { list: users, total: users.length };
});

route('GET', '/api/users/:id', async (params) => {
  const user = await findById('users', params.id) || await findWhere('users', (u) => u.identity === params.id);
  if (!user) throw new HttpError('用户不存在', 404);
  const viewer = await currentIdentity();
  const rooms = [];
  for (const r of await filter('rooms', (x) => x.ownerId === user.id && !isTestRoom(x))) {
    rooms.push(await shapeRoom(r, viewer.identity));
  }
  const posts = (await filter('posts', (p) => p.authorIdentity === user.identity))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const shaped = [];
  for (const p of posts) shaped.push(await shapePost(p, viewer.identity));
  const hearts = (await filter('posts', (p) => (p.likers || []).indexOf(user.identity) !== -1)).length;
  return {
    user: publicUser(user),
    rooms: rooms,
    posts: shaped,
    hearts: hearts,
    relation: await relation(viewer.identity, user.identity),
    favorites: await count('favorites', (f) => f.identity === user.identity),
  };
});

route('GET', '/api/feed', async () => {
  const viewer = await currentIdentity();
  const blocked = new Set((await filter('blocks', (b) => b.from === viewer.identity)).map((b) => b.to));
  const watched = new Set([viewer.identity]);
  for (const f of await filter('follows', (f) => f.from === viewer.identity)) watched.add(f.to);

  const items = [];
  for (const r of await coll('rooms')) {
    if (isTestRoom(r) || !r.ownerSnapshot) continue;
    const ownerId = r.ownerSnapshot.identity;
    if (blocked.has(ownerId)) continue;
    if (watched.has(ownerId)) {
      items.push({
        kind: 'room', id: r.id, roomId: r.id, actor: r.ownerSnapshot,
        at: r.createdAt, room: await shapeRoom(r, viewer.identity), text: r.title,
      });
    }
  }
  for (const p of await coll('posts')) {
    if (p.kind !== 'answer' || blocked.has(p.authorIdentity)) continue;
    if (watched.has(p.authorIdentity)) {
      items.push({
        kind: 'answer', id: p.id, roomId: p.roomId, actor: p.authorSnapshot,
        at: p.createdAt, post: await shapePost(p, viewer.identity), text: p.text,
      });
    }
  }
  items.sort((a, b) => b.at - a.at);
  return { list: items.slice(0, 40), total: Math.min(items.length, 40) };
});

route('GET', '/api/topics', async () => {
  const counts = {};
  for (const r of await coll('rooms')) {
    if (isTestRoom(r)) continue;
    (r.tags || []).forEach((t) => {
      if (!counts[t]) counts[t] = { tag: t, rooms: 0, questions: 0 };
      counts[t].rooms++;
    });
  }
  for (const p of await coll('posts')) {
    if (p.kind !== 'question') continue;
    (p.tags || []).forEach((t) => {
      if (!counts[t]) counts[t] = { tag: t, rooms: 0, questions: 0 };
      counts[t].questions++;
    });
  }
  return {
    list: Object.values(counts)
      .sort((a, b) => (b.rooms + b.questions) - (a.rooms + a.questions))
      .slice(0, 20)
      .map((x) => Object.assign(x, { total: x.rooms + x.questions })),
  };
});

route('GET', '/api/suggestions', async () => {
  const viewer = await currentIdentity();
  const watching = new Set((await filter('follows', (f) => f.from === viewer.identity)).map((f) => f.to));
  const blocked = new Set((await filter('blocks', (b) => b.from === viewer.identity)).map((b) => b.to));

  const scored = [];
  for (const u of await coll('users')) {
    if (u.identity === viewer.identity || watching.has(u.identity)) continue;
    if (blocked.has(u.identity) || isSynthetic(u.identity)) continue;
    const s = u.stats || {};
    const theirFollowers = (await filter('follows', (f) => f.to === u.identity)).map((f) => f.from);
    const mutual = theirFollowers.filter((f) => watching.has(f)).length;
    if (theirFollowers.length === 0 && !s.posts && !s.received) continue;
    const score = (s.rooms || 0) * 2 + (s.received || 0) * 0.6 + (s.hearts || 0) / 20 + mutual * 8 +
      (u.id || 'u_x').charCodeAt(2) % 7;
    scored.push({ user: publicUser(u), mutual: mutual, score: score });
  }
  return { list: scored.sort((a, b) => b.score - a.score).slice(0, 6) };
});

/* ---- 广场 / 统计 ---- */
route('GET', '/api/plaza', async () => {
  const viewer = await currentIdentity();
  const rooms = [];
  const roomIds = new Set();
  for (const r of await coll('rooms')) {
    if (isTestRoom(r)) continue;
    rooms.push(await shapeRoom(r, viewer.identity));
    roomIds.add(r.id);
  }
  const hotRooms = rooms.slice().sort((a, b) => {
    const sa = a.counts.questions * 3 + a.counts.answers * 2 + a.counts.hearts + a.counts.visits;
    const sb = b.counts.questions * 3 + b.counts.answers * 2 + b.counts.hearts + b.counts.visits;
    return sb - sa;
  }).slice(0, 8);

  const pool = (await filter('posts', (p) => !p.pending && roomIds.has(p.roomId)))
    .sort((a, b) => ((b.hearts || 0) + (b.claps || 0)) - ((a.hearts || 0) + (a.claps || 0)))
    .slice(0, 10);
  const hotPosts = [];
  for (const p of pool) hotPosts.push(await shapePost(p, viewer.identity));

  return { hotRooms: hotRooms, hotPosts: hotPosts, topTags: [], online: await count('meta') };
});

route('GET', '/api/stats', async () => {
  const now = nowMs();
  const buckets = [];
  const posts = await coll('posts');
  const visits = await coll('visits');
  for (let i = 23; i >= 0; i--) {
    const end = now - i * 3600000;
    const start = end - 3600000;
    buckets.push({
      hour: new Date(end).getHours(),
      posts: posts.filter((p) => p.createdAt >= start && p.createdAt < end).length,
      visits: visits.filter((v) => v.createdAt >= start && v.createdAt < end).length,
    });
  }
  return {
    online: 1,
    buckets: buckets,
    totals: {
      rooms: await count('rooms'),
      posts: posts.length,
      users: await count('users'),
      hearts: posts.reduce((s, p) => s + (p.hearts || 0), 0),
    },
  };
});

route('GET', '/api/rooms/:id/visits', async (params) => {
  const list = (await filter('visits', (v) => v.roomId === params.id))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  return {
    list: list.map((v) => ({ id: v.id, name: v.visitorName, avatar: avatarFor(v.visitorId), at: v.createdAt })),
    total: list.length,
  };
});

/* ---- 通知 ---- */
route('GET', '/api/messages', async () => {
  const viewer = await currentIdentity();
  const list = (await filter('messages', (m) => m.userId === viewer.id))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  return { list: list, unread: list.filter((m) => !m.read).length };
});

route('POST', '/api/messages/read', async () => {
  const viewer = await currentIdentity();
  const rows = await coll('messages');
  let changed = false;
  for (const m of rows) {
    if (m.userId === viewer.id && !m.read) { m.read = true; changed = true; }
  }
  if (changed) await persist('messages');
  return { done: true };
});

/* ---- 举报 ---- */
route('POST', '/api/reports', async (params, body) => {
  const post = await findById('posts', body.postId);
  if (!post) throw new HttpError('内容不存在', 404);
  await insert('reports', {
    id: uid('rp'), postId: post.id, roomId: post.roomId,
    reason: String(body.reason || '其他').slice(0, 50),
    detail: String(body.detail || '').slice(0, 200),
    status: 'pending', createdAt: nowMs(),
  });
  await update('posts', post.id, { reportCount: (post.reportCount || 0) + 1 });
  return { done: true };
});

route('GET', '/api/reports', async () => {
  const list = (await filter('reports', (r) => r.status === 'pending'))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { list: list, total: list.length };
});

route('POST', '/api/reports/:id/resolve', async (params, body) => {
  const report = await findById('reports', params.id);
  if (!report) throw new HttpError('举报不存在', 404);
  await update('reports', report.id, { status: body.action === 'remove' ? 'removed' : 'dismissed' });
  if (body.action === 'remove') await remove('posts', report.postId);
  return { done: true };
});

/* ---- 草稿 ---- */
route('GET', '/api/drafts', async () => {
  const viewer = await currentIdentity();
  return { list: await filter('drafts', (d) => d.identity === viewer.identity) };
});

route('PUT', '/api/drafts', async (params, body) => {
  const viewer = await currentIdentity();
  const existing = await findWhere('drafts', (d) => d.identity === viewer.identity && d.roomId === body.roomId);
  if (existing) {
    existing.text = String(body.text || '').slice(0, 300);
    existing.updatedAt = nowMs();
    await persist('drafts');
  } else {
    await insert('drafts', {
      id: uid('df'), identity: viewer.identity, roomId: body.roomId,
      text: String(body.text || '').slice(0, 300), createdAt: nowMs(), updatedAt: nowMs(),
    });
  }
  return { saved: true };
});

/* ---- 数据导出 ---- */
route('GET', '/api/export', async () => {
  const viewer = await currentIdentity();
  return {
    exportedAt: nowMs(),
    user: publicUser(viewer),
    rooms: await filter('rooms', (r) => r.ownerId === viewer.id),
    posts: await filter('posts', (p) => p.authorIdentity === viewer.identity),
    favorites: await filter('favorites', (f) => f.identity === viewer.identity),
    follows: await filter('follows', (f) => f.from === viewer.identity),
  };
});

/** 清空本机数据（设置里的「清除缓存」） */
route('POST', '/api/data/reset', async () => {
  for (const s of STORES) {
    cache[s] = [];
    await persist(s);
  }
  return { done: true };
});

/* ============ 分发 ============ */

function matchRoute(method, pathname) {
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const exact = routes[method + ' ' + pathname];
  if (exact) return { handler: exact, params: {} };
  for (const key of Object.keys(routes)) {
    const idx = key.indexOf(' ');
    if (key.slice(0, idx) !== method) continue;
    const ps = key.slice(idx + 1).replace(/^\/+/, '').split('/').filter(Boolean);
    if (ps.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].charAt(0) === ':') params[ps[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (ps[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[key], params: params };
  }
  return null;
}

/**
 * 发起一次「本地请求」。
 * 与 api.js 里 fetch 版本返回同样的 { ok, data } / { ok, message }。
 */
async function localRequest(method, path, body) {
  const [pathname, queryString] = path.split('?');
  const query = {};
  if (queryString) {
    queryString.split('&').forEach((kv) => {
      const [k, v] = kv.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
  }
  const hit = matchRoute(method, pathname);
  if (!hit) return { ok: false, message: '接口不存在', status: 404 };
  try {
    const data = await hit.handler(hit.params, body || {}, query);
    return { ok: true, data: data };
  } catch (err) {
    return {
      ok: false,
      message: err.message || '请求失败',
      status: err.status || 400,
    };
  }
}

/* ============ 首次运行的种子数据 ============ */

async function seedIfEmpty() {
  const rooms = await coll('rooms');
  if (rooms.length) return;

  const demo = await ensureUser('local:demo', '小满');
  demo.bio = '把想问的话都攒起来，一次问完。';
  demo.stats = { rooms: 3, posts: 42, received: 118, hearts: 640 };
  await persist('users');

  const cast = [
    { key: 'demo2', name: '阿泽', bio: '不问工作，只问心情。' },
    { key: 'demo3', name: '林一', bio: '毕业两年，还在找方向。' },
    { key: 'demo4', name: '陈默', bio: '想说什么都可以，我接着。' },
  ];
  for (const p of cast) {
    const u = await ensureUser('local:' + p.key, p.name);
    u.bio = p.bio;
    u.stats = { rooms: 1, posts: 12, received: 60, hearts: 240 };
  }
  await persist('users');

  // 建立关注关系，让动态流与推荐不为空
  const people = [];
  for (const p of cast) people.push(await findWhere('users', (u) => u.identity === 'local:' + p.key));
  for (let i = 0; i < people.length; i++) {
    if (i % 2 === 0) {
      await insert('follows', {
        id: uid('fl'), from: people[i].identity, fromId: people[i].id,
        to: demo.identity, toId: demo.id, createdAt: nowMs() - (i + 1) * DAY,
      });
    }
    if (i < 2) {
      await insert('follows', {
        id: uid('fl'), from: demo.identity, fromId: demo.id,
        to: people[i].identity, toId: people[i].id, createdAt: nowMs() - (i + 2) * DAY,
      });
    }
  }

  const presets = [
    {
      owner: demo, title: '小满的坦白局', subtitle: '关于生活的 20 个问题',
      tags: ['生活', '成长'], theme: 'yellow',
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
        '后悔高三那年为了面子选了文科，其实我真正想读的是建筑。',
        '有。误会了三年才说开，这件事教会我别把猜测当答案。',
        '想带走我那台用了八年的笔记本，它存着我所有的日记。',
        '羡慕那个敢当场拒绝领导的人，而我只会等散会再难受。',
      ],
    },
    {
      owner: people[0], title: '阿泽の树洞', subtitle: '不问工作，只问心情',
      tags: ['情绪', '树洞'], theme: 'mint',
      questions: [
        '最近让你半夜睡不着的是什么？',
        '你有没有一句一直想对某人说但没说出口的话？',
        '现在的日子和你二十五岁时的想象差多少？',
        '你觉得自己在变好还是变坏？',
        '什么是你现在最不敢面对的事？',
      ],
      answers: [
        '是我爸体检报告上那个箭头。他自己不查，我不敢问。',
        '差很远，但我不再为此道歉了。',
        '在变好。至少我现在能承认自己需要休息。',
      ],
    },
    {
      owner: people[1], title: '毕业季大调查', subtitle: '关于未来的 15 问',
      tags: ['未来', '校园'], theme: 'lilac',
      questions: [
        '你毕业后第一份工作想做什么？',
        '你更想要稳定还是更想要自由？',
        '你理想中的生活一天是怎么过的？',
        '如果只能带一样东西去陌生城市，你带什么？',
        '你觉得三十岁的自己会后悔现在的选择吗？',
      ],
      answers: [
        '想去一家不需要开会的公司，做产品。',
        '稳定。但我要那种我自己选的稳定。',
      ],
    },
  ];

  for (const preset of presets) {
    const owner = preset.owner;
    const room = {
      id: uid('r'),
      code: Math.random().toString(36).slice(2, 8),
      ownerId: owner.id,
      ownerSnapshot: publicUser(owner),
      title: preset.title,
      subtitle: preset.subtitle,
      slogan: '今天一人问一个问题，我全部如实回答',
      avatar: owner.avatar,
      theme: preset.theme,
      tags: preset.tags,
      rules: { onePerGuest: true, requireLogin: false, allowVoice: true, reviewFirst: false },
      pinned: false,
      createdAt: nowMs() - Math.random() * 3 * 3600000,
      deadline: nowMs() + DAY,
      closed: false,
    };
    await insert('rooms', room);

    preset.questions.forEach((text, qi) => {
      const asker = 'seed:asker:' + room.id + ':' + qi;
      insert('posts', {
        id: uid('p'), roomId: room.id, kind: 'question', text: text,
        voice: null, tags: [], replyTo: null,
        authorIdentity: asker,
        authorSnapshot: { id: 'seed', nickname: '匿名访客', avatar: avatarFor(asker), bio: '', identity: 'guest', verified: false, stats: { rooms: 0, posts: 0, received: 0, hearts: 0 }, createdAt: nowMs() },
        hearts: 12 + qi * 7, claps: 3 + qi * 2,
        featured: qi === 0 && preset.title === '小满的坦白局',
        pending: false, answered: qi < preset.answers.length, reportCount: 0,
        createdAt: room.createdAt + (qi + 1) * 600000,
        likers: [], clappers: [],
      });
    });

    preset.answers.forEach((text, ai) => {
      insert('posts', {
        id: uid('p'), roomId: room.id, kind: 'answer', text: text,
        voice: null, tags: [], replyTo: null,
        authorIdentity: owner.identity,
        authorSnapshot: publicUser(owner),
        hearts: 40 + ai * 18, claps: 4 + ai * 3,
        featured: false, pending: false, reportCount: 0,
        createdAt: room.createdAt + (ai + 1) * 900000,
        likers: [], clappers: [],
      });
    });
  }
  await Promise.all([persist('posts'), persist('rooms')]);
}

window.LocalData = {
  localRequest: localRequest,
  seedIfEmpty: seedIfEmpty,
  clearAll: async () => {
    for (const s of STORES) { cache[s] = []; await persist(s); }
  },
  _resetCache: () => { for (const k of Object.keys(cache)) delete cache[k]; },
};

})();

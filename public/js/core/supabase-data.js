/**
 * Supabase 数据层 —— 让多台设备、不同访客真正共享数据。
 *
 * 整个文件包在 IIFE 里，避免顶层 const 泄漏到全局作用域
 * 与其他 classic script 冲突（曾因 const routes 重名导致整站白屏）。
 */
(function () {
/**
 * Supabase 数据层 —— 让多台设备、不同访客真正共享数据。
 *
 * 三种存储后端，同一套接口：
 *   1. supabase有网络 → Supabase（多人共享，推荐部署用）
 *   2. 本地有后端     → fetch 到 server.js（本地开发联调用）
 *   3. 离线兜底       → IndexedDB（断网也能用）
 *
 * 上层 api.js 只调用本模块暴露的方法，不关心底层是哪一种。
 */

const SB_URL = 'https://crscsipvlytlfjycnptn.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNyc2NzaXB2bHl0bGZqeWNucHRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzNDU1MzIsImV4cCI6MjEwNjkyMTUzMn0.wHFWmnUoxAJYu-mNIwkxTu5tivC5qpxOLEsGA0mX6M';

/* ============ 网络请求 ============ */

async function sbFetch(path, options) {
  const opts = options || {};
  const headers = {
    apikey: SB_ANON,
    Authorization: 'Bearer ' + SB_ANON,
    'Content-Type': 'application/json',
  };
  if (opts.headers) Object.assign(headers, opts.headers);

  const res = await fetch(SB_URL + '/rest/v1/' + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.hint)) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return json;
}

/* ============ 后端探测 ============ */

const state = { backend: null, probedAt: 0 };

/**
 * 决定用哪个后端。优先级：Supabase > 本地服务端> 纯本地。
 * 每30 秒重新探测一次，便于开发时切换。
 */
async function resolveBackend() {
  // 强制指定，便于调试与测试：
  //   ?backend=local / ?backend=supabase / ?backend=server
  //   window.__forceBackend 由测试注入（vm 沙箱里没有真实网络环境）
  const forced = (typeof window !== 'undefined' && window.__forceBackend) ||
    new URLSearchParams(location.search).get('backend');
  if (forced === 'local') return 'local';
  if (forced === 'supabase') return 'supabase';
  if (forced === 'server') return 'server';

  if (state.backend && Date.now() - state.probedAt < 30000) return state.backend;

  // 先看本地服务端是否在跑（开发时用）。
  // 只要能拿到 JSON 应答就算通 —— 未登录(401)也是服务端正常的应答。
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    let res;
    try {
      res = await fetch('/api/health', {
        method: 'GET',
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res && res.ok) {
      state.backend = 'server';
      state.probedAt = Date.now();
      return 'server';
    }
    // 拿到了应答但不是 2xx，说明服务端在、只是这个接口有问题，仍算可用
    if (res && res.status < 600) {
      state.backend = 'server';
      state.probedAt = Date.now();
      return 'server';
    }
  } catch (_) { /* 没有后端，继续 */ }

  // 再试 Supabase。
  // 必须用真实的 anon key 发一次请求来判断可达性：
  // sbFetch 失败会抛错（含 401 Invalid API key、表未建等），那说明这条路走不通，
  // 必须退回本地，否则整站会因所有请求失败而空白。
  try {
    await sbFetch('users?select=id&limit=1');
    state.backend = 'supabase';
    state.probedAt = Date.now();
    return 'supabase';
  } catch (err) {
    console.warn('[data] Supabase 不可用，改用本地存储：' + err.message);
    state.lastSupabaseError = err.message;
  }

  state.backend = 'local';
  state.probedAt = Date.now();
  return 'local';
}

/* ============ 本地兜底（复用 local-data.js） ============ */

async function viaLocal(method, path, body) {
  const r = await window.LocalData.localRequest(method, path, body || {});
  if (!r.ok) throw new Error(r.message || '请求失败');
  return r.data;
}

/**
 * 传输层错误 = 后端真的连不上（网络中断、5xx、响应不是 JSON）。
 * 业务错误（401 未登录 / 400 参数不对）不是传输问题，要原样交给上层处理。
 */
function isTransportError(err) {
  if (!err) return false;
  if (err.transport) return true;
  const m = String(err.message || '');
  return /Failed to fetch|NetworkError|load failed|网络连接失败|服务无响应|Unexpected token/i.test(m);
}

async function viaServer(method, path, body) {
  const headers = { 'x-device-id': deviceId() };
  const hasBody = body !== undefined && body !== null;
  if (hasBody) headers['Content-Type'] = 'application/json';

  // GET / HEAD 不能带 body，浏览器会直接抛错。
  // 所有 api.xxx() 都传了 body||{}，这里必须按方法判断是否真的发送。
  const sendBody = hasBody && method !== 'GET' && method !== 'HEAD';

  let res;
  try {
    res = await fetch(path, {
      method: method,
      headers: headers,
      credentials: 'same-origin',
      body: sendBody ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const e = new Error('Failed to fetch');
    e.transport = true;
    throw e;
  }

  let payload;
  try {
    payload = await res.json();
  } catch (_) {
    const e = new Error('服务无响应');
    e.transport = true;
    throw e;
  }

  // 后端正常应答（哪怕是 4xx）——统一转成 { ok, data } 交给上层，
  // 上层 api.js 会把 !ok 抛成 ApiError，页面据此提示或回退。
  if (!res.ok || !payload.ok) {
    return {
      ok: false,
      message: payload.message || '请求失败',
      status: res.status || 400,
    };
  }
  return { ok: true, data: payload.data };
}

function deviceId() {
  try {
    let d = localStorage.getItem('tb_device');
    if (!d) {
      d = 'd' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('tb_device', d);
    }
    return d;
  } catch (_) {
    return 'd' + Math.random().toString(36).slice(2, 12);
  }
}

/* ============ 身份 ============ */

const ME_KEY = 'tb_me';

function cachedMe() {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function cacheMe(user) {
  try {
    if (user) localStorage.setItem(ME_KEY, JSON.stringify(user));
    else localStorage.removeItem(ME_KEY);
  } catch (_) { /* ignore */ }
}

async function sbMe() {
  const rows = await sbFetch('users?select=*&eq=identity,eq.' + encodeURIComponent(deviceIdentity()) + '&limit=1');
  if (rows && rows.length) return rows[0];
  const created = await sbFetch('users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [rowForNewUser('匿名访客', 'guest:' + deviceIdentity())],
  });
  return (created && created[0]) || rowForNewUser('匿名访客', 'guest:' + deviceIdentity());
}

/** 本机稳定身份，用于区分设备 */
function deviceIdentity() {
  return 'guest:' + deviceId();
}

function publicUser(u) {
  if (!u) return null;
  const stats = typeof u.stats === 'object' && u.stats ? u.stats : {};
  return {
    id: u.id,
    nickname: u.nickname,
    avatar: typeof u.avatar === 'object' && u.avatar ? u.avatar : { type: 'ring', hue: 210, text: '匿' },
    bio: u.bio || '',
    identity: u.identity,
    verified: !!u.verified,
    stats: {
      rooms: stats.rooms || 0,
      posts: stats.posts || 0,
      received: stats.received || 0,
      hearts: stats.hearts || 0,
    },
    createdAt: u.created_at,
  };
}

function rowForNewUser(nickname, identity) {
  let h = 0;
  const s = String(nickname || identity);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return {
    id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    identity: identity,
    nickname: nickname,
    avatar: { type: 'ring', hue: h % 360, text: s.slice(0, 1).toUpperCase() || '匿' },
    bio: '',
    stats: { rooms: 0, posts: 0, received: 0, hearts: 0 },
    verified: false,
    created_at: Date.now(),
  };
}

async function currentUser() {
  const backend = await resolveBackend();
  if (backend === 'server') {
    try { return await viaServer('GET', '/api/auth/me'); } catch (_) { /* 落到本地 */ }
  }
  if (backend === 'supabase') {
    try {
      const row = await sbMe();
      return publicUser(row);
    } catch (_) { /* 落到本地 */ }
  }
  return viaLocal('GET', '/api/auth/me');
}

/* ============ 通用查询辅助 ============ */

const TABLES = {
  users: 'users', rooms: 'rooms', posts: 'posts', messages: 'messages',
  follows: 'follows', blocks: 'blocks', favorites: 'favorites',
  visits: 'visits', events: 'events', drafts: 'drafts', reports: 'reports',
};

function snake(key) {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function camel(str) {
  return str.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
}

function toSnakeRow(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => { out[snake(k)] = obj[k]; });
  return out;
}

function toCamelRow(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => { out[camel(k)] = obj[k]; });
  return out;
}

async function selectAll(table, query, order) {
  let q = table + '?select=*';
  if (query) q += '&' + query;
  if (order) q += '&order=' + order;
  const rows = await sbFetch(q);
  return (rows || []).map(toCamelRow);
}

async function insertRow(table, row) {
  const r = await sbFetch(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [toSnakeRow(row)],
  });
  return toCamelRow((r && r[0]) || row);
}

async function patchRow(table, id, patch) {
  const r = await sbFetch(table + '?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: toSnakeRow(patch),
  });
  return toCamelRow((r && r[0]) || {});
}

async function deleteRow(table, id) {
  await sbFetch(table + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
  return true;
}

/* ============ 路由：与 server.js 同构 ============ */

const R = {};
function on(method, path, fn) { R[method + ' ' + path] = fn; }

/* ---- 登录 ---- */
on('POST', '/api/auth/login-local', async (params, body) => {
  const nickname = String(body.nickname || '').trim() || '匿名访客';
  const identity = 'local:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const row = rowForNewUser(nickname, identity);
  row.bio = String(body.bio || '').slice(0, 60);
  const created = await insertRow('users', row);
  const user = publicUser(created);
  cacheMe(user);
  return { token: identity, user: user };
});

on('POST', '/api/auth/guest', async () => {
  const identity = 'guest:' + Math.random().toString(36).slice(2, 10);
  const created = await insertRow('users', rowForNewUser('匿名访客', identity));
  const user = publicUser(created);
  cacheMe(user);
  return { token: identity, user: user };
});

on('GET', '/api/auth/me', async () => currentUser());

on('PATCH', '/api/auth/profile', async (params, body) => {
  const me = await currentUser();
  const patch = {};
  if (body.nickname !== undefined) patch.nickname = String(body.nickname).slice(0, 16) || me.nickname;
  if (body.bio !== undefined) patch.bio = String(body.bio).slice(0, 60);
  const updated = await patchRow('users', me.id, patch);
  const user = publicUser(Object.assign({}, me, updated));
  cacheMe(user);
  return user;
});

on('POST', '/api/auth/logout', async () => {
  cacheMe(null);
  return { done: true };
});

/* ---- 坦白局 ---- */
on('GET', '/api/rooms', async (params, body, query) => {
  const me = await currentUser();
  let rooms = await selectAll('rooms', null, 'created_at.desc');
  rooms = rooms.filter((r) => !/测试|验证|改名后/.test(r.title || ''));
  rooms.sort((a, b) => (a.pinned === b.pinned ? b.createdAt - a.createdAt : (b.pinned ? 1 : -1)));
  if (query.tag) rooms = rooms.filter((r) => (r.tags || []).indexOf(query.tag) !== -1);

  const posts = await selectAll('posts');
  const visits = await selectAll('visits');
  const list = rooms.map((r) => shapeRoomFast(r, posts, visits, me.identity));
  return { list: list, total: list.length };
});

function shapeRoomFast(room, allPosts, allVisits, viewerIdentity) {
  const posts = allPosts.filter((p) => p.roomId === room.id);
  const questions = posts.filter((p) => p.kind === 'question');
  const answers = posts.filter((p) => p.kind === 'answer');
  const expired = room.deadline && Date.now() > room.deadline;
  return {
    id: room.id,
    code: room.code,
    ownerId: room.ownerId,
    owner: room.ownerSnapshot || { id: room.ownerId, nickname: '发起者', avatar: { type: 'ring', hue: 200, text: '匿' }, stats: {} },
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
      visits: allVisits.filter((v) => v.roomId === room.id).length,
    },
    hasAnswered: posts.some((p) => p.kind === 'answer' && p.authorIdentity === viewerIdentity),
  };
}

on('POST', '/api/rooms', async (params, body) => {
  const me = await currentUser();
  const title = String(body.title || '').trim();
  if (title.length < 2) throw new Error('给这场坦白局起个名字吧');
  if (title.length > 30) throw new Error('名字请控制在 30 字以内');

  const days = Math.min(Math.max(Number(body.days) || 1, 1), 30);
  const room = {
    id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    code: Math.random().toString(36).slice(2, 8),
    ownerId: me.id,
    ownerSnapshot: me,
    title: title,
    subtitle: String(body.subtitle || '').slice(0, 60),
    slogan: String(body.slogan || '').slice(0, 40) || '今天一人问一个问题，我全部如实回答',
    avatar: me.avatar,
    theme: body.theme || 'yellow',
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 4) : [],
    rules: {
      onePerGuest: body.rules && body.rules.onePerGuest !== undefined ? !!body.rules.onePerGuest : true,
      requireLogin: false,
      allowVoice: body.rules && body.rules.allowVoice !== undefined ? !!body.rules.allowVoice : true,
      reviewFirst: !!(body.rules && body.rules.reviewFirst),
    },
    pinned: false,
    createdAt: Date.now(),
    deadline: Date.now() + days * 86400000,
    closed: false,
  };
  const created = await insertRow('rooms', room);
  return shapeRoomFast(created, [], [], me.identity);
});

on('GET', '/api/rooms/:id', async (params) => {
  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(params.id));
  let room = rooms[0];
  if (!room) {
    const byCode = await selectAll('rooms', 'code=eq.' + encodeURIComponent(params.id));
    room = byCode[0];
  }
  if (!room) throw new Error('这场坦白局不存在或已删除');
  const me = await currentUser();
  await insertRow('visits', {
    id: 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    roomId: room.id,
    visitorId: me.identity,
    visitorName: me.nickname,
    createdAt: Date.now(),
  });
  const posts = await selectAll('posts', 'room_id=eq.' + encodeURIComponent(room.id), 'created_at');
  const visits = await selectAll('visits', 'room_id=eq.' + encodeURIComponent(room.id));
  const shaped = shapeRoomFast(room, posts, visits, me.identity);
  shaped.visitor = me;
  return shaped;
});

on('PATCH', '/api/rooms/:id', async (params, body) => {
  const me = await currentUser();
  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(params.id));
  const room = rooms[0];
  if (!room) throw new Error('不存在');
  if (me.id !== room.ownerId) throw new Error('只有发起者能修改');
  const patch = {};
  if (body.title) patch.title = String(body.title).slice(0, 30);
  if (body.slogan !== undefined) patch.slogan = String(body.slogan).slice(0, 40);
  if (body.subtitle !== undefined) patch.subtitle = String(body.subtitle).slice(0, 60);
  if (body.tags) patch.tags = body.tags.slice(0, 4);
  if (body.rules) patch.rules = Object.assign({}, room.rules, body.rules);
  if (body.theme) patch.theme = body.theme;
  if (body.closed !== undefined) patch.closed = !!body.closed;
  await patchRow('rooms', room.id, patch);
  const updated = await selectAll('rooms', 'id=eq.' + encodeURIComponent(room.id));
  return shapeRoomFast(updated[0] || room, [], [], me.identity);
});

on('GET', '/api/rooms/:id/posts', async (params, body, query) => {
  const me = await currentUser();
  let list = await selectAll('posts', 'room_id=eq.' + encodeURIComponent(params.id) + '&pending=eq.false', 'created_at');
  if (query.kind) list = list.filter((p) => p.kind === query.kind);
  if (query.filter === 'featured') list = list.filter((p) => p.featured);
  if (query.filter === 'unanswered') list = list.filter((p) => p.kind === 'question' && !p.answered);
  if (query.filter === 'mine') list = list.filter((p) => p.authorIdentity === me.identity);
  list.sort((a, b) => (a.featured === b.featured ? a.createdAt - b.createdAt : (a.featured ? -1 : 1)));
  const favs = await selectAll('favorites', 'identity=eq.' + encodeURIComponent(me.identity));
  const favIds = new Set(favs.map((f) => f.postId));
  return {
    list: list.map((p) => shapePostFast(p, me.identity, favIds)),
    total: list.length,
  };
});

function shapePostFast(post, viewerIdentity, favIds) {
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
    favorited: favIds ? favIds.has(post.id) : false,
    mentions: post.mentions || [],
  };
}

/* ---- 内容 ---- */
on('POST', '/api/rooms/:id/posts', async (params, body) => {
  const me = await currentUser();
  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(params.id));
  const room = rooms[0];
  if (!room) throw new Error('这场坦白局不存在');
  if (room.closed) throw new Error('这场坦白局已关闭');
  if (room.deadline && Date.now() > room.deadline) throw new Error('本场坦白局已到期，只能浏览');

  const kind = body.kind === 'answer' ? 'answer' : 'question';
  const text = String(body.text || '').trim();
  if (!text && !body.voice) throw new Error('说点什么吧');
  if (text.length > 300) throw new Error('内容请控制在 300 字以内');

  if (kind === 'question' && room.rules && room.rules.onePerGuest) {
    const mine = await selectAll('posts',
      'room_id=eq.' + encodeURIComponent(room.id) + '&kind=eq.question&author_identity=eq.' + encodeURIComponent(me.identity));
    if (mine.length >= 1) throw new Error('每人只能问一个问题哦，明天再来吧');
  }

  const post = {
    id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    roomId: room.id,
    kind: kind,
    text: text,
    voice: body.voice || null,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 3) : [],
    replyTo: body.replyTo || null,
    authorIdentity: me.identity,
    authorSnapshot: me,
    hearts: 0, claps: 0, likers: [], clappers: [],
    featured: false,
    pending: !!(room.rules && room.rules.reviewFirst),
    answered: false, reportCount: 0,
    createdAt: Date.now(),
  };
  const created = await insertRow('posts', post);

  // @提及
  const mentions = await resolveMentions(text);
  if (mentions.length) {
    await patchRow('posts', created.id, { mentions: mentions.map((u) => u.nickname) });
    for (const u of mentions) {
      if (u.identity === me.identity) continue;
      await insertRow('messages', {
        id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        userId: u.id, type: 'mention',
        text: me.nickname + ' 在坦白局里提到了你',
        roomId: room.id, postId: created.id, read: false, createdAt: Date.now(),
      });
    }
  }
  return { post: shapePostFast(created, me.identity), masked: null, mentioned: mentions.map((u) => u.nickname) };
});

async function resolveMentions(text) {
  const re = /@([^\s@，,。.!！?？:：;；]{1,16})/g;
  const names = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) names.push(m[1]);
  if (!names.length) return [];
  const all = await selectAll('users');
  return names.map((n) => all.filter((u) => u.nickname === n)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]).filter(Boolean);
}

on('POST', '/api/posts/:id/answer', async (params, body) => {
  const me = await currentUser();
  const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(params.id));
  const question = rows[0];
  if (!question || question.kind !== 'question') throw new Error('问题不存在');
  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(question.roomId));
  const room = rooms[0];
  if (!room || me.id !== room.ownerId) throw new Error('只有发起者可以回答');

  const text = String(body.text || '').trim();
  if (!text && !body.voice) throw new Error('写点什么再回答吧');

  const answer = await insertRow('posts', {
    id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    roomId: room.id, kind: 'answer', text: text,
    voice: body.voice || null, tags: [], replyTo: question.id,
    authorIdentity: me.identity, authorSnapshot: me,
    hearts: 0, claps: 0, likers: [], clappers: [],
    featured: false, pending: false, answered: false, reportCount: 0,
    createdAt: Date.now(),
  });
  await patchRow('posts', question.id, { answered: true });

  const askers = await selectAll('users', 'identity=eq.' + encodeURIComponent(question.authorIdentity));
  if (askers[0]) {
    await insertRow('messages', {
      id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      userId: askers[0].id, type: 'answered',
      text: (room.ownerSnapshot && room.ownerSnapshot.nickname || '发起者') + ' 回答了你的问题',
      roomId: room.id, postId: question.id, read: false, createdAt: Date.now(),
    });
    const st = askers[0].stats || {};
    await patchRow('users', askers[0].id, { stats: Object.assign({}, st, { received: (st.received || 0) + 1 }) });
  }
  return { answer: shapePostFast(answer, me.identity) };
});

on('POST', '/api/posts/:id/react', async (params, body) => {
  const me = await currentUser();
  const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(params.id));
  const post = rows[0];
  if (!post) throw new Error('内容不存在');

  const type = body.type === 'clap' ? 'clap' : 'heart';
  const key = type === 'clap' ? 'clappers' : 'likers';
  const arr = post[key] || [];
  const i = arr.indexOf(me.identity);
  const next = i === -1 ? arr.concat([me.identity]) : arr.filter((x) => x !== me.identity);

  const hearts = Math.max(0, (post.hearts || 0) + (i === -1 && type === 'heart' ? 1 : 0) + (i !== -1 && type === 'heart' ? -1 : 0));
  const claps = Math.max(0, (post.claps || 0) + (i === -1 && type === 'clap' ? 1 : 0) + (i !== -1 && type === 'clap' ? -1 : 0));

  const patch = { hearts: hearts, claps: claps };
  patch[key] = next;
  await patchRow('posts', post.id, patch);

  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(post.roomId));
  if (i === -1 && rooms[0]) {
    await insertRow('events', {
      id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      roomId: post.roomId, type: type, visitorId: me.identity, createdAt: Date.now(),
    });
  }
  return { hearts: hearts, claps: claps, reacted: i === -1 };
});

on('POST', '/api/posts/:id/feature', async (params) => {
  const me = await currentUser();
  const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(params.id));
  const post = rows[0];
  if (!post) throw new Error('内容不存在');
  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(post.roomId));
  if (!rooms[0] || me.id !== rooms[0].ownerId) throw new Error('只有发起者能精选');
  const next = !post.featured;
  await patchRow('posts', post.id, { featured: next });
  return { featured: next };
});

on('DELETE', '/api/posts/:id', async (params) => {
  const me = await currentUser();
  const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(params.id));
  const post = rows[0];
  if (!post) throw new Error('内容不存在');
  const rooms = await selectAll('rooms', 'id=eq.' + encodeURIComponent(post.roomId));
  const isHost = rooms[0] && me.id === rooms[0].ownerId;
  if (!isHost && post.authorIdentity !== me.identity) throw new Error('没有权限删除');
  await deleteRow('posts', post.id);
  return { done: true };
});

on('POST', '/api/posts/:id/followup', async (params, body) => {
  const me = await currentUser();
  const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(params.id));
  const target = rows[0];
  if (!target) throw new Error('内容不存在');
  const text = String(body.text || '').trim();
  if (!text) throw new Error('追问不能为空');
  if (text.length > 200) throw new Error('追问请控制在 200 字以内');

  const created = await insertRow('posts', {
    id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    roomId: target.roomId, kind: 'question', text: text,
    voice: null, tags: [], replyTo: target.id,
    authorIdentity: me.identity, authorSnapshot: me,
    hearts: 0, claps: 0, likers: [], clappers: [],
    featured: false, pending: false, answered: false, reportCount: 0,
    createdAt: Date.now(),
  });
  return { post: shapePostFast(created, me.identity) };
});

on('POST', '/api/posts/:id/favorite', async (params) => {
  const me = await currentUser();
  const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(params.id));
  if (!rows[0]) throw new Error('内容不存在');
  const favs = await selectAll('favorites',
    'identity=eq.' + encodeURIComponent(me.identity) + '&post_id=eq.' + encodeURIComponent(params.id));
  if (favs.length) {
    await deleteRow('favorites', favs[0].id);
    return { favorited: false };
  }
  await insertRow('favorites', {
    id: 'fv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    identity: me.identity, postId: params.id, roomId: rows[0].roomId, createdAt: Date.now(),
  });
  return { favorited: true };
});

on('GET', '/api/me/favorites', async () => {
  const me = await currentUser();
  const favs = (await selectAll('favorites', 'identity=eq.' + encodeURIComponent(me.identity), 'created_at.desc'));
  const list = [];
  for (const f of favs) {
    const rows = await selectAll('posts', 'id=eq.' + encodeURIComponent(f.postId));
    if (rows[0]) list.push({ post: shapePostFast(rows[0], me.identity), at: f.createdAt });
  }
  return { list: list, total: list.length };
});

/* ---- 社交 ---- */
on('POST', '/api/users/:id/follow', async (params) => {
  const me = await currentUser();
  const target = (await selectAll('users', 'id=eq.' + encodeURIComponent(params.id)))[0];
  if (!target) throw new Error('用户不存在');
  if (target.identity === me.identity) throw new Error('不能关注自己');

  const existing = await selectAll('follows',
    'from_identity=eq.' + encodeURIComponent(me.identity) + '&to_identity=eq.' + encodeURIComponent(target.identity));
  if (existing.length) {
    await deleteRow('follows', existing[0].id);
    const left = await selectAll('follows', 'to_identity=eq.' + encodeURIComponent(target.identity));
    return { following: false, followers: left.length };
  }
  await insertRow('follows', {
    id: 'fl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fromIdentity: me.identity, fromId: me.id,
    toIdentity: target.identity, toId: target.id,
    createdAt: Date.now(),
  });
  await insertRow('messages', {
    id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userId: target.id, type: 'follow',
    text: me.nickname + ' 关注了你',
    roomId: null, postId: null, read: false, createdAt: Date.now(),
  });
  const now = await selectAll('follows', 'to_identity=eq.' + encodeURIComponent(target.identity));
  return { following: true, followers: now.length };
});

on('POST', '/api/users/:id/block', async (params) => {
  const me = await currentUser();
  const target = (await selectAll('users', 'id=eq.' + encodeURIComponent(params.id)))[0];
  if (!target) throw new Error('用户不存在');
  if (target.identity === me.identity) throw new Error('不能屏蔽自己');

  const existing = await selectAll('blocks',
    'from_identity=eq.' + encodeURIComponent(me.identity) + '&to_identity=eq.' + encodeURIComponent(target.identity));
  if (existing.length) {
    await deleteRow('blocks', existing[0].id);
    return { blocked: false };
  }
  await insertRow('blocks', {
    id: 'bk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fromIdentity: me.identity, toIdentity: target.identity, createdAt: Date.now(),
  });
  return { blocked: true };
});

on('GET', '/api/users/:id/relation', async (params) => {
  const me = await currentUser();
  const target = (await selectAll('users', 'id=eq.' + encodeURIComponent(params.id)))[0];
  if (!target) throw new Error('用户不存在');
  return buildRelation(me, target);
});

async function buildRelation(me, target) {
  const fwd = await selectAll('follows', 'from_identity=eq.' + encodeURIComponent(me.identity));
  const back = await selectAll('follows', 'to_identity=eq.' + encodeURIComponent(target.identity));
  const meFollows = fwd.some((f) => f.toIdentity === target.identity);
  const targetFollows = back.some((f) => f.fromIdentity === me.identity);
  const blocks = await selectAll('blocks', 'from_identity=eq.' + encodeURIComponent(me.identity));
  return {
    following: meFollows,
    followsYou: targetFollows,
    friend: meFollows && targetFollows,
    blocked: blocks.some((b) => b.toIdentity === target.identity),
    followers: back.length,
    followingCount: fwd.length,
    posts: (await selectAll('posts', 'author_identity=eq.' + encodeURIComponent(target.identity))).length,
    rooms: (await selectAll('rooms', 'owner_id=eq.' + encodeURIComponent(target.id))).length,
    favorites: (await selectAll('favorites', 'identity=eq.' + encodeURIComponent(target.identity))).length,
  };
}

on('GET', '/api/users/:id/follows', async () => {
  const me = await currentUser();
  const fwd = await selectAll('follows', 'from_identity=eq.' + encodeURIComponent(me.identity));
  const users = [];
  for (const f of fwd) {
    if (String(f.toIdentity).indexOf('seed:') === 0) continue;
    const u = (await selectAll('users', 'identity=eq.' + encodeURIComponent(f.toIdentity)))[0];
    if (u) users.push(publicUser(u));
  }
  return { list: users, total: users.length };
});

on('GET', '/api/users/:id/fans', async (params) => {
  const target = (await selectAll('users', 'id=eq.' + encodeURIComponent(params.id)))[0];
  if (!target) throw new Error('用户不存在');
  const back = await selectAll('follows', 'to_identity=eq.' + encodeURIComponent(target.identity));
  const users = [];
  for (const f of back) {
    if (String(f.fromIdentity).indexOf('seed:') === 0) continue;
    const u = (await selectAll('users', 'identity=eq.' + encodeURIComponent(f.fromIdentity)))[0];
    if (u) users.push(publicUser(u));
  }
  return { list: users, total: users.length };
});

on('GET', '/api/users/:id', async (params) => {
  const user = (await selectAll('users', 'id=eq.' + encodeURIComponent(params.id)))[0];
  if (!user) throw new Error('用户不存在');
  const me = await currentUser();

  const allRooms = await selectAll('rooms', 'owner_id=eq.' + encodeURIComponent(user.id), 'created_at.desc');
  const rooms = allRooms
    .filter((r) => !/测试|验证|改名后/.test(r.title || ''))
    .map((r) => shapeRoomFast(r, [], [], me.identity));

  const rawPosts = (await selectAll('posts', 'author_identity=eq.' + encodeURIComponent(user.identity), 'created_at.desc'))
    .slice(0, 50);
  const favs = await selectAll('favorites', 'identity=eq.' + encodeURIComponent(me.identity));
  const favIds = new Set(favs.map((f) => f.postId));
  const allPosts = await selectAll('posts');
  const hearts = allPosts.filter((p) => (p.likers || []).indexOf(user.identity) !== -1).length;

  return {
    user: publicUser(user),
    rooms: rooms,
    posts: rawPosts.map((p) => shapePostFast(p, me.identity, favIds)),
    hearts: hearts,
    relation: await buildRelation(me, user),
    favorites: (await selectAll('favorites', 'identity=eq.' + encodeURIComponent(user.identity))).length,
  };
});

on('GET', '/api/feed', async () => {
  const me = await currentUser();
  const blocks = await selectAll('blocks', 'from_identity=eq.' + encodeURIComponent(me.identity));
  const blocked = new Set(blocks.map((b) => b.toIdentity));
  const fwd = await selectAll('follows', 'from_identity=eq.' + encodeURIComponent(me.identity));
  const watched = new Set([me.identity].concat(fwd.map((f) => f.toIdentity)));

  const items = [];
  const rooms = await selectAll('rooms');
  for (const r of rooms) {
    if (/测试|验证|改名后/.test(r.title || '') || !r.ownerSnapshot) continue;
    if (blocked.has(r.ownerSnapshot.identity)) continue;
    if (watched.has(r.ownerSnapshot.identity)) {
      items.push({
        kind: 'room', id: r.id, roomId: r.id,
        actor: r.ownerSnapshot, at: r.createdAt, text: r.title,
        room: shapeRoomFast(r, [], [], me.identity),
      });
    }
  }
  const answers = await selectAll('posts', 'kind=eq.answer');
  for (const p of answers) {
    if (blocked.has(p.authorIdentity)) continue;
    if (watched.has(p.authorIdentity)) {
      items.push({
        kind: 'answer', id: p.id, roomId: p.roomId,
        actor: p.authorSnapshot, at: p.createdAt, text: p.text,
        post: shapePostFast(p, me.identity),
      });
    }
  }
  items.sort((a, b) => b.at - a.at);
  return { list: items.slice(0, 40), total: Math.min(items.length, 40) };
});

on('GET', '/api/topics', async () => {
  const counts = {};
  const rooms = await selectAll('rooms');
  for (const r of rooms) {
    if (/测试|验证|改名后/.test(r.title || '')) continue;
    (r.tags || []).forEach((t) => {
      if (!counts[t]) counts[t] = { tag: t, rooms: 0, questions: 0 };
      counts[t].rooms++;
    });
  }
  const posts = await selectAll('posts', 'kind=eq.question');
  for (const p of posts) {
    (p.tags || []).forEach((t) => {
      if (!counts[t]) counts[t] = { tag: t, rooms: 0, questions: 0 };
      counts[t].questions++;
    });
  }
  return {
    list: Object.keys(counts)
      .map((t) => Object.assign(counts[t], { total: counts[t].rooms + counts[t].questions }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20),
  };
});

on('GET', '/api/suggestions', async () => {
  const me = await currentUser();
  const fwd = await selectAll('follows', 'from_identity=eq.' + encodeURIComponent(me.identity));
  const watching = new Set(fwd.map((f) => f.toIdentity));
  const blocks = await selectAll('blocks', 'from_identity=eq.' + encodeURIComponent(me.identity));
  const blocked = new Set(blocks.map((b) => b.toIdentity));

  const users = await selectAll('users');
  const allFollows = await selectAll('follows');
  const scored = [];
  for (const u of users) {
    if (u.identity === me.identity || watching.has(u.identity)) continue;
    if (blocked.has(u.identity)) continue;
    if (String(u.identity).indexOf('seed:') === 0) continue;
    const st = u.stats || {};
    const theirFollowers = allFollows.filter((f) => f.toIdentity === u.identity);
    const mutual = theirFollowers.filter((f) => watching.has(f.fromIdentity)).length;
    if (!theirFollowers.length && !st.posts && !st.received) continue;
    const score = (st.rooms || 0) * 2 + (st.received || 0) * 0.6 + (st.hearts || 0) / 20 + mutual * 8 +
      (u.id || 'u_x').charCodeAt(2) % 7;
    scored.push({ user: publicUser(u), mutual: mutual, score: score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { list: scored.slice(0, 6) };
});

/* ---- 运营 ---- */
on('GET', '/api/plaza', async () => {
  const me = await currentUser();
  const allRooms = (await selectAll('rooms'))
    .filter((r) => !/测试|验证|改名后/.test(r.title || ''));
  const posts = await selectAll('posts');
  const visits = await selectAll('visits');

  const rooms = allRooms.map((r) => shapeRoomFast(r, posts, visits, me.identity));
  const hotRooms = rooms.slice().sort((a, b) => {
    const sa = a.counts.questions * 3 + a.counts.answers * 2 + a.counts.hearts + a.counts.visits;
    const sb = b.counts.questions * 3 + b.counts.answers * 2 + b.counts.hearts + b.counts.visits;
    return sb - sa;
  }).slice(0, 8);

  const roomIds = new Set(allRooms.map((r) => r.id));
  const hotPosts = posts
    .filter((p) => !p.pending && roomIds.has(p.roomId))
    .sort((a, b) => ((b.hearts || 0) + (b.claps || 0)) - ((a.hearts || 0) + (a.claps || 0)))
    .slice(0, 10)
    .map((p) => shapePostFast(p, me.identity));

  return { hotRooms: hotRooms, hotPosts: hotPosts, topTags: [], online: 1 };
});

on('GET', '/api/stats', async () => {
  const posts = await selectAll('posts');
  const visits = await selectAll('visits');
  const rooms = await selectAll('rooms');
  const users = await selectAll('users');
  const now = Date.now();
  const buckets = [];
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
      rooms: rooms.length,
      posts: posts.length,
      users: users.length,
      hearts: posts.reduce((s, p) => s + (p.hearts || 0), 0),
    },
  };
});

on('GET', '/api/rooms/:id/visits', async (params) => {
  const list = (await selectAll('visits', 'room_id=eq.' + encodeURIComponent(params.id), 'created_at.desc')).slice(0, 50);
  return {
    list: list.map((v) => {
      let h = 0;
      for (let i = 0; i < v.visitorId.length; i++) h = (h * 31 + v.visitorId.charCodeAt(i)) >>> 0;
      return {
        id: v.id, name: v.visitorName,
        avatar: { type: 'ring', hue: h % 360, text: (v.visitorName || '匿').slice(0, 1) },
        at: v.createdAt,
      };
    }),
    total: list.length,
  };
});

/* ---- 通知 ---- */
on('GET', '/api/messages', async () => {
  const me = await currentUser();
  const list = await selectAll('messages', 'user_id=eq.' + encodeURIComponent(me.id), 'created_at.desc');
  return { list: list.slice(0, 50), unread: list.filter((m) => !m.read).length };
});

on('POST', '/api/messages/read', async () => {
  const me = await currentUser();
  const list = await selectAll('messages', 'user_id=eq.' + encodeURIComponent(me.id) + '&read=eq.false');
  for (const m of list) await patchRow('messages', m.id, { read: true });
  return { done: true };
});

/* ---- 举报 ---- */
on('POST', '/api/reports', async (params, body) => {
  const posts = await selectAll('posts', 'id=eq.' + encodeURIComponent(body.postId));
  if (!posts[0]) throw new Error('内容不存在');
  await insertRow('reports', {
    id: 'rp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    postId: body.postId, roomId: posts[0].roomId,
    reason: String(body.reason || '其他').slice(0, 50),
    detail: String(body.detail || '').slice(0, 200),
    status: 'pending', createdAt: Date.now(),
  });
  await patchRow('posts', body.postId, { reportCount: (posts[0].reportCount || 0) + 1 });
  return { done: true };
});

on('GET', '/api/reports', async () => {
  const list = await selectAll('reports', 'status=eq.pending', 'created_at.desc');
  return { list: list, total: list.length };
});

on('POST', '/api/reports/:id/resolve', async (params, body) => {
  const rows = await selectAll('reports', 'id=eq.' + encodeURIComponent(params.id));
  if (!rows[0]) throw new Error('举报不存在');
  await patchRow('reports', params.id, { status: body.action === 'remove' ? 'removed' : 'dismissed' });
  if (body.action === 'remove') await deleteRow('posts', rows[0].postId);
  return { done: true };
});

/* ---- 草稿 ---- */
on('GET', '/api/drafts', async () => {
  const me = await currentUser();
  return { list: await selectAll('drafts', 'identity=eq.' + encodeURIComponent(me.identity)) };
});

on('PUT', '/api/drafts', async (params, body) => {
  const me = await currentUser();
  const existing = await selectAll('drafts',
    'identity=eq.' + encodeURIComponent(me.identity) + '&room_id=eq.' + encodeURIComponent(body.roomId));
  if (existing.length) {
    await patchRow('drafts', existing[0].id, { text: String(body.text || '').slice(0, 300), updatedAt: Date.now() });
  } else {
    await insertRow('drafts', {
      id: 'df_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      identity: me.identity, roomId: body.roomId,
      text: String(body.text || '').slice(0, 300),
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  return { saved: true };
});

on('GET', '/api/export', async () => {
  const me = await currentUser();
  return {
    exportedAt: Date.now(),
    user: me,
    rooms: await selectAll('rooms', 'owner_id=eq.' + encodeURIComponent(me.id)),
    posts: await selectAll('posts', 'author_identity=eq.' + encodeURIComponent(me.identity)),
    favorites: await selectAll('favorites', 'identity=eq.' + encodeURIComponent(me.identity)),
  };
});

/* ============ 分发 ============ */

function matchRoute(method, pathname) {
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const exact = R[method + ' ' + pathname];
  if (exact) return { fn: exact, params: {} };
  for (const key of Object.keys(R)) {
    const sp = key.indexOf(' ');
    if (key.slice(0, sp) !== method) continue;
    const ps = key.slice(sp + 1).replace(/^\/+/, '').split('/').filter(Boolean);
    if (ps.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].charAt(0) === ':') params[ps[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (ps[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { fn: R[key], params: params };
  }
  return null;
}

async function dispatch(method, path, body) {
  const backend = await resolveBackend();
  if (backend === 'server') {
    try {
      return await viaServer(method, path, body);
    } catch (err) {
      // 只有「后端真的不可达」才降级。
      // 401 未登录、400 参数错误这类是正常业务结果，必须原样抛给上层，
      // 否则上层无法走「游客回退」流程，且会误切后端导致数据看起来全空。
      if (!isTransportError(err)) {
        return { ok: false, message: err.message, status: err.status || 400 };
      }
      console.warn('[data] 服务端不可达，改用本地存储：' + err.message);
      state.backend = 'local';
      state.probedAt = Date.now();
    }
  }
  if (backend === 'supabase') {
    const [pathname, qs] = path.split('?');
    const hit = matchRoute(method, pathname);
    if (!hit) return { ok: false, message: '接口不存在' };
    const query = {};
    if (qs) qs.split('&').forEach((kv) => {
      const [k, v] = kv.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    try {
      const data = await hit.fn(hit.params, body || {}, query);
      return { ok: true, data: data };
    } catch (err) {
      return { ok: false, message: err.message || '请求失败' };
    }
  }
  return viaLocal(method, path, body).then(
    (d) => ({ ok: true, data: d }),
    (e) => ({ ok: false, message: e.message })
  );
}

window.Data = { dispatch: dispatch, resolveBackend: resolveBackend };

})();

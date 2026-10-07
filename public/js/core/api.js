/**
 * API 客户端。
 *
 * 只负责「把调用转给Data 层」并统一错误类型。
 * 真正的存储后端（Supabase / 本地 server.js / 浏览器本地）由 Data 层自行探测决定，
 * 因此同一份前端代码可以跑在本地开发环境，也能直接部署到 GitHub Pages。
 */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/* ---------- 设备标识 ---------- */

let deviceId = null;
try {
  deviceId = localStorage.getItem('tb_device');
  if (!deviceId) {
    deviceId = 'd' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('tb_device', deviceId);
  }
} catch (_) {
  deviceId = 'd' + Math.random().toString(36).slice(2, 12);
}

/* ---------- 统一请求 ---------- */

async function request(method, path, body) {
  if (!window.Data || typeof window.Data.dispatch !== 'function') {
    throw new ApiError('数据层未就绪', 0);
  }
  const r = await window.Data.dispatch(method, path, body || {});
  if (!r.ok) throw new ApiError(r.message || '请求失败', r.status || 400);
  return r.data;
}

/* ---------- 接口定义 ---------- */

const api = {
  // 登录 / 身份
  /** 昵称登录（三种后端都支持，是静态部署的主入口） */
  loginLocal: (nickname, bio) =>
    request('POST', '/api/auth/login-local', { nickname: nickname, bio: bio || '' }),
  /** 游客模式：不留昵称直接进入 */
  guest: () => request('POST', '/api/auth/guest'),
  me: () => request('GET', '/api/auth/me'),
  updateProfile: (patch) => request('PATCH', '/api/auth/profile', patch),
  logout: () => request('POST', '/api/auth/logout'),
  resetData: () => request('POST', '/api/data/reset'),

  // 扫码登录（仅本地服务端支持；静态部署下前端会引导用昵称登录）
  qrTicket: () => request('POST', '/api/auth/qr/ticket'),
  qrPoll: (ticket) => request('GET', '/api/auth/qr/poll?t=' + encodeURIComponent(ticket)),
  qrConfirm: (ticket) => request('POST', '/api/auth/qr/confirm', { ticket: ticket }),
  qrBind: (ticket, nickname) =>
    request('POST', '/api/auth/qr/bind', { ticket: ticket, nickname: nickname, deviceId: deviceId }),
  phoneCode: (phone) => request('POST', '/api/auth/phone/code', { phone: phone }),
  phoneLogin: (phone, code) => request('POST', '/api/auth/phone/login', { phone: phone, code: code }),
  register: (username, password, nickname) =>
    request('POST', '/api/auth/register', { username: username, password: password, nickname: nickname }),
  login: (username, password) =>
    request('POST', '/api/auth/login', { username: username, password: password }),

  // 坦白局
  rooms: (tag) => request('GET', '/api/rooms' + (tag ? '?tag=' + encodeURIComponent(tag) : '')),
  room: (id) => request('GET', '/api/rooms/' + id),
  createRoom: (payload) => request('POST', '/api/rooms', payload),
  updateRoom: (id, payload) => request('PATCH', '/api/rooms/' + id, payload),
  posts: (id, query) =>
    request('GET', '/api/rooms/' + id + '/posts' + (query ? '?' + new URLSearchParams(query) : '')),

  createPost: (roomId, payload) => request('POST', '/api/rooms/' + roomId + '/posts', payload),
  answer: (postId, payload) => request('POST', '/api/posts/' + postId + '/answer', payload),
  react: (postId, type) => request('POST', '/api/posts/' + postId + '/react', { type: type }),
  feature: (postId) => request('POST', '/api/posts/' + postId + '/feature'),
  removePost: (postId) => request('DELETE', '/api/posts/' + postId),
  followup: (postId, text) => request('POST', '/api/posts/' + postId + '/followup', { text: text }),

  // 社交
  followUser: (id) => request('POST', '/api/users/' + id + '/follow'),
  blockUser: (id) => request('POST', '/api/users/' + id + '/block'),
  relation: (id) => request('GET', '/api/users/' + id + '/relation'),
  fans: (id) => request('GET', '/api/users/' + id + '/fans'),
  follows: (id) => request('GET', '/api/users/' + id + '/follows'),
  favorite: (id) => request('POST', '/api/posts/' + id + '/favorite'),
  myFavorites: () => request('GET', '/api/me/favorites'),
  feed: () => request('GET', '/api/feed'),
  topics: () => request('GET', '/api/topics'),
  suggestions: () => request('GET', '/api/suggestions'),

  // 运营
  plaza: () => request('GET', '/api/plaza'),
  stats: () => request('GET', '/api/stats'),
  visits: (roomId) => request('GET', '/api/rooms/' + roomId + '/visits'),
  messages: () => request('GET', '/api/messages'),
  readMessages: () => request('POST', '/api/messages/read'),
  report: (postId, reason, detail) =>
    request('POST', '/api/reports', { postId: postId, reason: reason, detail: detail }),
  reports: () => request('GET', '/api/reports'),
  resolveReport: (id, action) => request('POST', '/api/reports/' + id + '/resolve', { action: action }),

  // 草稿
  drafts: () => request('GET', '/api/drafts'),
  saveDraft: (roomId, text) => request('PUT', '/api/drafts', { roomId: roomId, text: text }),
};

window.api = api;
window.ApiError = ApiError;
window.deviceId = deviceId;
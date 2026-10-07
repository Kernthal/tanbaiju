'use strict';
/**
 * 社交关系与互动服务。
 *
 * 坦白局不只是问答，核心是「人和人之间的连接」，所以这里维护：
 *   关注关系、好友、访客记录、收藏、屏蔽、@提及、话题聚合、动态流
 *
 * 全部基于现有的 users / posts / rooms 集合派生，不引入新存储结构，
 * 保证零依赖与向后兼容。
 */

const db = require('./store');
const auth = require('./auth');
const moderation = require('./moderation');

/** 判断 a 是否关注 b */
function isFollowing(aIdentity, bIdentity) {
  if (!aIdentity || !bIdentity) return false;
  return db.follows.count((f) => f.from === aIdentity && f.to === bIdentity) > 0;
}

/** 关注 / 取关 */
function toggleFollow(fromIdentity, toIdentity) {
  if (!fromIdentity || !toIdentity) return { ok: false, message: '身份不完整' };
  if (fromIdentity === toIdentity) return { ok: false, message: '不能关注自己' };
  const target = db.users.findOne((u) => u.identity === toIdentity);
  if (!target) return { ok: false, message: '用户不存在' };

  const existing = db.follows.findOne((f) => f.from === fromIdentity && f.to === toIdentity);
  if (existing) {
    db.follows.remove(existing.id);
    return { ok: true, following: false, followers: countFollowers(toIdentity) };
  }
  db.follows.insert({
    id: db.id('fl'),
    from: fromIdentity,
    fromId: findUser(fromIdentity) ? findUser(fromIdentity).id : null,
    to: toIdentity,
    toId: target.id,
    createdAt: Date.now(),
  });
  return { ok: true, following: true, followers: countFollowers(toIdentity) };
}

/**
 * 演示/机器人身份过滤。
 * 种子数据里的提问者用 seed:asker:* 身份创建，只是为了让气泡墙看起来热闹，
 * 绝不能出现在推荐、粉丝、关注列表里 —— 否则用户会当成真人。
 */
function isSynthetic(identity) {
  return typeof identity === 'string' &&
    (identity.indexOf('seed:') === 0 || identity.indexOf('dev:') === 0);
}

function findUser(identity) {
  return db.users.findOne((u) => u.identity === identity);
}

/**
 * 路由层拿到的可能是用户 id（u_xxx），而关系数据存的是 identity（acct:xxx）。
 * 这里两种都能解析，避免上层反复踩坑。
 */
function resolveUser(idOrIdentity) {
  if (!idOrIdentity) return null;
  const byId = db.users.find(idOrIdentity);
  if (byId) return byId;
  return db.users.findOne((u) => u.identity === idOrIdentity);
}

/** 解析出 identity，找不到返回 null */
function resolveIdentity(idOrIdentity) {
  const u = resolveUser(idOrIdentity);
  return u ? u.identity : null;
}

function countFollowers(identity) {
  return db.follows.count((f) => f.to === identity);
}

function countFollowing(identity) {
  return db.follows.count((f) => f.from === identity);
}

/** 互相关注 = 好友 */
function isFriend(a, b) {
  return isFollowing(a, b) && isFollowing(b, a);
}

/** 拉黑：被拉黑者内容对拉黑者不可见 */
function isBlocked(aIdentity, bIdentity) {
  if (!aIdentity || !bIdentity) return false;
  return db.blocks.count(
    (r) => r.from === aIdentity && r.to === bIdentity
  ) > 0;
}

/** 可见性过滤：从某人视角看，哪些身份被屏蔽 */
function blockedSet(viewerIdentity) {
  if (!viewerIdentity) return new Set();
  return new Set(db.blocks.filter((r) => r.from === viewerIdentity).map((r) => r.to));
}

/** 过滤掉被屏蔽用户的内容 */
function visiblePosts(posts, viewerIdentity) {
  const blocked = blockedSet(viewerIdentity);
  if (!blocked.size) return posts;
  return posts.filter((p) => !blocked.has(p.authorIdentity));
}

/** 收藏 */
function toggleFavorite(viewerIdentity, postId) {
  const post = db.posts.find(postId);
  if (!post) return { ok: false, message: '内容不存在' };
  const existing = db.favorites.findOne(
    (f) => f.identity === viewerIdentity && f.postId === postId
  );
  if (existing) {
    db.favorites.remove(existing.id);
    return { ok: true, favorited: false };
  }
  db.favorites.insert({
    id: db.id('fv'),
    identity: viewerIdentity,
    postId: postId,
    roomId: post.roomId,
    createdAt: Date.now(),
  });
  return { ok: true, favorited: true };
}

function listFavorites(viewerIdentity) {
  return db.favorites
    .filter((f) => f.identity === viewerIdentity)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((f) => {
      const post = db.posts.find(f.postId);
      return post ? { post: post, favoritedAt: f.createdAt } : null;
    })
    .filter(Boolean);
}

function isFavorited(viewerIdentity, postId) {
  return db.favorites.findOne((f) => f.identity === viewerIdentity && f.postId === postId) !== null;
}

/* ---------- @提及解析 ---------- */

/**
 * 从文本里解析 @昵称，命中则建立提及关系并生成通知。
 * 昵称需匹配已存在用户；匹配不到就当普通文本，不报错。
 */
function parseMentions(text) {
  const re = /@([^\s@，,。.!！?？:：;；]{1,16})/g;
  const out = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const name = m[1];
    const user = db.users.findOne((u) => u.nickname === name);
    if (user) out.push(user);
  }
  return out;
}

/** 通知某个用户 */
function notify(userId, type, text, extra) {
  if (!userId) return;
  db.messages.insert({
    id: db.id('msg'),
    userId: userId,
    type: type,
    text: text,
    roomId: (extra && extra.roomId) || null,
    postId: (extra && extra.postId) || null,
    read: false,
    createdAt: Date.now(),
  });
}

/** 有人关注时通知，并计入对方粉丝数 */
function notifyFollow(targetUser, followerUser) {
  notify(targetUser.id, 'follow', followerUser.nickname + ' 关注了你', {});
}

/* ---------- 话题聚合 ---------- */

function trendingTopics(limit) {
  const counts = {};
  db.rooms.all().forEach((r) => {
    (r.tags || []).forEach((t) => {
      if (!counts[t]) counts[t] = { tag: t, rooms: 0, questions: 0 };
      counts[t].rooms++;
    });
  });
  db.posts.all().forEach((p) => {
    if (p.kind !== 'question') return;
    (p.tags || []).forEach((t) => {
      if (!counts[t]) counts[t] = { tag: t, rooms: 0, questions: 0 };
      counts[t].questions++;
    });
  });
  return Object.values(counts)
    .sort((a, b) => (b.rooms + b.questions) - (a.rooms + a.questions))
    .slice(0, limit || 12)
    .map((x) => Object.assign(x, { total: x.rooms + x.questions }));
}

/* ---------- 动态流 ---------- */

/**
 * 综合动态：关注的人 + 自己 的最新坦白局与回答。
 * 这是社交产品的信息流核心。
 */
function feed(viewerIdentity, limit) {
  const me = findUser(viewerIdentity);
  const blocked = blockedSet(viewerIdentity);

  const watched = new Set([viewerIdentity]);
  db.follows.filter((f) => f.from === viewerIdentity).forEach((f) => watched.add(f.to));

  const items = [];

  // 我关注的人的坦白局
  db.rooms.all().forEach((r) => {
    if (!r.ownerSnapshot) return;
    const ownerIdentity = r.ownerSnapshot.identity;
    if (blocked.has(ownerIdentity)) return;
    const isMine = ownerIdentity === viewerIdentity;
    const isWatched = watched.has(ownerIdentity);
    if (!isMine && !isWatched) return;
    items.push({
      kind: 'room',
      id: r.id,
      roomId: r.id,
      actor: r.ownerSnapshot,
      at: r.createdAt,
      room: r,
    });
  });

  // 我关注的人的回答
  db.posts.all().forEach((p) => {
    if (p.kind !== 'answer') return;
    if (blocked.has(p.authorIdentity)) return;
    const isMine = p.authorIdentity === viewerIdentity;
    const isWatched = watched.has(p.authorIdentity);
    if (!isMine && !isWatched) return;
    items.push({
      kind: 'answer',
      id: p.id,
      roomId: p.roomId,
      actor: p.authorSnapshot,
      at: p.createdAt,
      post: p,
    });
  });

  items.sort((a, b) => b.at - a.at);
  return items.slice(0, limit || 30);
}

/* ---------- 推荐：可能感兴趣的人 ---------- */

function suggestions(viewerIdentity, limit) {
  // 游客没有账号记录，此时不应返回空 —— 回退到全局热门推荐
  const me = findUser(viewerIdentity);
  const watching = new Set(db.follows.filter((f) => f.from === viewerIdentity).map((f) => f.to));
  const meBlocked = blockedSet(viewerIdentity);
  const myFollowing = watching;

  const scored = [];
  db.users.all().forEach((u) => {
    if (viewerIdentity && u.identity === viewerIdentity) return;
    if (watching.has(u.identity)) return;
    if (meBlocked.has(u.identity)) return;

    // 演示/机器人账号（seed: 前缀）不展示给用户
    if (u.identity.indexOf('seed:') === 0) return;

    const s = u.stats || {};
    let score = (s.rooms ? s.rooms : 0) * 2 +
                (s.received ? s.received : 0) * 0.6 +
                (s.hearts ? s.hearts : 0) / 20;

    // 有共同关注的人 -> 更值得推荐
    const theirFollowers = db.follows.filter((f) => f.to === u.identity).map((f) => f.from);
    const mutual = theirFollowers.filter((f) => myFollowing.has(f)).length;
    score += mutual * 8;

    const followerCount = theirFollowers.length;
    // 完全无人问津且没发过内容的账号没有推荐价值
    if (followerCount === 0 && (s.posts || 0) === 0 && (s.received || 0) === 0) return;

    const tie = (u.id || 'u_x').charCodeAt(2) % 7;
    scored.push({ user: auth.publicUser(u), mutual: mutual, score: score + tie });
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit || 6);
}

/* ---------- 用户关系摘要 ---------- */

function relation(viewerIdentity, targetIdentity) {
  const target = findUser(targetIdentity);
  if (!target) return null;
  return {
    following: isFollowing(viewerIdentity, targetIdentity),
    followsYou: isFollowing(targetIdentity, viewerIdentity),
    friend: isFriend(viewerIdentity, targetIdentity),
    blocked: isBlocked(viewerIdentity, targetIdentity),
    followers: countFollowers(targetIdentity),
    followingCount: countFollowing(targetIdentity),
    posts: db.posts.count((p) => p.authorIdentity === targetIdentity),
    rooms: db.rooms.count((r) => r.ownerId === target.id),
    favorites: db.favorites.count((f) => f.identity === targetIdentity),
  };
}

module.exports = {
  isFollowing: isFollowing,
  toggleFollow: toggleFollow,
  isFriend: isFriend,
  isBlocked: isBlocked,
  blockedSet: blockedSet,
  visiblePosts: visiblePosts,
  toggleFavorite: toggleFavorite,
  isFavorited: isFavorited,
  listFavorites: listFavorites,
  parseMentions: parseMentions,
  notify: notify,
  notifyFollow: notifyFollow,
  trendingTopics: trendingTopics,
  feed: feed,
  suggestions: suggestions,
  relation: relation,
  findUser: findUser,
  isSynthetic: isSynthetic,
  resolveUser: resolveUser,
  resolveIdentity: resolveIdentity,
  countFollowers: countFollowers,
  countFollowing: countFollowing,
};
/**
 * 社交功能验证：关注、粉丝、关系摘要、收藏、屏蔽、@提及、话题、动态流、推荐。
 * 运行：node test/social.js（需服务已启动）
 */

const B = 'http://127.0.0.1:8848';
let pass = 0, fail = 0;

function identity(name) { return { name, cookie: '' }; }
async function call(method, path, body, who) {
  const w = who || main;
  const res = await fetch(B + path, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'x-device-id': 'dev-' + w.name },
      w.cookie ? { cookie: w.cookie } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) w.cookie = sc.map((c) => c.split(';')[0]).join('; ');
  let json = {};
  try { json = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, json };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
}

const main = identity('main');

(async function run() {
  console.log('\n=== 建立测试用户 ===');

  // A：发起者
  const a = identity('soc-a');
  const unameA = 'soca' + Date.now().toString().slice(-6);
  let r = await call('POST', '/api/auth/register', { username: unameA, password: 'abc123456', nickname: '阿测' }, a);
  check('用户A 注册', r.json.ok, r.json.data && r.json.data.user.nickname);
  const idA = r.json.data.user.id;

  // B：关注者
  const b = identity('soc-b');
  const unameB = 'socb' + Date.now().toString().slice(-6);
  r = await call('POST', '/api/auth/register', { username: unameB, password: 'abc123456', nickname: '小测' }, b);
  check('用户B 注册', r.json.ok);
  const idB = r.json.data.user.id;

  // C：陌生人
  const c = identity('soc-c');
  const unameC = 'socc' + Date.now().toString().slice(-6);
  r = await call('POST', '/api/auth/register', { username: unameC, password: 'abc123456', nickname: '陌生测' }, c);
  check('用户C 注册', r.json.ok);

  console.log('\n=== 关注 / 取关 ===');

  r = await call('POST', '/api/users/' + idA + '/follow', undefined, b);
  check('B 关注 A', r.json.ok && r.json.data.following === true, '粉丝数=' + (r.json.data && r.json.data.followers));

  r = await call('GET', '/api/users/' + idA + '/fans', undefined, b);
  check('A 的粉丝列表含 B', r.json.ok && r.json.data.list.some((u) => u.id === idB), r.json.data.total + ' 人');

  r = await call('GET', '/api/users/' + idA + '/follows', undefined, a);
  check('A 的关注列表当前为空', r.json.ok && r.json.data.total === 0, r.json.data.total + ' 人');

  r = await call('GET', '/api/users/' + idA + '/relation', undefined, b);
  check('关系摘要：following=true', r.json.ok && r.json.data.following === true);
  check('关系摘要：followsYou=false', r.json.ok && r.json.data.followsYou === false);
  check('关系摘要：friend=false（单向）', r.json.ok && r.json.data.friend === false);

  r = await call('POST', '/api/users/' + idB + '/follow', undefined, a);
  r = await call('GET', '/api/users/' + idB + '/relation', undefined, a);
  check('互相关注后 friend=true', r.json.ok && r.json.data.friend === true);

  r = await call('POST', '/api/users/' + idA + '/follow', undefined, a);
  check('关注自己被拒绝', !r.json.ok, r.json.message);

  r = await call('POST', '/api/users/' + idA + '/follow', undefined, c);
  check('C 也能关注 A', r.json.ok && r.json.data.following === true);

  r = await call('POST', '/api/users/' + idA + '/follow', undefined, b);
  check('再次关注=取消关注', r.json.ok && r.json.data.following === false);
  // 恢复关注，供后续动态流测试
  await call('POST', '/api/users/' + idA + '/follow', undefined, b);

  console.log('\n=== 收藏 ===');

  r = await call('POST', '/api/rooms', { title: '社交测试局', days: 1, rules: { onePerGuest: false } }, a);
  check('A 创建坦白局', r.json.ok);
  const roomId = r.json.data.id;

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '你会收藏这个问题吗？' }, b);
  check('B 提问', r.json.ok);
  const qId = r.json.data.post.id;

  r = await call('POST', '/api/posts/' + qId + '/favorite', undefined, a);
  check('A 收藏内容', r.json.ok && r.json.data.favorited === true);

  r = await call('GET', '/api/me/favorites', undefined, a);
  check('A 的收藏列表含该内容', r.json.ok && r.json.data.list.some((x) => x.post.id === qId), r.json.data.total + ' 条');

  r = await call('GET', '/api/rooms/' + roomId + '/posts', undefined, a);
  const favPost = r.json.data.list.find((p) => p.id === qId);
  check('帖子带 favorited 标记', favPost && favPost.favorited === true);

  r = await call('POST', '/api/posts/' + qId + '/favorite', undefined, a);
  check('再次收藏=取消', r.json.ok && r.json.data.favorited === false);

  console.log('\n=== @提及 ===');

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '@小测 你怎么看这个问题？' }, c);
  check('带 @昵称 的提问成功', r.json.ok);
  check('解析出被提及者', r.json.ok && Array.isArray(r.json.data.mentioned) && r.json.data.mentioned.indexOf('小测') >= 0,
    JSON.stringify(r.json.data.mentioned));

  r = await call('GET', '/api/messages', undefined, b);
  check('B 收到提及通知', r.json.ok && r.json.data.list.some((m) => m.type === 'mention'),
    r.json.data.list.map((m) => m.type).join(','));

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '@不存在的人 测试' }, c);
  check('@不存在用户不报错', r.json.ok && r.json.data.mentioned.length === 0);

  console.log('\n=== 动态流 ===');

  r = await call('GET', '/api/feed', undefined, b);
  check('B 的动态流含 A 的坦白局', r.json.ok && r.json.data.list.some((x) => x.kind === 'room' && x.actor.id === idA),
    r.json.data.total + ' 条动态');

  r = await call('GET', '/api/feed', undefined, c);
  check('C 未关注 B 时看不到 B 的动态', r.json.ok && !r.json.data.list.some((x) => x.actor.id === idB));

  console.log('\n=== 话题与推荐 ===');

  r = await call('GET', '/api/topics', undefined, main);
  check('话题列表返回', r.json.ok && Array.isArray(r.json.data.list), r.json.data.total || (r.json.data.list || []).length + ' 个话题');
  const topics = (r.json.data.list || []);
  check('话题带热度权重', topics.length === 0 || typeof topics[0].total === 'number',
    topics.length ? topics[0].tag + '=' + topics[0].total : '暂无话题');

  r = await call('GET', '/api/suggestions', undefined, c);
  check('推荐可能感兴趣的人', r.json.ok && Array.isArray(r.json.data.list), r.json.data.list.length + ' 人');
  check('推荐里不包含已关注的人', r.json.ok && !r.json.data.list.some((u) => u.user.id === idA));

  console.log('\n=== 屏蔽 ===');

  r = await call('POST', '/api/users/' + idB + '/block', undefined, c);
  check('C 屏蔽 B', r.json.ok && r.json.data.blocked === true);

  r = await call('GET', '/api/users/' + idB + '/relation', undefined, c);
  check('关系摘要显示 blocked=true', r.json.ok && r.json.data.blocked === true);

  r = await call('GET', '/api/feed', undefined, c);
  check('屏蔽后 C 的动态流不含 B', r.json.ok && !r.json.data.list.some((x) => x.actor.id === idB));

  r = await call('POST', '/api/users/' + idB + '/block', undefined, c);
  check('再次屏蔽=取消', r.json.ok && r.json.data.blocked === false);

  r = await call('POST', '/api/users/' + idB + '/block', undefined, b);
  check('屏蔽自己被拒绝', !r.json.ok, r.json.message);

  console.log('\n=== 边界 ===');

  r = await call('POST', '/api/users/nonexistent/follow', undefined, b);
  check('关注不存在用户返回 404', r.status === 404, 'HTTP ' + r.status);

  r = await call('GET', '/api/feed', undefined, identity('anon-' + Date.now()));
  check('未登录访问动态流不报错', r.json.ok);

  r = await call('GET', '/api/topics', undefined, identity('anon2'));
  check('未登录访问话题不报错', r.json.ok);

  console.log('\n================================');
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   失败 ' + fail : '   全部通过'));
  console.log('================================\n');
  process.exit(fail ? 1 : 0);
})();
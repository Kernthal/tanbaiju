/**
 * 端到端接口测试。逐条验证关键链路与权限边界。
 * 运行：node test/api-e2e.js
 */

const B = 'http://127.0.0.1:8848';
let cookies = '';
let pass = 0;
let fail = 0;

/** 每个身份独立的 cookie 罐，用于正确验证权限边界 */
function identity(name) {
  return { name: name, cookie: '' };
}

async function call(method, path, body, who) {
  const who2 = who || main;
  const res = await fetch(B + path, {
    method: method,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'x-device-id': 'dev-' + who2.name },
      who2.cookie ? { cookie: who2.cookie } : {}
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length) who2.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, json: await res.json() };
}

const main = identity('main');

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

(async function run() {
  console.log('\n=== 登录通道 ===');

  let r = await call('POST', '/api/auth/qr/ticket');
  check('扫码票据生成', r.json.ok && r.json.data.svg.indexOf('<svg') === 0, 'svg ' + r.json.data.svg.length + ' 字符');
  let ticket = r.json.data.ticket;

  r = await call('GET', '/api/auth/qr/poll?t=' + ticket);
  check('票据初始为等待态', r.json.data.status === 'waiting', r.json.data.status);

  r = await call('POST', '/api/auth/qr/confirm', { ticket: ticket });
  check('未登录确认票据被拦截', r.status === 401, 'HTTP ' + r.status);

  r = await call('POST', '/api/auth/guest');
  check('游客登录', r.json.ok && !!r.json.data.token, r.json.data.user.nickname);

  r = await call('POST', '/api/auth/qr/ticket');
  const t2 = r.json.data.ticket;
  r = await call('POST', '/api/auth/qr/confirm', { ticket: t2 });
  check('已登录确认票据', r.json.ok, 'nickname=' + (r.json.data && r.json.data.nickname));
  r = await call('GET', '/api/auth/qr/poll?t=' + t2);
  check('票据变为已确认', r.json.data.status === 'confirmed', r.json.data.status);

  r = await call('GET', '/api/auth/qr/poll?t=nonexistent');
  check('无效票据返回失效', r.json.data.status === 'expired', r.json.data.status);

  const uname = 'tester' + Date.now().toString().slice(-6);
  r = await call('POST', '/api/auth/register', { username: uname, password: 'abc123456', nickname: '测试员' });
  check('注册账号', r.json.ok && !!r.json.data.token, uname);

  r = await call('POST', '/api/auth/register', { username: uname, password: 'abc123456' });
  check('重复用户名被拒', !r.json.ok, r.json.message);

  r = await call('POST', '/api/auth/register', { username: 'ab', password: 'abc123456' });
  check('过短用户名被拒', !r.json.ok, r.json.message);

  r = await call('POST', '/api/auth/phone/code', { phone: '13800138000' });
  check('手机验证码下发', r.json.ok && r.json.data.code === '8888', 'code=' + (r.json.data && r.json.data.code));
  const code = r.json.data.code;
  r = await call('POST', '/api/auth/phone/login', { phone: '13800138000', code: '0000' });
  check('错误验证码被拒', !r.json.ok, r.json.message);
  r = await call('POST', '/api/auth/phone/login', { phone: '13800138000', code: code });
  check('手机号登录', r.json.ok && !!r.json.data.token);

  r = await call('POST', '/api/auth/phone/code', { phone: '123' });
  check('非法手机号被拒', !r.json.ok, r.json.message);

  console.log('\n=== 坦白局与问答 ===');

  r = await call('POST', '/api/rooms', {
    title: '端到端测试局',
    subtitle: '自动化测试用',
    days: 1,
    tags: ['测试'],
    rules: { onePerGuest: true },
  });
  check('创建坦白局', r.json.ok && !!r.json.data.id, r.json.data && r.json.data.id);
  const roomId = r.json.data.id;

  r = await call('POST', '/api/rooms', { title: 'x' });
  check('过短标题被拒', !r.json.ok, r.json.message);

  r = await call('GET', '/api/rooms/' + roomId);
  check('读取房间详情', r.json.ok, '问题数=' + r.json.data.counts.questions);

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '这是一个自动化测试问题吗？' });
  check('提交提问', r.json.ok && !!r.json.data.post.id);
  const qId = r.json.data.post.id;

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '再问一次试试' });
  check('每人限一问', !r.json.ok, r.json.message);

  // 敏感词与脱敏需要在「还能提问」的前提下验证，故另开不限次数的房间
  const freeRoom = (await call('POST', '/api/rooms', {
    title: '敏感词检测局', days: 1, rules: { onePerGuest: false },
  })).json.data.id;

  r = await call('POST', '/api/rooms/' + freeRoom + '/posts', { kind: 'question', text: '你这个白痴' });
  check('侮辱类敏感词被拦截', !r.json.ok, r.json.message);

  r = await call('POST', '/api/rooms/' + freeRoom + '/posts', { kind: 'question', text: '加微信私聊我' });
  check('营销类词被脱敏', r.json.ok && r.json.data.post.text.indexOf('加微信') === -1,
    r.json.ok ? '脱敏为: ' + r.json.data.post.text : '被拒: ' + r.json.message);

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '' });
  check('空内容被拒', !r.json.ok, r.json.message);

  // 权限边界必须用「另一个身份」验证，不能用主人自己的会话
  const other = identity('other');
  await call('POST', '/api/auth/guest', undefined, other);
  r = await call('POST', '/api/posts/' + qId + '/answer', { text: '我不是主人，我来答' }, other);
  check('非主人回答被拦截', !r.json.ok, r.json.message || 'HTTP ' + r.status);

  r = await call('POST', '/api/posts/' + qId + '/feature', undefined, other);
  check('非主人无法精选', !r.json.ok, r.json.message || 'HTTP ' + r.status);

  r = await call('POST', '/api/posts/' + qId + '/react', { type: 'heart' });
  check('心动互动', r.json.ok && r.json.data.hearts === 1, 'hearts=' + r.json.data.hearts);
  r = await call('POST', '/api/posts/' + qId + '/react', { type: 'heart' });
  check('心动可取消', r.json.ok && r.json.data.hearts === 0, 'hearts=' + r.json.data.hearts);
  r = await call('POST', '/api/posts/' + qId + '/react', { type: 'clap' });
  check('鼓掌互动', r.json.ok && r.json.data.claps === 1, 'claps=' + r.json.data.claps);

  r = await call('POST', '/api/posts/' + qId + '/followup', { text: '能再具体一点吗' });
  check('追问功能', r.json.ok && r.json.data.post.replyTo === qId);

  r = await call('POST', '/api/posts/' + qId + '/feature');
  check('主人可设为精选', r.json.ok && r.json.data.featured === true, 'featured=' + (r.json.data && r.json.data.featured));
  r = await call('POST', '/api/posts/' + qId + '/feature');
  check('精选可取消', r.json.ok && r.json.data.featured === false, 'featured=' + (r.json.data && r.json.data.featured));
  // 重新设为精选，供后续筛选用例验证
  await call('POST', '/api/posts/' + qId + '/feature');

  r = await call('POST', '/api/posts/' + qId + '/report', { reason: 'x' });
  check('举报（错误路径应 404）', r.status === 404, 'HTTP ' + r.status);

  r = await call('POST', '/api/reports', { postId: qId, reason: '测试举报', detail: '自动化测试' });
  check('提交举报', r.json.ok);

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '主人不该受限提问' });
  check('主人自己也受限（沿用房间规则）', !r.json.ok, r.json.message);

  // 主人回答自己的问题 —— 核心闭环，必须验证
  r = await call('POST', '/api/posts/' + qId + '/answer', { text: '这是主人的正式回答。' });
  check('主人可以回答', r.json.ok && !!(r.json.data && r.json.data.answer));
  const answerId = r.json.data && r.json.data.answer && r.json.data.answer.id;

  r = await call('GET', '/api/rooms/' + roomId + '/posts?filter=unanswered');
  check('回答后标记为已答', r.json.ok && !r.json.data.list.some((p) => p.id === qId));

  if (answerId) {
    r = await call('POST', '/api/posts/' + answerId + '/react', { type: 'heart' });
    check('回答也能互动', r.json.ok);
  }

  r = await call('POST', '/api/posts/' + qId + '/answer', { text: '' });
  check('空回答被拒', !r.json.ok, r.json.message);

  // 提问者应收到通知：换一个提问者身份来验证
  const asker = identity('asker');
  await call('POST', '/api/auth/guest', undefined, asker);
  const askRoom = (await call('POST', '/api/rooms', {
    title: '通知验证局', days: 1, rules: { onePerGuest: false },
  }, asker)).json.data.id;
  const askQ = (await call('POST', '/api/rooms/' + askRoom + '/posts',
    { kind: 'question', text: '你会收到通知吗？' }, asker)).json.data.post.id;
  await call('POST', '/api/posts/' + askQ + '/answer', { text: '会的。' }, asker);
  r = await call('GET', '/api/messages', undefined, asker);
  check('提问者收到回答通知', r.json.ok && r.json.data.list.length > 0,
    r.json.data.list.length + ' 条通知');

  r = await call('GET', '/api/rooms/' + roomId + '/posts');
  check('帖子列表加载', r.json.ok && r.json.data.list.length >= 2, r.json.data.list.length + ' 条');

  r = await call('GET', '/api/rooms/' + roomId + '/posts?filter=featured');
  check('精选筛选', r.json.ok && r.json.data.list.length === 1 && r.json.data.list[0].id === qId,
    r.json.data.list.length + ' 条精选');

  r = await call('GET', '/api/rooms/' + roomId + '/posts?filter=unanswered');
  check('待回答筛选', r.json.ok && r.json.data.list.every((p) => p.kind === 'question' && !p.answered),
    r.json.data.list.length + ' 条');

  console.log('\n=== 社交与运营 ===');

  r = await call('GET', '/api/plaza');
  check('广场数据', r.json.ok && r.json.data.hotRooms.length > 0, '热榜 ' + r.json.data.hotRooms.length + ' 条');

  r = await call('GET', '/api/stats');
  check('统计接口', r.json.ok && r.json.data.buckets.length === 24, '24 小时曲线');

  r = await call('GET', '/api/rooms/' + roomId + '/visits');
  check('访客墙', r.json.ok, r.json.data.total + ' 次访问');

  r = await call('GET', '/api/reports');
  check('举报列表', r.json.ok, r.json.data.total + ' 条待处理');

  const reportId = r.json.data.list[0] && r.json.data.list[0].id;
  if (reportId) {
    r = await call('POST', '/api/reports/' + reportId + '/resolve', { action: 'dismiss' });
    check('处理举报', r.json.ok);
  }

  r = await call('GET', '/api/messages');
  check('通知列表', r.json.ok, r.json.data.list.length + ' 条');

  r = await call('GET', '/api/auth/me');
  check('获取当前用户', r.json.ok, r.json.data.nickname);

  r = await call('PUT', '/api/drafts', { roomId: roomId, text: '草稿内容' });
  check('保存草稿', r.json.ok);
  r = await call('GET', '/api/drafts');
  check('读取草稿', r.json.ok && r.json.data.list.length > 0, r.json.data.list.length + ' 条');

  r = await call('PATCH', '/api/rooms/' + roomId, { title: '改名后的测试局' });
  check('主人可修改房间', r.json.ok && r.json.data.title === '改名后的测试局');

  r = await call('PATCH', '/api/rooms/' + roomId, { closed: true });
  check('关闭坦白局', r.json.ok && r.json.data.state === 'closed');

  r = await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: '关闭后还能提问吗' });
  check('关闭后拒绝提问', !r.json.ok, r.json.message);

  r = await call('GET', '/api/export');
  check('数据导出', !!r.json);

  r = await call('GET', '/api/nothing-here');
  check('未知接口返回 404', r.status === 404);

  r = await call('GET', '/api/rooms/notexist123');
  check('不存在的房间返回 404', r.status === 404);

  console.log('\n=== 静态资源 ===');
  const html = await fetch(B + '/');
  const htmlText = await html.text();
  check('首页 HTML 可访问', html.status === 200 && htmlText.indexOf('坦白局') !== -1);

  for (const f of ['/js/app.js', '/js/core/ui.js', '/js/modules/room.js', '/css/base.css', '/assets/favicon.svg']) {
    const res = await fetch(B + f);
    check('静态文件 ' + f, res.status === 200);
  }

  const spa = await fetch(B + '/some/deep/route');
  check('SPA 路由回落', spa.status === 200);

  console.log('\n================================');
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   失败 ' + fail + ' 项' : '   全部通过'));
  console.log('================================\n');
  process.exit(fail ? 1 : 0);
})();
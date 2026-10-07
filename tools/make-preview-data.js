/**
 * 造一批真实感的数据，用于本地预览视觉效果。
 * 不会进Git（data/ 已忽略），也不是演示数据灌入逻辑，只是手动预览用。
 *
 * 用法：node tools/make-preview-data.js
 */

const B = 'http://127.0.0.1:8848';
let cookie = '';
const device = 'preview' + Math.random().toString(36).slice(2, 10);

async function call(method, path, body) {
  const res = await fetch(B + path, {
    method: method,
    headers: Object.assign(
      { 'Content-Type': 'application/json', 'x-device-id': device },
      cookie ? { cookie: cookie } : {}
    ),
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return res.json();
}

const ROOMS = [
  {
    title: '小满的坦白局',
    subtitle: '关于生活的 20 个问题',
    theme: 'yellow',
    tags: ['生活', '成长'],
    days: 3,
    q: [
      '你现在最后悔的决定是什么？',
      '有没有一个瞬间，你觉得全世界都误解了你？',
      '如果明天必须离开这座城市，你最想带走什么？',
      '你偷偷羡慕过身边哪个人？',
      '你觉得自己最大的缺点是什么？',
      '有什么爱好是你一直藏着没告诉别人的？',
    ],
    a: [
      '后悔高三那年为了面子选了文科，其实我真正想读的是建筑。',
      '有。误会了三年才说开，这件事教会我别把猜测当答案。',
      '想带走我那台用了八年的笔记本，它存着我所有的日记。',
      '羡慕那个敢当场拒绝领导的人，而我只会等散会再难受。',
    ],
  },
  {
    title: '阿泽の树洞',
    subtitle: '不问工作，只问心情',
    theme: 'mint',
    tags: ['情绪', '树洞'],
    days: 2,
    q: [
      '最近让你半夜睡不着的是什么？',
      '现在的日子和你二十五岁时的想象差多少？',
      '什么是你现在最不敢面对的事？',
    ],
    a: [
      '是我爸体检报告上那个箭头。他自己不查，我不敢问。',
      '差很远，但我不再为此道歉了。',
    ],
  },
  {
    title: '毕业季大调查',
    subtitle: '关于未来的 15 问',
    theme: 'lilac',
    tags: ['未来', '校园'],
    days: 7,
    q: [
      '你毕业后第一份工作想做什么？',
      '你更想要稳定还是更想要自由？',
      '你理想中的生活一天是怎么过的？',
      '如果只能带一样东西去陌生城市，你带什么？',
    ],
    a: ['想去一家不需要开会的公司，做产品。', '稳定。但我要那种我自己选的稳定。'],
  },
];

(async () => {
  await call('POST', '/api/auth/guest');

  for (const spec of ROOMS) {
    const created = await call('POST', '/api/rooms', {
      title: spec.title,
      subtitle: spec.subtitle,
      theme: spec.theme,
      tags: spec.tags,
      days: spec.days,
      rules: { onePerGuest: false, allowVoice: true },
    });
    if (!created.ok) {
      console.log('建房失败:', spec.title, created.message);
      continue;
    }
    const roomId = created.data.id;
    console.log('已建:', spec.title);

    for (const text of spec.q) {
      await call('POST', '/api/rooms/' + roomId + '/posts', { kind: 'question', text: text });
    }

    const list = await call('GET', '/api/rooms/' + roomId + '/posts');
    const questions = (list.data.list || []).filter((p) => p.kind === 'question');
    for (let i = 0; i < Math.min(spec.a.length, questions.length); i++) {
      await call('POST', '/api/posts/' + questions[i].id + '/answer', { text: spec.a[i] });
    }

    // 给部分内容加热度，让热榜与排序有变化
    const posts = await call('GET', '/api/rooms/' + roomId + '/posts');
    for (let i = 0; i < Math.min(3, (posts.data.list || []).length); i++) {
      for (let k = 0; k < i + 1; k++) {
        await call('POST', '/api/posts/' + posts.data.list[i].id + '/react', { type: 'heart' });
      }
    }
  }

  const health = await fetch(B + '/api/health').then((r) => r.json());
  console.log('\n完成:', JSON.stringify(health.data.counts));
})();
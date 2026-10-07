/**
 * 浏览器端冒烟测试：用最小 DOM 垫片加载真实前端脚本，
 * 验证关键交互能跑通、图标能正确注入、页面能渲染。
 * 目的：在没有浏览器的环境下，仍能验证前端逻辑而不只是「看起来没问题」。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE = process.env.BASE || 'http://127.0.0.1:8848';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
}

/* ---------- 极简 DOM 垫片 ---------- */
class Node {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.classList = makeClassList(this);
    this._text = '';
    this._html = '';
    this.parentNode = null;
    this.listeners = {};
  }
  get className() { return this.attrs['class'] || ''; }
  set className(v) { this.attrs['class'] = v; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  appendChild(child) {
    if (child === null || child === undefined || child === false) return child;
    const node = typeof child === 'string' ? new Node('#text') : child;
    if (typeof child === 'string') node.textContent = child;
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  appendChild2() { return this; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
  removeEventListener() {}
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); } }
  querySelector(sel) { return findAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return findAll(this, sel); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 40, right: 100, bottom: 40 }; }
  closest() { return null; }
  focus() {}
  click() { (this.listeners.click || []).forEach((fn) => fn({ target: this, stopPropagation() {}, preventDefault() {} })); }
  contains() { return true; }
  count(sel) { return findAll(this, sel).length; }
}

function makeClassList(node) {
  const list = () => String(node.attrs['class'] || '').split(/\s+/).filter(Boolean);
  const write = (arr) => { node.attrs['class'] = arr.join(' '); };
  return {
    add(...c) { write(Array.from(new Set(list().concat(c)))); },
    remove(...c) { write(list().filter((x) => !c.includes(x))); },
    toggle(c, force) {
      const has = list().includes(c);
      const want = force === undefined ? !has : !!force;
      if (want && !has) write(list().concat(c));
      if (!want && has) write(list().filter((x) => x !== c));
      return want;
    },
    contains(c) { return list().includes(c); },
  };
}

function findAll(root, sel) {
  const out = [];
  const match = (n) => {
    if (sel.startsWith('.')) return String(n.attrs['class'] || '').split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith('#')) return n.attrs.id === sel.slice(1);
    if (sel.startsWith('[')) {
      const m = /^\[([^=\]]+)(?:="?([^"\]]*)"?)?\]$/.exec(sel);
      if (m) return m[2] === undefined ? m[1] in n.attrs : n.attrs[m[1]] === m[2];
    }
    return n.tagName === sel.toUpperCase();
  };
  (function walk(n) {
    n.children.forEach((c) => {
      if (match(c)) out.push(c);
      walk(c);
    });
  })(root);
  return out;
}

const doc = new Node('document');
doc.createElement = (t) => new Node(t);
doc.createElementNS = (ns, t) => new Node(t);
doc.createTextNode = (s) => { const n = new Node('#text'); n.textContent = s; return n; };
doc.body = new Node('body');
doc.documentElement = new Node('html');
doc.documentElement.setAttribute = function (k, v) { this.attrs[k] = v; };
doc.documentElement.removeAttribute = function (k) { delete this.attrs[k]; };
doc.getElementById = (id) => findAll(doc.body, '#' + id)[0] || null;
doc.addEventListener = () => {};
doc.head = new Node('head');

const localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; },
};

const win = {
  document: doc,
  localStorage: localStorage,
  location: { hash: '#/home', pathname: '/', origin: BASE, search: '' },
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  console: console,
  fetch: (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o),
  addEventListener: () => {},
  scrollTo: () => {},
  matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} }),
  URLSearchParams: URLSearchParams,
  Audio: function () { this.play = async () => {}; this.pause = () => {}; },
};
win.window = win;
win.globalThis = win;
win.self = win;

/* ---------- 加载真实前端脚本 ---------- */
const FILES = [
  'public/vendor/qr.js',
  'public/js/core/icons.js',
  'public/js/core/store.js',
  'public/js/core/ui.js',
  'public/js/core/local-data.js',
  'public/js/core/supabase-data.js',
  'public/js/core/api.js',
  'public/js/core/router.js',
  'public/js/core/qr-view.js',
  'public/js/modules/home.js',
  'public/js/modules/room.js',
  'public/js/modules/create.js',
  'public/js/modules/me.js',
  'public/js/modules/messages.js',
  'public/js/modules/social.js',
  'public/js/modules/login.js',
];

const sandbox = vm.createContext(win);
// 本沙箱没有真实 IndexedDB / 同源 fetch，强制走 server 模式打真实接口，
// 避免误测到 local-data.js 的离线分支。
win.__forceBackend = 'server';
for (const f of FILES) {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f });
  } catch (err) {
    console.log('  FAIL  加载 ' + f + ': ' + err.message);
    fail++;
  }
}

/* ---------- 断言 ---------- */
(async function run() {
  console.log('\n=== 前端加载 ===');
  check('核心模块挂载', typeof win.ui === 'object' && typeof win.router === 'object');
  check('图标系统挂载', typeof win.icon === 'function' && typeof win.iconHTML === 'function');
  check('二维码挂载', typeof win.QR === 'object' && typeof win.QR.toSvg === 'function');

  console.log('\n=== 图标注入 ===');
  const ic = win.icon('heart', 16);
  check('图标生成 DOM 节点', ic.tagName === 'I' && ic.className.indexOf('hicon') >= 0);
  check('图标带 mask-image', String(ic.style.webkitMaskImage || ic.style.maskImage).indexOf('heart.png') > 0);
  check('图标尺寸正确', ic.style.width === '16px' && ic.style.height === '16px');
  const svgHtml = win.iconHTML('star', 20);
  check('iconHTML 输出可用', svgHtml.indexOf('star.png') > 0 && svgHtml.indexOf('mask-image') > 0);

  // 校验每个引用的图标文件真实存在
  const dir = path.join(__dirname, '..', 'public', 'assets', 'icons');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.replace('.png', ''));
  check('图标文件齐全（28 个）', names.length >= 28, names.length + ' 个');
  const used = ['heart', 'check', 'send', 'mic', 'bell', 'chevron', 'user', 'search', 'sparkle', 'close', 'home', 'plus'];
  const missing = used.filter((n) => !names.includes(n));
  check('代码引用的图标均存在', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '全部命中');

  console.log('\n=== UI 组件 ===');
  const toastNode = win.ui.toast('测试');
  check('toast 生成节点', !!toastNode && toastNode.tagName === 'DIV');
  const t0 = win.ui.timeAgo(Date.now() - 5 * 60000);
  check('timeAgo 相对时间', t0 === '5 分钟前', t0);
  const cd = win.ui.countdownParts(Date.now() + 3661000);
  check('倒计时拆分', cd.h === 1 && cd.m === 1 && cd.s === 1, cd.h + ':' + cd.m + ':' + cd.s);
  check('fmtCount 千分位', win.ui.fmtCount(999) === '999' && win.ui.fmtCount(1500) === '1.5k', win.ui.fmtCount(1500));
  check('esc 转义', win.ui.esc('<b>&"') === '&lt;b&gt;&amp;&quot;');

  console.log('\n=== 二维码（浏览器路径）===');
  const qrSvg = win.QRSvg(BASE + '/#/room/abc123', { margin: 1 });
  check('QRSvg 生成成功', qrSvg.indexOf('<svg') === 0 && qrSvg.length > 500, qrSvg.length + ' 字符');
  check('二维码含可扫模块', qrSvg.indexOf('<path') > 0);

  console.log('\n=== API 客户端 ===');
  try {
    const rooms = await win.api.rooms();
    check('api.rooms 拉取成功', rooms.list.length > 0, rooms.list.length + ' 场');
    const room = rooms.list[0];
    const detail = await win.api.room(room.id);
    check('api.room 详情成功', !!detail.id && typeof detail.counts === 'object',
      detail.counts.questions + ' 问');
    const posts = await win.api.posts(room.id);
    check('api.posts 列表成功', Array.isArray(posts.list), posts.list.length + ' 条');
    const filtered = await win.api.posts(room.id, { filter: 'unanswered' });
    check('筛选参数生效', filtered.list.every((p) => !p.answered), filtered.list.length + ' 条待答');
    const plaza = await win.api.plaza();
    check('api.plaza 热榜', Array.isArray(plaza.hotRooms));
    const stats = await win.api.stats();
    check('api.stats 24 小时曲线', stats.buckets.length === 24);
  } catch (err) {
    check('API 调用', false, err.message);
  }

  console.log('\n=== 视图渲染 ===');
  const view = doc.createElement('main');
  doc.body.appendChild(view);
  try {
    await win.viewHome(view, {});
    const text = view.textContent;
    check('首页渲染出内容', text.length > 20, text.slice(0, 30).replace(/\s+/g, ' '));
    check('首页含坦白局卡片', view.querySelectorAll('.room-card').length > 0,
      view.querySelectorAll('.room-card').length + ' 张卡片');
  } catch (err) {
    check('首页渲染', false, err.message);
  }

  // 房间页
  try {
    const list = await win.api.rooms();
    const rid = list.list[0].id;
    const rv = doc.createElement('main');
    doc.body.appendChild(rv);
    await win.viewRoom(rv, { id: rid });
    const t = rv.textContent;
    check('房间页渲染', t.length > 40);
    check('房间页含聊天气泡', rv.querySelectorAll('.bubble').length > 0,
      rv.querySelectorAll('.bubble').length + ' 个气泡');
    check('房间页含提问框', rv.querySelectorAll('.ask-box').length > 0);
  } catch (err) {
    check('房间页渲染', false, err.message);
  }

  console.log('\n================================');
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   失败 ' + fail : '   全部通过'));
  console.log('================================\n');
  process.exit(fail ? 1 : 0);
})();
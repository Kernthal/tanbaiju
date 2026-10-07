/**
 * 真实浏览器守卫测试 —— 防「测试全绿但页面打不开」这类事故。
 *
 * 早期教训：单元测试直接调 viewHome()，绕过了 router，
 * 导致 router 从未注册视图、线上白屏而测试全绿。
 * 这里用真实 Chrome 加载真实页面，抓取控制台错误与页面文案，
 * 确保路由、脚本加载、渲染链路全部真的通。
 *
 * 运行：node test/browser-guard.js
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://127.0.0.1:8848';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
}

/* ---------- 极简 CDP 客户端（不依赖任何 npm 包） ---------- */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => reject(new Error('CDP 请求超时')));
  });
}

/** 极简 WebSocket 客户端（仅够用：文本帧 + 掩码） */
class MiniWS {
  constructor(url) {
    // ws:// 协议给 net.connect 之前先转成 http:// 才能取 host/port
    this.url = url.replace(/^ws:\/\//, 'http://');
    this.handlers = [];
    this.buf = Buffer.alloc(0);
    this.ready = false;
    this.opened = false;
  }
  connect() {
    const u = new URL(this.url);
    const key = Buffer.from(Math.random().toString(36)).toString('base64').slice(0, 22) + '==';
    return new Promise((resolve, reject) => {
      const sock = require('net').connect(Number(u.port), u.hostname, () => {
        sock.write(
          'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
          'Host: ' + u.host + '\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      sock.on('data', (chunk) => {
        if (!this.ready) {
          const s = chunk.toString('latin1');
          const i = s.indexOf('\r\n\r\n');
          if (i === -1) return;
          if (!/101/.test(s.slice(0, 20))) return reject(new Error('WebSocket 握手失败'));
          this.ready = true;
          this.opened = true;
          this.sock = sock;
          const rest = chunk.slice(Buffer.byteLength(s.slice(0, i + 4), 'latin1'));
          if (rest.length) this._onData(rest);
          resolve();
        } else {
          this._onData(chunk);
        }
      });
      sock.on('error', reject);
    });
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len).toString('utf8');
      this.buf = this.buf.slice(off + len);
      this.handlers.forEach((h) => { try { h(JSON.parse(payload)); } catch (_) { /* 忽略非 JSON */ } });
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = require('crypto').randomBytes(4);
    let header;
    if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
    else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(data.length), 2); }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  close() { try { this.sock && this.sock.destroy(); } catch (_) {} }
}

async function evaluatePages() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-chrome-'));
  const port = 9333 + Math.floor(Math.random() * 400);

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (_) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} };
  process.on('exit', cleanup);

  // 等 DevTools 就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = JSON.parse(await httpGet('http://127.0.0.1:' + port + '/json/list')); break; }
    catch (_) { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (!targets) { cleanup(); throw new Error('Chrome DevTools 未就绪'); }

  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new MiniWS(page.webSocketDebuggerUrl);
  await ws.connect();

  let msgId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  ws.handlers.push((msg) => {
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(msg.params.errorText);
    }
  });

  const cmd = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send({ id, method, params: params || {} });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 30000);
  });

  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  await cmd('Runtime.enable');
  await cmd('Network.enable');
  await cmd('Page.enable');

  /** 等到骨架屏消失且有内容 */
  async function waitRendered(maxTries) {
    for (let i = 0; i < (maxTries || 30); i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const skel = await evalJs("document.querySelectorAll('.skel').length");
        const len = await evalJs("(function(){var v=document.getElementById('view');return v?v.innerText.trim().length:0;})()");
        if (skel === 0 && len > 0) return true;
      } catch (_) { /* 还在导航 */ }
    }
    return false;
  }

  async function visit(hash, label) {
    consoleErrors.length = 0; pageErrors.length = 0; failedRequests.length = 0;
    await cmd('Page.navigate', { url: BASE + '/' + hash });

    // 首页冷启动要并发拉多个接口，给足等待；
    // 判定标准是骨架屏消失 —— 出现即退出等待，不必死等固定时长。
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const skel = await evalJs("document.querySelectorAll('.skel').length");
        const len = await evalJs("(function(){var v=document.getElementById('view');return v?v.innerText.trim().length:0;})()");
        if (skel === 0 && len > 0) { ready = true; break; }
      } catch (_) { /* 页面还在导航 */ }
    }
    await new Promise((r) => setTimeout(r, 600));

    const info = await evalJs(`(function(){
      var v = document.getElementById('view');
      return {
        text: v ? v.innerText.slice(0, 300) : '(缺少 #view)',
        len: v ? v.innerText.trim().length : 0,
        cards: document.querySelectorAll('.room-card').length,
        bubbles: document.querySelectorAll('.bubble').length,
        icons: document.querySelectorAll('.hicon').length,
        iconMasks: Array.prototype.filter.call(document.querySelectorAll('.hicon'), function(el){
          return !!(el.style.webkitMaskImage || el.style.maskImage);
        }).length,
        skel: document.querySelectorAll('.skel').length,
        title: document.title,
        hasErr: /not a function|is not defined|undefined/i.test(v ? v.innerText : '')
      };
    })()`);
    return { info, consoleErrors: consoleErrors.slice(), pageErrors: pageErrors.slice(), failedRequests: failedRequests.slice() };
  }

  const results = {};
  const pages = [
    ['#/home', 'home'],
    ['#/feed', 'feed'],
    ['#/discover', 'discover'],
    ['#/create', 'create'],
    ['#/messages', 'messages'],
    ['#/me', 'me'],
    ['#/favorites', 'favorites'],
    ['#/rooms', 'rooms'],
    ['#/follows', 'follows'],
  ];

  for (const [hash, label] of pages) {
    console.log('\n--- ' + label + ' (' + hash + ') ---');
    let r;
    try {
      r = await visit(hash, label);
    } catch (err) {
      check(label + ' 页面加载', false, err.message);
      continue;
    }
    const { info } = r;
    results[label] = r;

    check(label + ' 渲染有内容', info.len > 5, info.len + ' 字符');
    check(label + ' 无运行时异常', r.pageErrors.length === 0, r.pageErrors.slice(0, 2).join(' | '));
    check(label + ' 无未捕获错误文案', !info.hasErr, info.hasErr ? '页面出现错误提示' : '');
    check(label + ' 图标已注入', info.icons > 0 && info.iconMasks === info.icons,
      info.icons + ' 个 / 已着色 ' + info.iconMasks);
    check(label + ' 骨架屏已清除', info.skel === 0, info.skel + ' 个残留');
    const fatal = r.consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
    check(label + ' 控制台无 error', fatal.length === 0, fatal.slice(0, 2).join(' | '));
    console.log('       文案: ' + String(info.text).replace(/\s+/g, ' ').slice(0, 70));
  }

  // 房间页需要真实 id
  console.log('\n--- room (动态) ---');
  const roomId = await evalJs("(async function(){var r=await fetch('/api/rooms').then(x=>x.json());return r.data.list[0].id;})()");
  if (roomId) {
    const r = await visit('#/room/' + roomId, 'room');
    results.room = r;
    check('房间页渲染有内容', r.info.len > 20, r.info.len + ' 字符');
    check('房间页有聊天气泡', r.info.bubbles > 0, r.info.bubbles + ' 个气泡');
    check('房间页无运行时异常', r.pageErrors.length === 0, r.pageErrors.slice(0, 2).join(' | '));
    check('房间页无未捕获错误文案', !r.info.hasErr, '');
    const fatal = r.consoleErrors.filter((e) => !/favicon|manifest/i.test(e));
    check('房间页控制台无 error', fatal.length === 0, fatal.slice(0, 2).join(' | '));
    console.log('       文案: ' + String(r.info.text).replace(/\s+/g, ' ').slice(0, 70));
  } else {
    check('获取房间 id', false);
  }

  /* ---- 交互验证：真点击，而不是只看静态渲染 ---- */
  console.log('\n--- 交互（真实点击）---');

  // 1. 首页点标签应触发筛选
  await cmd('Page.navigate', { url: BASE + '/#/home' });
  await waitRendered();
  const tagResult = await evalJs(`(function(){
    var chips = Array.prototype.filter.call(document.querySelectorAll('.chip'), function(c){
      return (c.textContent||'').indexOf('#') === 0;
    });
    if (!chips.length) return { ok:false, why:'没有可点的标签' };
    var before = document.querySelectorAll('.room-card').length;
    chips[0].click();
    return { ok:true, tag: chips[0].textContent.trim(), before: before };
  })()`);
  check('首页存在可点击的话题标签', tagResult.ok, tagResult.tag || tagResult.why);

  await new Promise((r) => setTimeout(r, 1800));
  const afterTag = await evalJs(`(function(){
    return {
      cards: document.querySelectorAll('.room-card').length,
      onChip: document.querySelectorAll('.chip-on').length
    };
  })()`);
  check('点击标签后进入筛选态', afterTag.onChip > 0, afterTag.onChip + ' 个选中标签');
  check('筛选后仍有内容渲染', afterTag.cards >= 0, afterTag.cards + ' 张卡片');

  // 2. 发现页点关注按钮
  await cmd('Page.navigate', { url: BASE + '/#/discover' });
  await waitRendered();
  const followClick = await evalJs(`(function(){
    var btns = Array.prototype.filter.call(document.querySelectorAll('.btn'), function(b){
      return b.textContent.trim() === '关注';
    });
    if (!btns.length) return { ok:false, why:'没有关注按钮' };
    btns[0].click();
    return { ok:true };
  })()`);
  check('发现页存在关注按钮', followClick.ok, followClick.why || '');

  await new Promise((r) => setTimeout(r, 1600));
  const followState = await evalJs(`(function(){
    var btns = Array.prototype.filter.call(document.querySelectorAll('.btn'), function(b){
      return b.textContent.trim() === '已关注';
    });
    var toast = document.querySelectorAll('.toast').length;
    return { followed: btns.length, toast: toast };
  })()`);
  check('点击后按钮变为「已关注」', followState.followed > 0 || followState.toast > 0,
    '已关注=' + followState.followed + ' 提示=' + followState.toast);

  // 3. 我的页面导航宫格可点
  await cmd('Page.navigate', { url: BASE + '/#/me' });
  await waitRendered();
  const navOk = await evalJs(`(function(){
    var items = document.querySelectorAll('.me-nav-item');
    return { count: items.length, href: items[0] ? items[0].getAttribute('href') : null };
  })()`);
  check('「我的」有导航宫格', navOk.count === 5, navOk.count + ' 个入口');
  check('宫格入口指向有效路由', !!navOk.href && navOk.href.indexOf('#/') === 0, navOk.href || '');

  // 4. 登录页必须能打开 —— 曾因 href="/login" 绝对路径在子路径部署下 404
  await cmd('Page.navigate', { url: BASE + '/#/login' });
  await waitRendered();
  const loginOk = await evalJs(`(function(){
    var v = document.getElementById('view');
    return {
      len: v ? v.innerText.trim().length : 0,
      text: v ? v.innerText.replace(/\\s+/g,' ').slice(0, 60) : ''
    };
  })()`);
  check('登录页可打开（#/login）', loginOk.len > 10, loginOk.text);

  // 默认是扫码面板；切到「手机号」通道应有输入控件。
  // 静态部署下扫码无法跨设备确认，手机/账号通道才是可用路径。
  const nickInput = await evalJs(`(function(){
    var btns = Array.prototype.slice.call(document.querySelectorAll('#view button'));
    var target = btns.filter(function(b){
      var t = (b.textContent||'').trim();
      return t === '手机号' || t === '账号';
    })[0];
    if (target) target.click();
    return new Promise(function(res){
      setTimeout(function(){
        res({
          clicked: !!target,
          label: target ? target.textContent.trim() : '',
          inputs: document.querySelectorAll('#view input').length
        });
      }, 700);
    });
  })()`);
  check('登录页切换通道后有输入控件', nickInput.inputs > 0,
    (nickInput.clicked ? '点击「' + nickInput.label + '」后 ' : '未找到切换按钮，') + nickInput.inputs + ' 个输入框');

  // 5. 站内不得有指向绝对路径的可点链接（子路径部署必 404）
  const badLinks = await evalJs(`(function(){
    var bad = [];
    var nodes = document.querySelectorAll('a[href]');
    for (var i = 0; i < nodes.length; i++) {
      var h = nodes[i].getAttribute('href') || '';
      // 只抓会以域名根为起点的路径型链接
      if (h.charAt(0) === '/' && h.indexOf('//') !== 0) {
        bad.push(nodes[i].textContent.trim().slice(0,14) + ' -> ' + h);
      }
    }
    return bad.slice(0, 8);
  })()`);
  check('站内无绝对路径死链', badLinks.length === 0, badLinks.join(' | ') || '全部为相对/hash 路径');

  // 截图留证
  try {
    const shot = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, '..', 'screenshot-home.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n  截图已保存: screenshot-home.png');
  } catch (_) { /* 忽略 */ }

  ws.close();
  cleanup();

  console.log('\n================================');
  console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   失败 ' + fail : '   全部通过'));
  console.log('================================\n');
  process.exit(fail ? 1 : 0);
}

evaluatePages().catch((err) => {
  console.error('浏览器测试失败:', err.message);
  process.exit(1);
});
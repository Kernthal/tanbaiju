/**
 * 在真实浏览器里手动走一遍注册流程，逐步打印状态。
 * 用来定位 browser-guard 里那个「找不到账号按钮」到底卡在哪一步。
 *
 * 用法：node tools/diag-login-flow.js
 */

const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8848';

function get(u) {
  return new Promise((res, rej) => {
    const q = new URL(u);
    http.get({ hostname: q.hostname, port: q.port, path: q.pathname + q.search }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => res(s));
    }).on('error', rej);
  });
}

class WS {
  constructor(u) { this.url = u.replace(/^ws:\/\//, 'http://'); this.h = []; this.buf = Buffer.alloc(0); }
  connect() {
    const u = new URL(this.url);
    const key = Buffer.from(Math.random().toString(36)).toString('base64').slice(0, 22) + '==';
    return new Promise((resolve, reject) => {
      const sock = require('net').connect(+u.port, u.hostname, () => {
        sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host +
          '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
          '\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      sock.on('data', (c) => {
        if (!this.ready) {
          const s = c.toString('latin1');
          const i = s.indexOf('\r\n\r\n');
          if (i === -1) return;
          if (!/101/.test(s.slice(0, 20))) return reject(new Error('handshake'));
          this.ready = true; this.sock = sock; resolve();
        } else this.onD(c);
      });
      sock.on('error', reject);
    });
  }
  onD(c) {
    this.buf = Buffer.concat([this.buf, c]);
    for (;;) {
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const p = this.buf.slice(off, off + len).toString('utf8');
      this.buf = this.buf.slice(off + len);
      this.h.forEach((x) => { try { x(JSON.parse(p)); } catch (e) { /* ignore */ } });
    }
  }
  send(o) {
    const d = Buffer.from(JSON.stringify(o), 'utf8');
    const m = require('crypto').randomBytes(4);
    let hd;
    if (d.length < 126) hd = Buffer.from([0x81, 0x80 | d.length]);
    else if (d.length < 65536) { hd = Buffer.alloc(4); hd[0] = 0x81; hd[1] = 0xfe; hd.writeUInt16BE(d.length, 2); }
    else { hd = Buffer.alloc(10); hd[0] = 0x81; hd[1] = 0xff; hd.writeBigUInt64BE(BigInt(d.length), 2); }
    const mk = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) mk[i] = d[i] ^ m[i % 4];
    this.sock.write(Buffer.concat([hd, m, mk]));
  }
}

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lf-'));
  const port = 9300 + Math.floor(Math.random() * 90);
  const ch = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
    '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 40; i++) {
    try { t = JSON.parse(await get('http://127.0.0.1:' + port + '/json/list')); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 400)); }
  }
  const ws = new WS((t.find((x) => x.type === 'page') || t[0]).webSocketDebuggerUrl);
  await ws.connect();

  let id = 0;
  const pend = new Map();
  const logs = [];
  ws.h.push((m) => {
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + ((d.exception && d.exception.description) || d.text));
    }
  });
  const cmd = (me, pa) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { resolve: res, reject: rej });
    ws.send({ id: i, method: me, params: pa || {} });
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error(me + ' timeout')); } }, 30000);
  });
  const ev = async (e) => {
    const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' +
      ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''));
    return r.result.value;
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Page.navigate', { url: BASE + '/#/login' });
  await new Promise((r) => setTimeout(r, 4500));

  console.log('=== 逐步走注册流程 ===\n');

  const step = async (label, expr) => {
    const r = await ev(expr);
    console.log(label + ': ' + JSON.stringify(r).slice(0, 300));
    return r;
  };

  await step('1. location.hash', 'location.hash');
  await step('2. #view 是否存在', '!!document.getElementById("view")');
  await step('3. 当前按钮列表', `(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('#view button'));
    return b.map(function(x){ return (x.textContent||'').trim(); });
  })()`);
  await step('4. store.me', 'window.store && window.store.me ? window.store.me.nickname : null');
  await step('3b. enterApp 是否已定义', 'typeof window.enterApp');
  await step('3c. router 是否已启动', 'window.router ? !!window.router.started() : "no-router"');
  await step('3d. app class', `(function(){
    var a = document.querySelector('.app');
    return a ? a.className : 'no-app';
  })()`);
  await step('5. 切到账号', `(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('#view button'))
      .filter(function(x){ return (x.textContent||'').trim() === '账号'; })[0];
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await step('6. 账号通道按钮', `(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('#view button'));
    return b.map(function(x){ return (x.textContent||'').trim(); });
  })()`);
  await step('7. 点去注册', `(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('#view button'))
      .filter(function(x){ return (x.textContent||'').indexOf('去注册') >= 0; })[0];
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  await step('8. 注册态按钮与输入框', `(function(){
    var b = Array.prototype.slice.call(document.querySelectorAll('#view button'));
    var i = document.querySelectorAll('#view input');
    return {
      buttons: b.map(function(x){ return (x.textContent||'').trim(); }),
      inputs: i.length,
      placeholders: Array.prototype.slice.call(i).map(function(x){ return x.placeholder; })
    };
  })()`);

  const regResult = await step('9. 填表并提交', `(async function(){
    function btns(){ return Array.prototype.slice.call(document.querySelectorAll('#view button')); }
    function setVal(input, v){
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var inputs = document.querySelectorAll('#view input');
    if (inputs.length < 3) return { why: '输入框不足 ' + inputs.length };
    var stamp = Date.now().toString().slice(-8);
    setVal(inputs[0], 'dg' + stamp);
    setVal(inputs[1], 'abc123456');
    setVal(inputs[2], '诊断员');
    // 确认值真的落进去了 —— 上一次失败就是因为这里值是空的
    var values = Array.prototype.slice.call(inputs).map(function(x){ return x.value; });
    var submit = btns().filter(function(x){
      return (x.textContent||'').indexOf('注册并登录') >= 0;
    })[0];
    if (!submit) return { why: '无提交按钮' };
    // 直接调 onclick，排除 CDP click 的行为差异
    submit.onclick();
    await wait(1200);
    var toasts = Array.prototype.slice.call(document.querySelectorAll('.toast'))
      .map(function(t){ return (t.textContent||'').trim(); });
    for (var i = 0; i < 24; i++) {
      await wait(250);
      if ((location.hash||'').indexOf('#/home') === 0) break;
    }
    var el = document.getElementById('userName');
    return {
      values: values,
      toastsAfterOnclick: toasts,
      hash: location.hash,
      nick: el ? el.textContent : '',
      me: window.store && window.store.me ? window.store.me.nickname : null,
      appClass: (function(){
        var a = document.querySelector('.app');
        return a ? a.className : 'no-app';
      })(),
      routerStarted: window.router ? window.router.started() : null
    };
  })()`);

  console.log('\n注册结果: ' + JSON.stringify(regResult));
  if (logs.length) {
    console.log('\n=== 控制台 ===');
    logs.slice(0, 12).forEach((l) => console.log('  ' + l.slice(0, 200)));
  }

  ws.sock.destroy();
  ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})();
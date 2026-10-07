/**
 * 移动端横向溢出诊断：找出所有超出视口宽度的元素。
 * 用法：node tools/diag-overflow.js [宽度]
 */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = Number(process.argv[2] || 390);
const H = Number(process.argv[3] || 844);
const ROUTES = (process.argv[4] || '#/home,#/me,#/discover,#/create').split(',');

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
  constructor(u) {
    this.url = u.replace(/^ws:\/\//, 'http://');
    this.h = []; this.buf = Buffer.alloc(0);
  }
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
    else { hd = Buffer.alloc(4); hd[0] = 0x81; hd[1] = 0xfe; hd.writeUInt16BE(d.length, 2); }
    const mk = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) mk[i] = d[i] ^ m[i % 4];
    this.sock.write(Buffer.concat([hd, m, mk]));
  }
}

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-of-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const ch = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
    '--window-size=' + W + ',' + H, 'about:blank',
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
  ws.h.push((m) => {
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const cmd = (me, pa) => new Promise((resolve, reject) => {
    const i = ++id;
    pend.set(i, { resolve, reject });
    ws.send({ id: i, method: me, params: pa || {} });
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error(me + ' timeout')); } }, 25000);
  });
  const ev = async (e) => {
    const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: true,
  });

  const PROBE = `(function(){
    var vw = document.documentElement.clientWidth;
    var bad = [];
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1) {
        var cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
        bad.push({
          tag: el.tagName.toLowerCase(),
          cls: String(cls).slice(0, 60),
          right: Math.round(r.right),
          width: Math.round(r.width),
          text: (el.textContent || '').trim().slice(0, 24)
        });
      }
    }
    return {
      vw: vw,
      scrollW: document.documentElement.scrollWidth,
      bodyScrollW: document.body.scrollWidth,
      overflow: bad.slice(0, 14),
      total: bad.length
    };
  })()`;

  for (const route of ROUTES) {
    await cmd('Page.navigate', { url: 'http://127.0.0.1:8848/' + route });
    await new Promise((r) => setTimeout(r, 3200));
    const info = await ev(PROBE);
    const bad = info.scrollW > info.vw;
    console.log('\n--- ' + route + ' @' + W + 'px ---');
    console.log('  视口宽: ' + info.vw + '  文档滚动宽: ' + info.scrollW + '  body滚动宽: ' + info.bodyScrollW);
    console.log(bad ? '  ✗ 存在横向溢出 ' + info.total + ' 处:' : '  ✓ 无横向溢出');
    if (info.overflow.length) {
      info.overflow.forEach((x) => {
        console.log('     <' + x.tag + ' class="' + x.cls + '"> right=' + x.right + ' w=' + x.width + '  "' + x.text + '"');
      });
    }
  }

  ws.sock.destroy();
  ch.kill();
  process.exit(0);
})();
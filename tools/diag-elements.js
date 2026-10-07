/**
 * 列出页面里所有可点元素及其文本，用于定位选择器写错的问题。
 * 用法：node tools/diag-elements.js [hash]
 */

const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8848';
const HASH = process.argv[2] || '#/login';

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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-el-'));
  const port = 9200 + Math.floor(Math.random() * 90);
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
  ws.h.push((m) => {
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Page.navigate', { url: BASE + '/' + HASH });
  await new Promise((r) => setTimeout(r, 4500));

  const out = await ev(`(function(){
    function where(el){
      var s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className) s += '.' + String(el.className).trim().split(/\\s+/).join('.');
      return s;
    }
    var view = document.getElementById('view');
    if (!view) return { rows: [], viewLen: -1 };
    function inView(el){ return view.contains(el); }
    var rows = [];
    Array.prototype.forEach.call(document.querySelectorAll('button'), function(b){
      rows.push({ inView: inView(b), tag: 'button', sel: where(b), text: (b.textContent||'').trim().slice(0,20) });
    });
    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function(a){
      rows.push({ inView: inView(a), tag: 'a', sel: where(a), href: a.getAttribute('href'), text: (a.textContent||'').trim().slice(0,20) });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input,textarea'), function(i){
      rows.push({ inView: inView(i), tag: 'input', sel: where(i), ph: i.placeholder||'', type: i.type||'' });
    });
    return { rows: rows, viewLen: view.innerText.trim().length };
  })()`);

  console.log('页面 ' + HASH + '  #view 文本长度=' + out.viewLen);
  console.log('');
  console.log('--- #view 内的元素 ---');
  out.rows.filter((r) => r.inView).forEach((r) => {
    let d = r.sel;
    if (r.href !== undefined) d += '  href=' + r.href;
    if (r.ph) d += '  ph=' + r.ph;
    if (r.type) d += '  type=' + r.type;
    console.log('  [' + r.tag + '] ' + d + '   "' + (r.text || '') + '"');
  });
  console.log('');
  console.log('--- #view 外的元素（前 8 个）---');
  out.rows.filter((r) => !r.inView).slice(0, 8).forEach((r) => {
    let d = r.sel;
    if (r.href !== undefined) d += '  href=' + r.href;
    console.log('  [' + r.tag + '] ' + d + '   "' + (r.text || '') + '"');
  });

  ws.sock.destroy();
  ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})();
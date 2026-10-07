/**
 * 数据层诊断：直接在真实浏览器里跑 Data.dispatch，看每一步真实返回什么。
 * 用法：node tools/diag-data.js
 */

const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// 允许用环境变量指向别处（例如 tools/static-server.js 起的静态环境）
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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-data-'));
  const port = 9900 + Math.floor(Math.random() * 90);
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
  await cmd('Page.navigate', { url: BASE + '/#/home' });
  await new Promise((r) => setTimeout(r, 5000));

  console.log('=== 数据层逐个接口实测 ===\n');

  const PROBE = `(async function(){
    var out = {};
    function log(k, v) { out[k] = v; }

    try { log('backend', await window.Data.resolveBackend()); }
    catch(e){ log('backend', 'ERR: ' + e.message); }

    try {
      var r = await window.Data.dispatch('GET', '/api/rooms', {});
      log('rooms', r.ok ? ('ok, total=' + r.data.total) : ('fail: ' + r.message));
    } catch(e){ log('rooms', 'THROW: ' + e.message); }

    try {
      var r = await window.Data.dispatch('GET', '/api/auth/me', {});
      log('me', r.ok ? ('ok, ' + (r.data && r.data.nickname)) : ('fail: ' + r.message));
    } catch(e){ log('me', 'THROW: ' + e.message); }

    try {
      var r = await window.Data.dispatch('POST', '/api/auth/guest', {});
      log('guest', r.ok ? 'ok' : ('fail: ' + r.message));
    } catch(e){ log('guest', 'THROW: ' + e.message); }

    try {
      var r = await window.Data.dispatch('GET', '/api/rooms', {});
      log('rooms_after_guest', r.ok ? ('ok, total=' + r.data.total) : ('fail: ' + r.message));
    } catch(e){ log('rooms_after_guest', 'THROW: ' + e.message); }

    try {
      var r = await window.Data.dispatch('GET', '/api/plaza', {});
      log('plaza', r.ok ? ('ok, hotRooms=' + r.data.hotRooms.length) : ('fail: ' + r.message));
    } catch(e){ log('plaza', 'THROW: ' + e.message); }

    try {
      var r = await window.Data.dispatch('GET', '/api/topics', {});
      log('topics', r.ok ? ('ok, ' + r.data.list.length) : ('fail: ' + r.message));
    } catch(e){ log('topics', 'THROW: ' + e.message); }

    return out;
  })()`;

  let result;
  try {
    result = await ev(PROBE);
    Object.keys(result).forEach((k) => console.log('  ' + k.padEnd(18) + result[k]));
  } catch (e) {
    console.log('  探测脚本异常:', e.message);
  }

  // 页面实际状态
  console.log('\n=== 页面状态 ===');
  console.log('  room-card:', await ev('document.querySelectorAll(".room-card").length'));
  console.log('  skel:', await ev('document.querySelectorAll(".skel").length'));
  console.log('  正文:', JSON.stringify(await ev('document.getElementById("view").innerText.slice(0,160)')));

  if (logs.length) {
    console.log('\n=== 控制台 ===');
    logs.slice(0, 15).forEach((l) => console.log('  ' + l.slice(0, 180)));
  }

  ws.sock.destroy();
  ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})();
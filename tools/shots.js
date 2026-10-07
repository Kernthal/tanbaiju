/**
 * 多宽度截图工具。
 *
 * 重要：headless 直接用 --window-size 截图时，Chrome 仍按桌面视口布局再裁图，
 * 会让移动端看起来「被右边切掉」，那是截图假象而非页面溢出。
 * 因此手机/平板宽度改用 CDP 的 Emulation.setDeviceMetricsOverride 真正模拟设备。
 *
 * 用法：node tools/shots.js [outDir]
 */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.argv[2] || path.join(__dirname, '..', 'shots');
const BASE = 'http://127.0.0.1:8848';

const VIEWS = [
  { hash: '#/home', name: 'home' },
  { hash: '#/discover', name: 'discover' },
  { hash: '#/me', name: 'me' },
  { hash: '#/create', name: 'create' },
];
const SIZES = [
  { w: 1280, h: 900, tag: 'desktop', mobile: false },
  { w: 834, h: 1000, tag: 'tablet', mobile: true },
  { w: 390, h: 844, tag: 'phone', mobile: true },
];

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
    else if (d.length < 65536) { hd = Buffer.alloc(4); hd[0] = 0x81; hd[1] = 0xfe; hd.writeUInt16BE(d.length, 2); }
    else { hd = Buffer.alloc(10); hd[0] = 0x81; hd[1] = 0xff; hd.writeBigUInt64BE(BigInt(d.length), 2); }
    const mk = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) mk[i] = d[i] ^ m[i % 4];
    this.sock.write(Buffer.concat([hd, m, mk]));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-shot-'));
  const port = 9800 + Math.floor(Math.random() * 150);
  const ch = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof, 'about:blank',
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
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error(me + ' timeout')); } }, 30000);
  });
  const ev = async (e) => {
    const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await cmd('Runtime.enable');
  await cmd('Page.enable');

  for (const size of SIZES) {
    // 真正模拟设备尺寸，截图才反映移动端真实布局
    await cmd('Emulation.setDeviceMetricsOverride', {
      width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.mobile,
    });
    await cmd('Emulation.setTouchEmulationEnabled', { enabled: size.mobile });

    for (const v of VIEWS) {
      await cmd('Page.navigate', { url: BASE + '/' + v.hash });
      // 等骨架屏消失
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const skel = await ev("document.querySelectorAll('.skel').length");
          const len = await ev("(function(){var v=document.getElementById('view');return v?v.innerText.trim().length:0;})()");
          if (skel === 0 && len > 0) break;
        } catch (e) { /* still navigating */ }
      }
      await new Promise((r) => setTimeout(r, 700));

      const shot = await cmd('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, size.tag + '-' + v.name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      const of = await ev('(function(){return document.documentElement.scrollWidth - document.documentElement.clientWidth;})()');
      console.log('  ' + path.basename(file).padEnd(26) + (fs.statSync(file).size / 1024).toFixed(0) + ' KB'
        + (of > 1 ? '   溢出 ' + of + 'px' : '   无溢出'));
    }
  }

  ws.sock.destroy();
  ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n输出目录: ' + OUT);
  process.exit(0);
})();
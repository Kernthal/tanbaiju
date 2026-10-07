/**
 * 布局诊断：打印关键元素的实际盒模型，找出「留白」的真实来源。
 * 用法：node tools/diag-layout.js
 */

const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lay-'));
  const port = 9950 + Math.floor(Math.random() * 40);
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: 'http://127.0.0.1:8848/#/home' });
  await new Promise((r) => setTimeout(r, 5000));

  const info = await ev(`(function(){
    function box(sel, label){
      var el = document.querySelector(sel);
      if(!el) return { label: label, missing: true };
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return {
        label: label,
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        h: Math.round(r.height), w: Math.round(r.width),
        minH: cs.minHeight, align: cs.alignItems, display: cs.display
      };
    }
    var out = [];
    out.push(box('#view','#view'));
    out.push(box('.layout-desk','.layout-desk'));
    out.push(box('.layout-desk > .col','.layout-desk > .col'));
    out.push(box('.layout-desk > .col > .grid-2','.col > .grid-2'));
    out.push(box('.side','.side'));
    out.push(box('.room-card','.room-card(第一个)'));
    out.push(box('.side-cta','.side-cta'));
    var g = document.querySelector('.layout-desk > .col > .grid-2');
    if(g){
      var gs = getComputedStyle(g);
      out.push({label:'grid-2 计算样式', autoRows: gs.gridAutoRows, alignContent: gs.alignContent, display: gs.display, rows: gs.gridTemplateRows});
    }
    return { boxes: out, viewportH: window.innerHeight,
      docH: document.documentElement.scrollHeight };
  })()`);

  console.log('视口高:', info.viewportH, ' 文档高:', info.docH);
  console.log('');
  info.boxes.forEach((b) => {
    if (b.missing) { console.log('  ' + b.label.padEnd(24) + '(不存在)'); return; }
    console.log('  ' + b.label.padEnd(24) +
      ' top=' + String(b.top).padStart(4) +
      ' bottom=' + String(b.bottom).padStart(4) +
      ' h=' + String(b.h).padStart(4) +
      (b.minH && b.minH !== '0px' ? ' minH=' + b.minH : '') +
      (b.autoRows ? '\n' + ' '.repeat(28) + 'autoRows=' + b.autoRows + ' rows=' + b.rows : ''));
  });

  // 底部留白多少
  const gap = await ev(`(function(){
    var cards = document.querySelectorAll('.layout-desk > .col > .grid-2 > *');
    if(!cards.length) return -1;
    var last = cards[cards.length-1].getBoundingClientRect();
    var col = document.querySelector('.layout-desk > .col').getBoundingClientRect();
    return Math.round(col.bottom - last.bottom);
  })()`);
  console.log('\n主栏底部留白:', gap, 'px');

  ws.sock.destroy();
  ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})();
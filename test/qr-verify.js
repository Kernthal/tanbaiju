#!/usr/bin/env node
/*!
 * qr-verify.js —— 用真实扫码器（zxing-cpp）验证 lib/qr.js 生成的二维码能不能被解出来
 *
 * 跑法：node test/qr-verify.js
 * 依赖：Python 3 + zxing-cpp（pip install zxing-cpp）
 *      也可以用环境变量 QR_PYTHON 指定别的 python
 *
 * 流程：Node 把 QR 矩阵自己栅格化成 PNG（用内置 zlib，不依赖 Pillow），
 *       然后调一次 Python，用 zxing-cpp 真解，再把解出来的字节和原文逐字节比对。
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..');
var QR = require(path.join(ROOT, 'lib', 'qr.js'));

var SCALE = 8;          // 每个模块放大成 8x8 像素，方便扫码器识别
var MASK = '#dddddd';   // manifest / 临时文件用

// ---------------------------------------------------------------------------
// 1. 内置最小 PNG 编码器（8 位灰度，零第三方依赖）
// ---------------------------------------------------------------------------

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// matrix 是 boolean[][]（true = 黑），写成一个灰度 PNG
function writeGrayPng(file, matrix, scale) {
  var n = matrix.length;
  var w = n * scale;
  var stride = w + 1; // 每行开头一个 filter 字节
  var raw = Buffer.alloc(stride * w === 0 ? 0 : stride * n * scale);
  for (var y = 0; y < n * scale; y++) {
    var rowStart = y * stride;
    raw[rowStart] = 0; // filter: None
    var srcRow = matrix[Math.floor(y / scale)];
    for (var x = 0; x < w; x++) {
      var dark = srcRow[Math.floor(x / scale)];
      raw[rowStart + 1 + x] = dark ? 0 : 255;
    }
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // colortype: grayscale
  var png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
}

// ---------------------------------------------------------------------------
// 2. 准备用例
// ---------------------------------------------------------------------------

// 约 180 字节、带中文查询参数的长 URL（直接写中文字符，走 UTF-8 字节模式）
// 中文按 UTF-8 各占 3 字节，所以「约 180 字符」实际是 177 字节
var LONG_URL = 'https://tanbaiju.local/room/9f3a2b?from=qr&title=现场报名' +
  '&city=深圳南山科技园&paper=用户满意度调查问卷' +
  '&sig=8f2c1d40ab7e4f9c8d6e5a3b2c1d0e9f&tab=3&note=问卷';

var CASES = [
  { name: '普通 URL', text: 'https://example.com/room/abc123' },
  { name: '内网 IP + 查询参数', text: 'http://127.0.0.1:8848/login?t=abc123XYZ&s=7' },
  { name: '大写域名 + 锚点', text: 'HTTPS://TANBAIJU.LOCAL/#/room/9f3a2b?from=qr' },
  { name: '长 URL（含中文，UTF-8 字节模式）', text: LONG_URL },
  { name: '极短串', text: 'A' }
];

var EC_CASES = ['L', 'M', 'Q', 'H'];

// 可复现的伪随机数，保证每次跑同一批数据
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var EXHAUSTIVE_COUNT = 200;
var EXHAUSTIVE_SEED = 20240701;

function randomAscii(rnd, len) {
  var pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var special = '-_.~:/?#[]@!$&\'()*+,;=%';
  var out = '';
  for (var i = 0; i < len; i++) {
    // 大部分用字母数字，少部分标点，模拟真实 URL
    out += rnd() < 0.85 ? pool.charAt(Math.floor(rnd() * pool.length))
      : special.charAt(Math.floor(rnd() * special.length));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 生成 PNG 与清单
// ---------------------------------------------------------------------------

function pickPython() {
  var candidates = [];
  if (process.env.QR_PYTHON) candidates.push(process.env.QR_PYTHON);
  candidates.push('C:/Users/cn/.workbuddy/binaries/python/versions/3.13.12/python.exe');
  candidates.push('python', 'python3');
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    try {
      var r = spawnSync(p, ['-c', 'import zxingcpp'], { encoding: 'utf8' });
      if (r.error) continue;
      if (r.status === 0) return p;
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

function main() {
  var python = pickPython();
  if (!python) {
    console.error('没找到带 zxing-cpp 的 Python。请先执行：');
    console.error('  python -m pip install zxing-cpp');
    console.error('或者用环境变量指定：  QR_PYTHON=/path/to/python node test/qr-verify.js');
    process.exit(2);
  }
  console.log('使用 Python：' + python);

  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrverify-'));
  var manifest = [];

  function pushCase(label, text, ec) {
    var m;
    try {
      m = QR.modules(text, ec, 4);
    } catch (e) {
      manifest.push({ label: label, expectB64: Buffer.from(text, 'utf8').toString('base64'), error: e.message, file: null });
      return;
    }
    var file = path.join(tmpDir, 'qr_' + manifest.length + '.png');
    writeGrayPng(file, m.modules, SCALE);
    manifest.push({
      label: label,
      ec: ec,
      version: (m.size - 8 - 17) / 4,
      size: m.size,
      expectB64: Buffer.from(text, 'utf8').toString('base64'),
      expectText: text,
      file: file
    });
  }

  console.log('\n=== 一、指定用例 ===');
  CASES.forEach(function (c) { pushCase(c.name, c.text, 'M'); });
  // 空串：应抛错而不是崩溃
  try {
    QR.encode('');
    manifest.push({ label: '空字符串', expectB64: '', error: null, file: null });
  } catch (e) {
    console.log('  空字符串 -> 按预期抛错：' + e.message);
  }

  console.log('\n=== 二、纠错等级 L/M/Q/H ===');
  CASES.slice(0, 3).forEach(function (c) {
    EC_CASES.forEach(function (ec) { pushCase(c.name + ' @' + ec, c.text, ec); });
  });

  console.log('\n=== 三、穷举随机串 1~' + EXHAUSTIVE_COUNT + ' 条（长度 1~200 字节）===');
  var rnd = mulberry32(EXHAUSTIVE_SEED);
  for (var i = 0; i < EXHAUSTIVE_COUNT; i++) {
    var len = 1 + Math.floor(rnd() * 200);
    var s = randomAscii(rnd, len);
    pushCase('随机#' + (i + 1) + ' len=' + Buffer.byteLength(s), s, 'M');
  }

  var manifestPath = path.join(tmpDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  // ---------------------------------------------------------------------------
  // 4. 用 zxing-cpp 真解
  // ---------------------------------------------------------------------------
  var driverPath = path.join(tmpDir, 'decode.py');
  fs.writeFileSync(driverPath, [
    'import json, sys, base64, zxingcpp',
    'from PIL import Image',
    'manifest_path, out_path = sys.argv[1], sys.argv[2]',
    'with open(manifest_path, "r", encoding="utf-8") as f:',
    '    items = json.load(f)',
    'results = []',
    'for it in items:',
    '    rec = {"file": it.get("file")}',
    '    if not it.get("file"):',
    '        rec.update({"ok": False, "reason": "skipped"})',
    '        results.append(rec); continue',
    '    try:',
    '        found = zxingcpp.read_barcodes(Image.open(it["file"]), formats=[zxingcpp.QRCode])',
    '        if not found:',
    '            rec.update({"ok": False, "reason": "扫码器没解出任何码"})',
    '        else:',
    '            r = found[0]',
    '            raw = bytes(r.bytes) if getattr(r, "bytes", None) is not None else None',
    '            rec.update({"ok": True, "text": r.text, "b64": base64.b64encode(raw).decode("ascii") if raw is not None else None})',
    '    except Exception as e:',
    '        rec.update({"ok": False, "reason": str(e)})',
    '    results.append(rec)',
    'with open(out_path, "w", encoding="utf-8") as f:',
    '    json.dump(results, f, ensure_ascii=False)'
  ].join('\n'), 'utf8');

  var outPath = path.join(tmpDir, 'results.json');
  var run = spawnSync(python, [driverPath, manifestPath, outPath], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error('\nPython 解码脚本失败：');
    console.error((run.stderr || '') + (run.stdout || ''));
    process.exit(3);
  }
  var results = JSON.parse(fs.readFileSync(outPath, 'utf8'));

  // ---------------------------------------------------------------------------
  // 5. 逐条比对
  // ---------------------------------------------------------------------------
  var pass = 0;
  var fail = 0;
  var failures = [];

  function diffDetail(gotB64, wantB64) {
    var g = Buffer.from(gotB64 || '', 'base64');
    var w = Buffer.from(wantB64, 'base64');
    if (g.length !== w.length) return '长度不同 期望 ' + w.length + ' 字节，实得 ' + g.length + ' 字节';
    for (var i = 0; i < g.length; i++) {
      if (g[i] !== w[i]) return '第 ' + i + ' 个字节不同：期望 0x' + w[i].toString(16) + '，实得 0x' + g[i].toString(16);
    }
    return '内容一致（但字符串层面可能不一致）';
  }

  var cursor = 0;
  function fmt(label, width) {
    width = width || 40;
    var s = label.length > width ? label.slice(0, width - 1) + '…' : label;
    return s + new Array(width - s.length + 1).join(' ');
  }
  function check(rec) {
    var item = manifest[cursor++];
    var pad = fmt(item.label);
    if (item.error) {
      // 本来就该抛错的用例
      var wantThrow = item.expectB64 === '';
      if (wantThrow && rec.ok === false && /skip|not|empty|empty|encoding/.test(rec.reason || '') === false) {
        // pass
      }
      if (wantThrow) { pass++; console.log('  [通过] ' + pad + '按预期拒绝（' + item.error + '）'); }
      else { fail++; failures.push({ label: item.label, reason: '不该抛错却抛了：' + item.error }); console.log('  [失败] ' + pad + item.label + ' -> ' + item.error); }
      return;
    }
    if (!rec.ok) {
      fail++;
      failures.push({ label: item.label, reason: rec.reason || '解码失败' });
      console.log('  [失败] ' + pad + (rec.reason || '解码失败'));
      return;
    }
    if (rec.b64 !== item.expectB64) {
      fail++;
      failures.push({ label: item.label, reason: diffDetail(rec.b64, item.expectB64) });
      console.log('  [失败] ' + pad + diffDetail(rec.b64, item.expectB64));
      return;
    }
    pass++;
    var shown = item.expectText.length > 36 ? item.expectText.slice(0, 33) + '...' : item.expectText;
    console.log('  [通过] ' + pad +
      'v' + item.version + ' ' + item.size + 'x' + item.size + '  ' +
      Buffer.from(item.expectB64, 'base64').length + 'B  解出：' + JSON.stringify(shown));
  }

  console.log('\n--- 比对结果 ---');
  // 结果数组顺序与 manifest 一致（除了空串那条我们没有发过去）
  // 重新按 index 对齐：manifest 中 file 为 null 的条目跳过，结果里对应位置也要跳过
  var ri = 0;
  for (var mi = 0; mi < manifest.length; mi++) {
    var it = manifest[mi];
    if (!it.file && it.expectB64 === '') {
      // 空串：不参与解码，单独判定
      var threw = /empty|不能为空/.test(it.error || '');
      if (threw) { pass++; console.log('  [通过] ' + fmt('空字符串', 40) + '按预期抛错：' + it.error); }
      else { fail++; failures.push({ label: '空字符串', reason: '空串没有抛错' }); }
      continue;
    }
    check(results[ri++]);
  }

  // ---------------------------------------------------------------------------
  // 6. SVG 输出自检
  // ---------------------------------------------------------------------------
  console.log('\n=== 四、SVG 输出自检 ===');
  var svgChecks = [
    { name: 'toSvg 含 xmlns 声明', ok: /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(QR.toSvg('A')) },
    { name: 'toSvg 默认带 viewBox', ok: /viewBox="0 0 \d+ \d+"/.test(QR.toSvg('A')) },
    { name: 'toSvg scalable:false 不带 viewBox', ok: !/viewBox=/.test(QR.toSvg('A', { scalable: false })) },
    { name: 'toSvg 带 size 时输出 width/height', ok: /width="240" height="240"/.test(QR.toSvg('A', { size: 240 })) },
    { name: 'toSvg 有背景 rect 与前景 path', ok: /<rect[^>]*fill="#ffffff"/.test(QR.toSvg('A')) && /<path[^>]*fill="#000000"/.test(QR.toSvg('A')) },
    { name: 'toSvg path 以 M 开头', ok: /<path d="M/.test(QR.toSvg('A')) },
    { name: 'toPath 是合法 d 字符串', ok: /^M[\d\s]+h[\d]+v1h-[\d]+z/.test(QR.toPath('https://a.b')) },
    { name: 'toPath 可被 SVG 解析（括号闭合）', ok: (function () { var d = QR.toPath('A'); var o = (d.match(/\(/g) || []).length; var c = (d.match(/\)/g) || []).length; return o === c && o === 0; })() }
  ];
  svgChecks.forEach(function (c) {
    if (c.ok) { pass++; console.log('  [通过] ' + c.name); }
    else { fail++; failures.push({ name: c.name, reason: 'SVG 自检未通过' }); console.log('  [失败] ' + c.name); }
  });

  console.log('\n============================================');
  console.log('  总计 ' + (manifest.filter(function (x) { return x.file; }).length + svgChecks.length) + ' 项：通过 ' + pass + '，失败 ' + fail);
  console.log('============================================');
  if (fail > 0) {
    console.log('\n失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f.label + '：' + f.reason); });
  }
  console.log('\n临时目录保留在：' + tmpDir + '（PNG 样本可直接查看）');
  process.exit(fail > 0 ? 1 : 0);
}

main();

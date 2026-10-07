/*!
 * qr.js —— 零依赖 QR 码（二维码）编码器
 * 实现依据：ISO/IEC 18004
 * 采用字节模式（byte mode，模式指示符 0100）编码，字符集内部按 UTF-8 字节处理，
 * 纯 ASCII 文本与 ISO-8859-1 字节结果完全一致。
 *
 * 支持版本 1~10，自动纠错等级（L/M/Q/H），自动挑选惩罚分数最低的掩码。
 * 不依赖任何第三方库，浏览器与 Node 通用（UMD）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.QR = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 一、GF(256) 有限域运算（本原多项式 0x11D）
  // ---------------------------------------------------------------------------

  // 伽罗华域乘法：先把结果左移一位，若溢出本原多项式则异或回来，再乘上 y 的对应位
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = ((z << 1) ^ ((z >>> 7) * 0x11D)) & 0xFF;
      z ^= ((y >>> i) & 1) * x;
      z &= 0xFF;
    }
    return z;
  }

  /**
   * 生成多项式：x^n + a_{n-1}x^{n-1} + ... + a_0，系数用 GF(256) 表示
   * degree 为纠错码字个数，返回长度为 degree 的数组，末尾是最高次项系数 1
   */
  function rsDivisor(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02); // root 依次取 α^0, α^1, α^2 ...
    }
    return result;
  }

  /**
   * 多项式除法取余数：用生成多项式除数据多项式，返回长度为 divisor.length 的余数
   */
  function rsRemainder(data, divisor) {
    var result = new Uint8Array(divisor.length);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result[0];
      for (var i = 0; i < result.length - 1; i++) result[i] = result[i + 1];
      result[result.length - 1] = 0;
      for (var j = 0; j < result.length; j++) result[j] ^= gfMul(divisor[j], factor);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 二、参数表（版本 1~10）
  // ---------------------------------------------------------------------------

  // 每个版本的总码字（含纠错）数量，下标 0 占位
  var TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  // 纠错等级。formatBits 是格式信息里表示的 2 位数值：L=01, M=00, Q=11, H=10
  var EC_LEVELS = {
    L: { formatBits: 1, name: 'L' },
    M: { formatBits: 0, name: 'M' },
    Q: { formatBits: 3, name: 'Q' },
    H: { formatBits: 2, name: 'H' }
  };

  // 每块的纠错码字个数，下标按版本 1~10
  var ECC_PER_BLOCK = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28]
  };

  // 纠错块的总个数
  var NUM_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8]
  };

  // 校正图案（alignment pattern）的中心坐标，版本 1 没有
  var ALIGNMENT_CENTERS = [
    null,
    null,
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50]
  ];

  var MIN_VERSION = 1;
  var MAX_VERSION = 10;

  // ---------------------------------------------------------------------------
  // 三、位缓冲与编码码字生成
  // ---------------------------------------------------------------------------

  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (num, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((num >>> i) & 1);
  };
  BitBuffer.prototype.length = function () {
    return this.bits.length;
  };

  // 把 JS 字符串转成 UTF-8 字节数组；纯 ASCII 时与 ISO-8859-1 逐字节一致
  function toBytes(text) {
    if (typeof text !== 'string') {
      throw new TypeError('QR.encode 的第一个参数必须是字符串');
    }
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        // 代理对，合成一个码点
        var lo = text.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  // 某版本某纠错等级下，字节模式能装下的最大字节数
  function capacity(version, ecName) {
    assertVersion(version);
    var level = getLevel(ecName);
    var dataCodewords = TOTAL_CODEWORDS[version] - ECC_PER_BLOCK[level.name][version] * NUM_BLOCKS[level.name][version];
    // 版本 1~9 的字符计数指示符 8 位，10 及以上 16 位
    var countBits = version < 10 ? 8 : 16;
    return Math.floor((dataCodewords * 8 - 4 - countBits - 4) / 8);
  }

  // 按长度挑一个装得下的最小版本
  function selectVersion(byteLen, level) {
    for (var v = MIN_VERSION; v <= MAX_VERSION; v++) {
      if (byteLen <= capacity(v, level.name)) return v;
    }
    return 0; // 容量不足
  }

  function getLevel(name) {
    var level = EC_LEVELS[String(name || 'M').toUpperCase()];
    if (!level) throw new Error('不支持的纠错等级：' + name + '（可选 L / M / Q / H）');
    return level;
  }

  function assertVersion(v) {
    if (!(v >= MIN_VERSION && v <= MAX_VERSION)) {
      throw new RangeError('QR 版本只支持 ' + MIN_VERSION + '~' + MAX_VERSION + '，当前为 ' + v);
    }
  }

  // 生成数据码字（含纠错码字），返回交织后的完整码字序列
  function buildCodewords(bytes, version, level) {
    var total = TOTAL_CODEWORDS[version];
    var eccLen = ECC_PER_BLOCK[level.name][version];
    var blocks = NUM_BLOCKS[level.name][version];

    // --- 1. 拼数据码流 ---
    var bb = new BitBuffer();
    bb.put(0b0100, 4); // 模式指示符：字节模式
    bb.put(bytes.length, version < 10 ? 8 : 16); // 字符计数指示符
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

    // terminator（最多补 4 位）
    bb.put(0, Math.min(4, total * 8 - bb.length()));
    // 补齐到字节边界
    bb.put(0, (8 - (bb.length() % 8)) % 8);
    // 0xEC / 0x11 交替填充
    for (var pad = 0xec; bb.length() < total * 8; pad ^= 0xec ^ 0x11) bb.put(pad, 8);

    var dataCodewords = [];
    for (var d = 0; d < dataBitsToBytes(bb.length()); d++) {
      var byteVal = 0;
      for (var b = 0; b < 8; b++) byteVal = (byteVal << 1) | bb.bits[d * 8 + b];
      dataCodewords.push(byteVal);
    }

    // --- 2. 分块 + 逐块 RS 纠错 ---
    var rawCodewords = total;
    var numShortBlocks = blocks - (rawCodewords % blocks);
    var shortBlockLen = Math.floor(rawCodewords / blocks);

    var dataBlocks = [];
    var offset = 0;
    for (var blk = 0; blk < blocks; blk++) {
      var datLen = (blk < numShortBlocks ? shortBlockLen : shortBlockLen + 1) - eccLen;
      // 长短块长度不一样，起始位置必须逐块累加，不能用 blk * datLen
      var dat = dataCodewords.slice(offset, offset + datLen);
      offset += datLen;
      var ecc = rsRemainder(dat, rsDivisor(eccLen));
      dataBlocks.push({ data: dat, ecc: ecc });
    }

    // --- 3. 块间交织：先交数据位，再交织纠错位 ---
    var result = [];
    var maxDataLen = 0;
    for (var k = 0; k < dataBlocks.length; k++) maxDataLen = Math.max(maxDataLen, dataBlocks[k].data.length);
    for (var col = 0; col < maxDataLen; col++) {
      for (var n = 0; n < dataBlocks.length; n++) {
        if (col < dataBlocks[n].data.length) result.push(dataBlocks[n].data[col]);
      }
    }
    for (var e = 0; e < eccLen; e++) {
      for (var m = 0; m < dataBlocks.length; m++) result.push(dataBlocks[m].ecc[e]);
    }
    return result;
  }

  function dataBitsToBytes(bits) {
    return Math.floor(bits / 8) + (bits % 8 === 0 ? 0 : 1);
  }

  // ---------------------------------------------------------------------------
  // 四、矩阵绘制
  // ---------------------------------------------------------------------------

  // 掩码条件：i 是行号，j 是列号
  var MASKS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i, j) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return ((i * j) % 2) + ((i * j) % 3) === 0; },
    function (i, j) { return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0; },
    function (i, j) { return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0; }
  ];

  function makeQrMatrix(text, ecName) {
    var level = getLevel(ecName);
    var bytes = toBytes(text);
    if (bytes.length === 0) {
      throw new Error('QR 编码内容不能为空字符串');
    }
    var version = selectVersion(bytes.length, level);
    if (!version) {
      throw new RangeError('内容过长（' + bytes.length + ' 字节），版本 ' + MAX_VERSION + ' + ' + level.name + ' 最多只能放 ' + capacity(MAX_VERSION, level.name) + ' 字节');
    }
    return buildMatrix(version, level, bytes);
  }

  function buildMatrix(version, level, bytes) {
    var size = version * 4 + 17; // 不含静区的边长
    var modules = [];
    var isFunc = [];
    for (var y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFunc.push(new Array(size).fill(false));
    }

    function setFunc(x, y, dark) {
      modules[y][x] = !!dark;
      isFunc[y][x] = true;
    }
    function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

    // --- 时序图案：第 6 行 / 第 6 列 ---
    for (var t = 0; t < size; t++) {
      setFunc(6, t, t % 2 === 0);
      setFunc(t, 6, t % 2 === 0);
    }

    // --- 三个定位图案（含 1 模块的隔离带）---
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // --- 校正图案 ---
    var centers = ALIGNMENT_CENTERS[version];
    if (centers) {
      var last = centers.length - 1;
      for (var ci = 0; ci < centers.length; ci++) {
        for (var cj = 0; cj < centers.length; cj++) {
          // 与三个定位图案重合的三个角要跳过
          if ((ci === 0 && cj === 0) || (ci === 0 && cj === last) || (ci === last && cj === 0)) continue;
          drawAlignment(centers[ci], centers[cj]);
        }
      }
    }

    // --- 版本信息（>= 7 才有）---
    drawVersionBits();

    // --- 格式信息占位（下面会按选中掩码重画）---
    drawFormatBits(0, size);

    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var xx = cx + dx;
          var yy = cy + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
            setFunc(xx, yy, dist !== 2 && dist !== 4);
          }
        }
      }
    }

    function drawAlignment(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          setFunc(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    // 版本信息：BCH(18,6)，生成多项式 0x1F25
    function drawVersionBits() {
      if (version < 7) return;
      var rem = version;
      for (var i = 0; i < 12; i++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        rem &= 0xfffff;
      }
      var bits = (version << 12) | rem;
      for (var b = 0; b < 18; b++) {
        var bit = getBit(bits, b);
        var a = size - 11 + (b % 3);
        var c = Math.floor(b / 3);
        setFunc(a, c, bit);
        setFunc(c, a, bit);
      }
    }

    // 格式信息：BCH(15,5)，生成多项式 0x537，最后异或 0x5412（另有 dark module）
    function drawFormatBits(mask, n) {
      n = n || size;
      var data = (level.formatBits << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) {
        rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        rem &= 0x7fff;
      }
      var bits = ((data << 10) | rem) ^ 0x5412;

      // 第一份：左上角
      for (var k = 0; k <= 5; k++) setFunc(8, k, getBit(bits, k));
      setFunc(8, 7, getBit(bits, 6));
      setFunc(8, 8, getBit(bits, 7));
      setFunc(7, 8, getBit(bits, 8));
      for (var p = 9; p < 15; p++) setFunc(14 - p, 8, getBit(bits, p));

      // 第二份：左下 + 右上
      for (var q = 0; q < 8; q++) setFunc(n - 1 - q, 8, getBit(bits, q));
      for (var r = 8; r < 15; r++) setFunc(8, n - 15 + r, getBit(bits, r));

      // dark module，恒为黑
      setFunc(8, n - 8, true);
    }

    // --- 数据码字按之字形（Zigzag）填入 ---
    var codewords = buildCodewords(bytes, version, level);
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过第 6 列（时序图案所在列）
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var yy = upward ? size - 1 - vert : vert;
          if (!isFunc[yy][x] && bitIndex < totalBits) {
            modules[yy][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    // --- 8 种掩码逐个试算惩罚分数，取最低 ---
    var best = null;
    for (var m = 0; m < 8; m++) {
      applyMask(m);
      drawFormatBits(m);
      var score = penaltyScore();
      if (best === null || score < best.score) best = { score: score, mask: m };
      applyMask(m); // 复原
    }

    applyMask(best.mask);
    drawFormatBits(best.mask);

    function applyMask(maskId) {
      var fn = MASKS[maskId];
      for (var row = 0; row < size; row++) {
        for (var col = 0; col < size; col++) {
          if (!isFunc[row][col] && fn(row, col)) modules[row][col] = !modules[row][col];
        }
      }
    }

    // 惩罚评分：规则 1 同色连续、规则 2 2x2 同色块、规则 3 类似定位的图案、规则 4 黑白比例失衡
    var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

    function penaltyScore() {
      var result = 0;
      var x, y, runColor, runLen;

      // 规则 1 + 规则 3（横向 / 纵向各扫一遍）
      for (y = 0; y < size; y++) {
        runColor = false;
        runLen = 0;
        var hist = [0, 0, 0, 0, 0, 0, 0];
        for (x = 0; x < size; x++) {
          if (modules[y][x] === runColor) {
            runLen++;
            if (runLen === 5) result += PENALTY_N1;
            else if (runLen > 5) result++;
          } else {
            addHistory(runLen, hist);
            if (!runColor) result += countPatterns(hist) * PENALTY_N3;
            runColor = modules[y][x];
            runLen = 1;
          }
        }
        result += terminateAndCount(runColor, runLen, hist) * PENALTY_N3;
      }
      for (x = 0; x < size; x++) {
        runColor = false;
        runLen = 0;
        hist = [0, 0, 0, 0, 0, 0, 0];
        for (y = 0; y < size; y++) {
          if (modules[y][x] === runColor) {
            runLen++;
            if (runLen === 5) result += PENALTY_N1;
            else if (runLen > 5) result++;
          } else {
            addHistory(runLen, hist);
            if (!runColor) result += countPatterns(hist) * PENALTY_N3;
            runColor = modules[y][x];
            runLen = 1;
          }
        }
        result += terminateAndCount(runColor, runLen, hist) * PENALTY_N3;
      }

      // 规则 2：2x2 同色块
      for (y = 0; y < size - 1; y++) {
        for (x = 0; x < size - 1; x++) {
          var c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
            result += PENALTY_N2;
          }
        }
      }

      // 规则 4：黑色占比偏离 50%
      var dark = 0;
      for (y = 0; y < size; y++) {
        for (x = 0; x < size; x++) if (modules[y][x]) dark++;
      }
      var total = size * size;
      var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      result += k * PENALTY_N4;

      return result;
    }

    // 跑动历史里挤入一段长度，尾部补 0
    function addHistory(run, hist) {
      if (hist[0] === 0) run += size; // 起始 / 结束处补上静区的浅色段
      for (var i = hist.length - 1; i > 0; i--) hist[i] = hist[i - 1];
      hist[0] = run;
    }

    // 检测 1011101 前后各带 4 个浅模块的图案
    function countPatterns(hist) {
      var n = hist[1];
      var core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
      return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) +
        (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
    }

    function terminateAndCount(runColor, runLen, hist) {
      if (runColor) {
        addHistory(runLen, hist);
        runLen = 0;
      }
      runLen += size;
      addHistory(runLen, hist);
      return countPatterns(hist);
    }

    return { size: size, version: version, modules: modules, ecLevel: level.name, mask: best.mask };
  }

  // 给裸矩阵四周加静区（quiet zone）
  function addQuietZone(src, margin) {
    var n = src.length;
    var out = [];
    for (var y = 0; y < n + margin * 2; y++) {
      var row = new Array(n + margin * 2);
      for (var x = 0; x < n + margin * 2; x++) {
        row[x] = (y >= margin && y < n + margin && x >= margin && x < n + margin)
          ? src[y - margin][x - margin]
          : false;
      }
      out.push(row);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 五、对外 API
  // ---------------------------------------------------------------------------

  /**
   * 编码文本，返回带静区的布尔矩阵（matrix[y][x]，true 表示黑模块）
   * @param {string} text
   * @param {string} [ecLevel='M'] L / M / Q / H
   */
  function encode(text, ecLevel) {
    var m = makeQrMatrix(text, ecLevel);
    return addQuietZone(m.modules, 4);
  }

  /**
   * 同 encode，但额外返回边长
   * @returns {{size:number, modules:boolean[][]}}
   */
  function modules(text, ecLevel, margin) {
    var m = makeQrMatrix(text, ecLevel);
    var mg = margin == null ? 4 : margin;
    return { size: m.size + mg * 2, modules: addQuietZone(m.modules, mg) };
  }

  /**
   * 把矩阵转成 SVG path 的 d 属性（把水平连续黑块合并成一段）
   * @param {string} text
   * @param {object} [opts] {margin, ecLevel}
   */
  function toPath(text, opts) {
    opts = opts || {};
    var mg = opts.margin == null ? 4 : opts.margin;
    var m = addQuietZone(makeQrMatrix(text, opts.ecLevel).modules, mg);
    var n = m.length;
    var parts = [];
    for (var y = 0; y < n; y++) {
      var x = 0;
      while (x < n) {
        if (!m[y][x]) { x++; continue; }
        var start = x;
        while (x < n && m[y][x]) x++;
        // 一段水平矩形：M x y  h len  v 1  h -len  z
        parts.push('M' + start + ' ' + y + 'h' + (x - start) + 'v1h-' + (x - start) + 'z');
      }
    }
    return parts.join('');
  }

  /**
   * 输出 SVG 字符串
   * @param {string} text
   * @param {object} [opts] {size, margin, dark, light, scalable}
   */
  function toSvg(text, opts) {
    opts = opts || {};
    var mg = opts.margin == null ? 4 : opts.margin;
    var m = addQuietZone(makeQrMatrix(text, opts.ecLevel).modules, mg);
    var n = m.length;

    var px = opts.size > 0 ? Math.round(opts.size) : 0;
    var dark = opts.dark || '#000000';
    var light = opts.light || '#ffffff';
    var scalable = opts.scalable !== false;

    var attrs = 'xmlns="http://www.w3.org/2000/svg"';
    if (px > 0) attrs += ' width="' + px + '" height="' + px + '"';
    if (scalable) attrs += ' viewBox="0 0 ' + n + ' ' + n + '"';
    attrs += ' shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet"';

    var d = toPath(text, { margin: mg, ecLevel: opts.ecLevel });
    return '<svg ' + attrs + '>' +
      '<rect width="100%" height="100%" fill="' + light + '"/>' +
      '<path d="' + d + '" fill="' + dark + '" fill-rule="evenodd"/>' +
      '</svg>';
  }

  return {
    encode: encode,
    modules: modules,
    capacity: capacity,
    toSvg: toSvg,
    toPath: toPath,
    // 常量与内部工具，方便调试和二次使用
    EC_LEVELS: EC_LEVELS,
    MASKS: MASKS,
    MIN_VERSION: MIN_VERSION,
    MAX_VERSION: MAX_VERSION,
    _rsDivisor: rsDivisor,
    _rsRemainder: rsRemainder
  };
});

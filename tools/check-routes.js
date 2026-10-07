/**
 * 对比 api.js 需要的接口与各数据层实现的接口，列出缺口。
 *
 * 用途：切换数据层（local <-> supabase）后，
 * 避免又漏实现某个接口导致「接口不存在」。
 *
 * 用法：node tools/check-routes.js
 * 退出码 0 = 覆盖完整，1 = 有缺口。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'public', 'js', 'core', 'api.js'), 'utf8');

/**
 * api.js 里每个调用形如：
 *   rooms: (tag) => request('GET', '/api/rooms' + (tag ? '?tag=' + ... : '')),
 *   room: (id) => request('GET', '/api/rooms/' + id),
 * 取方法名，再把第一个字符串字面量取出来；
 * 拼接的变量段统一替换为 :p。
 */
function extractCalls(src) {
  const calls = [];
  const lines = src.split('\n');

  for (const line of lines) {
    const methodMatch = line.match(/request\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,/);
    if (!methodMatch) continue;

    const method = methodMatch[1];
    // 取出该行里所有的单引号字符串，按出现顺序拼接。
    // 注意：第 1 个是方法名本身（'GET'），要跳过。
    const strings = [];
    const re = /'([^']*)'/g;
    let m;
    let idx = 0;
    while ((m = re.exec(line)) !== null) {
      if (idx++ === 0) continue; // 跳过方法名
      strings.push(m[1]);
    }

    if (!strings.length) continue;

    // 第 1 个是路径片段；后面若还有片段，说明中间夹了变量（+ id等）
    let path = strings[0];
    if (strings.length > 1) {
      // 只取到查询串之前的部分，避免把 '?tag=' 也拼进去
      path = strings[0];
      // 变量段插在末尾片段之前：把第一个片段末尾补 :p
      if (/\/(?:$|[^/]*$)/.test(path) && path.charAt(path.length - 1) !== '/') {
        path += ':p';
      }
    }

    calls.push(method + ' ' + path);
  }
  return calls;
}

/** 把路径里的 :param 统一换成 :p，便于比对 */
function norm(key) {
  const sp = key.indexOf(' ');
  const method = key.slice(0, sp);
  const path = key.slice(sp + 1).split('?')[0].replace(/^\/+/, '');
  return method + ' ' + path.split('/').filter(Boolean)
    .map((s) => (s.charAt(0) === ':' ? ':p' : s)).join('/');
}

/**
 * 宽松匹配：段数一致、方法相同，每个位置要么都是参数，
 * 要么静态文本完全相同。这样 '/api/rooms/:p' 与 '/api/rooms/:id' 能匹配上。
 */
function looseMatch(a, b) {
  if (a === b) return true;
  const spA = a.indexOf(' ');
  if (a.slice(0, spA) !== b.slice(0, b.indexOf(' '))) return false;
  const pa = a.slice(spA + 1).split('/');
  const pb = b.slice(b.indexOf(' ') + 1).split('/');
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) {
    const x = pa[i].charAt(0) === ':';
    const y = pb[i].charAt(0) === ':';
    if (x && y) continue;
    if (x !== y) return false;
    if (pa[i] !== pb[i]) return false;
  }
  return true;
}

function collectRoutes(file, fnNames) {
  const src = fs.readFileSync(file, 'utf8');
  const set = [];
  for (const fn of fnNames) {
    const re = new RegExp(fn + "\\(\\s*'(GET|POST|PUT|PATCH|DELETE)'\\s*,\\s*'([^']+)'", 'g');
    let mm;
    while ((mm = re.exec(src)) !== null) set.push(norm(mm[1] + ' ' + mm[2]));
  }
  return set;
}

const needed = [...new Set(extractCalls(api).map((k) => norm(k)))];

const layers = [
  { name: 'local-data.js', file: 'public/js/core/local-data.js', fns: ['route'] },
  { name: 'supabase-data.js', file: 'public/js/core/supabase-data.js', fns: ['on'] },
];

console.log('api.js 使用 ' + needed.length + ' 个接口\n');

let anyGap = false;
for (const layer of layers) {
  const set = collectRoutes(path.join(ROOT, layer.file), layer.fns);
  const missing = needed.filter((k) => !set.some((r) => looseMatch(k, r)));
  console.log(layer.name + '  实现 ' + set.length + ' 个');
  if (!missing.length) {
    console.log('  OK 覆盖完整\n');
  } else {
    anyGap = true;
    console.log('  缺 ' + missing.length + ' 个:');
    missing.forEach((k) => console.log('      ' + k));
    console.log('');
  }
}

process.exit(anyGap ? 1 : 0);
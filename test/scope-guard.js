/**
 * 跨文件作用域冲突检查。
 *
 * 教训：classic script 共享全局作用域，两个文件都写 `const routes`
 *      会让后加载的文件整体失效，页面白屏，而单元测试可能照样全绿。
 *      这个脚本把该类问题拦在提交前。
 *
 * 运行：node test/scope-guard.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIRS = [
  path.join(ROOT, 'public', 'js', 'core'),
  path.join(ROOT, 'public', 'js', 'modules'),
];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : '')); }
}

/** 判断一个文件是否被 IIFE 包住 */
function wrappedInIIFE(src) {
  // 去掉注释后，检查首个语句是否为 (function () {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  return /^\(function\s*\(\s*\)/.test(stripped);
}

const files = [];
JS_DIRS.forEach((dir) => {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach((f) => {
    if (f.endsWith('.js')) files.push(path.join(dir, f));
  });
});

console.log('\n=== 作用域冲突检查 ===');
check('找到前端脚本', files.length >= 8, files.length + ' 个文件');

// 收集所有真正泄漏到全局的顶层声明。
// 关键：被 IIFE 包住的文件，其内部声明不进入全局作用域，必须整体排除，
// 否则会把闭包内的局部变量误报成冲突。
const owners = new Map();
const conflicts = [];

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const isWrapped = wrappedInIIFE(raw);

  // 去掉块注释与行注释，避免注释里的代码干扰
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // IIFE 文件：只检查 IIFE 之外的代码（IIFE 包裹后外部应为空）
  const effective = isWrapped ? '' : src;

  const declRe = /^(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = declRe.exec(effective)) !== null) {
    const name = m[2];
    if (owners.has(name)) {
      conflicts.push({ name, a: owners.get(name), b: rel });
    } else {
      owners.set(name, rel);
    }
  }
  if (isWrapped) console.log('    已隔离(IIFE): ' + rel);
}

check('顶层无重复声明', conflicts.length === 0,
  conflicts.length ? conflicts.map((c) => c.name + '(' + c.a + ' vs ' + c.b + ')').join('; ') : '无冲突');

/* ---- 关键全局符号必须存在 ---- */
console.log('\n=== 必需全局符号 ===');

const concatenated = files
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

[
  ['window.api', /api\.\w+\s*=\s*api|window\.api\s*=/],
  ['window.Data', /window\.Data\s*=/],
  ['window.LocalData', /window\.LocalData\s*=/],
  ['window.router', /window\.router\s*=/],
  ['window.ui', /window\.ui\s*=/],
  ['window.store', /window\.store\s*=/],
  ['window.hicon', /window\.hicon\s*=/],
].forEach(([name, re]) => {
  check(name + ' 已暴露到全局', re.test(concatenated));
});

/* ---- 视图函数：router 靠自动发现，名字必须以 view 开头 ---- */
console.log('\n=== 视图函数（router 自动发现） ===');
const viewFns = [];
files.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const re = /window\.(view[A-Z]\w*)\s*=/g;
  let m;
  while ((m = re.exec(src)) !== null) viewFns.push(m[1]);
});
check('至少注册 10 个视图', viewFns.length >= 10, viewFns.length + ' 个: ' + viewFns.join(', '));

console.log('\n================================');
console.log('  通过 ' + pass + ' / ' + (pass + fail) + (fail ? '   失败 ' + fail : '   全部通过'));
console.log('================================\n');
process.exit(fail ? 1 : 0);
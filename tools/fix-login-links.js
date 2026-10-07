/**
 * 一次性脚本：把前端里所有 '/login' 绝对路径链接改为 hash 路由。
 * 原因见 app.js 的 isLoginRoute() 注释。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [
  path.join(ROOT, 'public', 'js', 'modules'),
  path.join(ROOT, 'public', 'js', 'core'),
];

const NEEDLE = "href: '/login'";
const REPL = "href: '#/login'";

let total = 0;
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue;
  fs.readdirSync(dir).forEach((name) => {
    if (!name.endsWith('.js')) return;
    const file = path.join(dir, name);
    let src = fs.readFileSync(file, 'utf8');
    const count = src.split(NEEDLE).length - 1;
    if (!count) return;
    src = src.split(NEEDLE).join(REPL);
    fs.writeFileSync(file, src);
    total += count;
    console.log(path.relative(ROOT, file).replace(/\\/g, '/') + ': ' + count + ' 处');
  });
}

console.log('\n共替换 ' + total + ' 处');

// 复查：还有没有遗漏的绝对路径跳转
const remaining = [];
for (const dir of DIRS) {
  fs.readdirSync(dir).forEach((name) => {
    if (!name.endsWith('.js')) return;
    const file = path.join(dir, name);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // 只看会触发导航的绝对路径：href/src/location 赋值
      if (/(href|src)\s*:\s*['"]\//.test(line) || /location\.(href|pathname)\s*=\s*['"]\//.test(line)) {
        remaining.push(path.relative(ROOT, file).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + line.trim());
      }
    });
  });
}
console.log('\n剩余绝对路径导航: ' + (remaining.length ? '' : '无'));
remaining.forEach((r) => console.log('  ' + r));
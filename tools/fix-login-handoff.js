/**
 * 把登录成功后的 router.navigate('/home') 换成 enterApp('/home')。
 *
 * 为什么要换：
 * 登录页是「接管模式」—— 自己渲染 #view、给 .app 加 auth-mode 隐藏顶栏。
 * 登录成功必须先解除接管（enterApp），否则首页会一直显示登录页的内容、
 * 顶栏也恢复不了。
 *
 * 只替换精确的 `router.navigate('/home');` 独立语句，
 * 不碰 setTimeout 里的箭头函数（那种替换会破坏语法）。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'modules', 'login.js');
const src = fs.readFileSync(FILE, 'utf8');

// 精确匹配：整行就是这一句语句（后面没有箭头函数）
const exactLine = /^(\s*)router\.navigate\('\/home'\);$/gm;

let count = 0;
const out = src.replace(exactLine, (full, indent) => {
  count++;
  return indent + "if (window.enterApp) window.enterApp('/home'); else router.navigate('/home');";
});

fs.writeFileSync(FILE, out, 'utf8');
console.log('已替换 ' + count + ' 处登录后跳转');

// 校验语法与残留
const vm = require('vm');
try {
  new vm.Script(out, { filename: 'login.js' });
  console.log('语法 OK');
} catch (err) {
  console.log('语法错误: ' + err.message);
  process.exit(1);
}

const left = out.split("router.navigate('/home');").length - 1;
console.log('剩余 router.navigate 直接调用: ' + left + ' 处（setTimeout 内的应保留为 1）');
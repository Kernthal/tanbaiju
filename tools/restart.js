/**
 * 重启开发服务：先杀掉占用 8848 的进程，再启动新实例。
 * 避免反复出现 EADDRINUSE。运行：node tools/restart.js
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8848;

function killPort() {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const pids = [...new Set(
      out.split('\n')
        .filter((l) => l.includes(':' + PORT) && l.includes('LISTENING'))
        .map((l) => l.trim().split(/\s+/).pop())
    )];
    pids.forEach((p) => {
      try {
        execSync('taskkill /F /PID ' + p);
        console.log('  已结束占用 ' + PORT + ' 的进程 ' + p);
      } catch (_) { /* ignore */ }
    });
    if (!pids.length) console.log('  端口 ' + PORT + ' 本来就是空闲的');
  } catch (err) {
    console.log('  检查端口失败：' + err.message);
  }
}

function cleanData() {
  const dir = path.join(__dirname, '..', 'data');
  try {
    fs.readdirSync(dir).forEach((f) => {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
    });
    console.log('  数据已清空');
  } catch (_) { /* ignore */ }
}

killPort();
if (process.argv.includes('--clean')) cleanData();

const args = path.join(__dirname, '..', 'server.js');
const demo = process.argv.includes('--demo');
const finalArgs = demo ? [args, '--demo'] : [args];

const server = spawn(process.execPath, finalArgs, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  detached: false,
});

server.on('exit', (code) => process.exit(code));
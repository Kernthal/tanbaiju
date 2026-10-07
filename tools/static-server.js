/**
 * 起一个纯静态文件服务器，模拟 GitHub Pages 的环境（没有后端 API）。
 * 用途：在本地验证「静态部署下数据层会连上 Supabase」这条路径，
 * 因为线上没有 /api/*可探测，探测逻辑只有在这里才会走到 Supabase 分支。
 *
 * 用法：node tools/static-server.js [端口]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8899);
const ROOT = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(ROOT, rel);
  // 防目录穿越
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('静态服务器已启动: http://127.0.0.1:' + PORT);
  console.log('（模拟 GitHub Pages，无后端 API）');
});
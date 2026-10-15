/**
 * 本地预览服务：托管 apps/web/dist 静态产物，并把 /api 反向代理到后端 3000 端口。
 *
 * 用途：在无法运行 `vite` dev server（需要 spawn esbuild 子进程）的环境下，
 * 以"构建产物 + 同源代理"的方式获得与开发服务器一致的访问效果。
 * 代理目标与 apps/web/vite.config.ts 中的 server.proxy 保持一致。
 *
 * 用法：node scripts/local-preview-server.cjs
 *   环境变量 WEB_PORT（默认 5173）、API_TARGET（默认 http://127.0.0.1:3000）
 */
const http = require('node:http');
const { createReadStream, existsSync, statSync } = require('node:fs');
const path = require('node:path');

const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:3000';
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(response, filePath) {
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://localhost:${WEB_PORT}`);
  let filePath = path.join(DIST_DIR, decodeURIComponent(url.pathname));

  // 防目录穿越
  if (!filePath.startsWith(DIST_DIR)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    sendFile(response, filePath);
    return;
  }
  // SPA 回退
  sendFile(response, path.join(DIST_DIR, 'index.html'));
}

function proxyApi(request, response) {
  const target = new URL(API_TARGET);
  const proxyRequest = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `${target.hostname}:${target.port}` },
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    },
  );
  proxyRequest.on('error', (error) => {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: `后端不可达：${error.message}` }));
  });
  request.pipe(proxyRequest);
}

if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error(`前端构建产物不存在：${DIST_DIR}\\index.html\n请先执行 apps/web 的 vite build。`);
  process.exit(1);
}

http
  .createServer((request, response) => {
    if (request.url?.startsWith('/api')) proxyApi(request, response);
    else serveStatic(request, response);
  })
  .listen(WEB_PORT, '127.0.0.1', () => {
    console.log(`WEB  http://127.0.0.1:${WEB_PORT}  →  静态目录 ${DIST_DIR}`);
    console.log(`API  ${API_TARGET}  （/api 反向代理）`);
  });

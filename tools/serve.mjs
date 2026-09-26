#!/usr/bin/env node
/**
 * serve.mjs — PDScope 本地服务
 *
 * 用途：
 *   1. 用 http://127.0.0.1:PORT 打开完整 UI（避免浏览器对 file:// 下 ES Module 的限制）
 *   2. 暴露 /api/samples、/api/sample 让「载入示例」可用
 *
 * 解析本身完全在前端完成，服务端只负责发静态资源和示例文件。
 *
 * 用法：
 *   node tools/serve.mjs [--port 5188] [--no-open]
 */
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');                 // PDScope/
const UI = join(ROOT, 'src', 'ui');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.PORT || 5188));
const OPEN = !argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 查找示例抓包：项目目录 + 其父目录（用户把 .atkcc 和 PDScope 放一起的常见情况） */
async function findSamples() {
  const dirs = [ROOT, resolve(ROOT, '..')];
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    let names;
    try { names = await readdir(d); } catch { continue; }
    for (const n of names) {
      if (!/\.atkcc$/i.test(n)) continue;
      const p = join(d, n);
      if (seen.has(p)) continue;
      seen.add(p);
      let size = 0;
      try { size = (await stat(p)).size; } catch {}
      out.push({ name: n, path: p, size });
    }
  }
  out.sort((a, b) => a.size - b.size);
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(url.pathname);

  const send = (code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };

  // ── 示例列表 ──
  if (pathname === '/api/samples') {
    const list = await findSamples();
    return send(200, JSON.stringify(list), MIME['.json']);
  }
  // ── 取示例文件 ──
  if (pathname === '/api/sample') {
    const name = url.searchParams.get('name') || '';
    const list = await findSamples();
    const hit = list.find((x) => x.name === name);
    if (!hit) return send(404, 'not found');
    const buf = await readFile(hit.path);
    return send(200, buf, 'application/octet-stream');
  }
  if (pathname === '/api/health') return send(200, JSON.stringify({ ok: true, root: ROOT }), MIME['.json']);

  // ── 静态资源 ──
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // /js/core/*  → src/js/core/*      （app.js 里的 ../js/core/... 会解析成 /js/core/...）
  // /ui/*       → src/ui/*
  let file;
  if (pathname.startsWith('/js/')) file = join(ROOT, 'src', pathname);
  else if (pathname.startsWith('/ui/')) file = join(ROOT, 'src', pathname.slice(1));
  else file = join(UI, pathname);

  // 防目录穿越
  const norm = resolve(file);
  if (!norm.startsWith(resolve(ROOT))) return send(403, 'forbidden');

  try {
    const st = await stat(norm);
    if (st.isDirectory()) return send(404, 'not found');
    const buf = await readFile(norm);
    return send(200, buf, MIME[extname(norm).toLowerCase()] || 'application/octet-stream');
  } catch {
    return send(404, 'not found: ' + pathname);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  PDScope · USB PD 抓包解析上位机');
  console.log('  ────────────────────────────────────────────');
  console.log(`  已启动： \x1b[36m${url}\x1b[0m`);
  console.log(`  项目根： ${ROOT}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
  if (OPEN) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, a, { stdio: 'ignore', detached: true }).unref(); } catch {}
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用，换一个：node tools/serve.mjs --port 5189\n`);
  } else console.error(e);
  process.exit(1);
});

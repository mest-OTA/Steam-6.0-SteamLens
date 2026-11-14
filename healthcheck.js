/*
 * 在线版健康检查（供 启动 SteamLens.bat 使用）
 * 只用 node:http，不依赖 fetch / AbortSignal.timeout，任何 Node 版本都能跑。
 *   健康  → exit code 0
 *   不健康 → exit code 1
 */
'use strict';
const http = require('node:http');
const req = http.get('http://127.0.0.1:8787/api/health', res => {
  let body = '';
  res.on('data', c => { body += c; });
  res.on('end', () => {
    let ok = res.statusCode === 200;
    try { ok = ok && JSON.parse(body).ok === true; } catch (e) {}
    process.exit(ok ? 0 : 1);
  });
});
req.setTimeout(1500, () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));

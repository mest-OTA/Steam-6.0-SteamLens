/**
 * SteamLens · Steam 客户端好友状态直读（零第三方依赖）
 *
 * 用户诉求：「找好友的时候直接在 Steam 里提取，好友上线就自动显示」。
 *
 * 原理：Steam 客户端自己的「好友与聊天」窗口是 CEF 页面，本机开着一个远程调试端口
 * （常见 8080）。好友列表 DOM 上直接写着状态 class：
 *     <div class="friend ingame awayOrSnooze">…</div>   → 游戏中
 *     <div class="friend offline">…</div>                → 离线
 *     <div class="friend online">…</div>                 → 在线
 * 以及昵称、正在玩的游戏名、头像 hash（40 位）。
 *
 * 本模块通过 CDP Runtime.evaluate **只读取 .friend 节点的状态字段**，
 * 不取 document.body.innerText、不读任何聊天消息、不碰 Cookie / 密码 / 登录凭证。
 * 头像 hash 与本机 localconfig.vdf 的好友名册对上后换算成 SteamID64，
 * 结果写到 data/steam-client-friends.json，由 friends-core 生成上线事件与通知。
 *
 * 端口自动发现：先试缓存端口 → 常见端口 → netstat 里全部本机监听端口，
 * 并用 /json/list 里的 steamloopback.host / 「好友列表」特征确认它确实是 Steam 客户端，
 * 绝不会误连普通 Chrome。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const core = require('./steam-core');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(DATA_DIR, 'steam-client-friends.json');
const COMMON_PORTS = [8080, 9222, 9223, 9229, 28573, 28574, 27036];
const ID_BASE = 76561197960265728n;
const CACHE_MS = 30000;

let cachedPort = 0;
let lastDiscoverAt = 0;
let lastSignature = '';
let lastWriteAt = 0;
let lastError = '';
let lastItems = [];
let lastMapped = 0;
let lastUnmapped = 0;
let pollCount = 0;

/* ------------------------------ 基础工具 ------------------------------ */
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

function httpJson(url, timeout = 900) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, r => {
      let d = '';
      r.on('data', c => { d += c; if (d.length > 2_000_000) req.destroy(); });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** 只认 Steam 客户端自己的 CEF 页面，避免连到别的调试端口 */
async function steamTargets(port) {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`, 1100);
  if (!Array.isArray(list)) return null;
  const isSteam = list.some(t => /steamloopback\.host|好友列表|Friends List|Valve Steam/i.test(
    String(t.url || '') + ' ' + String(t.title || '') + ' ' + String(t.type || '')));
  if (!isSteam) return null;
  const pages = list.filter(t => t.webSocketDebuggerUrl &&
    /好友列表|Friends List|steamloopback\.host/i.test(String(t.title || '') + ' ' + String(t.url || '')));
  return pages.length ? pages : null;
}

async function candidatePorts() {
  const set = new Set(COMMON_PORTS);
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 5000, windowsHide: true, maxBuffer: 4_000_000 },
        (e, stdout) => e ? reject(e) : resolve(String(stdout || '')));
    });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.match(/127\.0\.0\.1:(\d+)\s|0\.0\.0\.0:(\d+)\s/);
      if (m) set.add(Number(m[1] || m[2]));
    }
  } catch { /* netstat 不可用时用常见端口兜底 */ }
  return [...set].filter(p => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 90);
}

async function discover(force = false) {
  if (!force && cachedPort && Date.now() - lastDiscoverAt < CACHE_MS) {
    try { const t = await steamTargets(cachedPort); if (t) return { port: cachedPort, targets: t }; } catch {}
  }
  const ports = await candidatePorts();
  const found = await Promise.all(ports.map(async p => {
    try { const t = await steamTargets(p); return t ? { port: p, targets: t } : null; } catch { return null; }
  }));
  const hit = found.find(Boolean);
  lastDiscoverAt = Date.now();
  if (hit) { cachedPort = hit.port; lastError = ''; return hit; }
  cachedPort = 0;
  lastError = '未发现 Steam 客户端好友页面：请在 Steam 里打开「好友与聊天」窗口（可最小化）';
  return null;
}

/* ------------------------------ CDP 只读表达式 ------------------------------ */
/* 严格只遍历 .friend 节点，取 class / 昵称 / 头像 hash / 分组游戏名。
   不访问聊天区、不取 body.innerText、不读取任何消息内容。 */
const READ_EXPR = `(function(){
  var seen={}, out=[];
  var nodes=document.querySelectorAll('.friend');
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i], cls=String(n.className||'');
    var st=-1;
    if(/ingame|in-game/i.test(cls)) st=1;
    else if(/(^|\\s)offline(\\s|$)/i.test(cls)) st=0;
    else if(/(^|\\s)online(\\s|$)/i.test(cls)) st=1;
    else if(/away|busy|snooze/i.test(cls)) st=3;
    if(st<0) continue;
    var ne=n.querySelector('.nOdcT-MoOaXGePXLyPe0H, .labelHolder .friendName');
    var name=ne?String(ne.textContent||'').trim().slice(0,80):'';
    var img=n.querySelector('img.avatar, img[src*="avatars.steamstatic.com"]');
    var src=img?String(img.getAttribute('src')||''):'';
    var mh=src.match(/([0-9a-f]{40})/i);
    var hash=mh?mh[1].toLowerCase():'';
    if(!name&&!hash) continue;
    var game='';
    var g=n.closest?n.closest('.friendGroup'):null;
    if(g&&/gameGroup/i.test(String(g.className||''))){
      var gt=String(g.textContent||'').replace(/\\s+/g,' ').trim();
      var mm=gt.match(/^(.+?)\\s*\\(\\d+\\)/);
      if(mm) game=mm[1].trim().slice(0,120);
    }
    if(!game&&st===1){
      var ge=n.querySelector('[class*="_1cB0qtF0paHWWyj1XNcnbG"]');
      if(ge) game=String(ge.textContent||'').trim().slice(0,120);
      if(/^(上次在线|最后在线|Last online|Offline)/i.test(game)) game='';
    }
    var key=hash||name;
    var prev=seen[key];
    if(prev&&(prev.state>0||prev.game)&&st===0) continue;
    seen[key]={name:name,hash:hash,state:st,game:game};
  }
  for(var k in seen) out.push(seen[k]);
  return JSON.stringify({ts:Date.now(),title:document.title,url:location.href,nodes:nodes.length,items:out});
})()`;

function cdpEvaluate(wsUrl, timeout = 2600) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('CDP 读取超时')), timeout);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: READ_EXPR, returnByValue: true }
    }));
    ws.onmessage = e => {
      try {
        const m = JSON.parse(String(e.data || ''));
        if (m.id !== 1) return;
        const v = m.result?.result?.value;
        if (typeof v !== 'string') return finish(new Error('CDP 未返回数据'));
        finish(null, JSON.parse(v));
      } catch (err) { finish(err); }
    };
    ws.onerror = () => finish(new Error('CDP 连接失败'));
  });
}

/* ------------------------------ 名册映射 ------------------------------ */
/** 头像 hash / 昵称 → SteamID64。数据源全是本机 Steam 文件，不联网、不碰凭证。 */
function rosterMap() {
  const byHash = new Map(), byName = new Map();
  const add = (hash, name, id64) => {
    if (hash) byHash.set(String(hash).toLowerCase(), id64);
    if (name) byName.set(String(name).trim(), id64);
  };
  let rootList = [];
  try { rootList = core.detectSteamRoots(); } catch {}
  for (const r of rootList) {
    const base = path.join(r.path, 'userdata');
    let dirs = [];
    try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
      let v = null;
      try { v = core.vdfFile(path.join(base, d.name, 'config', 'localconfig.vdf')); } catch { continue; }
      const root = v?.UserLocalConfigStore || v || {};
      for (const [k, f] of Object.entries(root.friends || {})) {
        if (!/^\d+$/.test(k) || !f || typeof f !== 'object') continue;
        let id64 = '';
        try { id64 = String(ID_BASE + BigInt(k)); } catch { continue; }
        add(f.avatar, f.name, id64);
      }
      // Steam 新版好友 UI 的玩家缓存，同样含 steamid + avatar_hash
      const pc = root.WebStorage?.friendstore_playercache;
      if (typeof pc === 'string') {
        try {
          for (const p of JSON.parse(pc)) {
            if (!p || !p.steamid) continue;
            add(p.avatar_hash, p.persona_name, String(p.steamid));
          }
        } catch {}
      }
    }
  }
  return { byHash, byName };
}

/* ------------------------------ 轮询 ------------------------------ */
/**
 * 读一次 Steam 客户端好友列表，把状态写进本机文件。
 * @returns {{ok:boolean, changed:boolean, mapped:number, unmapped:number, items:number, port:number, error:string}}
 */
async function poll(opts = {}) {
  pollCount++;
  const d = await discover(!!opts.forceDiscover);
  if (!d) return { ok: false, changed: false, mapped: 0, unmapped: 0, items: 0, port: 0, error: lastError };

  let parsed = null, usedUrl = '';
  for (const page of d.targets.slice(0, 3)) {
    try {
      const r = await cdpEvaluate(page.webSocketDebuggerUrl);
      if (r && Array.isArray(r.items)) {
        // 合并多个好友页面：优先取节点数多（通常是主好友列表）的那一份
        if (!parsed || r.items.length >= parsed.items.length) { parsed = r; usedUrl = page.title || ''; }
      }
    } catch (e) { lastError = e.message; }
  }
  if (!parsed) return { ok: false, changed: false, mapped: 0, unmapped: 0, items: 0, port: d.port, error: lastError || '好友页面暂不可读' };

  const { byHash, byName } = rosterMap();
  const players = [];
  let unmapped = 0;
  for (const it of parsed.items) {
    const id = byHash.get(it.hash) || byName.get(it.name) || '';
    if (!/^\d{17}$/.test(id)) { unmapped++; continue; }
    players.push({
      steamid: id,
      personaname: it.name || '',
      personastate: Number(it.state) || 0,
      gameextrainfo: it.game || '',
      avatarfull: it.hash ? `https://avatars.steamstatic.com/${it.hash}_full.jpg` : ''
    });
  }

  // 空结果不覆盖上一轮，避免 Steam 窗口临时重载时把在线好友误判成离线
  if (!players.length) {
    return { ok: false, changed: false, mapped: 0, unmapped, items: parsed.items.length, port: d.port, error: '好友状态未能匹配到本机名册（Steam 窗口可能正在加载）' };
  }

  const sig = JSON.stringify(players.map(p => [p.steamid, p.personastate, p.gameextrainfo]));
  const changed = sig !== lastSignature;
  lastSignature = sig;
  lastItems = parsed.items;
  lastMapped = players.length;
  lastUnmapped = unmapped;
  lastWriteAt = Date.now();
  lastError = '';
  atomicWrite(OUT_FILE, JSON.stringify({
    ts: lastWriteAt, iso: new Date(lastWriteAt).toISOString(),
    source: 'Steam 客户端好友列表（本机 CEF 只读）',
    port: d.port, pageTitle: usedUrl, nodes: parsed.nodes,
    count: players.length, unmapped, friends: players
  }, null, 2));
  return { ok: true, changed, mapped: players.length, unmapped, items: parsed.items.length, port: d.port, error: '' };
}

function readStates(maxAgeMs = 5 * 60 * 1000) {
  try {
    const j = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    if (!j || !Array.isArray(j.friends) || !j.friends.length) return null;
    const age = Date.now() - Number(j.ts || 0);
    if (age > maxAgeMs || age < -60000) return null;
    return j;
  } catch { return null; }
}
function hasStates() { return !!readStates(); }

function status() {
  const j = readStates();
  return {
    ok: !!(j || cachedPort),
    connected: !!j,
    port: cachedPort || 0,
    lastAt: j?.ts || lastWriteAt || 0,
    secondsAgo: j?.ts ? Math.max(0, Math.round((Date.now() - j.ts) / 1000)) : null,
    nodes: j?.nodes ?? parsedNodes(),
    count: j?.count ?? 0,
    online: (j?.friends || []).filter(f => Number(f.personastate) > 0).length,
    unmapped: j?.unmapped ?? lastUnmapped,
    mapped: j?.count ?? lastMapped,
    items: lastItems.slice(0, 20),
    polls: pollCount,
    error: lastError,
    pollIntervalSec: 3,
    note: '直接读取 Steam 客户端「好友与聊天」窗口的状态标记；不读聊天记录、不接触密码或 Cookie。'
  };
}
function parsedNodes() { return lastItems.length; }

module.exports = { poll, readStates, hasStates, status, discover };

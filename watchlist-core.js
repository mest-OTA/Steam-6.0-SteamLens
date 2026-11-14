/**
 * SteamLens · 愿望单监控（自己添加游戏 → 价格 / 折扣 / 上线自动提醒）
 *
 * 用户诉求：
 *   · 可以添加 Steam 里的游戏（本机库、Steam 商店搜索、或手填 AppID），也支持批量加入已拥有的游戏；
 *   · 显示现价、原价、折扣、是否发售 / 测试版 / Demo / 抢先体验；
 *   · 每款单独设置「降到 ¥X 提醒」「折扣达到 X% 提醒」「未上线 / 测试版正式上线时提醒」；
 *   · 添加后自动运行：服务每分钟检查一次，跨过规则才推送，且写进秒级更新日志与离线快照。
 *
 * 数据来源优先级：Steam 商店公开 appdetails（走 steam-net 的 CONNECT 代理）→ 本机价格缓存
 * → 本机游戏库快照 / 玩法缓存。联网不可用时仍能用本机数据显示名称与上次价格，不会白屏。
 * 通知复用现有通道：Windows 原生通知 / 邮件 / 微信 / QQ / 钉钉，都只发给用户自己。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');
const net = require('./steam-net');
const gameDetail = require('./game-detail-core');
const gameMeta = require('./game-meta-core');   // 监控清单也要有名字和封面图
const notify = require('./notify-core');
const mail = require('./mail-core');
const wechat = require('./wechat-core');
const qq = require('./qq-core');
const dingtalk = require('./dingtalk-core');
const sms = require('./sms-core');

const DATA_DIR = path.join(__dirname, 'data');
const LIST_FILE = path.join(DATA_DIR, 'watchlist.json');
const STATE_FILE = path.join(DATA_DIR, 'watchlist-monitor.json');
const ALERTS_FILE = path.join(DATA_DIR, 'watchlist-monitor-alerts.json');
const SNAP_FILE = path.join(DATA_DIR, 'offline-snapshot.json');
const MIN_ALERT_GAP_MS = 3600000;   // 同一游戏同一类提醒最短间隔 1 小时，避免刷屏

function read(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function write(f, obj) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); } catch {}
}
function localTime(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const yuan = c => (Number(c || 0) / 100).toFixed(2);
const isApp = s => /^\d{1,12}$/.test(String(s || ''));

function readList() {
  const j = read(LIST_FILE, null);
  if (!j || !Array.isArray(j.items)) return { autoEnabled: true, lastCheckIso: '', items: [] };
  return { autoEnabled: j.autoEnabled !== false, lastCheckIso: j.lastCheckIso || '', items: j.items };
}
function saveList(j) { write(LIST_FILE, j); return j; }

/** 本机来源：游戏库快照 / 价格缓存 / 玩法缓存（缓存 60 秒，避免反复读大快照） */
let SRC_CACHE = null, SRC_CACHE_AT = 0;
function localSources() {
  if (SRC_CACHE && Date.now() - SRC_CACHE_AT < 60000) return SRC_CACHE;
  const snap = read(SNAP_FILE, null);
  const games = (snap && snap.state && Array.isArray(snap.state.games)) ? snap.state.games : [];
  const prices = core.getPriceCache() || {};
  let details = [];
  try {
    // allCached() 返回的是 { appid: {...} } 对象，不是数组
    const d = gameDetail.allCached() || {};
    details = Object.entries(d).map(([appid, v]) => ({ appid, name: (v && v.name) || '' }));
  } catch { /* */ }
  SRC_CACHE = { games, prices, details };
  SRC_CACHE_AT = Date.now();
  return SRC_CACHE;
}
function localName(appid) {
  const { games, prices, details } = localSources();
  const id = String(appid);
  const g = games.find(x => String(x.appid) === id);
  if (g && g.name) return String(g.name);
  if (prices[id] && prices[id].name) return String(prices[id].name);
  const d = details.find(x => String(x.appid) === id);
  return (d && d.name) ? String(d.name) : '';
}
function localOwned(appid) {
  const { games } = localSources();
  return games.some(g => String(g.appid) === String(appid));
}
function localPrice(appid) {
  const { games, prices } = localSources();
  const id = String(appid);
  const p = prices[id];
  if (p) return {
    finalCents: Number(p.finalCents || 0), initialCents: Number(p.initialCents || 0),
    discount: Number(p.discount || 0), isFree: !!p.isFree,
    checkedAtIso: p.checkedAt ? new Date(p.checkedAt).toISOString() : ''
  };
  const g = games.find(x => String(x.appid) === id);
  if (g) return {
    finalCents: Number(g.priceCents || 0), initialCents: Number(g.priceCents || 0),
    discount: 0, isFree: !Number(g.priceCents || 0), checkedAtIso: ''
  };
  return null;
}

/** 带超时的 Steam 商店公开接口 */
async function getJson(url, ms = 9000) {
  let r;
  try {
    r = await Promise.race([
      net.get(url),
      new Promise(res => setTimeout(() => res({ ok: false, error: '请求超时' }), ms))
    ]);
  } catch (e) { return { ok: false, error: e.message }; }
  if (!r || !r.ok || !r.text) return { ok: false, error: (r && (r.error || ('HTTP ' + r.status))) || '无响应' };
  try { return { ok: true, json: JSON.parse(r.text), via: r.via || '' }; }
  catch { return { ok: false, error: 'Steam 返回的不是 JSON' }; }
}

async function fetchApp(appid) {
  const id = String(appid);
  const url = `https://store.steampowered.com/api/appdetails?appids=${id}&cc=cn&l=schinese`;
  const r = await getJson(url);
  const d = r.ok && r.json ? r.json[id] : null;
  const base = {
    appid: id, name: localName(id) || ('AppID ' + id),
    owned: localOwned(id), headerImage: '', source: '', online: false, error: ''
  };
  if (!d || !d.success || !d.data) {
    const lp = localPrice(id) || { finalCents: 0, initialCents: 0, discount: 0, isFree: false, checkedAtIso: '' };
    return {
      ...base, source: '本机缓存（Steam 商店暂不可用）', error: r.error || '商店无数据',
      finalCents: lp.finalCents, initialCents: lp.initialCents, discount: lp.discount,
      isFree: lp.isFree, hasPrice: lp.finalCents > 0, comingSoon: false,
      releaseDate: '', type: '', earlyAccess: false, pendingRelease: false,
      statusLabel: '价格来自本机缓存'
    };
  }
  const x = d.data;
  const p = x.price_overview || null;
  const rel = x.release_date || {};
  const tags = [].concat(x.genres || []).map(g => String(g.description || '')).join(' ');
  const earlyAccess = /Early Access|抢先体验/i.test(tags + ' ' + String(x.name || ''));
  const type = String(x.type || 'game');
  const comingSoon = !!rel.coming_soon;
  const hasPrice = !!p;
  const pendingRelease = comingSoon || type === 'demo' || (!hasPrice && !x.is_free) || earlyAccess;
  let statusLabel = '已发售';
  if (comingSoon) statusLabel = '即将推出';
  else if (type === 'demo') statusLabel = '测试版 / Demo';
  else if (earlyAccess) statusLabel = '抢先体验';
  else if (!hasPrice && !x.is_free) statusLabel = '未上架 / 暂不可购买';
  if (x.is_free) statusLabel += ' · 免费';
  return {
    ...base,
    name: String(x.name || base.name),
    headerImage: String(x.header_image || ''),
    source: 'Steam 商店公开接口' + (r.via ? '（' + r.via + '）' : ''),
    online: true,
    finalCents: Number(p?.final || 0), initialCents: Number(p?.initial || 0),
    discount: Number(p?.discount_percent || 0), isFree: !!x.is_free,
    hasPrice, comingSoon, releaseDate: String(rel.date || ''), type, earlyAccess,
    pendingRelease, statusLabel
  };
}

/** 搜索：本机库 + 本机缓存 + Steam 商店在线搜索 + 纯数字 AppID */
async function search(term) {
  const q = String(term || '').trim();
  if (!q) return { ok: false, items: [], note: '请输入游戏名或 AppID' };
  const { games, prices, details } = localSources();
  const out = [];
  const seen = new Set();
  const push = (appid, name, source, owned) => {
    const id = String(appid);
    if (!isApp(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ appid: id, name: String(name || ('AppID ' + id)), source, owned: !!owned });
  };
  const match = (name, id) => String(name || '').toLowerCase().includes(q.toLowerCase()) || String(id) === q;
  for (const g of games) if (match(g.name, g.appid)) push(g.appid, g.name, '本机 Steam 游戏库', true);
  for (const [id, p] of Object.entries(prices)) if (match(p.name, id)) push(id, p.name, '本机价格缓存', localOwned(id));
  for (const d of details) if (match(d.name, d.appid)) push(d.appid, d.name, '本机游戏详情缓存', localOwned(d.appid));
  if (/^\d+$/.test(q)) push(q, localName(q) || ('AppID ' + q), '手动填 AppID', localOwned(q));

  let online = false, note = '';
  if (out.length < 20) {
    const r = await getJson('https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(q) + '&l=schinese&cc=cn', 8000);
    if (r.ok && Array.isArray(r.json?.items)) {
      for (const it of r.json.items) push(it.id, it.name, 'Steam 商店搜索', localOwned(it.id));
      online = true;
    } else note = 'Steam 商店搜索暂不可用（' + (r.error || '网络不通') + '），已用本机游戏库 / 缓存的结果';
  }
  if (!out.length) note = '没找到这款游戏。可以直接填 Steam 商店页 URL 里的 AppID（纯数字）加入监控。';
  return { ok: true, term: q, items: out.slice(0, 40), online, note };
}

function add(appid, name, source) {
  const id = String(appid || '').trim();
  if (!isApp(id)) return { ok: false, error: 'AppID 应为纯数字' };
  const data = readList();
  if (data.items.some(x => String(x.appid) === id)) return { ok: false, error: '这款游戏已经在监控清单里了' };
  const item = {
    appid: id, name: String(name || localName(id) || ('AppID ' + id)),
    source: String(source || '手动添加'), addedAt: Date.now(), addedAtLocal: localTime(),
    owned: localOwned(id), enabled: true,
    targetYuan: 0, discountPct: 0, watchRelease: true
  };
  data.items.unshift(item);
  saveList(data);
  return { ok: true, item };
}
function remove(appid) {
  const data = readList();
  const before = data.items.length;
  data.items = data.items.filter(x => String(x.appid) !== String(appid));
  saveList(data);
  const st = read(STATE_FILE, {}); delete st[String(appid)]; write(STATE_FILE, st);
  return { ok: true, removed: before - data.items.length };
}
function setRule(appid, patch) {
  const data = readList();
  const it = data.items.find(x => String(x.appid) === String(appid));
  if (!it) return { ok: false, error: '清单里没有这款游戏' };
  const num = (v, max) => Math.min(max, Math.max(0, Number(v) || 0));
  if (patch.targetYuan !== undefined) it.targetYuan = num(patch.targetYuan, 100000);
  if (patch.discountPct !== undefined) it.discountPct = Math.round(num(patch.discountPct, 100));
  if (patch.watchRelease !== undefined) it.watchRelease = !!patch.watchRelease;
  if (patch.enabled !== undefined) it.enabled = !!patch.enabled;
  saveList(data);
  return { ok: true, item: it };
}
function setAuto(enabled) {
  const data = readList(); data.autoEnabled = !!enabled; saveList(data);
  return { ok: true, autoEnabled: data.autoEnabled };
}
/** ✕ 不再提醒：保留这款游戏在清单里，但关掉它的提醒并删掉它已产生的提醒记录；可恢复 */
function mute(appid, muted) {
  const id = String(appid || '');
  const data = readList();
  const it = data.items.find(x => String(x.appid) === id);
  if (!it) return { ok: false, error: '清单里没有这款游戏' };
  const off = muted !== false;
  it.enabled = !off;
  saveList(data);
  let removedAlerts = 0;
  if (off) {
    const alerts = read(ALERTS_FILE, []);
    const keep = alerts.filter(a => String(a.appid) !== id);
    removedAlerts = alerts.length - keep.length;
    if (removedAlerts) write(ALERTS_FILE, keep);
  }
  return { ok: true, appid: id, muted: off, removedAlerts, status: status() };
}
/** 批量把本机已拥有的游戏加入监控 */
function importOwned(limit = 30) {
  const { games } = localSources();
  const data = readList();
  const have = new Set(data.items.map(x => String(x.appid)));
  let n = 0;
  for (const g of games) {
    if (n >= limit) break;
    const id = String(g.appid);
    if (!isApp(id) || have.has(id)) continue;
    data.items.push({
      appid: id, name: String(g.name || ('AppID ' + id)), source: '本机已拥有游戏',
      addedAt: Date.now(), addedAtLocal: localTime(), owned: true, enabled: true,
      targetYuan: 0, discountPct: 0, watchRelease: false
    });
    have.add(id); n++;
  }
  saveList(data);
  return { ok: true, added: n, total: data.items.length };
}

/** 通过所有已开启的通道把提醒发给用户自己 */
async function broadcast(kind, item, info) {
  const label = ({ target: '到达目标价', discount: '达到目标折扣', release: '正式上线' })[kind] || '价格变化';
  const price = info.isFree ? '免费' : `¥${yuan(info.finalCents)}`;
  const title = `SteamLens · 愿望单${label}提醒`;
  const body = `${item.name} ${label}\n现价 ${price}${info.discount ? `（-${info.discount}%）` : ''}\n原价 ¥${yuan(info.initialCents)}\n状态：${info.statusLabel}\nhttps://store.steampowered.com/app/${item.appid}/`;
  const rec = { desktop: null, mail: null, wechat: null, qq: null, dingtalk: null, sms: null };
  const key = `watch:${item.appid}:${kind}`;
  try { rec.desktop = await notify.toast(title, `${item.name} · ${price} · ${label}`, false); } catch (e) { rec.desktop = { ok: false, reason: e.message }; }
  try {
    const html = `<div style="font-family:'Microsoft YaHei',sans-serif;padding:20px"><h2>${label}：${item.name}</h2><p>现价 <b>${price}</b>，原价 ¥${yuan(info.initialCents)}${info.discount ? `，折扣 -${info.discount}%` : ''}</p><p>状态：${info.statusLabel}</p><a href="https://store.steampowered.com/app/${item.appid}/">打开 Steam 商店页</a></div>`;
    rec.mail = await mail.sendDirect(`${title}：${item.name} ${price}`, html, body, { key, minIntervalSec: 3600, type: 'wishlist' });
  } catch (e) { rec.mail = { sent: false, reason: e.message }; }
  for (const [name, mod] of [['wechat', wechat], ['qq', qq], ['dingtalk', dingtalk]]) {
    try { const r = await mod.send(title, body, { kind: 'wishlist', dedupeKey: key }); rec[name] = { ok: !!r.ok, reason: r.reason || '' }; }
    catch (e) { rec[name] = { ok: false, reason: e.message }; }
  }
  /* 手机号短信：目标价 / 折扣 与 正式上线 分开控制 */
  try {
    const sr = await sms.send(kind === 'release' ? 'watchlistRelease' : 'watchlistPrice',
      `${item.name} ${label}：现价 ${price}`);
    rec.sms = { ok: !!sr.ok, reason: sr.reason || '' };
  } catch (e) { rec.sms = { ok: false, reason: e.message }; }
  return rec;
}

async function checkOne(item, state, alerts) {
  const id = String(item.appid);
  const info = await fetchApp(id);
  const prev = state[id];
  const now = Date.now();
  const targetCents = Math.round(Number(item.targetYuan || 0) * 100);
  const kinds = [];
  if (prev) {
    if (targetCents > 0 && info.finalCents > 0 && info.finalCents <= targetCents
        && Number(prev.finalCents || 0) > targetCents) kinds.push('target');
    if (Number(item.discountPct || 0) > 0 && info.discount >= Number(item.discountPct)
        && Number(prev.discount || 0) < Number(item.discountPct)) kinds.push('discount');
    if (item.watchRelease && prev.pendingRelease && !info.pendingRelease) kinds.push('release');
  }
  const lastAlerts = prev?.lastAlerts || {};
  const fired = [];
  for (const kind of kinds) {
    if (kind !== 'release' && lastAlerts[kind] && now - lastAlerts[kind] < MIN_ALERT_GAP_MS) continue;
    if (kind === 'release' && lastAlerts.release) continue;   // 上线只提醒一次
    lastAlerts[kind] = now;
    const rec = {
      ts: now, iso: new Date(now).toISOString(), localTime: localTime(now),
      appid: id, name: info.name, kind,
      finalCents: info.finalCents, initialCents: info.initialCents, discount: info.discount,
      statusLabel: info.statusLabel, channels: null
    };
    try { rec.channels = await broadcast(kind, item, info); } catch (e) { rec.channels = { error: e.message }; }
    alerts.unshift(rec); fired.push(rec);
    console.log(`[SteamLens 愿望单监控 ${localTime(now)}] ${kind}：${info.name} ¥${yuan(info.finalCents)}`);
  }
  state[id] = {
    name: info.name, finalCents: info.finalCents, initialCents: info.initialCents,
    discount: info.discount, isFree: info.isFree, hasPrice: info.hasPrice,
    comingSoon: info.comingSoon, pendingRelease: info.pendingRelease,
    statusLabel: info.statusLabel, type: info.type, releaseDate: info.releaseDate,
    headerImage: info.headerImage, source: info.source, online: info.online,
    error: info.error || '', checkedAt: now, checkedAtLocal: localTime(now),
    baselineAtLocal: prev?.baselineAtLocal || localTime(now), lastAlerts
  };
  return { info, fired };
}

/** 每分钟自动跑一次；手动点「立即检查」也走这里 */
async function check(opts = {}) {
  const data = readList();
  if (opts.auto && !data.autoEnabled) return { ok: true, skipped: true, checked: 0, alerts: [], message: '自动监控已关闭' };
  const active = data.items.filter(x => x.enabled !== false);
  if (!active.length) return { ok: true, checked: 0, alerts: [], message: '监控清单还是空的：先在愿望单页添加游戏' };
  const state = read(STATE_FILE, {});
  const alerts = read(ALERTS_FILE, []);
  const fired = [];
  const queue = active.slice(0, 60);
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try { const r = await checkOne(item, state, alerts); fired.push(...r.fired); }
      catch (e) { console.error('[SteamLens 愿望单监控]', item.appid, e.message); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (alerts.length > 200) alerts.length = 200;
  write(STATE_FILE, state); write(ALERTS_FILE, alerts);
  data.lastCheckIso = new Date().toISOString(); data.lastCheckLocal = localTime();
  saveList(data);
  const msg = fired.length
    ? `检查 ${active.length} 款，触发 ${fired.length} 条提醒（${[...new Set(fired.map(x => x.kind))].join(' / ')}）`
    : `检查 ${active.length} 款，价格与上线状态暂无跨过提醒线`;
  return { ok: true, checked: active.length, alerts: fired, message: msg, lastCheckLocal: data.lastCheckLocal };
}

/** 刚添加 / 手动刷新某一款：立刻查一次，写基线但不误报 */
async function refreshOne(appid) {
  const data = readList();
  const item = data.items.find(x => String(x.appid) === String(appid));
  if (!item) return { ok: false, error: '清单里没有这款游戏' };
  const state = read(STATE_FILE, {});
  const alerts = read(ALERTS_FILE, []);
  const r = await checkOne(item, state, alerts);
  if (alerts.length > 200) alerts.length = 200;
  write(STATE_FILE, state); write(ALERTS_FILE, alerts);
  data.lastCheckLocal = localTime(); data.lastCheckIso = new Date().toISOString();
  saveList(data);
  return { ok: true, item, info: r.info, fired: r.fired };
}

function status() {
  const data = readList();
  const state = read(STATE_FILE, {});
  const alerts = read(ALERTS_FILE, []);
  const items = data.items.map(it => {
    const id = String(it.appid);
    const s = state[id] || null;
    const lp = s ? null : localPrice(it.appid);
    /* 只有 AppID 的条目排队补中文名；封面优先用商店检查时拿到的精确地址，
       其次用永久元数据缓存，最后退到通用 CDN（前端还会再退到本机 Steam 封面）。 */
    const metaName = gameMeta.nameOf(id);
    if (!metaName) gameMeta.queue(id);
    const shownName = (it.name && !/^AppID\s*\d+$/i.test(String(it.name)))
      ? String(it.name) : (metaName || String(it.name || ('AppID ' + id)));
    return {
      ...it,
      name: shownName,
      cover: String((s && s.headerImage) || gameMeta.coverOf(id) || ''),
      price: s ? {
        name: s.name, finalCents: s.finalCents, initialCents: s.initialCents,
        discount: s.discount, isFree: s.isFree, statusLabel: s.statusLabel,
        releaseDate: s.releaseDate, headerImage: s.headerImage,
        source: s.source, online: !!s.online, checkedAtLocal: s.checkedAtLocal || ''
      } : (lp ? {
        name: it.name, finalCents: lp.finalCents, initialCents: lp.initialCents,
        discount: lp.discount, isFree: lp.isFree, statusLabel: '价格来自本机缓存',
        releaseDate: '', headerImage: '', source: '本机缓存', online: false, checkedAtLocal: ''
      } : null)
    };
  });
  return {
    ok: true, autoEnabled: data.autoEnabled, items,
    alerts: alerts.slice(0, 40),
    lastCheckIso: data.lastCheckIso || '', lastCheckLocal: data.lastCheckLocal || '',
    total: items.length, enabledCount: items.filter(x => x.enabled !== false).length
  };
}

module.exports = {
  search, add, remove, setRule, setAuto, mute, importOwned, check, status, fetchApp, refreshOne,
  snapshot: status, LIST_FILE, STATE_FILE, ALERTS_FILE
};

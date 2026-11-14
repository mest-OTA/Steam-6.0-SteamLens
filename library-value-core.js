/**
 * SteamLens · 库价值永久账本（零第三方依赖）
 *
 * 用户诉求：
 *  1. 「提取一次价值之后永久保存这个价值」→ 价格按 AppID 永久落盘，永不因缓存失效丢失；
 *  2. 「多的游戏就增加价值，少游戏就减去价值」→ 每次用当前游戏清单重算，记录新增 / 移除与差额；
 *  3. 「为什么是 0」→ 账号同步失败、价格缓存丢失、临时读不到游戏列表时，
 *     保留上一次已确认的价值，绝不把面板打回 0。
 *
 * 文件：data/library-value.json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'library-value.json');
const HISTORY_MAX = 120;

function empty() {
  return {
    version: 1,
    prices: {},            // appid -> { priceCents, name, firstIso, lastPriceIso, source }
    lastTotalCents: 0,     // 上一次确认的库价值
    lastGameIds: [],       // 上一次参与计价的游戏 ID（用于算增减）
    firstIso: '', lastIso: '',
    history: []
  };
}
function read() {
  try {
    const raw = String(fs.readFileSync(FILE, 'utf8')).replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    return Object.assign(empty(), j && typeof j === 'object' ? j : {});
  } catch { return empty(); }
}
function write(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.renameSync(tmp, FILE); }
    catch { fs.copyFileSync(tmp, FILE); try { fs.unlinkSync(tmp); } catch {} }
    return true;
  } catch { return false; }
}
const yuan = c => Math.round((Number(c) || 0) / 100 * 100) / 100;

function status() {
  const L = read();
  return {
    ok: true, file: FILE,
    totalCents: L.lastTotalCents, totalYuan: yuan(L.lastTotalCents),
    valuedGames: (L.lastGameIds || []).length,
    savedPrices: Object.keys(L.prices || {}).length,
    firstIso: L.firstIso || '', lastIso: L.lastIso || '',
    history: (L.history || []).slice(-12).reverse()
  };
}
function reset() { write(empty()); return status(); }

/**
 * 用当前游戏清单重算并落盘。
 * @param {Array} games      buildGames 产出的游戏（已带 valueEligible / priceCents）
 * @param {Object} priceCache data/prices.json 的价格表（可选，用于补齐）
 */
function sync(games, priceCache) {
  const L = read();
  const prices = L.prices || {};
  const nowIso = new Date().toLocaleString('zh-CN', { hour12: false });
  const current = [];
  let newPrice = false;

  for (const g of (Array.isArray(games) ? games : [])) {
    const id = String((g && g.appid) || '');
    if (!/^\d{1,12}$/.test(id)) continue;
    if (!g.valueEligible) continue;                 // Demo / 退款 / 愿望单永不计价

    let cents = Number(g.priceCents || 0);
    if (!(cents > 0) && priceCache) {               // 缓存价兜底
      const p = priceCache[id];
      if (p && !p.unavailable) cents = Number(p.initialCents > 0 ? p.initialCents : p.finalCents) || 0;
    }
    if (!(cents > 0) && prices[id]) cents = Number(prices[id].priceCents) || 0;  // 永久账本兜底
    if (!(cents > 0)) continue;

    const name = String(g.name || '');
    if (!prices[id] || prices[id].priceCents !== cents || (name && prices[id].name !== name)) {
      prices[id] = {
        priceCents: cents, name,
        firstIso: (prices[id] && prices[id].firstIso) || nowIso,
        lastPriceIso: nowIso,
        source: String(g.priceSource || 'Steam 商店标价')
      };
      newPrice = true;
    }
    current.push({ appid: id, cents });
  }

  const prevTotal = Number(L.lastTotalCents || 0);
  const prevIds = new Set(L.lastGameIds || []);

  /* 临时读不到游戏列表时冻结上一次价值，防止面板闪回 0 */
  if (!current.length && prevIds.size > 0) {
    return {
      ok: true, frozen: true, totalCents: prevTotal, totalYuan: yuan(prevTotal),
      valuedGames: prevIds.size, savedPrices: Object.keys(prices).length,
      added: [], removed: [], addedCents: 0, removedCents: 0, deltaCents: 0,
      firstIso: L.firstIso, lastIso: L.lastIso, history: (L.history || []).slice(-8).reverse()
    };
  }

  const curIds = [...new Set(current.map(x => x.appid))];
  const curSet = new Set(curIds);
  const added = curIds.filter(id => !prevIds.has(id));
  const removed = [...prevIds].filter(id => !curSet.has(id));
  const priceOf = id => Number((prices[id] || {}).priceCents || 0);
  const addedCents = added.reduce((s, id) => s + priceOf(id), 0);
  const removedCents = removed.reduce((s, id) => s + priceOf(id), 0);
  const totalCents = current.reduce((s, x) => s + x.cents, 0);
  const deltaCents = totalCents - prevTotal;

  /* 只有真的变了才写盘，避免每秒刷新反复改文件 */
  if (added.length || removed.length || totalCents !== prevTotal || newPrice || !L.firstIso) {
    L.prices = prices;
    L.lastTotalCents = totalCents;
    L.lastGameIds = curIds;
    L.lastIso = nowIso;
    if (!L.firstIso) L.firstIso = nowIso;
    L.history = (L.history || []).concat([{
      iso: nowIso, added, removed, addedCents, removedCents, deltaCents, totalCents
    }]).slice(-HISTORY_MAX);
    write(L);
  }

  return {
    ok: true, frozen: false, totalCents, totalYuan: yuan(totalCents),
    valuedGames: current.length, savedPrices: Object.keys(prices).length,
    added, removed, addedCents, removedCents, deltaCents,
    firstIso: L.firstIso, lastIso: L.lastIso,
    history: (L.history || []).slice(-8).reverse()
  };
}

module.exports = { sync, status, reset, FILE };

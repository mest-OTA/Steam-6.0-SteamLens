/**
 * SteamLens · 愿望单降价 / 回涨提醒（零第三方依赖）
 *
 * 规则（按用户要求）：
 *   · 阈值默认 ¥30，可配置。
 *   · 只有「从 ≥30 跌破 30」才发降价提醒；本来就在 30 以下不打扰。
 *   · 打折结束后「从 <30 涨回 ≥30」再发一封恢复原价提醒。
 *   · 首次观察到某游戏只建立基线，不发任何邮件。
 *   · 状态按 appid 持久化，服务重启也不会重复提醒。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('./steam-core');
const account = require('./account-core');
const mail = require('./mail-core');
const notify = require('./notify-core');
const wechat = require('./wechat-core');
const qq = require('./qq-core');
const dingtalk = require('./dingtalk-core');
const sms = require('./sms-core');

const STATE_FILE = path.join(__dirname, 'data', 'wishlist-prices.json');
const ALERT_FILE = path.join(__dirname, 'data', 'wishlist-alerts.json');
/* 「不再提醒」的游戏：按 AppID 永久记在本机，重启不丢 */
const MUTED_FILE = path.join(__dirname, 'data', 'wishlist-muted.json');

function read(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function write(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = c => (Number(c || 0) / 100).toFixed(2);

function readMuted() {
  const a = read(MUTED_FILE, []);
  return Array.isArray(a) ? [...new Set(a.map(String))] : [];
}
function writeMuted(ids) { write(MUTED_FILE, [...new Set(ids.map(String))]); }
/** 删掉某款游戏已经产生的提醒记录（用户点「✕ 不再提醒」时一起清掉） */
function deleteAlertsOf(appid) {
  const id = String(appid || '');
  const alerts = read(ALERT_FILE, []);
  const keep = alerts.filter(a => String(a.appid) !== id);
  const removed = alerts.length - keep.length;
  if (removed) write(ALERT_FILE, keep);
  return removed;
}
/** 点 ✕：静音这款游戏（不再发降价/回涨通知）+ 删除它的历史提醒记录；可再点恢复 */
function setMuted(appid, muted) {
  const id = String(appid || '').trim();
  if (!id) return { ok: false, error: '缺少 AppID' };
  const list = readMuted();
  if (muted === false) {
    writeMuted(list.filter(x => x !== id));
    return { ok: true, appid: id, muted: false, status: status() };
  }
  if (!list.includes(id)) list.push(id);
  writeMuted(list);
  const removedAlerts = deleteAlertsOf(id);
  return { ok: true, appid: id, muted: true, removedAlerts, status: status() };
}
/** 删「最近提醒记录」里的单条记录 */
function deleteAlert(ts) {
  const alerts = read(ALERT_FILE, []);
  const keep = alerts.filter(a => String(a.ts) !== String(ts));
  const removed = alerts.length - keep.length;
  if (removed) write(ALERT_FILE, keep);
  return { ok: true, removed, status: status() };
}

function config() {
  const c = core.getConfig();
  return {
    thresholdCents: Math.max(0, Math.round(Number(c.wishlistThresholdYuan || 30) * 100)),
    thresholdYuan: Number(c.wishlistThresholdYuan || 30),
    enabled: c.wishlistNotifyEnabled !== false,
    minIntervalSec: Math.max(60, Number(c.wishlistAlertMinIntervalSec || 3600))
  };
}

function storeUrl(appid) {
  return `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=cn&l=schinese`;
}

function priceOf(j, appid) {
  const d = j?.[String(appid)];
  if (!d?.success || !d.data) return null;
  const p = d.data.price_overview || null;
  return {
    name: String(d.data.name || ''),
    isFree: !!d.data.is_free,
    currency: p?.currency || 'CNY',
    initialCents: Number(p?.initial || 0),
    finalCents: Number(p?.final || 0),
    discount: Number(p?.discount_percent || 0),
    storeUrl: `https://store.steampowered.com/app/${appid}/`
  };
}

function alertMail(g, kind, cfg) {
  const drop = kind === 'drop';
  const title = drop ? `降到 ¥${yuan(g.finalCents)} 了` : `价格回到 ¥${yuan(g.finalCents)}`;
  const subject = `${drop ? '【愿望单降价】' : '【愿望单回涨】'}${g.name} ${title}`;
  const accent = drop ? '#10b39c' : '#e29437';
  const html = `<div style="margin:0;padding:24px;background:#f4f7fd;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
  <div style="max-width:540px;margin:auto;background:#fff;border:1px solid #e3eafb;border-radius:16px;overflow:hidden">
    <div style="padding:18px 24px;background:${accent};color:#fff">
      <div style="font-size:12px;letter-spacing:2px;opacity:.85">STEAMLENS · 愿望单监控</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">${drop ? '降价提醒' : '恢复原价提醒'}</div>
    </div>
    <div style="padding:26px 24px">
      <div style="font-size:18px;color:#17213a;font-weight:600">${esc(g.name)}</div>
      <div style="margin-top:16px;padding:16px;background:#f7faff;border-radius:12px;font-size:14px;color:#2f4a7a;line-height:1.9">
        ${drop ? '当前折扣价' : '现价'}：<b style="font-size:20px;color:${accent}">¥${yuan(g.finalCents)}</b>
        ${g.discount > 0 ? ` <span style="color:#10b39c">(-${g.discount}%)</span>` : ''}<br>
        原价：¥${yuan(g.initialCents)}<br>
        你的提醒线：低于 ¥${cfg.thresholdYuan.toFixed(2)}<br>
        上次价格：¥${yuan(g.prevFinalCents)}
      </div>
      <p style="margin-top:16px;color:#7b8aa6;font-size:13px;line-height:1.7">
        ${drop
          ? `这款游戏从 ¥${yuan(g.prevFinalCents)} 跌破了 ¥${cfg.thresholdYuan.toFixed(2)}，${g.discount > 0 ? '目前是打折价，折扣结束会恢复原价，到时候会再提醒你一次。' : '可以去看一眼了。'}`
          : `之前低于 ¥${cfg.thresholdYuan.toFixed(2)} 的折扣已经结束（或价格回调），现在回到 ¥${yuan(g.finalCents)}。`}
      </p>
      <a href="${esc(g.storeUrl)}" style="display:inline-block;margin-top:8px;padding:10px 18px;background:${accent};color:#fff;border-radius:8px;text-decoration:none;font-size:14px">打开 Steam 商店页</a>
    </div>
    <div style="padding:14px 24px;background:#fafcff;border-top:1px solid #eef2fa;color:#9aa8bf;font-size:12px">
      由本机 SteamLens 自动发送 · ${new Date().toLocaleString('zh-CN', { hour12: false })} · 可在面板里关闭或调整提醒线
    </div>
  </div></div>`;
  const plain = `${subject}｜现价 ¥${yuan(g.finalCents)}，原价 ¥${yuan(g.initialCents)}，折扣 ${g.discount}%｜${g.storeUrl}`;
  return { subject, html, plain };
}

/** 检查全部愿望单价格，跨阈值才产生提醒 */
async function checkPrices(opts = {}) {
  const cfg = config();
  const truth = account.getTruth();
  const list = truth.wishlist || [];
  if (!list.length) {
    return { ok: true, checked: 0, alerts: [], message: '愿望单为空：先在「Steam 账号」页连接账号或粘贴愿望单 JSON。' };
  }

  const state = read(STATE_FILE, {});
  const alerts = read(ALERT_FILE, []);
  const mutedIds = new Set(readMuted());   // ✕ 不再提醒：价格基线照常更新，但不发通知
  const priceCache = core.getPriceCache();
  const result = { ok: true, checked: 0, changed: 0, alerts: [], errors: [], thresholdYuan: cfg.thresholdYuan };

  for (const w of list.slice(0, 120)) {
    const id = String(w.appid);
    let p;
    try { p = priceOf(await core.fetchJson(storeUrl(id), 20000), id); }
    catch (e) { result.errors.push(`${w.name || id}：${e.message}`); continue; }
    result.checked++;
    if (!p) { result.errors.push(`${w.name || id}：商店无价格 / 已下架 / 锁区`); continue; }

    // 把价格写回缓存，面板的愿望单列表立即有价
    priceCache[id] = {
      name: p.name, isFree: p.isFree, currency: p.currency,
      initialCents: p.initialCents, finalCents: p.finalCents,
      discount: p.discount, checkedAt: Date.now()
    };

    const prev = state[id];
    const below = p.finalCents > 0 && p.finalCents < cfg.thresholdCents;
    const nowIso = new Date().toISOString();

    if (!prev) {
      // 首次建立基线：即使本来就低于阈值也不提醒
      state[id] = {
        name: w.name || p.name, lastFinalCents: p.finalCents, lastInitialCents: p.initialCents,
        lastDiscount: p.discount, below, checkedAt: Date.now(), baselineAt: nowIso
      };
      continue;
    }

    state[id] = {
      name: w.name || p.name, lastFinalCents: p.finalCents, lastInitialCents: p.initialCents,
      lastDiscount: p.discount, below, checkedAt: Date.now(),
      baselineAt: prev.baselineAt || nowIso, lastChangeIso: prev.lastChangeIso || ''
    };

    /* 用户对这款游戏点了「✕ 不再提醒」：只更新价格基线，不产生任何提醒 / 邮件 / 短信 */
    if (mutedIds.has(id)) { state[id].lastChangeIso = nowIso; continue; }

    let kind = null;
    if (!prev.below && below) kind = 'drop';
    else if (prev.below && p.finalCents >= cfg.thresholdCents) kind = 'rebound';

    if (!kind) continue;
    result.changed++;
    const g = { ...p, appid: id, name: w.name || p.name || ('App ' + id), prevFinalCents: prev.lastFinalCents || 0 };
    const m = alertMail(g, kind, cfg);
    const rec = {
      ts: Date.now(), iso: nowIso, appid: id, name: g.name, kind,
      fromCents: prev.lastFinalCents || 0, toCents: p.finalCents,
      discount: p.discount, thresholdCents: cfg.thresholdCents,
      mail: null, desktop: null, wechat: null, qq: null, dingtalk: null, sms: null
    };

    if (cfg.enabled) {
      try {
        rec.mail = await mail.sendDirect(m.subject, m.html, m.plain, {
          key: `wishlist:${id}:${kind}`, minIntervalSec: cfg.minIntervalSec, type: 'wishlist'
        });
      } catch (e) { rec.mail = { sent: false, reason: e.message }; }
      try {
        rec.desktop = await notify.toast(`SteamLens · 愿望单${kind === 'drop' ? '降价' : '回涨'}`,
          `${g.name} 现价 ¥${yuan(p.finalCents)}（原价 ¥${yuan(p.initialCents)}）`, false);
      } catch (e) { rec.desktop = { ok: false, reason: e.message }; }
      try {
        const w = await wechat.send(
          `SteamLens · 愿望单${kind === 'drop' ? '降价' : '回涨'} ¥${cfg.thresholdYuan}`,
          `${g.name}\n现价 ¥${yuan(p.finalCents)}（原价 ¥${yuan(p.initialCents)}）\n${kind === 'drop' ? '已跌破提醒线' : '已从打折价涨回提醒线以上'}`,
          { kind: 'wishlist', dedupeKey: `wishlist:${id}:${kind}` }
        );
        rec.wechat = { ok: !!w.ok, reason: w.reason || '' };
      } catch (e) { rec.wechat = { ok: false, reason: e.message }; }
      try {
        const q = await qq.send(
          `SteamLens · 愿望单${kind === 'drop' ? '降价' : '回涨'} ¥${cfg.thresholdYuan}`,
          `${g.name}\n现价 ¥${yuan(p.finalCents)}（原价 ¥${yuan(p.initialCents)}）`,
          { kind: 'wishlist', dedupeKey: `wishlist:${id}:${kind}` }
        );
        rec.qq = { ok: !!q.ok, reason: q.reason || '' };
      } catch (e) { rec.qq = { ok: false, reason: e.message }; }
      try {
        const d = await dingtalk.send(
          `SteamLens · 愿望单${kind === 'drop' ? '降价' : '回涨'} ¥${cfg.thresholdYuan}`,
          `${g.name}\n现价 ¥${yuan(p.finalCents)}（原价 ¥${yuan(p.initialCents)}）`,
          { kind: 'wishlist', dedupeKey: `wishlist:${id}:${kind}` }
        );
        rec.dingtalk = { ok: !!d.ok, reason: d.reason || '' };
      } catch (e) { rec.dingtalk = { ok: false, reason: e.message }; }
      /* 手机号短信：按「愿望单降价 / 回涨」分类开关决定发不发 */
      try {
        const sr = await sms.send(kind === 'drop' ? 'wishlistDrop' : 'wishlistRebound',
          `${g.name} ${kind === 'drop' ? '降价' : '回涨'}：现价 ¥${yuan(p.finalCents)}（原价 ¥${yuan(p.initialCents)}）`);
        rec.sms = { ok: !!sr.ok, reason: sr.reason || '' };
      } catch (e) { rec.sms = { ok: false, reason: e.message }; }
    }
    state[id].lastChangeIso = nowIso;
    alerts.unshift(rec);
    result.alerts.push(rec);
    console.log(`[SteamLens 愿望单] ${kind === 'drop' ? '跌破' : '涨回'} ¥${cfg.thresholdYuan}：${g.name} ¥${yuan(p.finalCents)}`);
    await new Promise(r => setTimeout(r, 180));
  }

  if (alerts.length > 200) alerts.length = 200;
  write(STATE_FILE, state);
  write(ALERT_FILE, alerts);
  core.savePriceCache(priceCache);
  result.message = result.alerts.length
    ? `发现 ${result.alerts.length} 条跨阈值变化，已尝试发送邮件与微信`
    : `已检查 ${result.checked} 款愿望单游戏，没有跨过 ¥${cfg.thresholdYuan} 的价格变化`;
  return result;
}

function status() {
  const cfg = config();
  const state = read(STATE_FILE, {});
  const alerts = read(ALERT_FILE, []);
  const muted = readMuted();
  const mutedIds = new Set(muted);
  const entries = Object.entries(state).map(([appid, v]) => ({ appid, ...v, muted: mutedIds.has(appid) }));
  return {
    enabled: cfg.enabled,
    thresholdYuan: cfg.thresholdYuan,
    tracked: entries.length,
    belowCount: entries.filter(x => x.below).length,
    items: entries.sort((a, b) => a.lastFinalCents - b.lastFinalCents).slice(0, 60),
    alerts: alerts.slice(0, 30),
    muted,
    mutedCount: muted.length,
    mail: mail.status()
  };
}

module.exports = { checkPrices, status, config, setMuted, deleteAlert, STATE_FILE, ALERT_FILE, MUTED_FILE };

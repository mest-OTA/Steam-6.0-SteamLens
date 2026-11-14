/**
 * SteamLens · QQ 直接登录引擎（登录「你自己的 QQ」，自己发给自己）
 *
 * 方式：① 扫码登录 ② QQ 号 + 密码登录。成功后用这个 QQ 给自己发一条消息。
 *
 * ★ 扫码登录的两个硬性约束（oicq 2.3.1，之前登不上的根因）：
 *   1) createClient() 必须传入要登录的 QQ 号。用 createClient(0) 时，手机确认后
 *      oicq 会判定「扫码账号(你的QQ)与登录账号(0)不符」，直接丢弃结果并自动换码，
 *      于是手机显示成功、面板永远停在等待扫码。
 *   2) 手机点「确认登录」后必须再调用一次 client.login() 才会真正上线
 *      （官方示例就是「扫码后按回车登录」），光监听 system.online 不会自己发生。
 *   因此这里：扫码前绑定 QQ 号 + 每 1.5 秒轮询扫码结果 + 确认后自动 login()
 *   + 未填 QQ 号时从「账号不符」错误里识别出 QQ 号并自动用正确账号换一张新码。
 *
 * 风险：协议模拟登录可能被腾讯风控，请只用于自己的账号、只给自己发消息。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data', 'qq-direct');
const LOGINS_FILE = path.join(DATA_DIR, 'logins.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
/* 腾讯封禁旧协议这件事要跨重启记住，否则每次重启用户又被骗去试一遍 */
const BAN_FILE = path.join(DATA_DIR, 'protocol-banned.json');
/* 滑块 / 设备锁验证链接要跨重启记住：改代码重启服务时不至于把用户手上那条链接弄丢 */
const VERIFY_FILE = path.join(DATA_DIR, 'verify.json');

let oicqMod = null;
function loadOicq() {
  if (oicqMod) return oicqMod;
  try {
    oicqMod = require('oicq');
    return oicqMod;
  } catch (e) {
    const err = new Error('未安装 oicq 依赖，请先在 SteamLens 目录执行：npm install oicq');
    err.code = 'NO_OICQ';
    throw err;
  }
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}
function deviceName() { try { return os.hostname() || '本机'; } catch { return '本机'; } }
function maskUin(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return s.slice(0, 2) + '•••' + s.slice(-2);
}
function isUin(v) { return /^\d{5,12}$/.test(String(v || '')); }
function verifyUin() {
  let n = '';
  try { n = String((client && client.uin) || 0); } catch { /* */ }
  if (!isUin(n)) n = String(currentUin || detectedUin || '');
  if (!isUin(n)) n = String(loadSession().lastUin || '');
  return isUin(n) ? n : '';
}
/**
 * 腾讯下发的验证链接里 uin 经常是 0，直接用会提示参数无效 / 拿不到 ticket。
 * 只做「定点替换」，绝不重编码整个 query —— cap_cd / sid 是签名参数，
 * 经过 URLSearchParams 重新序列化后可能被改变，导致链接失效。
 */
function normalizeVerifyUrl(raw, uin) {
  let u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  const n = String(uin || verifyUin() || '').trim();
  if (isUin(n)) {
    u = u.replace(/([?&])uin=(?:0|)(?=&|#|$)/i, `$1uin=${n}`);
    if (!/[?&]uin=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'uin=' + n;
  }
  return u;
}
function saveVerify() {
  try {
    ensureDir();
    fs.writeFileSync(VERIFY_FILE, JSON.stringify({
      sliderUrl, sliderRawUrl, sliderAt, deviceUrl, deviceNote,
      uin: verifyUin(), savedAt: Date.now()
    }, null, 2));
  } catch { /* 写不进也不影响登录 */ }
}
function clearVerify() {
  sliderUrl = ''; sliderRawUrl = ''; sliderAt = 0; deviceUrl = ''; deviceNote = '';
  sliderRefreshing = false; sliderRefreshAt = 0;
  try { fs.unlinkSync(VERIFY_FILE); } catch { /* */ }
}
function isoSecond(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------------- 内存状态 ---------------- */
let client = null;
let state = 'offline';          // offline | connecting | qrcode | slider | device | online | error
let currentUin = '';
let currentMethod = '';         // qrcode | password
let qrDataUri = '';
let sliderUrl = '';
let sliderRawUrl = '';
let sliderAt = 0;
let sliderRefreshing = false;
let sliderRefreshAt = 0;
let deviceUrl = '';
let deviceNote = '';
let devicePhone = '';
let ticketAutoAt = 0;          // 验证页脚本自动回传 ticket 的时间
let lastError = '';
let lastErrorAt = 0;
let lastErrorCode = 0;
let qrGeneratedAt = 0;
let scanState = '';
let networkError = '';
let detectedUin = '';
let onlineAtIso = '';
let qrPoll = null;
let qrPollBusy = false;
let lastScanCode = null;
const events = [];              // 登录诊断时间线（精确到秒）
const logins = loadLogins();

/* 服务重启后恢复最近 30 分钟内的验证链接：改代码 / 守护拉起服务时链接不会凭空消失 */
try {
  const v = JSON.parse(fs.readFileSync(VERIFY_FILE, 'utf8'));
  const age = Date.now() - Number(v.sliderAt || 0);
  if (v && age >= 0 && age < 30 * 60 * 1000) {
    sliderRawUrl = String(v.sliderRawUrl || '');
    sliderUrl = String(v.sliderUrl || '') || normalizeVerifyUrl(sliderRawUrl, v.uin);
    sliderAt = Number(v.sliderAt || 0);
    deviceUrl = String(v.deviceUrl || '');
    deviceNote = String(v.deviceNote || '');
  }
} catch { /* 没有可恢复的验证链接，属于正常情况 */ }

function loadLogins() {
  ensureDir();
  try {
    const arr = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveLogins() {
  ensureDir();
  try { fs.writeFileSync(LOGINS_FILE, JSON.stringify(logins.slice(0, 100), null, 2)); } catch { /* ignore */ }
}
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; }
}
function saveSession(patch) {
  ensureDir();
  const s = Object.assign(loadSession(), patch);
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  return s;
}
function pushLogin(rec) {
  logins.unshift(Object.assign({
    ts: Date.now(),
    iso: isoSecond(),
    device: deviceName(),
    where: '本机 · ' + deviceName()
  }, rec));
  if (logins.length > 100) logins.length = 100;
  saveLogins();
}
function pushEvent(text, detail) {
  events.unshift({ ts: Date.now(), iso: isoSecond(), text: String(text || ''), detail: String(detail || '') });
  if (events.length > 50) events.length = 50;
  try { console.log('[QQ登录 ' + isoSecond() + '] ' + text + (detail ? ' · ' + detail : '')); } catch { /* */ }
}
function setState(s) { state = s; }

/* ---------------- 客户端生命周期 ---------------- */
function dropClient(c) {
  if (!c) return;
  // 移除监听器，避免旧会话迟到的事件把新会话的状态打回去
  try { c.removeAllListeners && c.removeAllListeners(); } catch { /* */ }
  try { c.terminate(); } catch { /* */ }
  if (client === c) client = null;
}
function newClient(uin) {
  const { createClient } = loadOicq();
  return createClient(Number(uin) || 0, {
    platform: 5,
    log_level: 'warn',
    data_dir: DATA_DIR,
    ignore_self: false
  });
}
function stopQrPoll() { if (qrPoll) { clearInterval(qrPoll); qrPoll = null; } qrPollBusy = false; }

/** 轮询扫码结果：手机点确认后自动调用 login() 完成上线 */
function startQrPoll(c) {
  stopQrPoll();
  lastScanCode = null;
  qrPoll = setInterval(async () => {
    if (qrPollBusy || client !== c || state === 'online' || state === 'error') return;
    qrPollBusy = true;
    try {
      const r = await c.queryQrcodeResult();
      const code = Number(r && r.retcode);
      if (code !== lastScanCode) {
        lastScanCode = code;
        const label = ({ 48: '等待手机扫码', 53: '已扫码，等待手机点「确认登录」', 17: '二维码超时', 54: '扫码被取消', 0: '手机已确认' })[code]
          || ('扫码返回码 ' + code);
        pushEvent('扫码状态：' + label, 'QQ ' + (c.uin || '未指定'));
      }
      if (code === 53) scanState = '已扫码 · 请在手机 QQ 上点「确认登录」';
      else if (code === 48) scanState = '等待手机 QQ 扫码';
      else if (code === 17 || code === 54) {
        scanState = '二维码已失效，正在自动换新码';
        try { c.login(); } catch (e) { pushEvent('换新二维码失败：' + e.message); }
      } else if (code === 0 && r && r.t106) {
        scanState = '手机已确认，正在完成登录…';
        pushEvent('手机已确认登录，正在向 QQ 服务器完成上线', 'QQ ' + (c.uin || ''));
        stopQrPoll();
        try { const p = c.login(); if (p && p.catch) p.catch(e => pushEvent('完成登录失败：' + e.message)); }
        catch (e) { pushEvent('完成登录失败：' + e.message); }
      }
    } catch (e) {
      networkError = '查询扫码结果失败：' + (e.message || '网络异常');
    } finally { qrPollBusy = false; }
  }, 1500);
  try { qrPoll.unref(); } catch { /* */ }
}

/* ---------------- 事件绑定 ---------------- */
function bindClient(c, method) {
  currentMethod = method;
  c.on('system.login.qrcode', (e) => {
    if (client !== c || state === 'online') return;   // 迟到的二维码事件不许覆盖「已登录」
    try { qrDataUri = 'data:image/png;base64,' + Buffer.from(e.image).toString('base64'); }
    catch { qrDataUri = ''; }
    qrGeneratedAt = Date.now();
    scanState = '等待手机 QQ 扫码';
    networkError = '';
    setState('qrcode');
    pushEvent('二维码已生成', c.uin ? ('绑定 QQ ' + c.uin) : '未绑定 QQ 号（首次自动识别）');
    if (method === 'qrcode') startQrPoll(c);
  });

  // oicq 内部事件：账号不符 / 超时 / 取消都走这里（qrcodeErrorListener 会自动换码）
  c.on('internal.error.qrcode', (code, message) => {
    if (client !== c || state === 'online') return;
    const msg = String(message || '');
    const m = msg.match(/扫码账号\((\d{5,12})\)/);
    if (m) {
      detectedUin = m[1];
      saveSession({ lastUin: detectedUin });
      pushEvent('已识别到你的 QQ 号 ' + detectedUin, '旧二维码未绑定账号，正在自动换成绑定该账号的新二维码，请再扫一次');
      // 二维码里的账号必须和 client 绑定一致：立刻停用旧会话，用该 QQ 号重建
      if (state === 'online' || client !== c) return;
      try { dropClient(c); startQR(detectedUin, true); }
      catch (e) { pushEvent('自动换码失败：' + e.message); }
      return;
    }
    scanState = '';
    pushEvent('扫码返回：' + msg, '返回码 ' + code);
    if (/超时|被取消|未知错误|失败/.test(msg)) { lastError = msg; lastErrorAt = Date.now(); }
  });

  c.on('system.login.slider', (e) => {
    if (client !== c || state === 'online') return;
    sliderRawUrl = String(e.url || e.link || e.captchaUrl || '').trim();
    /* status() 以前根本没把 sliderUrl 返回给前端，这才是「滑块验证页刷新不出来」的根因 */
    sliderUrl = normalizeVerifyUrl(sliderRawUrl, c.uin || currentUin || detectedUin);
    sliderAt = Date.now();
    sliderRefreshing = false; sliderRefreshAt = 0;
    /* 能走到验证流程说明服务器已放行，之前的历史错误码 45 / 155 不再是当前状态 */
    lastError = ''; lastErrorCode = 0; lastErrorAt = 0;
    try { fs.unlinkSync(BAN_FILE); } catch { /* */ }
    saveVerify();
    setState('slider'); stopQrPoll();
    pushEvent('需要滑块验证', sliderUrl || sliderRawUrl || '服务器未给出链接，请重新发起登录');
  });

  c.on('system.login.device', (e) => {
    if (client !== c || state === 'online') return;
    const raw = String(e.url || e.link || '').trim();
    deviceUrl = normalizeVerifyUrl(raw, c.uin || currentUin || detectedUin);
    devicePhone = String(e.phone || '').trim();
    deviceNote = deviceUrl ? ('请在浏览器打开：' + deviceUrl) : '请在手机 QQ 上确认本次登录';
    saveVerify();
    setState('device'); stopQrPoll();
    pushEvent('需要设备锁 / 登录保护验证', deviceNote);
  });

  c.on('system.login.error', (e) => {
    if (client !== c || state === 'online') return;
    lastError = String(e.message || ('错误码 ' + (e.code || '?')));
    lastErrorCode = Number(e.code || 0);
    lastErrorAt = Date.now();
    /* 验证流程里的错误（ticket 过期 / 超时）不等于协议被封，别再写封禁标记 */
    if (!sliderUrl && bannedByServer()) markBanned();
    /* 关键：链接还在时保持 slider 状态，否则面板会「一闪就没」，用户以为没刷新出来 */
    setState(sliderUrl ? 'slider' : 'error'); stopQrPoll();
    pushEvent('登录失败：' + lastError, '错误码 ' + (e.code || '?'));
    if (sliderUrl) pushEvent('验证链接仍然保留', '完成验证后把 ticket 贴回上方输入框即可继续');
  });

  // 网络错误只记录，不把二维码面板切走，避免「一闪就没了」
  c.on('system.offline.network', (e) => {
    if (client !== c) return;
    networkError = String((e && e.message) || 'QQ 服务器连接失败');
    pushEvent('网络异常：' + networkError, '请检查本机能否访问 QQ 服务器（安全软件 / 网络策略可能拦截）');
  });

  c.on('system.online', () => {
    if (client !== c) return;
    const wasOnline = state === 'online';
    currentUin = String(c.uin || currentUin || detectedUin || '');
    qrDataUri = ''; clearVerify(); scanState = '';
    networkError = ''; lastError = '';
    onlineAtIso = new Date().toISOString();
    setState('online'); stopQrPoll();
    saveSession({ uin: currentUin, lastUin: currentUin, method: currentMethod, onlineAtIso });
    if (!wasOnline) {
      pushLogin({ type: 'login', uin: currentUin, method: currentMethod });
      pushEvent('✓ 已登录 QQ ' + maskUin(currentUin), '方式：' + (currentMethod === 'qrcode' ? '扫码登录' : 'QQ号+密码登录'));
      const msg = `🟢 SteamLens 已用你的 QQ 登录成功\n时间：${isoSecond()}\n设备：本机 · ${deviceName()}\n方式：${currentMethod === 'qrcode' ? '扫码登录' : 'QQ号+密码登录'}`;
      sendToSelf(msg).catch(() => { /* 已记录日志即可 */ });
    }
  });

  c.on('system.offline', (e) => {
    if (client !== c) return;
    const reason = (e && (e.message || e.retcode)) ? String(e.message || e.retcode) : '未知';
    if (state === 'online') { pushLogin({ type: 'logout', uin: currentUin, reason }); pushEvent('QQ 已离线', reason); }
    setState('offline'); onlineAtIso = ''; stopQrPoll();
  });
}

/* ---------------- ticket 提取 ----------------
 * ★ 关键认知（oicq 官方源码 lib/internal/listeners.js 原话）：
 *   「收到滑动验证码，请访问以下地址完成滑动，并**从网络响应中取出 ticket** 输入」
 *   腾讯的 ti.qq.com 安全验证页做完验证后【不会在页面上把 ticket 显示给你】，
 *   ticket 只在浏览器 F12 → Network → cap_union_new_verify 之类请求的响应 JSON 里，
 *   有时会带在验证完成后的地址栏 URL 上。以前界面写「把页面给出的 ticket 粘回来」
 *   是错的，用户做完验证自然拿不到任何东西。
 * 因此这里允许粘贴任意内容（完整响应 JSON / 地址栏 URL / 页面文字 / 纯 ticket），
 * 统一把 ticket 抠出来。 */
function maskTicket(t) {
  const s = String(t || '');
  return s.length <= 12 ? s.slice(0, 3) + '…' : s.slice(0, 6) + '…' + s.slice(-4);
}
function extractTicket(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const found = [];
  const add = v => {
    let x = String(v || '').trim();
    try { x = decodeURIComponent(x); } catch { /* 原样即可 */ }
    x = x.replace(/^[\s<("'`]+|[\s>)"'`;,]+$/g, '');
    x = x.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (!x || /^https?:\/\//i.test(x)) return;
    if (/^[A-Za-z0-9_\-+.=/%&:?]{6,500}$/.test(x)) found.push(x);
  };
  let m;
  // ① 响应 JSON / 页面文字： "ticket":"xxx"、'ticket': 'xxx'、ticket = xxx
  const reField = /(?:ticket|cap_ticket|sms_ticket)\s*["']?\s*[:=]\s*(?:["']([^"'\n\r,}\]]{6,500})["']|([A-Za-z0-9_\-+.=/%]{6,500}))/gi;
  while ((m = reField.exec(s))) add(m[1] || m[2]);
  // ② 地址栏 URL： ?ticket=xxx / &ticket=xxx / #ticket=xxx
  const reQuery = /[?&#](?:ticket|cap_ticket|sms_ticket)=([^&#\s"'<>\]]{6,500})/gi;
  while ((m = reQuery.exec(s))) add(m[1]);
  // ③ 中文提示后的裸值：ticket 为：xxxx
  const reText = /ticket[^A-Za-z0-9]{0,14}([A-Za-z0-9_\-+.=/%]{8,500})/gi;
  while ((m = reText.exec(s))) add(m[1]);
  // ④ 用户直接粘了一整串 ticket
  if (/^[A-Za-z0-9_\-+.=/%]{6,500}$/.test(s)) add(s);
  // ticket 通常比 randstr / 其它字段长；去重后取最长的一条
  return [...new Set(found)].sort((a, b) => b.length - a.length)[0] || '';
}

/* ---------------- 公开方法 ---------------- */
/**
 * 开始扫码登录。uin 必须是本人 QQ 号；不填时用上次识别/登录过的号，
 * 实在没有才用 0 走一次「自动识别」，识别成功后会自动换正确二维码。
 */
function startQR(uin, force) {
  const given = String(uin || '').trim();
  const s = loadSession();
  const use = isUin(given) ? given
    : (isUin(detectedUin) ? detectedUin
      : (isUin(s.lastUin) ? String(s.lastUin) : '0'));
  // 复用当前活动二维码，防止「刷新几次页面就把用户正在扫的码作废」
  if (!force && client && Number(client.uin) === Number(use)
      && state === 'qrcode' && qrDataUri && Date.now() - qrGeneratedAt < 150000) {
    return { ok: true, state, qrDataUri, reused: true, uin: use, scanState };
  }
  dropClient(client);
  const c = newClient(use);
  client = c;
  currentUin = use === '0' ? '' : use;
  currentMethod = 'qrcode';
  qrDataUri = ''; lastError = ''; networkError = ''; scanState = '正在获取二维码…';
  qrGeneratedAt = 0; onlineAtIso = '';
  setState('connecting');
  stopQrPoll();
  pushEvent('开始扫码登录', use === '0' ? '未填 QQ 号，先自动识别账号' : ('绑定 QQ ' + use));
  saveSession({ lastUin: currentUin || s.lastUin || '' });
  bindClient(c, 'qrcode');
  try { const p = c.login(); if (p && p.catch) p.catch(e => { lastError = e.message; setState('error'); pushEvent('获取二维码失败：' + e.message); }); }
  catch (e) { lastError = e.message; lastErrorAt = Date.now(); setState('error'); pushEvent('获取二维码失败：' + e.message); }
  return { ok: true, state, qrDataUri, uin: use, scanState };
}

function startPassword(uin, pwd) {
  uin = String(uin || '').trim();
  pwd = String(pwd || '');
  if (!isUin(uin)) return { ok: false, error: 'QQ 号应为 5–12 位纯数字' };
  if (!pwd) return { ok: false, error: '密码不能为空' };
  dropClient(client); stopQrPoll();
  const c = newClient(uin);
  client = c;
  currentUin = uin; currentMethod = 'password';
  qrDataUri = ''; lastError = ''; networkError = ''; scanState = '';
  qrGeneratedAt = 0; onlineAtIso = '';
  setState('connecting');
  pushEvent('开始 QQ 号 + 密码登录', 'QQ ' + uin);
  saveSession({ lastUin: uin });
  bindClient(c, 'password');
  try { const p = c.login(pwd); if (p && p.catch) p.catch(e => { lastError = e.message; setState('error'); pushEvent('密码登录失败：' + e.message); }); }
  catch (e) { lastError = e.message; lastErrorAt = Date.now(); setState('error'); }
  return { ok: true, state, uin };
}

/** 「我已在手机确认，完成登录」：手动补一次 login()（自动轮询之外的兜底） */
function finishScan() {
  if (!client) return { ok: false, error: '当前没有进行中的登录' };
  if (state === 'online') return { ok: true, already: true, state };
  pushEvent('手动触发完成登录');
  try {
    const p = client.login();
    if (p && p.catch) p.catch(e => pushEvent('完成登录失败：' + e.message));
    return { ok: true, state };
  } catch (e) { return { ok: false, error: e.message }; }
}

function submitSlider(ticket, source = 'manual') {
  if (state === 'online') return { ok: true, already: true, state };
  if (!client) return { ok: false, error: '当前没有进行中的登录会话（服务可能重启过）；请先点「↻ 重新获取验证链接」或重新登录一次' };
  /* 允许直接粘整段响应 / URL：统一抠出 ticket，不让用户自己去找哪一段是 ticket */
  const t = extractTicket(ticket);
  if (!t) {
    pushEvent('没识别到 ticket', '请复制 F12 → Network 里验证请求的完整响应（含 "ticket" 字段），或验证完成后地址栏的完整 URL');
    return { ok: false, error: '没有识别到 ticket：请粘贴验证请求的响应 JSON / 验证后地址栏 URL / 页面上的 ticket 字符串' };
  }
  try {
    client.submitSlider(t);
    /* 前端现在按 sliderUrl 显示验证卡片，这里切 connecting 不会把卡片藏掉 */
    setState('connecting');
    if (source === 'auto') ticketAutoAt = Date.now();
    const label = source === 'auto' ? '验证页自动回传了 ticket，正在提交'
      : source === 'paste' ? '已从粘贴内容自动识别 ticket，正在提交'
        : '已提交滑块 ticket';
    pushEvent(label, 'ticket ' + maskTicket(t) + ' · 等待 QQ 服务器确认…');
    return { ok: true, ticket: maskTicket(t), state };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 「自动提取 ticket」：用户把任意内容粘进大输入框，后端负责抠 ticket 并提交 */
function submitTicketPaste(raw) {
  const t = extractTicket(raw);
  if (!t) return { ok: false, error: '这段内容里没有找到 ticket。请复制 F12 → Network 中验证请求的响应（里面有 "ticket" 字段），或者验证完成后浏览器地址栏的完整链接。' };
  return submitSlider(t, 'paste');
}

/** 验证页里的自动抓取脚本回传 ticket（GET 走图片、POST 走 fetch，双保险） */
function receiveTicket(raw) {
  if (state === 'online') return { ok: true, already: true, state };
  const t = extractTicket(raw) || String(raw || '').trim();
  if (!t) return { ok: false, error: 'ticket 为空' };
  if (!client) return { ok: false, error: '本机当前没有进行中的验证会话' };
  return submitSlider(t, 'auto');
}

/** 验证已做完但没拿到 ticket：直接重新 login() 一次。
 *  oicq 在验证通过后复用 0x104 / password_md5 重新发包，腾讯若已放行会直接上线，
 *  否则会重新下发一条验证链接 —— 两种情况界面都会每秒自动反映。 */
function finishVerify() {
  if (state === 'online') return { ok: true, already: true, state };
  if (!client) return { ok: false, needsRelogin: true, error: '当前没有对应的登录会话（服务可能重启过），请在上方重新点「🔑 QQ 号 + 密码登录」' };
  pushEvent('已完成安全验证，重新向 QQ 服务器发起登录',
    '腾讯若已放行会直接上线；若仍要求验证会下发一条新链接。都不需要手动找 ticket');
  try {
    const p = client.login();
    if (p && p.catch) p.catch(e => pushEvent('重新登录失败：' + e.message, '可改用下方「自动提取 ticket」，或回到开始界面重新登录一次'));
    return { ok: true, state };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 短信验证码备选路径（设备锁 / 短信验证登录页用得上） */
function sendSms() {
  if (!client) return { ok: false, error: '当前没有进行中的登录会话' };
  try {
    client.sendSmsCode();
    pushEvent('已请求发送短信验证码', devicePhone ? ('密保手机 ' + devicePhone) : '请在手机上查收');
    return { ok: true, phone: devicePhone };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 滑块验证是否还挂在同一个登录会话上（服务重启 / 切到扫码后就不再是了） */
function sliderSessionAlive() {
  return !!client && (state === 'slider' || state === 'connecting' || state === 'error');
}
/** 手动「重新获取验证链接」：只在原会话还在时重发登录；会话已断就明确引导重新登录，
 *  不偷偷换成二维码流程（无密码 login() 只会生成二维码，拿不到新滑块链接）。 */
function refreshSlider() {
  if (state === 'online') return { ok: false, error: '已经登录，无需再验证' };
  if (!sliderSessionAlive()) {
    return {
      ok: false, needsRelogin: true,
      error: '当前没有对应的登录会话（服务可能重启过，或已切到扫码）。请在上方重新点「🔑 QQ 号 + 密码登录」或「▣ 扫码登录 QQ」，腾讯会下发一条全新的验证链接。'
    };
  }
  sliderRefreshing = true;
  sliderRefreshAt = Date.now();
  try { fs.unlinkSync(BAN_FILE); } catch { /* */ }
  pushEvent('正在重新获取滑块验证链接', '旧链接可能已过期；收到新链接后上方地址和时间会自动更新');
  try {
    const p = client.login();
    if (p && p.catch) p.catch(e => { sliderRefreshing = false; pushEvent('重新获取验证链接失败：' + e.message, '可回到开始界面重新登录一次'); });
    return { ok: true, state };
  } catch (e) {
    sliderRefreshing = false;
    return { ok: false, error: e.message };
  }
}
function submitSmsCode(code) {
  if (!client) return { ok: false, error: '当前没有进行中的登录' };
  try { client.submitSmsCode(String(code || '').trim()); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
function confirmDevice() {
  if (!client) return { ok: false, error: '当前没有进行中的登录' };
  try { client.login(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
function cancel() {
  dropClient(client); stopQrPoll();
  qrDataUri = ''; clearVerify(); scanState = ''; qrGeneratedAt = 0;
  setState('offline');
  pushEvent('已取消登录');
  return { ok: true, state };
}
/** 回到「QQ 登录 · 自己发自己」的开始界面：停会话、清错误、清诊断事件 */
function reset() {
  dropClient(client); stopQrPoll();
  qrDataUri = ''; clearVerify(); scanState = '';
  qrGeneratedAt = 0; onlineAtIso = ''; lastError = ''; lastErrorCode = 0;
  lastErrorAt = 0; networkError = '';
  try { fs.unlinkSync(BAN_FILE); } catch {}   // 用户主动重新开始，才允许再试一次
  setState('offline');
  events.length = 0;
  saveSession({ uin: '' });
  return { ok: true, state, status: status() };
}
function logout() {
  dropClient(client); stopQrPoll();
  qrDataUri = ''; clearVerify(); scanState = ''; qrGeneratedAt = 0;
  setState('offline'); onlineAtIso = '';
  pushEvent('已退出 QQ 登录');
  saveSession({ uin: '', autoLogin: false });
  return { ok: true, state };
}

async function sendToSelf(text) {
  if (!client || state !== 'online') return { ok: false, error: 'QQ 尚未登录或已离线' };
  try {
    await client.sendPrivateMsg(client.uin, String(text || ''));
    return { ok: true, to: client.uin };
  } catch (e) { return { ok: false, error: e.message }; }
}

function isOnline() { return state === 'online' && !!client; }
function liveUin() { return isOnline() ? String(client.uin) : ''; }
function setAutoLogin(enabled) { saveSession({ autoLogin: !!enabled }); return { ok: true, autoLogin: !!enabled }; }

/** 服务启动时恢复：只有「以前真正登录成功过」(session.uin) 且用户允许自动重连才恢复。
 *  lastUin 只是给输入框预填用的，绝不拿它自动弹二维码，否则每次启动都会
 *  把用户丢回二维码界面，而不是干净的「QQ 登录 · 自己发自己」开始界面。 */
function autoLoginIfSaved() {
  /* 「QQ 登录 · 自己发自己」已按用户要求移除：服务启动时不再自动重连 QQ 协议客户端，
     也不会再弹二维码 / 滑块 / ticket 流程。保留本函数只为兼容旧调用，不做任何登录。 */
  return false;
}

/** 腾讯对 oicq 旧版协议的整体封禁：这些错误码与密码、验证码、网络都无关 */
function readBan() {
  try { return JSON.parse(fs.readFileSync(BAN_FILE, 'utf8')); } catch { return null; }
}
function bannedByServer() {
  return lastErrorCode === 45 || lastErrorCode === 155
    || /禁止登录|下载最新版QQ|太久没有操作|版本过低|协议/.test(lastError || '');
}
function markBanned() {
  try {
    ensureDir();
    fs.writeFileSync(BAN_FILE, JSON.stringify({
      banned: true, code: lastErrorCode, message: lastError, at: Date.now()
    }, null, 2), 'utf8');
  } catch {}
}
function isProtocolBanned() {
  if (bannedByServer()) return true;
  const b = readBan();
  return !!(b && b.banned);
}

function buildHint() {
  if (state === 'online') return '已登录。通知会发给你自己；下线后勾选「记住并自动重连」可在重启服务时自动恢复。';
  if (sliderUrl) return '需要完成安全验证：腾讯不会在页面上直接显示 ticket，它藏在浏览器 F12 → Network 里验证请求的响应中（"ticket" 字段），有时也会出现在验证完成后的地址栏 URL 上。最省事的是做完验证后直接点「✓ 我已完成验证，直接完成登录」；不行就把响应内容 / 地址栏链接粘进「自动提取 ticket」框，或重新登录一次拿新链接。';
  if (isProtocolBanned()) {
    const b = readBan();
    const code = Number((b && b.code) || lastErrorCode || 0);
    const how = code === 45 ? '错误码 45「请下载最新版 QQ 后重试」'
      : code === 155 ? '错误码 155「太久没有操作，请重新登录」' : '腾讯协议风控';
    return '上次登录被 QQ 服务器拒绝（' + how + '）。这可能与 QQ 客户端版本 / 登录环境有关；' +
      '扫码登录和「QQ 号 + 密码登录」两个按钮都保持可用，更新 QQ 或换过网络后点「↺ 回到开始界面 / 重新登录」再试即可。' +
      '暂时登不上时，通知也可以走「通知与邮箱」里的 QQ 邮箱 SMTP、微信 / 钉钉，或 QQ 通知里的 Qmsg / OneBot 通道发给你自己。';
  }
  if (networkError) return '本机服务连不上 QQ 服务器：请检查网络 / 安全软件是否拦截了 node 访问 QQ 服务器，然后点「刷新二维码」重试。';
  if (currentMethod === 'qrcode' && (!client || Number(client.uin) === 0))
    return '扫码登录必须先填你自己的 QQ 号（oicq 要求扫码前绑定账号）。未填时系统会从扫码结果自动识别，并换一张新二维码让你再扫一次。';
  if (scanState && /已扫码/.test(scanState)) return '手机已扫码，请点手机上的「确认登录」。扫码需与电脑在同一网络（同一 IP），手机用流量时可能失败。';
  if (state === 'qrcode') return '扫码后如果界面一直没变，点「我已在手机确认，完成登录」；若服务端返回「禁止登录」，说明旧协议已被腾讯停用，请改用邮件 / 微信 / 钉钉通知。';
  return '用扫码或 QQ 号 + 密码登录你本人的 QQ；所有消息只发给你自己。';
}

function status() {
  let installed = false;
  try { loadOicq(); installed = true; } catch { /* */ }
  if (sliderRefreshing && Date.now() - sliderRefreshAt > 15000) sliderRefreshing = false;
  return {
    installed,
    state,
    uin: maskUin(currentUin),
    uinFull: currentUin,
    method: currentMethod,
    online: isOnline(),
    hasQR: state === 'qrcode' && !!qrDataUri,
    qrDataUri: (state === 'qrcode' || state === 'connecting') ? qrDataUri : '',
    qrGeneratedAtIso: qrGeneratedAt ? new Date(qrGeneratedAt).toISOString() : null,
    qrAgeSec: qrGeneratedAt ? Math.max(0, Math.round((Date.now() - qrGeneratedAt) / 1000)) : 0,
    scanState, networkError, detectedUin, onlineAtIso,
    hasClient: !!client,
    /* 验证链接：以前漏了这几个字段，前端只能显示 href="#" 的占位链接 */
    sliderUrl, sliderRawUrl,
    sliderAtIso: sliderAt ? new Date(sliderAt).toISOString() : null,
    sliderAgeSec: sliderAt ? Math.max(0, Math.round((Date.now() - sliderAt) / 1000)) : 0,
    sliderPending: !!sliderUrl && state !== 'online',
    sliderSessionAlive: sliderSessionAlive(),
    sliderRefreshing,
    ticketAutoAtIso: ticketAutoAt ? new Date(ticketAutoAt).toISOString() : null,
    deviceUrl, deviceNote, devicePhone,
    connecting: state === 'connecting',
    events: events.slice(0, 16),
    lastError: lastError && (Date.now() - lastErrorAt < 120000) ? lastError : (state === 'error' ? lastError : ''),
    lastErrorCode,
    /* 已经进入验证流程就不是「协议被封」，别让旧的错误码 45 横幅继续误导 */
    protocolBanned: sliderUrl ? false : isProtocolBanned(),
    hint: buildHint(),
    autoLogin: loadSession().autoLogin !== false,
    where: '本机 · ' + deviceName(),
    logins: logins.slice(0, 30)
  };
}

module.exports = {
  status, startQR, startPassword, finishScan, submitSlider, refreshSlider,
  submitTicketPaste, receiveTicket, finishVerify, sendSms, extractTicket,
  submitSmsCode, confirmDevice, cancel, logout, reset, sendToSelf,
  isOnline, liveUin, setAutoLogin, autoLoginIfSaved
};

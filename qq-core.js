/**
 * SteamLens · QQ 通知通道（零第三方依赖，只发给你自己的 QQ）
 *
 * 边界说明：
 *  - QQ 个人号没有开放给第三方程序的登录 / 发消息接口，"扫码代登录 QQ" 属于协议模拟，
 *    会封号也会让聊天记录暴露给本地程序，因此不做。
 *  - 合规等价方案（消息只发到你自己的 QQ，别人发不进来，也不读任何聊天）：
 *      1. Qmsg 酱：在官方页用 QQ 扫码绑定，拿一个 Key；消息由官方机器人推给你的 QQ。
 *      2. 本机 QQ 机器人：NapCat / Lagrange.OneBot 等本地 HTTP 接口，发给指定的自己 QQ 号。
 *      3. 自定义 Webhook：任何你自己搭的转发服务。
 *  - 另外 QQ 邮箱通道已存在，QQ 客户端本身也会收到邮件提醒。
 */
'use strict';

const core = require('./steam-core');
const { httpPost } = require('./wechat-core');
const qqLogin = require('./qq-login-core');   // QQ 直接登录引擎（你自己的 QQ，自己发自己）

const CHANNELS = {
  qmsg: { name: 'Qmsg 酱 · QQ 扫码绑定', home: 'https://qmsg.zendee.cn/', hint: 'QQ 扫码登录后复制 Qmsg Key，并填接收消息的自己的 QQ 号' },
  onebot: { name: '本机 QQ 机器人 (OneBot)', home: 'https://napneko.github.io/', hint: '填本机 HTTP 地址与自己的 QQ 号，例如 http://127.0.0.1:3000' },
  custom: { name: '自定义 Webhook', home: '', hint: '填一个能接收 POST(JSON) 的完整 URL：① 用本机 QQ 机器人（NapCat / Lagrange）的 OneBot 地址（如 http://127.0.0.1:3000/send_private_msg）；② 自己搭任意能收 POST 的转发服务。SteamLens 会 POST {title, body, text, qq} 过去。' }
};

const recent = new Map();
const history = [];
const MAX_HISTORY = 60;
const MIN_TEST_GAP_MS = 3000;   // 连点 / 双触发保护：即使 force 也至少隔 3 秒

/** QQ 号只允许纯数字；界面上的掩码值绝不能写回配置 */
function cleanUin(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{5,12}$/.test(s) ? s : '';
}
function maskUin(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 4) return '••••';
  return s.slice(0, 2) + '•••' + s.slice(-2);
}
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return k.slice(0, 2) + '••••';
  return k.slice(0, 4) + '••••••••' + k.slice(-4);
}

function cfg() {
  const c = core.getConfig();
  const rawUin = String(c.qqUin || '').trim();
  return {
    channel: CHANNELS[c.qqChannel] ? c.qqChannel : 'qmsg',
    key: String(c.qqKey || '').trim(),
    uin: cleanUin(rawUin),
    rawUin,
    uinInvalid: !!rawUin && !cleanUin(rawUin),
    endpoint: String(c.qqEndpoint || '').trim(),
    enabled: c.qqEnabled === true,
    onOnline: c.qqOnOnline !== false,
    onOffline: c.qqOnOffline !== false,
    onWishlist: c.qqOnWishlist !== false,
    minIntervalSec: Math.min(3600, Math.max(0, Number(c.qqMinIntervalSec) || 60))
  };
}

/** 不发任何请求的纯诊断：把「为什么收不到」直接摆到界面上 */
function diagnose(c = cfg()) {
  const out = [];
  if (!c.enabled) out.push({ level: 'warn', text: 'QQ 推送总开关已关闭，测试消息可用，但自动通知不会发。' });
  if (c.channel === 'qmsg') {
    if (!c.key) out.push({ level: 'error', text: '还没填 Qmsg Key：请到 qmsg.zendee.cn 用 QQ 扫码绑定后复制 Key。' });
    else if (/^(SCT|SCU|send_)/i.test(c.key))
      out.push({ level: 'error', text: '当前填的是 Server酱 / 微信通道的 SendKey（SCT…），不是 Qmsg 的 Key，所以 Qmsg 官网不会有记录。请换填 Qmsg 官网的 Key。' });
    if (c.uinInvalid)
      out.push({ level: 'error', text: '保存的接收 QQ 号是打码值（含 • 字符），已被自动忽略。请在下方重新填一遍自己的 QQ 号。' });
    else if (!c.uin)
      out.push({ level: 'warn', text: '未填接收 QQ 号；部分 Qmsg 账号需要指定 qq 参数才能送达，建议填写自己的 QQ 号。' });
  } else if (c.channel === 'onebot') {
    if (!c.endpoint) out.push({ level: 'error', text: '还没填本机 QQ 机器人 HTTP 地址（例如 http://127.0.0.1:3000）。' });
    if (c.uinInvalid) out.push({ level: 'error', text: '接收 QQ 号是打码值，请重新填写纯数字 QQ 号。' });
    else if (!c.uin) out.push({ level: 'error', text: '还没填接收消息的自己 QQ 号（OneBot 必填 user_id）。' });
    if (c.endpoint && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(c.endpoint))
      out.push({ level: 'warn', text: '机器人地址不是本机回环地址，请确认它可被本机访问。' });
  } else if (c.channel === 'custom') {
    if (!c.endpoint) out.push({ level: 'error', text: '还没填自定义 Webhook 的完整 URL。' });
  } else {
    if (!qqLogin.isOnline()) out.push({ level: 'warn', text: '尚未通过「QQ 登录」板块登录你本人的 QQ；登录后这里会自动用它发通知给你自己。' });
    else out.push({ level: 'ok', text: `已登录 ${maskUin(qqLogin.liveUin())}，通知会发给你自己的 QQ。` });
  }
  if (!out.some(x => x.level === 'error')) out.push({ level: 'ok', text: `通道配置完整：${CHANNELS[c.channel].name}。点「发一条测试」可验证送达。` });
  const last = history.find(x => x.kind === 'test');
  if (last) out.push({ level: last.ok ? 'ok' : 'warn', text: `上次测试：${last.ok ? '已送达' : '未送达 — ' + (last.reason || '未知原因')}（${last.iso}）` });
  return out;
}

function status() {
  const c = cfg();
  const diag = diagnose(c);
  const hasCred = c.channel === 'onebot' || c.channel === 'custom' ? !!c.endpoint
    : c.channel === 'direct' ? qqLogin.isOnline()
    : !!c.key;
  return {
    ok: true,
    connected: c.enabled && hasCred && !diag.some(x => x.level === 'error'),
    channel: c.channel, channelName: CHANNELS[c.channel].name,
    home: CHANNELS[c.channel].home, hint: CHANNELS[c.channel].hint,
    keyMasked: maskKey(c.key), keySet: !!c.key,
    // ★ 面板只监听 127.0.0.1：uinFull 给表单回填（避免把掩码写回配置），uin 只用于展示
    uin: maskUin(c.uin), uinMasked: maskUin(c.uin), uinFull: c.uin,
    uinInvalid: c.uinInvalid,
    endpoint: c.endpoint,
    enabled: c.enabled, onOnline: c.onOnline, onOffline: c.onOffline, onWishlist: c.onWishlist,
    minIntervalSec: c.minIntervalSec,
    diagnosis: diag, ready: !diag.some(x => x.level === 'error'),
    directOnline: c.channel === 'direct' && qqLogin.isOnline(),
    directUin: maskUin(qqLogin.liveUin()),
    direction: '只发给你自己的 QQ · 单向推送 · 不收消息 · 不读聊天记录',
    history: history.slice(0, 20),
    channels: Object.entries(CHANNELS).map(([id, v]) => ({ id, name: v.name, home: v.home, hint: v.hint }))
  };
}

function buildRequest(c, title, body) {
  const text = `${title}\n\n${body}`;
  if (c.channel === 'qmsg') {
    // Qmsg 酱：POST https://qmsg.zendee.cn/send/<key>  form: msg=...&qq=<自己的QQ号>
    const url = `https://qmsg.zendee.cn/send/${encodeURIComponent(c.key)}`;
    const form = new URLSearchParams({ msg: text });
    if (c.uin) form.set('qq', c.uin);
    return { url, type: 'form', body: form.toString() };
  }
  if (c.channel === 'onebot') {
    const base = (c.endpoint || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const url = /\/send_private_msg$/.test(base) ? base : base + '/send_private_msg';
    return { url, type: 'json', body: JSON.stringify({ user_id: Number(c.uin) || c.uin, message: text }) };
  }
  return {
    url: c.endpoint || c.key, type: 'json',
    body: JSON.stringify({ title, body, text, qq: c.uin, source: 'SteamLens', ts: Date.now() })
  };
}

/**
 * ★ 关键修复：HTTP 200 不等于送达。Qmsg / OneBot 都会在 200 里返回业务失败。
 *   之前只看 r.ok，导致「中转站没记录、QQ 没收到，界面却说已发送」。
 */
function parseResponse(channel, r) {
  const txt = String(r?.response || '').trim();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 纯文本响应 */ }
  if (/^ERR:/i.test(txt)) return { ok: false, reason: txt.slice(4, 180) };
  if (channel === 'qmsg') {
    if (j) {
      const good = j.success === true || j.code === 0 || j.status === 'ok';
      return { ok: good, reason: good ? '已发送到你的 QQ' : (j.reason || j.message || j.msg || `Qmsg 返回失败：${JSON.stringify(j).slice(0, 120)}`) };
    }
    return { ok: /\bsuccess\b|发送成功|^ok$/i.test(txt), reason: txt.slice(0, 160) || 'Qmsg 未返回可识别结果（可能 Key 无效）' };
  }
  if (channel === 'onebot') {
    if (j) {
      const good = j.retcode === 0 || j.status === 'ok' || !!j.data?.message_id;
      return { ok: good, reason: good ? '已发送到你的 QQ' : (j.message || j.wording || `OneBot retcode=${j.retcode}`) };
    }
    return { ok: false, reason: txt.slice(0, 160) || 'OneBot 无响应（机器人可能没启动）' };
  }
  return { ok: !!r?.ok, reason: r?.ok ? '已发送到自定义 Webhook' : (txt.slice(0, 160) || `HTTP ${r?.status || '?'}`) };
}

async function send(title, body, opts = {}) {
  const c = cfg();
  // 直接登录通道：用「QQ 登录」板块登录的你本人的 QQ 给自己发
  if (c.channel === 'direct') {
    const rec = {
      ts: Date.now(), iso: new Date().toISOString(), title, body,
      kind: opts.kind || 'test', ok: false, reason: '', channel: 'direct'
    };
    if (!qqLogin.isOnline()) {
      rec.reason = 'QQ 尚未通过「QQ 登录」板块登录'; rec.blocked = true;
      history.unshift(rec); trimHistory(); return rec;
    }
    try {
      const r = await qqLogin.sendToSelf(`${title}\n\n${body}`);
      rec.ok = !!r.ok; rec.reason = r.ok ? '已发给你自己的 QQ' : (r.error || '未送达');
    } catch (e) { rec.reason = e.message; }
    history.unshift(rec); trimHistory();
    console.log(`[SteamLens QQ 直接登录] ${rec.ok ? '已发送' : '失败：' + rec.reason} · ${title}`);
    return rec;
  }
  const rec = {
    ts: Date.now(), iso: new Date().toISOString(), title, body,
    kind: opts.kind || 'test', ok: false, reason: '', channel: c.channel
  };
  const diag = diagnose(c);
  const blocker = diag.find(x => x.level === 'error');
  if (blocker) {
    rec.reason = blocker.text; rec.blocked = true; rec.diagnosis = diag;
    history.unshift(rec); trimHistory(); return rec;
  }
  if (!c.enabled && !opts.force) { rec.reason = 'QQ 推送已关闭'; history.unshift(rec); return rec; }
  if (opts.kind === 'online' && !c.onOnline && !opts.force) { rec.reason = '未开启「好友上线推送」'; return rec; }
  if (opts.kind === 'offline' && !c.onOffline && !opts.force) { rec.reason = '未开启「好友退出 Steam 推送」'; return rec; }
  if (opts.kind === 'wishlist' && !c.onWishlist && !opts.force) { rec.reason = '未开启「愿望单推送」'; return rec; }

  const dk = opts.dedupeKey || `${opts.kind}:${title}`;
  const now = Date.now();
  // force 也保留最短冷却：防止按钮连点、双绑定、网络回退造成「一条测试发好几次」
  const gap = opts.force ? MIN_TEST_GAP_MS : Math.max(MIN_TEST_GAP_MS, c.minIntervalSec * 1000);
  const last = recent.get(dk) || 0;
  if (now - last < gap) {
    rec.reason = `刚刚已发过，${Math.ceil((gap - (now - last)) / 1000)} 秒内不重复推送`;
    rec.throttled = true;
    history.unshift(rec); trimHistory(); return rec;
  }
  recent.set(dk, now);

  try {
    const req = buildRequest(c, title, body);
    const r = await httpPost(req.url, req.type, req.body);
    const parsed = parseResponse(c.channel, r);
    rec.ok = parsed.ok;
    rec.reason = parsed.reason;
    rec.httpOk = !!r.ok;
    rec.httpStatus = r.status || null;
    rec.response = String(r.response || '').slice(0, 180);
    rec.via = r.fallback || 'Node fetch';
  } catch (e) { rec.reason = e.message; }
  history.unshift(rec); trimHistory();
  console.log(`[SteamLens QQ] ${rec.ok ? '已推送' : '失败：' + rec.reason} · ${title}`);
  return rec;
}

function trimHistory() { if (history.length > MAX_HISTORY) history.length = MAX_HISTORY; }

function saveConfig(patch = {}) {
  const allowed = {};
  if (patch.channel !== undefined && CHANNELS[patch.channel]) allowed.qqChannel = patch.channel;
  if (patch.enabled !== undefined) allowed.qqEnabled = !!patch.enabled;
  if (patch.onOnline !== undefined) allowed.qqOnOnline = !!patch.onOnline;
  if (patch.onOffline !== undefined) allowed.qqOnOffline = !!patch.onOffline;
  if (patch.onWishlist !== undefined) allowed.qqOnWishlist = !!patch.onWishlist;
  if (patch.uin !== undefined) {
    const v = cleanUin(patch.uin);
    // 掩码 / 非法值直接忽略，保留上一次保存的真实号码
    if (v) allowed.qqUin = v;
  }
  if (patch.endpoint !== undefined) allowed.qqEndpoint = String(patch.endpoint).trim();
  if (patch.minIntervalSec !== undefined) allowed.qqMinIntervalSec = Math.min(3600, Math.max(0, Number(patch.minIntervalSec) || 60));
  if (patch.key !== undefined) {
    const k = String(patch.key).trim();
    if (k && !/^[•*]/.test(k) && !/•••/.test(k)) allowed.qqKey = k;
  }
  if (Object.keys(allowed).length) core.saveConfig(allowed);
  return allowed;
}

async function connect(patch = {}) {
  const applied = saveConfig({ ...patch, enabled: true });
  const diag = diagnose();
  let test = null;
  // 配置明显无效时不再盲发：避免在中转站堆一堆无效请求
  if (patch.verify !== false && !diag.some(x => x.level === 'error')) {
    test = await send('SteamLens · QQ 绑定成功', '这条消息只发给你自己的 QQ。之后好友上线、愿望单降价或回涨时，会自动推送到这里。', { kind: 'test', force: true });
  }
  return { ok: true, applied, test, blocked: !test, diagnosis: diag, status: status() };
}

function disconnect() {
  core.saveConfig({ qqEnabled: false, qqKey: '' });
  return { ok: true, status: status() };
}

async function test() {
  return send('SteamLens · 测试推送', '这是一条测试消息，确认 QQ 通道能正常送达。', { kind: 'test', force: true });
}

module.exports = { CHANNELS, cfg, status, send, connect, disconnect, test, saveConfig, diagnose };

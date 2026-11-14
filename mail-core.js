/**
 * SteamLens · QQ 邮箱自动通知（零第三方依赖，原生 TLS SMTP）
 *
 * 安全边界：
 *   QQ 邮箱不向第三方本地应用开放「扫码登录 / OAuth 代登录」，
 *   让本地程序接管邮箱登录等同于交出邮箱钥匙。因此这里使用 QQ 邮箱
 *   官方支持的 SMTP【授权码】（16 位，不是 QQ 密码），只用于发信，
 *   无法读取、删除或管理你的任何邮件。授权码只保存在本机 config.json。
 *
 *   面板里的二维码 = 扫码打开 QQ 邮箱「设置 → 账号 → 开启 IMAP/SMTP」
 *   指引页，不含任何账号或凭证信息。
 */
'use strict';

const tls = require('node:tls');
const core = require('./steam-core');

const recent = new Map();
const history = [];
const MAX_HISTORY = 40;

const B64 = s => Buffer.from(s, 'utf8').toString('base64');
const MIMEWORD = s => '=?UTF-8?B?' + B64(s) + '?=';

function cfg() {
  const c = core.getConfig();
  return {
    enabled: !!c.mailEnabled,
    host: String(c.mailHost || 'smtp.qq.com').trim(),
    port: Number(c.mailPort || 465),
    user: String(c.mailUser || '').trim(),
    authCode: String(c.mailAuthCode || '').trim(),
    to: String(c.mailTo || '').trim() || String(c.mailUser || '').trim(),
    onOnline: c.mailOnOnline !== false,
    onOffline: c.mailOnOffline !== false,   // 好友退出 Steam 时默认发邮件
    onGame: !!c.mailOnGame,
    minIntervalSec: Math.min(86400, Math.max(0, Number(c.mailMinIntervalSec) || 300)),
    quiet: String(c.mailQuiet || '').trim(),
    subjectPrefix: String(c.mailSubjectPrefix || 'SteamLens').trim()
  };
}

/* 授权码格式体检：QQ 邮箱的 SMTP 授权码固定是 16 位字母数字，
   之前只判断「非空」就把 9 位/QQ 密码当成已登录，界面假成功、发信必被 535 拒绝。 */
function authCodeIssue(c = cfg()) {
  const code = String(c.authCode || '').trim();
  const host = String(c.host || '');
  if (!code) return '还没有填写 SMTP 授权码';
  if (/\s/.test(code)) return '授权码里含有空格，请重新完整复制一次';
  if (/[^\x20-\x7e]/.test(code)) return '授权码含有中文或全角字符，请重新复制';
  if (/qq\.com/i.test(host)) {
    if (code.length !== 16) {
      return `QQ 邮箱授权码应为 16 位，当前只有 ${code.length} 位 —— 多半是没复制全，或误填成了 QQ 密码`;
    }
    if (!/^[a-z0-9]+$/i.test(code)) return '授权码只能包含字母和数字，请重新复制';
  } else if (code.length < 6) {
    return '授权码太短，请重新复制完整的授权码';
  }
  return '';
}

/* 把 SMTP 的英文拒绝码翻译成能直接照着做的中文提示 */
function friendlySmtpError(e, c = cfg()) {
  const raw = String(e?.message || e || '');
  const issue = authCodeIssue(c);
  if (/535|Login fail|Authentication|auth/i.test(raw)) {
    return `QQ 邮箱拒绝了登录（SMTP 535）。${issue ? issue + '。' : ''}请打开 QQ 邮箱 →「设置 → 账号 → 安全设置」开启 IMAP/SMTP 服务，生成 16 位授权码（不是 QQ 密码），再填回本页点「登录 QQ 邮箱」。若在短时间内反复重试，也可能是登录频率限制，稍等几分钟再试。`;
  }
  if (/ETIMEDOUT|超时|timeout/i.test(raw)) return '连接邮箱服务器超时，请检查网络或稍后重试。';
  if (/ECONNREFUSED|ECONNRESET|提前关闭|socket hang up/i.test(raw)) return '与邮箱服务器的连接被断开，请检查端口（QQ 邮箱为 465）和防火墙后重试。';
  if (/certificate|TLS|SSL/i.test(raw)) return 'TLS 证书校验失败，请确认邮箱服务器地址正确。';
  return raw || '发信失败，原因未知';
}

function isQuiet(quiet) {
  if (!quiet) return false;
  const m = quiet.match(/^(\d{1,2})\s*[-~]\s*(\d{1,2})$/);
  if (!m) return false;
  const a = Number(m[1]) % 24, b = Number(m[2]) % 24, hr = new Date().getHours();
  return a <= b ? (hr >= a && hr < b) : (hr >= a || hr < b);
}

function wrap76(b64) {
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

function rfcDate() {
  return new Date().toUTCString();
}

function buildMessage(c, subject, html, plain) {
  const lines = [
    `From: ${MIMEWORD(c.subjectPrefix)} <${c.user}>`,
    `To: <${c.to}>`,
    `Subject: ${MIMEWORD(subject)}`,
    `Date: ${rfcDate()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: SteamLens (local, read-only notifications)',
    '',
    wrap76(B64(html || `<p>${plain || subject}</p>`))
  ];
  // SMTP DATA 结束标记：单独一行 "."
  return lines.join('\r\n') + '\r\n.\r\n';
}

/** 最小 SMTP 客户端：EHLO → AUTH LOGIN → MAIL/RCPT/DATA → QUIT */
function smtpSend(c, subject, html, plain) {
  return new Promise((resolve, reject) => {
    if (!c.user || !c.authCode || !c.to) {
      return reject(new Error('邮件未配置完整：需要 QQ 邮箱地址、授权码和收件人'));
    }
    let sock, done = false;
    let buf = '', step = 0, pending250 = false;
    const finish = (err, info) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { sock && sock.end(); } catch {}
      err ? reject(err) : resolve(info);
    };
    const timer = setTimeout(() => finish(new Error('SMTP 连接超时（15 秒）')), 15000);
    timer.unref?.();

    const send = line => { try { sock.write(line + '\r\n'); } catch (e) { finish(e); } };

    try {
      sock = tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: true });
    } catch (e) { return finish(e); }

    sock.setEncoding('utf8');
    sock.on('error', e => finish(e));
    sock.on('close', () => { if (!done) finish(new Error('SMTP 连接提前关闭')); });

    sock.on('connect', () => { /* 等待服务端 220 */ });

    sock.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const code = Number(raw.slice(0, 3));
        const more = raw.charAt(3) === '-';
        if (more && code === 250) { pending250 = true; continue; }
        if (pending250 && code === 250) { pending250 = false; }
        if (!Number.isFinite(code)) continue;

        if (code >= 400) return finish(new Error(`SMTP ${raw}`));

        try {
          switch (step) {
            case 0: // 220 greeting
              if (code !== 220) return;
              step = 1; send('EHLO steamlens.local'); break;
            case 1: // 250 EHLO 完成
              step = 2; send('AUTH LOGIN'); break;
            case 2: // 334 username
              step = 3; send(B64(c.user)); break;
            case 3: // 334 password
              step = 4; send(B64(c.authCode)); break;
            case 4: // 235 auth ok
              step = 5; send(`MAIL FROM:<${c.user}>`); break;
            case 5:
              step = 6; send(`RCPT TO:<${c.to}>`); break;
            case 6:
              step = 7; send('DATA'); break;
            case 7: // 354 go ahead
              step = 8; sock.write(buildMessage(c, subject, html, plain)); break;
            case 8: // 250 queued
              step = 9; send('QUIT'); break;
            case 9:
              finish(null, { ok: true, code, response: raw }); break;
            default: break;
          }
        } catch (e) { finish(e); }
      }
    });
  });
}

function htmlFor(ev, extra = {}) {
  const offline = ev.type === 'offline';
  const headline = offline ? '好友退出 Steam 提醒' : (ev.type === 'game' ? '好友开始玩游戏' : '好友上线提醒');
  const verb = offline ? '退出 Steam 了（已离线）' : (ev.type === 'game' ? `开始玩 ${escHtml(ev.game || '游戏')}` : '上线了');
  const game = !offline && ev.game ? `<div class="game">▸ 正在玩 <b>${escHtml(ev.game)}</b></div>` : '';
  const when = new Date().toLocaleString('zh-CN', { hour12: false });
  return `<div style="margin:0;padding:24px;background:#f4f7fd;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
  <div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e3eafb;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(30,60,120,.08)">
    <div style="padding:18px 24px;background:linear-gradient(120deg,#2f6df6,#7a63f5,#10b39c);color:#fff">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">STEAMLENS</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px">${headline}</div>
    </div>
    <div style="padding:26px 24px">
      <div style="font-size:17px;color:#17213a;font-weight:600">${escHtml(ev.name || '好友')} ${verb}</div>
      ${game ? `<div style="margin-top:10px;padding:10px 14px;background:#f0f5ff;border-radius:10px;color:#2f4a7a;font-size:14px">${game.replace(/<[^>]+>/g, '')}</div>` : ''}
      <div style="margin-top:18px;color:#7b8aa6;font-size:13px;line-height:1.7">
        检测时间：${when}<br>来源：${escHtml(extra.source || '本机 SteamLens 后台轮询')}<br>
        ${extra.starred ? '★ 这是你关注的好友<br>' : ''}
      </div>
    </div>
    <div style="padding:14px 24px;background:#fafcff;border-top:1px solid #eef2fa;color:#9aa8bf;font-size:12px">
      由本机 SteamLens 自动发送 · 数据只保存在你的电脑上 · 不想收到可在面板里关闭邮件通知
    </div>
  </div></div>`;
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function send(ev, extra = {}) {
  const c = cfg();
  if (!c.enabled && !extra.force) return { sent: false, reason: '邮件通知未开启' };
  if (isQuiet(c.quiet) && !extra.force) return { sent: false, reason: '处于安静时段' };
  const type = ev.type || 'online';
  if ((type === 'online' && !c.onOnline) || (type === 'offline' && !c.onOffline) || (type === 'game' && !c.onGame)) {
    if (!extra.force) return { sent: false, reason: '该类型事件未开启邮件' };
  }
  const key = `${ev.steamId64 || ev.name}:${type}`;
  const last = recent.get(key) || 0;
  if (!extra.force && Date.now() - last < c.minIntervalSec * 1000) return { sent: false, reason: '去重间隔内' };
  recent.set(key, Date.now());

  const label = { online: '上线了', offline: '退出 Steam 了', game: '开始玩游戏' }[type] || '状态变化';
  const subject = `${c.subjectPrefix} · ${ev.name || '好友'} ${label}${ev.game && type === 'game' ? '（' + ev.game + '）' : ''}`;
  const plain = `${ev.name} ${label}${ev.game ? ' · ' + ev.game : ''} · ${new Date().toLocaleString('zh-CN')}`;
  let r;
  try {
    r = await smtpSend(c, subject, htmlFor(ev, extra), plain);
  } catch (e) {
    // 发信失败要如实返回中文原因并记入历史，不能再让界面假装「已发送」
    const reason = friendlySmtpError(e, c);
    const fail = { ts: Date.now(), iso: new Date().toISOString(), to: c.to, subject, ok: false, type, name: ev.name, reason };
    history.unshift(fail); if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    console.log(`[SteamLens 邮件] 发送失败：${reason}`);
    return { sent: false, reason, detail: String(e.message || e).slice(0, 200) };
  }
  const rec = { ts: Date.now(), iso: new Date().toISOString(), to: c.to, subject, ok: true, type, name: ev.name };
  history.unshift(rec); if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  console.log(`[SteamLens 邮件] 已发送至 ${c.to}：${subject}`);
  return { sent: true, ...rec, smtp: r };
}

/** 通用发信入口：愿望单价格提醒等非好友事件使用，独立去重 key */
async function sendDirect(subject, html, plain, opts = {}) {
  const c = cfg();
  if (!c.enabled && !opts.force) return { sent: false, reason: '邮件通知未开启' };
  if (isQuiet(c.quiet) && !opts.force) return { sent: false, reason: '处于安静时段' };
  const key = String(opts.key || subject);
  const gap = Math.max(0, Number(opts.minIntervalSec ?? 600)) * 1000;
  const last = recent.get(key) || 0;
  if (!opts.force && Date.now() - last < gap) return { sent: false, reason: '去重间隔内' };
  recent.set(key, Date.now());
  let r;
  try { r = await smtpSend(c, subject, html, plain); }
  catch (e) { return { sent: false, reason: friendlySmtpError(e, c) }; }
  const rec = { ts: Date.now(), iso: new Date().toISOString(), to: c.to, subject, ok: true, type: opts.type || 'custom' };
  history.unshift(rec); if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  console.log(`[SteamLens 邮件] 已发送至 ${c.to}：${subject}`);
  return { sent: true, ...rec, smtp: r };
}

async function test() {
  const c = cfg();
  const issue = authCodeIssue(c);
  if (issue) return { sent: false, reason: issue, diagnosis: issue, hint: 'QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 生成 16 位授权码（不是 QQ 密码）' };
  const r = await send({
    steamId64: 'test', name: '测试好友', type: 'online', game: 'Counter-Strike 2',
    text: '测试'
  }, { starred: true, force: true, source: '面板「发送测试邮件」按钮' });
  return { ...r, diagnosis: r.sent ? '' : r.reason };
}

function status() {
  const c = cfg();
  const issue = authCodeIssue(c);
  return {
    enabled: c.enabled, host: c.host, port: c.port,
    user: c.user, to: c.to,
    authCodeSet: !!c.authCode,
    authCodeValid: !issue,
    authCodeIssue: issue,
    onOnline: c.onOnline, onOffline: c.onOffline, onGame: c.onGame,
    minIntervalSec: c.minIntervalSec, quiet: c.quiet,
    ready: !!(c.user && c.authCode && c.to),
    history: history.slice(0, 20)
  };
}

module.exports = { send, sendDirect, test, status, cfg, smtpSend, authCodeIssue, friendlySmtpError };

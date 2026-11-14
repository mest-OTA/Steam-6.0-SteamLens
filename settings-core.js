/**
 * SteamLens · 界面设置持久化层
 *
 * 目标：用户在面板里改过的任何东西（主题、页签、筛选、排序、开关、表单值），
 *       关掉窗口 / 重启服务 / 换浏览器再进来，都必须原样恢复。
 *
 * 存储：data/ui-settings.json（原子写入，零第三方依赖）
 * 注意：凭证（API Key / SMTP 授权码）不写这里，它们由 config.json 单独保存；
 *       本模块只负责「界面状态」与「非敏感表单草稿」。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'ui-settings.json');
const VERSION = 2;

/* 默认外观：白色 / 浅色玻璃（用户明确要求恢复成原来的白色） */
const DEFAULTS = Object.freeze({
  version: VERSION,
  theme: 'light',
  mode: 'auto',
  mask: true,
  exportMask: true,
  page: 'overview',
  filter: 'all',
  sort: 'playtime',
  search: '',
  friendFilter: 'all',
  friendSearch: '',
  friendAuto: true,
  mailVerify: true,
  lastEventTs: 0,
  draft: {},
  savedAt: 0
});

const BOOL_KEYS = ['mask', 'exportMask', 'friendAuto', 'mailVerify'];
const NUM_KEYS = ['lastEventTs', 'savedAt'];
const STR_KEYS = ['theme', 'mode', 'page', 'filter', 'sort', 'search', 'friendFilter', 'friendSearch'];

/* 草稿里带凭证味道的键一律不落盘，避免明文散落 */
const SECRET_RE = /(apikey|authcode|password|passwd|secret|token|pasted|privatekey)/i;
const DRAFT_BLOCKLIST = new Set([
  'cfgApiKey', 'fApiKey', 'acctApiKey', 'mailAuthCode', 'cfgPasted', 'fPasted',
  'acctPastedOwned', 'acctPastedWishlist'
]);

/* 只识别「旧版本残留」与极少数明确的历史测试值，绝不误伤正常用户设置 */
function looksLikeTestData(raw) {
  if (!raw || typeof raw !== 'object') return false;
  // 旧版本（version<2）文件直接重建，避免早期字段结构不兼容
  if (Number(raw.version) < VERSION) return true;
  const s = JSON.stringify(raw);
  // 只匹配当初那一组具体测试值；不要用字段名做条件，否则用户正常填好友码会被清空
  return s.includes('持久化测试') && s.includes('"fPoll":"123"') && s.includes('"lastEventTs":1700000000000');
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { version: VERSION };
  for (const k of STR_KEYS) out[k] = typeof src[k] === 'string' ? src[k] : DEFAULTS[k];
  for (const k of BOOL_KEYS) out[k] = typeof src[k] === 'boolean' ? src[k] : DEFAULTS[k];
  for (const k of NUM_KEYS) out[k] = Number.isFinite(Number(src[k])) ? Number(src[k]) : DEFAULTS[k];

  // 主题只允许 light / dark；白色为默认
  if (out.theme !== 'dark') out.theme = 'light';
  if (out.mode !== 'manual') out.mode = 'auto';
  if (!out.page) out.page = DEFAULTS.page;

  const d = (src.draft && typeof src.draft === 'object' && !Array.isArray(src.draft)) ? src.draft : {};
  const draft = {};
  for (const [k, v] of Object.entries(d)) {
    if (DRAFT_BLOCKLIST.has(k) || SECRET_RE.test(k)) continue;
    if (v === null || v === undefined) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (val.length > 20000) continue;             // 防止把整份 JSON 塞进来
    draft[k] = val;
  }
  out.draft = draft;
  out.savedAt = Number(src.savedAt) || 0;
  return out;
}

let mem = null;

function read() {
  if (mem) return mem;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { raw = null; }
  // 测试残留 / 旧版本 → 直接回到干净的白色默认，并立刻落盘
  const clean = looksLikeTestData(raw) ? normalize(null) : normalize(raw);
  mem = clean;
  if (!raw || looksLikeTestData(raw) || !Number(raw.savedAt)) {
    mem.savedAt = Date.now();
    atomicWrite(FILE, mem);
  }
  return mem;
}

function get() { return { ...read() }; }

function patch(obj) {
  const cur = read();
  const inc = obj && typeof obj === 'object' ? obj : {};
  const merged = normalize({ ...cur, ...inc, version: VERSION });

  // draft 是增量合并，不是整体替换（避免某个页面把别的页面草稿冲掉）
  if (inc.draft && typeof inc.draft === 'object' && !Array.isArray(inc.draft)) {
    const nd = { ...cur.draft };
    for (const [k, v] of Object.entries(inc.draft)) {
      if (DRAFT_BLOCKLIST.has(k) || SECRET_RE.test(k)) continue;
      if (v === null || v === undefined) { delete nd[k]; continue; }
      nd[k] = String(v).slice(0, 20000);
    }
    merged.draft = nd;
  } else {
    merged.draft = { ...cur.draft };
  }

  merged.savedAt = Date.now();
  mem = merged;
  atomicWrite(FILE, merged);
  return { ...merged };
}

function reset() {
  const fresh = normalize(null);
  fresh.savedAt = Date.now();
  mem = fresh;
  atomicWrite(FILE, fresh);
  return { ...fresh };
}

function importAll(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('导入内容不是有效对象');
  const src = obj.settings || obj.ui || obj;
  const fresh = normalize(src);
  fresh.savedAt = Date.now();
  mem = fresh;
  atomicWrite(FILE, fresh);
  return { ...fresh };
}

function status() {
  const s = read();
  return {
    ok: true,
    file: FILE,
    exists: fs.existsSync(FILE),
    version: s.version,
    savedAt: s.savedAt,
    savedAtIso: s.savedAt ? new Date(s.savedAt).toISOString() : null,
    draftCount: Object.keys(s.draft || {}).length,
    theme: s.theme,
    settings: { ...s }
  };
}

module.exports = { get, patch, reset, importAll, status, DEFAULTS, FILE };

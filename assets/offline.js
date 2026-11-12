/**
 * SteamLens · 前端离线引擎（在 app.js 之前加载，零依赖）
 *
 * 场景：服务器关掉 → 直接双击软件目录里的 index.html 照样能看本机数据、改设置、写记录；
 *       服务器重新打开 → 自动把离线期间的改动合并回在线版，然后切回实时数据。
 *
 * 存储分层（全部在用户自己的电脑上，不上传）：
 *   1. assets/offline-data.js  —— 服务端定期固化的全量快照（file:// 页面用 <script> 读，绕开 CORS）
 *   2. localStorage sl-offline-snapshot —— 浏览器本机的最新快照，优先于 1
 *   3. localStorage sl-offline-queue    —— 离线期间的 POST 变更队列
 *   4. 可导出的 .json 文件             —— 用户手动下载/导入的完整备份
 */
(function () {
  'use strict';

  var FILE_MODE = location.protocol === 'file:';
  var ORIGIN = FILE_MODE ? 'http://127.0.0.1:8787' : '';
  var K_SNAP = 'sl-offline-snapshot';
  var K_QUEUE = 'sl-offline-queue';
  var K_SINCE = 'sl-offline-since';
  var K_ID = 'sl-offline-client';

  function ls(k, fallback) {
    try { var v = localStorage.getItem(k); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function lsJson(k, fallback) {
    try { var v = JSON.parse(ls(k, '')); return v || fallback; } catch (e) { return fallback; }
  }
  function setLs(k, v) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {} }

  function clientId() {
    var id = ls(K_ID, '');
    if (!id) { id = 'sl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); setLs(K_ID, id); }
    return id;
  }

  var api = {
    fileMode: FILE_MODE,
    origin: ORIGIN,
    // 页面本身能从 http://127.0.0.1:8787 打开，说明服务器在线；
    // file:// 双击打开即「离线版」，永远保持离线身份，绝不自动跳到在线版。
    online: !FILE_MODE,
    serverUp: false,
    checking: false,
    lastSyncAt: 0,
    lastSyncResult: null,
    offlineSince: Number(ls(K_SINCE, 0)) || 0,
    clientId: clientId(),

    /** 完整快照：浏览器本机缓存优先，其次服务端固化在 assets/offline-data.js 的文件 */
    snapshot: function () {
      var local = lsJson(K_SNAP, null);
      var fileSnap = window.SL_OFFLINE_DATA || null;
      if (local && fileSnap) {
        return Number(local.generatedAt || 0) >= Number(fileSnap.generatedAt || 0) ? local : fileSnap;
      }
      return local || fileSnap;
    },
    snapshotAt: function () { var s = api.snapshot(); return s ? Number(s.generatedAt || 0) : 0; },

    /** 在线时把服务端拉到的全量状态写进浏览器本机 */
    saveSnapshot: function (parts) {
      var old = api.snapshot() || {};
      var snap = Object.assign({}, old, parts || {}, {
        app: 'SteamLens', version: 3, generatedAt: Date.now(),
        generatedAtIso: new Date().toISOString(), offlineCapable: true
      });
      setLs(K_SNAP, snap);
      return snap;
    },

    /** 打开离线模式：记下起始时间，界面切成本机数据 */
    markOffline: function () {
      if (!api.offlineSince) { api.offlineSince = Date.now(); setLs(K_SINCE, api.offlineSince); }
      api.online = false;
    },
    markOnline: function () { api.online = true; },

    /** 离线期间的写操作全部排队（对应服务端 offline-core 的白名单路径） */
    queueChange: function (path, body) {
      var q = lsJson(K_QUEUE, []);
      if (!Array.isArray(q)) q = [];
      q.push({ path: path, body: body || {}, ts: Date.now(), clientId: api.clientId });
      if (q.length > 600) q = q.slice(-600);
      setLs(K_QUEUE, q);
      return q.length;
    },
    pending: function () { var q = lsJson(K_QUEUE, []); return Array.isArray(q) ? q : []; },
    pendingCount: function () { return api.pending().length; },
    clearQueue: function () { setLs(K_QUEUE, []); },

    /** 服务器恢复后调用：把队列提交给服务端合并 */
    sync: function () {
      if (api.checking) return Promise.resolve({ skipped: true });
      var q = api.pending();
      if (!q.length) { api.lastSyncResult = { ok: true, applied: 0 }; return Promise.resolve(api.lastSyncResult); }
      api.checking = true;
      var payload = {
        clientId: api.clientId,
        offlineSince: api.offlineSince,
        changes: q
      };
      return fetch(ORIGIN + '/api/offline/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), cache: 'no-store'
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (r && r.ok) {
          api.clearQueue();
          setLs('sl-offline-notes', []);
          api.offlineSince = 0; setLs(K_SINCE, 0);
          api.lastSyncAt = Date.now();
          api.lastSyncResult = r;
        }
        return r;
      }).catch(function (e) {
        return { ok: false, error: e.message };
      }).then(function (r) { api.checking = false; return r; });
    },

    /** 探测服务是否恢复；恢复后自动同步离线队列（但绝不改变「离线版」身份） */
    probe: function (onRecover) {
      if (api.checking) return Promise.resolve(false);
      return fetch(ORIGIN + '/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) })
        .then(function (r) { return r.ok; })
        .catch(function () { return false; })
        .then(function (up) {
          // 离线版（file://）永远是离线版：即使服务器在线，也绝不自动跳转到在线版。
          // 用户主动打开离线文件就是要看本机快照；想用在线版请自行双击「启动 SteamLens.bat」。
          if (FILE_MODE) {
            api.serverUp = up;
            // 服务器可用时，把离线期间的改动悄悄合并回去，界面仍保持离线模式
            if (up && api.pendingCount() > 0) {
              return api.sync().then(function (res) {
                api.lastSyncResult = res;
                if (typeof onRecover === 'function') onRecover(res);
                return false;
              });
            }
            return false;
          }
          var wasOffline = !api.online;
          api.online = up;
          if (up && wasOffline) {
            return api.sync().then(function (res) {
              api.onRecovered = true;
              if (typeof onRecover === 'function') onRecover(res);
              return true;
            });
          }
          if (!up) api.markOffline();
          return up;
        });
    },

    /** 每 4 秒探测一次；状态变化时通知界面 */
    startWatcher: function (onChange, onRecover) {
      var last = null;
      function tick() {
        api.probe(onRecover).then(function (up) {
          if (last !== up) { last = up; if (typeof onChange === 'function') onChange(up, api.pendingCount()); }
          else if (typeof onChange === 'function') onChange(up, api.pendingCount());
        });
      }
      tick();
      setInterval(tick, 4000);
    },

    /** 导出完整本机数据到用户电脑（下载 .json） */
    exportFile: function () {
      var snap = api.snapshot() || {};
      var data = {
        app: 'SteamLens', kind: 'offline-backup', version: 3,
        exportedAt: new Date().toISOString(),
        snapshot: snap,
        queue: api.pending(),
        notes: lsJson('sl-offline-notes', []),
        settings: snap.uiSettings || {}
      };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'SteamLens-本机数据-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
      return data;
    },

    /** 导入之前导出的本机数据文件 */
    importFile: function (text) {
      var j = JSON.parse(text);
      if (j.snapshot) setLs(K_SNAP, j.snapshot);
      else if (j.settings) api.saveSnapshot({ uiSettings: j.settings });
      if (Array.isArray(j.queue)) setLs(K_QUEUE, j.queue);
      // 旧备份里的独立 notes 转成队列条目，避免与 changes 重复写入
      if (Array.isArray(j.notes)) for (var i = 0; i < j.notes.length; i++) {
        var n = j.notes[i];
        if (n && n.text) api.queueChange('/api/offline/note', { text: n.text, source: n.source || '离线记录' });
      }
      return { ok: true, snapshotAt: api.snapshotAt(), queued: api.pendingCount() };
    },

    /** 离线时写一条本地笔记：只进队列一次，避免同步时重复写入 */
    addNote: function (text) {
      api.queueChange('/api/offline/note', { text: text, source: '离线记录' });
      return api.pending().filter(function (x) { return x.path === '/api/offline/note'; }).length;
    },

    /** 离线笔记（尚未同步的）直接从队列里读，不另存一份导致重复 */
    localNotes: function () {
      return api.pending().filter(function (x) { return x.path === '/api/offline/note'; })
        .map(function (x) {
          return { ts: x.ts, iso: new Date(x.ts).toISOString(), text: x.body && x.body.text, source: '离线记录（待同步）' };
        }).reverse();
    },

    status: function () {
      return {
        fileMode: FILE_MODE,
        online: api.online,
        serverUp: api.serverUp,
        offlineSince: api.offlineSince,
        snapshotAt: api.snapshotAt(),
        snapshotAtIso: api.snapshotAt() ? new Date(api.snapshotAt()).toISOString() : null,
        pendingCount: api.pendingCount(),
        lastSyncAt: api.lastSyncAt,
        lastSyncResult: api.lastSyncResult,
        clientId: api.clientId
      };
    }
  };

  window.SLOffline = api;
  window.SL_API_ORIGIN = ORIGIN;
})();

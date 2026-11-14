/**
 * SteamLens · 本机硬件配置自动探测
 *
 * 用途：用户点开任意游戏的「系统需求」时，自动读出自己电脑的
 *       OS / CPU / GPU / 内存 / 系统盘剩余空间，和游戏要求做对比。
 *
 * 做法：在服务端用 PowerShell（Win32_* WMI 类）读一次真实硬件，
 *       结果缓存到 data/pc-specs.json；同一进程内重复调用直接读缓存，
 *       也支持手动「重新检测」。离线版导出时会把上一次缓存一并打包，
 *       这样离线也能做对比（标注「导出时捕获」）。
 *
 * 稳定性：任何一步失败都降级为「部分可用」，绝不抛错中断页面。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SPEC_FILE = path.join(DATA_DIR, 'pc-specs.json');

let _cache = null;

function gb(bytes, digits = 1) {
  if (!bytes || bytes <= 0) return 0;
  return Math.round((bytes / 1073741824) * Math.pow(10, digits)) / Math.pow(10, digits);
}

/** 用 PowerShell 读一次硬件，返回结构化对象；失败返回 null */
function readFromSystem() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$cpu = @(Get-CimInstance Win32_Processor)[0]',
    '$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch "Microsoft|Remote|Parsec|Virtual|Basic|RDP" })',
    'if (-not $gpus) { $gpus = @(Get-CimInstance Win32_VideoController | Select-Object -First 1) }',
    '$gpu = $gpus | Sort-Object { if($_.AdapterRAM){$_.AdapterRAM}else{0} } -Descending | Select-Object -First 1',
    '$cs = Get-CimInstance Win32_ComputerSystem',
    '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"',
    '$out = [ordered]@{',
    '  osName = if($os){[string]$os.Caption}else{""};',
    '  osVersion = if($os){[string]$os.Version}else{""};',
    '  osBuild = if($os){[string]$os.BuildNumber}else{""};',
    '  osArch = if($os){[string]$os.OSArchitecture}else{""};',
    '  cpuName = if($cpu){[string]$cpu.Name}else{""};',
    '  cpuCores = if($cpu){[int]$cpu.NumberOfCores}else{0};',
    '  cpuThreads = if($cpu){[int]$cpu.NumberOfLogicalProcessors}else{0};',
    '  gpuName = if($gpu){[string]$gpu.Name}else{""};',
    '  gpuVram = if($gpu -and $gpu.AdapterRAM){[int64]$gpu.AdapterRAM}else{0};',
    '  ramBytes = if($cs){[int64]$cs.TotalPhysicalMemory}else{0};',
    '  diskFreeBytes = if($disk){[int64]$disk.FreeSpace}else{0};',
    '}',
    '$out | ConvertTo-Json -Compress'
  ].join('\n');

  try {
    const raw = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 15000, maxBuffer: 1 << 20, windowsHide: true, encoding: 'buffer' });
    const txt = raw.toString('utf8').trim();
    const j = JSON.parse(txt);
    const ramGB = gb(j.ramBytes);
    const gpuVramGB = gb(j.gpuVram);
    const diskFreeGB = gb(j.diskFreeBytes);
    return {
      os: {
        name: String(j.osName || '').trim(),
        version: String(j.osVersion || '').trim(),
        build: String(j.osBuild || '').trim(),
        arch: /64/.test(String(j.osArch)) ? '64 位' : (String(j.osArch || '').trim() || '未知')
      },
      cpu: {
        name: String(j.cpuName || '').replace(/\s+/g, ' ').trim(),
        cores: Number(j.cpuCores) || 0,
        threads: Number(j.cpuThreads) || 0
      },
      gpu: {
        name: String(j.gpuName || '').replace(/\s+/g, ' ').trim(),
        vramGB: gpuVramGB
      },
      ramGB,
      diskFreeGB,
      detectedAt: Date.now(),
      source: '本机 PowerShell（Win32_*）'
    };
  } catch (e) {
    return null;
  }
}

function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')); } catch { _cache = null; }
  return _cache;
}

/** 重新探测并写缓存 */
function detect() {
  const fresh = readFromSystem();
  if (fresh) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SPEC_FILE, JSON.stringify(fresh, null, 2)); } catch { /* */ }
    _cache = fresh;
    return fresh;
  }
  // 探测失败但有旧缓存就沿用，没有就返回空结构（前端显示「检测失败，可重试」）
  const old = loadCache();
  if (old) return old;
  return {
    os: { name: '', version: '', build: '', arch: '' },
    cpu: { name: '', cores: 0, threads: 0 },
    gpu: { name: '', vramGB: 0 },
    ramGB: 0, diskFreeGB: 0, detectedAt: 0, source: '', error: '无法读取本机硬件'
  };
}

/** 返回缓存（不重新探测）；没有则尝试探测一次 */
function status() {
  const c = loadCache();
  if (c && c.detectedAt) return c;
  return detect();
}

function getCached() {
  return loadCache();
}

module.exports = { detect, status, getCached };

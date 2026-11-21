/**
 * 文件用途：Antigravity 2.0 桌面客户端安装路径自动检索与启动模块。
 * 核心职责：按「常见目录 -> 注册表卸载项 -> 快捷方式 -> 常见盘符浅层目录」顺序
 *          自动定位 resources/app.asar，通过 package.json 校验排除 IDE 误判，
 *          并提供独立进程（detached）方式拉起 Antigravity.exe。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { readAsarFile } = require('./asarCodec');

const TARGET_EXE_NAME = 'Antigravity.exe';
const TARGET_PKG_NAME = 'antigravity';
const ASAR_SUBPATH = path.join('resources', 'app.asar');
const PKG_REL_PATH = 'package.json';
const QUERY_TIMEOUT_MS = 5000;

// Windows 注册表卸载项根路径（依次覆盖当前用户、本机 64 位与 32 位）
const UNINSTALL_REG_KEYS = Object.freeze([
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]);

// 兜底浅层检索时扫描的常见盘符子目录模板
const DRIVE_SUBDIRS = Object.freeze([
  'antigravity',
  'Antigravity',
  path.join('Programs', 'antigravity'),
  path.join('Programs', 'Antigravity'),
  path.join('Program Files', 'Antigravity'),
  path.join('Software', 'Antigravity'),
  path.join('Apps', 'Antigravity'),
  path.join('Tools', 'Antigravity'),
]);

const DRIVE_LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * 根据 app.asar 路径推导对应的 Antigravity.exe 绝对路径。
 * @param {string} asarPath resources/app.asar 文件路径
 * @returns {string}
 */
function resolveExecutablePath(asarPath) {
  const resourcesDir = path.dirname(path.resolve(asarPath));
  const installDir = path.dirname(resourcesDir);
  return path.join(installDir, TARGET_EXE_NAME);
}

/**
 * 校验给定路径是否为有效的 Antigravity 2.0 桌面端 app.asar（排除 Antigravity IDE）。
 * @param {string} asarPath 候选 app.asar 路径
 * @returns {boolean}
 */
function isValidAntigravityAsar(asarPath) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    return false;
  }
  const exePath = resolveExecutablePath(asarPath);
  if (!fs.existsSync(exePath)) {
    return false;
  }
  try {
    const pkg = JSON.parse(readAsarFile(asarPath, PKG_REL_PATH).toString('utf8'));
    return pkg && pkg.name === TARGET_PKG_NAME;
  } catch (_err) {
    return false;
  }
}

/**
 * 将安装目录或可执行文件路径归一化为候选 app.asar 路径。
 * @param {string} rawPath 安装目录、exe 路径或 app.asar 路径
 * @returns {string | null}
 */
function normalizeCandidateToAsar(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return null;
  }
  // 先剥离注册表图标索引（如 ",0"），再去除首尾引号与空白
  const cleaned = rawPath.split(',')[0].trim().replace(/^"+|"+$/g, '').trim();
  if (!cleaned) {
    return null;
  }
  const lower = cleaned.toLowerCase();
  if (lower.endsWith('app.asar')) {
    return cleaned;
  }
  if (lower.endsWith('.exe')) {
    return path.join(path.dirname(cleaned), ASAR_SUBPATH);
  }
  return path.join(cleaned, ASAR_SUBPATH);
}

/**
 * 构建基于环境变量的常见固定安装目录候选列表。
 * @param {NodeJS.ProcessEnv} [env] 环境变量对象
 * @returns {string[]}
 */
function buildStandardCandidates(env = process.env) {
  const localAppData = env.LOCALAPPDATA || '';
  const programFiles = env.ProgramFiles || '';
  const programFilesX86 = env['ProgramFiles(x86)'] || '';
  const installDirs = [
    localAppData && path.join(localAppData, 'Programs', 'antigravity'),
    localAppData && path.join(localAppData, 'Antigravity'),
    localAppData && path.join(localAppData, 'Programs', 'Google Antigravity'),
    programFiles && path.join(programFiles, 'Antigravity'),
    programFilesX86 && path.join(programFilesX86, 'Antigravity'),
  ].filter(Boolean);
  return installDirs.map((dir) => path.join(dir, ASAR_SUBPATH));
}

/**
 * 从 reg query 文本输出中提取可能指向 Antigravity 安装目录的候选路径。
 * @param {string} regOutput reg.exe 命令输出
 * @returns {string[]}
 */
function parseRegistryInstallPaths(regOutput) {
  if (!regOutput) {
    return [];
  }
  const results = [];
  const linePattern = /^\s*(?:InstallLocation|DisplayIcon|UninstallString)\s+REG_\w+\s+(.+)$/i;
  for (const line of regOutput.split(/\r?\n/)) {
    const match = linePattern.exec(line);
    if (!match) {
      continue;
    }
    const rawVal = match[1].trim();
    const exeMatch = /([A-Za-z]:\\[^"\r\n]+?\.exe)/i.exec(rawVal);
    const candidate = normalizeCandidateToAsar(exeMatch ? exeMatch[1] : rawVal);
    if (candidate) {
      results.push(candidate);
    }
  }
  return results;
}

/**
 * 查询 Windows 注册表卸载项，检索自定义目录安装的 Antigravity。
 * @param {(file: string, args: string[], opts: object) => string} [execFn] 可注入命令执行器
 * @returns {string[]}
 */
function findCandidatesFromRegistry(execFn = execFileSync) {
  if (process.platform !== 'win32') {
    return [];
  }
  const candidates = [];
  for (const key of UNINSTALL_REG_KEYS) {
    try {
      const output = execFn('reg', ['query', key, '/s', '/f', 'Antigravity', '/d'], {
        encoding: 'utf8',
        timeout: QUERY_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      candidates.push(...parseRegistryInstallPaths(output));
    } catch (_err) {
      // 注册表分支无匹配时 reg.exe 返回退出码 1，属于正常无结果情况
    }
  }
  return candidates;
}

/**
 * 扫描当前用户桌面与开始菜单快捷方式，解析指向 Antigravity.exe 的目标路径。
 * @param {NodeJS.ProcessEnv} [env] 环境变量对象
 * @param {(file: string, args: string[], opts: object) => string} [execFn] 可注入命令执行器
 * @returns {string[]}
 */
function findCandidatesFromShortcuts(env = process.env, execFn = execFileSync) {
  if (process.platform !== 'win32') {
    return [];
  }
  const roots = [
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'Desktop'),
  ].filter((dir) => dir && fs.existsSync(dir));

  if (roots.length === 0) {
    return [];
  }
  const psScript = [
    '$sh = New-Object -ComObject WScript.Shell',
    ...roots.map((r) => `Get-ChildItem -LiteralPath '${r.replace(/'/g, "''")}' -Filter '*Antigravity*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $sh.CreateShortcut($_.FullName).TargetPath }`),
  ].join('; ');

  try {
    const out = execFn('powershell', ['-NoProfile', '-Command', psScript], {
      encoding: 'utf8',
      timeout: QUERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => normalizeCandidateToAsar(line))
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

/**
 * 兜底扫描本地可用盘符的常见浅层安装路径。
 * @returns {string[]}
 */
function findCandidatesFromDrives() {
  if (process.platform !== 'win32') {
    return [];
  }
  const candidates = [];
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:\\`;
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const sub of DRIVE_SUBDIRS) {
      candidates.push(path.join(root, sub, ASAR_SUBPATH));
    }
  }
  return candidates;
}

/**
 * 按优先级自动检索本机 Antigravity 2.0 桌面端 app.asar 路径。
 * @param {object} [options] 可注入测试选项（env / extraCandidates / validator / skipSystemSearch）
 * @returns {{ asarPath: string, exePath: string, source: string } | null}
 */
function locateAntigravityApp(options = {}) {
  const validator = options.validator || isValidAntigravityAsar;
  const seen = new Set();
  const stages = [
    { source: 'custom', list: () => (options.extraCandidates || []).map(normalizeCandidateToAsar).filter(Boolean) },
    { source: 'standard', list: () => buildStandardCandidates(options.env) },
    ...(options.skipSystemSearch
      ? []
      : [
          { source: 'registry', list: () => findCandidatesFromRegistry(options.execFn) },
          { source: 'shortcut', list: () => findCandidatesFromShortcuts(options.env, options.execFn) },
          { source: 'drives', list: () => findCandidatesFromDrives() },
        ]),
  ];

  for (const stage of stages) {
    for (const candidate of stage.list()) {
      const normalized = path.resolve(candidate);
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (validator(normalized)) {
        return {
          asarPath: normalized,
          exePath: resolveExecutablePath(normalized),
          source: stage.source,
        };
      }
    }
  }
  return null;
}

/**
 * 以独立后台进程方式启动与指定 app.asar 对应的 Antigravity.exe。
 * @param {string} asarPath 已打补丁的 app.asar 路径
 * @param {{ spawnFn?: typeof spawn, existsFn?: (p: string) => boolean }} [options]
 * @returns {{ exePath: string, pid: number | undefined }}
 */
function launchAntigravity(asarPath, options = {}) {
  const exePath = resolveExecutablePath(asarPath);
  const existsFn = options.existsFn || fs.existsSync;
  if (!existsFn(exePath)) {
    throw new Error(`未找到 Antigravity 可执行文件，无法自动启动: ${exePath}`);
  }
  const spawnFn = options.spawnFn || spawn;
  const child = spawnFn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  if (typeof child.unref === 'function') {
    child.unref();
  }
  return { exePath, pid: child.pid };
}

module.exports = Object.freeze({
  TARGET_EXE_NAME,
  resolveExecutablePath,
  isValidAntigravityAsar,
  normalizeCandidateToAsar,
  parseRegistryInstallPaths,
  buildStandardCandidates,
  locateAntigravityApp,
  launchAntigravity,
});

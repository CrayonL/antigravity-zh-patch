/**
 * 文件用途：Antigravity 2.0 中文汉化补丁主控程序（支持安装、更新、还原与状态查询）。
 * 核心职责：执行进程占用校验、原始 app.asar 备份与版本比对、补丁注入及原子还原。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline/promises');
const { execFileSync } = require('child_process');
const { parseAsarHeader, readAsarFile, rewriteAsar } = require('./asarCodec');
const { buildInlinePreloadBundle } = require('./zhInjector');
const { locateAntigravityApp, launchAntigravity } = require('./appLocator');
const zhDict = require('./zhDict');

// 默认安装路径与 ASAR 内部目标路径常量
const DEFAULT_ASAR_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'antigravity',
  'resources',
  'app.asar'
);
const BACKUP_SUFFIX = '.orig.bak';
const TARGET_PROCESS_NAME = 'Antigravity.exe';
const PRELOAD_REL_PATH = 'dist/preload.js';
const TRAY_REL_PATH = 'dist/tray.js';
const MAIN_REL_PATH = 'dist/main.js';
const MENU_REL_PATH = 'dist/menu.js';
const PKG_REL_PATH = 'package.json';
const PROCESS_CHECK_TIMEOUT_MS = 5000;

// 补丁起止标记，保证重复安装幂等且可精确识别
const PATCH_MARKER_START = '// === ANTIGRAVITY_ZH_PATCH_START ===';
const PATCH_MARKER_END = '// === ANTIGRAVITY_ZH_PATCH_END ===';

// dist/tray.js 中待汉化的英文计数模板正则
const TRAY_COUNT_PATTERN =
  /\(count > 0 \? `\$\{count\}` : 'No'\) \+\s*' agent' \+\s*\(count === 1 \? '' : 's'\) \+\s*' running';/;
const TRAY_COUNT_ZH =
  "count > 0 ? `${count} 个智能体运行中` : '当前无运行中的智能体';";

// dist/main.js 中原生系统托盘与 Dock 菜单的精确替换规则
const MAIN_MENU_RULES = Object.freeze([
  Object.freeze({ pattern: /label:\s*'No agents running'/, replace: "label: '当前无运行中的智能体'" }),
  Object.freeze({ pattern: /label:\s*`Open \$\{electron_1\.app\.getName\(\)\}`/, replace: 'label: `打开 ${electron_1.app.getName()}`' }),
  Object.freeze({ pattern: /label:\s*'Quit'/, replace: "label: '退出'" }),
  Object.freeze({ pattern: /label:\s*'New Window'/, replace: "label: '新建窗口'" }),
]);

// dist/menu.js 中主菜单与 WSL 托盘子菜单的精确替换规则（不改动 File/View/Help 等查找键）
const APP_MENU_RULES = Object.freeze([
  Object.freeze({ pattern: /label:\s*'New Window'/, replace: "label: '新建窗口'" }),
  Object.freeze({ pattern: /label:\s*'Docs'/, replace: "label: '文档'" }),
  Object.freeze({ pattern: /label:\s*'Connect to WSL'/, replace: "label: '连接到 WSL'" }),
  Object.freeze({ pattern: /label:\s*'Reopen Locally'/, replace: "label: '在本地重新打开'" }),
]);

/**
 * 检测 Windows 系统中 Antigravity.exe 是否仍在运行。
 * @returns {boolean}
 */
function isAppRunning() {
  if (process.platform !== 'win32') {
    return false;
  }
  const output = execFileSync(
    'tasklist',
    ['/FI', `IMAGENAME eq ${TARGET_PROCESS_NAME}`, '/NH'],
    { encoding: 'utf8', timeout: PROCESS_CHECK_TIMEOUT_MS }
  );
  return output.toLowerCase().includes(TARGET_PROCESS_NAME.toLowerCase());
}

/**
 * 读取 ASAR 内部 package.json 的版本号，用于检测软件是否已自动更新。
 * @param {string} asarPath ASAR 文件路径
 * @returns {string}
 */
function readAsarAppVersion(asarPath) {
  const pkgBuf = readAsarFile(asarPath, PKG_REL_PATH);
  const pkg = JSON.parse(pkgBuf.toString('utf8'));
  return String(pkg.version || 'unknown');
}

/**
 * 检查指定 ASAR 文件是否已注入汉化补丁标记。
 * @param {string} asarPath ASAR 文件路径
 * @returns {boolean}
 */
function isAsarPatched(asarPath) {
  const preloadText = readAsarFile(asarPath, PRELOAD_REL_PATH).toString('utf8');
  return preloadText.includes(PATCH_MARKER_START) && preloadText.includes(PATCH_MARKER_END);
}

/**
 * 生成内联中文渲染层 IIFE 后的 dist/preload.js 内容（零本地 require，支持幂等覆写）。
 * @param {string} preloadText 原始或已打补丁的 preload.js 源码
 * @returns {string}
 */
function buildPatchedPreload(preloadText) {
  const startIdx = preloadText.indexOf(PATCH_MARKER_START);
  const endIdx = preloadText.indexOf(PATCH_MARKER_END);
  let cleanText = preloadText;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = preloadText.slice(0, startIdx).trimEnd();
    const after = preloadText.slice(endIdx + PATCH_MARKER_END.length).trimStart();
    cleanText = after ? `${before}\n${after}` : before;
  }
  const inlineBundle = buildInlinePreloadBundle(zhDict);
  const hookBlock = [
    '',
    PATCH_MARKER_START,
    inlineBundle,
    PATCH_MARKER_END,
    '',
  ].join('\n');
  return `${cleanText.trimEnd()}\n${hookBlock}`;
}

/**
 * 尝试汉化 dist/tray.js 中的运行中智能体计数文案。
 * @param {string} trayText 原始 tray.js 源码
 * @returns {{ content: string, matched: boolean }}
 */
function buildPatchedTray(trayText) {
  if (!TRAY_COUNT_PATTERN.test(trayText)) {
    return { content: trayText, matched: false };
  }
  return {
    content: trayText.replace(TRAY_COUNT_PATTERN, TRAY_COUNT_ZH),
    matched: true,
  };
}

/**
 * 按规则列表逐条替换目标源码中的英文菜单文案，返回更新结果与命中数量。
 * @param {string} sourceText 原始源码文本
 * @param {ReadonlyArray<{ pattern: RegExp, replace: string }>} rules 替换规则列表
 * @returns {{ content: string, matched: boolean, matchedCount: number }}
 */
function applyLabelRules(sourceText, rules) {
  let content = sourceText;
  let matchedCount = 0;
  for (const rule of rules) {
    if (rule.pattern.test(content)) {
      content = content.replace(rule.pattern, rule.replace);
      matchedCount += 1;
    }
  }
  return { content, matched: matchedCount > 0, matchedCount };
}

/**
 * 尝试汉化 dist/main.js 中的原生托盘初始菜单与 Dock 菜单文案。
 * @param {string} mainText 原始 main.js 源码
 * @returns {{ content: string, matched: boolean, matchedCount: number }}
 */
function buildPatchedMain(mainText) {
  return applyLabelRules(mainText, MAIN_MENU_RULES);
}

/**
 * 尝试汉化 dist/menu.js 中的主菜单与 WSL 托盘子菜单文案。
 * @param {string} menuText 原始 menu.js 源码
 * @returns {{ content: string, matched: boolean, matchedCount: number }}
 */
function buildPatchedMenu(menuText) {
  return applyLabelRules(menuText, APP_MENU_RULES);
}

/**
 * 校验生成的 JS 文本语法是否合法，防止写入存在语法错误的代码。
 * @param {string} code JS 源代码
 * @param {string} filename 用于报错定位的文件名
 */
function assertValidJsSyntax(code, filename) {
  new vm.Script(code, { filename });
}

/**
 * 确定并准备用于打补丁的干净源备份文件路径。
 * @param {string} asarPath 目标 app.asar 路径
 * @param {string} backupPath 备份 app.asar.orig.bak 路径
 * @returns {string} 作为构建基准的干净源文件路径
 */
function ensureCleanBackup(asarPath, backupPath) {
  const currentlyPatched = isAsarPatched(asarPath);
  const backupExists = fs.existsSync(backupPath);

  if (!backupExists) {
    if (currentlyPatched) {
      throw new Error('当前 app.asar 已打补丁但缺少原始备份文件，请先重装或恢复原版');
    }
    fs.copyFileSync(asarPath, backupPath);
    return backupPath;
  }

  // 若软件已自动更新为未打补丁的新版本，则刷新原始备份避免回退旧版
  if (!currentlyPatched) {
    const curVer = readAsarAppVersion(asarPath);
    const bakVer = readAsarAppVersion(backupPath);
    if (curVer !== bakVer) {
      fs.copyFileSync(asarPath, backupPath);
    }
  }
  return backupPath;
}

/**
 * 解析目标 app.asar 路径：优先使用显式路径，否则自动检索本机 Antigravity 安装目录。
 * @param {string | undefined} explicitPath 显式传入的路径
 * @param {() => ({ asarPath: string } | null)} [locateFn] 可注入路径检索函数
 * @returns {string}
 */
function resolveTargetAsarPath(explicitPath, locateFn = locateAntigravityApp) {
  if (explicitPath) {
    return explicitPath;
  }
  const located = locateFn();
  return located ? located.asarPath : DEFAULT_ASAR_PATH;
}

/**
 * 查询目标 app.asar 的当前版本、备份状态与补丁安装状态。
 * @param {string} [asarPath] 可选自定义 app.asar 路径（省略时自动检索）
 * @returns {{ asarPath: string, exists: boolean, version: string, patched: boolean, hasBackup: boolean }}
 */
function getPatchStatus(asarPath) {
  const targetPath = resolveTargetAsarPath(asarPath);
  const backupPath = `${targetPath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(targetPath)) {
    return {
      asarPath: targetPath,
      exists: false,
      version: 'N/A',
      patched: false,
      hasBackup: fs.existsSync(backupPath),
    };
  }
  return {
    asarPath: targetPath,
    exists: true,
    version: readAsarAppVersion(targetPath),
    patched: isAsarPatched(targetPath),
    hasBackup: fs.existsSync(backupPath),
  };
}

/**
 * 从干净源 ASAR 中构建并通过语法校验的补丁文件映射。
 * @param {string} cleanSourcePath 未打补丁的原始 ASAR 路径
 * @returns {{ updates: Record<string, string>, trayPatched: boolean, mainPatched: boolean, menuPatched: boolean }}
 */
function buildAsarUpdates(cleanSourcePath) {
  const origPreload = readAsarFile(cleanSourcePath, PRELOAD_REL_PATH).toString('utf8');
  const origTray = readAsarFile(cleanSourcePath, TRAY_REL_PATH).toString('utf8');
  const origMain = readAsarFile(cleanSourcePath, MAIN_REL_PATH).toString('utf8');
  const origMenu = readAsarFile(cleanSourcePath, MENU_REL_PATH).toString('utf8');

  const patchedPreload = buildPatchedPreload(origPreload);
  const trayResult = buildPatchedTray(origTray);
  const mainResult = buildPatchedMain(origMain);
  const menuResult = buildPatchedMenu(origMenu);

  assertValidJsSyntax(patchedPreload, PRELOAD_REL_PATH);
  assertValidJsSyntax(trayResult.content, TRAY_REL_PATH);
  assertValidJsSyntax(mainResult.content, MAIN_REL_PATH);
  assertValidJsSyntax(menuResult.content, MENU_REL_PATH);

  const updates = { [PRELOAD_REL_PATH]: patchedPreload };
  if (trayResult.matched) {
    updates[TRAY_REL_PATH] = trayResult.content;
  }
  if (mainResult.matched) {
    updates[MAIN_REL_PATH] = mainResult.content;
  }
  if (menuResult.matched) {
    updates[MENU_REL_PATH] = menuResult.content;
  }
  return {
    updates,
    trayPatched: trayResult.matched,
    mainPatched: mainResult.matched,
    menuPatched: menuResult.matched,
  };
}

/**
 * 安装或更新中文汉化补丁到指定或自动检索到的 app.asar，可选完成后自动拉起软件。
 * @param {object} [options] 配置项（asarPath / autoLaunch / skipProcessCheck / checkRunning / locateFn / launchFn）
 * @returns {object}
 */
function installPatch(options = {}) {
  const checkRunning = options.checkRunning || isAppRunning;
  if (!options.skipProcessCheck && checkRunning()) {
    throw new Error('检测到 Antigravity.exe 正在运行！请先彻底退出软件（含右下角系统托盘）后再试。');
  }
  const asarPath = resolveTargetAsarPath(options.asarPath, options.locateFn);
  if (!fs.existsSync(asarPath)) {
    throw new Error(`未找到目标文件（自动检索与默认路径均不存在）: ${asarPath}`);
  }

  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;
  const cleanSourcePath = ensureCleanBackup(asarPath, backupPath);
  const version = readAsarAppVersion(cleanSourcePath);
  const { updates, trayPatched, mainPatched, menuPatched } = buildAsarUpdates(cleanSourcePath);

  const result = rewriteAsar({ sourcePath: cleanSourcePath, targetPath: asarPath, updates });
  // 回读校验确保新生成的 ASAR 完整可读
  if (!isAsarPatched(asarPath)) {
    throw new Error('补丁写入后回读校验失败，未检测到补丁标记');
  }
  let launchedExePath = null;
  if (options.autoLaunch) {
    const launchFn = options.launchFn || launchAntigravity;
    launchedExePath = launchFn(asarPath).exePath;
  }
  return {
    asarPath,
    version,
    backupPath,
    trayPatched,
    mainPatched,
    menuPatched,
    updatedCount: result.updatedCount,
    launchedExePath,
  };
}

/**
 * 从原始备份文件无损还原官方 app.asar。
 * @param {{ asarPath?: string, skipProcessCheck?: boolean, checkRunning?: () => boolean, locateFn?: Function }} [options]
 * @returns {{ asarPath: string, version: string }}
 */
function restorePatch(options = {}) {
  const checkRunning = options.checkRunning || isAppRunning;
  if (!options.skipProcessCheck && checkRunning()) {
    throw new Error('检测到 Antigravity.exe 正在运行！请先彻底退出软件（含右下角系统托盘）后再还原。');
  }
  const asarPath = resolveTargetAsarPath(options.asarPath, options.locateFn);
  const backupPath = `${asarPath}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backupPath)) {
    throw new Error(`未找到原始备份文件，无法还原: ${backupPath}`);
  }
  // 还原前校验备份头部完整
  parseAsarHeader(backupPath);
  fs.copyFileSync(backupPath, asarPath);
  const version = readAsarAppVersion(asarPath);
  fs.unlinkSync(backupPath);
  return { asarPath, version };
}

/**
 * 打印交互式中文管理工具主菜单，并展示自动检索到的目标路径。
 * @param {string} detectedPath 当前目标 app.asar 路径
 */
function printMenuBanner(detectedPath) {
  console.log('\n========================================================');
  console.log('  Antigravity 2.0 简体中文汉化补丁管理工具');
  console.log('========================================================');
  console.log(`目标路径: ${detectedPath}`);
  console.log('提示：安装或还原前请彻底退出 Antigravity，安装后将自动重新打开。\n');
  console.log('  [1] 自动检索并安装 / 更新汉化补丁（完成后自动打开）');
  console.log('  [2] 一键还原官方原版');
  console.log('  [3] 查看当前补丁状态');
  console.log('  [0] 退出\n');
}

/**
 * 执行单条 CLI 指令并向控制台打印中文结果。
 * @param {string} cmd 子命令名称（install / restore / status）
 * @param {string | undefined} asarPath 目标 app.asar 路径（未传则自动检索）
 * @param {{ noLaunch?: boolean }} [cliOpts] 命令行行为选项
 */
function executeCommand(cmd, asarPath, cliOpts = {}) {
  if (cmd === 'status') {
    const st = getPatchStatus(asarPath);
    console.log(`目标文件: ${st.asarPath}`);
    console.log(`文件存在: ${st.exists ? '是' : '否'}`);
    console.log(`应用版本: ${st.version}`);
    console.log(`补丁状态: ${st.patched ? '已安装中文补丁' : '官方原版（未安装）'}`);
    console.log(`原始备份: ${st.hasBackup ? '存在 (.orig.bak)' : '无'}`);
    return;
  }
  if (cmd === 'install') {
    const res = installPatch({ asarPath, autoLaunch: !cliOpts.noLaunch });
    console.log(`中文补丁安装成功！应用版本: ${res.version}`);
    console.log(`目标路径: ${res.asarPath}`);
    console.log(
      `已更新内部文件数: ${res.updatedCount}（托盘计数: ${res.trayPatched ? '已应用' : '跳过'}，托盘/主菜单: ${res.mainPatched && res.menuPatched ? '已应用' : '部分跳过'}）`
    );
    console.log(`原始备份已保存至: ${res.backupPath}`);
    if (res.launchedExePath) {
      console.log(`已自动打开软件: ${res.launchedExePath}`);
    }
    return;
  }
  if (cmd === 'restore') {
    const res = restorePatch({ asarPath });
    console.log(`已无损还原官方原版！应用版本: ${res.version}`);
    console.log(`目标文件: ${res.asarPath}`);
    return;
  }
  throw new Error('用法: node patcher.js <install|restore|status|interactive> [--asar <路径>] [--no-launch]');
}

/**
 * 安全读取单行用户输入，流关闭或中断时返回 null 以优雅结束菜单循环。
 * @param {import('readline/promises').Interface} rl readline 接口实例
 * @returns {Promise<string | null>}
 */
async function askChoice(rl) {
  try {
    const answer = await rl.question('请输入操作编号并按回车: ');
    return answer.trim();
  } catch (_err) {
    return null;
  }
}

/**
 * 启动基于 Node.js readline 的 UTF-8 交互式中文菜单，规避 cmd.exe 乱码与跳转错位。
 * @param {string | undefined} asarPath 目标 app.asar 路径
 * @param {{ noLaunch?: boolean }} [cliOpts] 命令行行为选项
 * @returns {Promise<void>}
 */
async function runInteractiveMenu(asarPath, cliOpts = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choiceToCmd = Object.freeze({ '1': 'install', '2': 'restore', '3': 'status' });
  const resolved = resolveTargetAsarPath(asarPath);
  const displayPath = fs.existsSync(resolved) ? `${resolved}（已自动检测）` : '未自动检测到，请安装客户端或用 --asar 指定';
  try {
    while (true) {
      printMenuBanner(displayPath);
      const choice = await askChoice(rl);
      if (choice === null || choice === '0') {
        console.log('已退出管理工具。');
        break;
      }
      const cmd = choiceToCmd[choice];
      if (!cmd) {
        console.log('[提示] 无效编号，请输入 0 / 1 / 2 / 3。');
        continue;
      }
      console.log('');
      try {
        executeCommand(cmd, asarPath, cliOpts);
      } catch (err) {
        console.error(`[错误] ${err.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * 解析命令行参数并执行对应子命令（install / restore / status / interactive）。
 * @param {string[]} argv 命令行参数数组
 * @returns {Promise<void>}
 */
async function runCli(argv) {
  const cmd = argv[0];
  const asarFlagIdx = argv.indexOf('--asar');
  const asarPath = asarFlagIdx !== -1 ? argv[asarFlagIdx + 1] : undefined;
  const cliOpts = { noLaunch: argv.includes('--no-launch') };
  if (cmd === 'interactive') {
    await runInteractiveMenu(asarPath, cliOpts);
    return;
  }
  executeCommand(cmd, asarPath, cliOpts);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(`[错误] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  DEFAULT_ASAR_PATH,
  BACKUP_SUFFIX,
  PATCH_MARKER_START,
  PATCH_MARKER_END,
  resolveTargetAsarPath,
  buildPatchedPreload,
  buildPatchedTray,
  buildPatchedMain,
  buildPatchedMenu,
  getPatchStatus,
  installPatch,
  restorePatch,
});

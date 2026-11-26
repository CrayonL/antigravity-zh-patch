/**
 * 文件用途：Electron 主进程原生菜单与右键上下文菜单汉化构建模块。
 * 核心职责：为 dist/tray.js、dist/main.js、dist/menu.js 与 dist/ipcHandlers.js
 *          生成安全的中文补丁源码，确保右键菜单项与子菜单全部同步汉化。
 */

'use strict';

// dist/tray.js 中待汉化的英文计数模板正则
const TRAY_COUNT_PATTERN =
  /\(count > 0 \? `\$\{count\}` : 'No'\) \+\s*' agent' \+\s*\(count === 1 \? '' : 's'\) \+\s*' running';/;
const TRAY_COUNT_ZH =
  "count > 0 ? `${count} 个智能体运行中` : '当前无运行中的智能体';";

// dist/main.js 中原生系统托盘与 Dock 菜单的精确替换规则
const MAIN_MENU_RULES = Object.freeze([
  Object.freeze({ pattern: /label:\s*'No agents running'/, replace: "label: '当前无运行中的智能体'" }),
  Object.freeze({
    pattern: /label:\s*`Open \$\{electron_1\.app\.getName\(\)\}`/,
    replace: 'label: `打开 ${electron_1.app.getName()}`',
  }),
  Object.freeze({ pattern: /label:\s*'Quit'/, replace: "label: '退出'" }),
  Object.freeze({ pattern: /label:\s*'New Window'/, replace: "label: '新建窗口'" }),
]);

// dist/menu.js 中主菜单与 WSL 托盘子菜单的精确替换规则（保留 File/View/Help 查找键）
const APP_MENU_RULES = Object.freeze([
  Object.freeze({ pattern: /label:\s*'New Window'/, replace: "label: '新建窗口'" }),
  Object.freeze({ pattern: /label:\s*'Docs'/, replace: "label: '文档'" }),
  Object.freeze({ pattern: /label:\s*'Connect to WSL'/, replace: "label: '连接到 WSL'" }),
  Object.freeze({ pattern: /label:\s*'Reopen Locally'/, replace: "label: '在本地重新打开'" }),
]);

// 主进程右键菜单最大可翻译文本长度阈值，防止误匹配用户标题
const MAX_MENU_LABEL_LEN = 320;
const CONTEXT_MENU_FN_SIG = 'function buildContextMenuTemplate(items, onSelect) {';
const CONTEXT_MENU_HELPER_MARKER = 'function __zhTranslateMenuLabel(rawLabel) {';

const CONTEXT_MENU_HELPER_CODE = `const { EXACT_MAP: __zhExactMap, REGEX_RULES: __zhRegexRules } = require('./zhDict');
const __zhLowerExactMap = Object.create(null);
for (const [k, v] of Object.entries(__zhExactMap)) {
    if (k.includes(' ') || k.includes(':') || k.includes('...') || k.includes('\\u2026')) {
        const nk = k.replace(/\\u2026/g, '...').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(__zhLowerExactMap, nk)) {
            __zhLowerExactMap[nk] = v;
        }
    }
}
function __zhTranslateMenuLabel(rawLabel) {
    if (typeof rawLabel !== 'string') {
        return rawLabel;
    }
    const trimmed = rawLabel.trim();
    if (!trimmed || trimmed.length > ${MAX_MENU_LABEL_LEN}) {
        return rawLabel;
    }
    const cleanKey = trimmed.replace(/&/g, '').replace(/\\u00a0/g, ' ').replace(/\\u2026/g, '...');
    const lowerKey = cleanKey.toLowerCase();
    const exactHit = Object.prototype.hasOwnProperty.call(__zhExactMap, trimmed)
        ? __zhExactMap[trimmed]
        : Object.prototype.hasOwnProperty.call(__zhExactMap, cleanKey)
            ? __zhExactMap[cleanKey]
            : Object.prototype.hasOwnProperty.call(__zhLowerExactMap, lowerKey)
                ? __zhLowerExactMap[lowerKey]
                : null;
    if (exactHit !== null) {
        return rawLabel.replace(trimmed, exactHit);
    }
    for (const rule of __zhRegexRules) {
        if (rule.pattern.test(cleanKey)) {
            return rawLabel.replace(trimmed, cleanKey.replace(rule.pattern, rule.replace));
        }
    }
    return rawLabel;
}
`;

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
 * 汉化 dist/ipcHandlers.js 中的原生右键上下文菜单构造器（window:show-context-menu）。
 * @param {string} ipcText 原始 ipcHandlers.js 源码
 * @returns {{ content: string, matched: boolean }}
 */
function buildPatchedIpcHandlers(ipcText) {
  const fnIdx = ipcText.indexOf(CONTEXT_MENU_FN_SIG);
  if (fnIdx === -1) {
    return { content: ipcText, matched: false };
  }
  const fnEndIdx = ipcText.indexOf('\n/**\n', fnIdx);
  const blockEnd = fnEndIdx !== -1 ? fnEndIdx : fnIdx + 1200;
  const fnBlock = ipcText.slice(fnIdx, blockEnd);
  const replacedBlock = fnBlock.replace(/label:\s*item\.label\s*\?\?\s*''/g, "label: __zhTranslateMenuLabel(item.label ?? '')");
  if (replacedBlock === fnBlock) {
    return { content: ipcText, matched: false };
  }
  const prefix = ipcText.slice(0, fnIdx);
  const helper = prefix.includes(CONTEXT_MENU_HELPER_MARKER) ? '' : CONTEXT_MENU_HELPER_CODE;
  return {
    content: `${prefix}${helper}${replacedBlock}${ipcText.slice(blockEnd)}`,
    matched: true,
  };
}

module.exports = Object.freeze({
  buildPatchedTray,
  buildPatchedMain,
  buildPatchedMenu,
  buildPatchedIpcHandlers,
});

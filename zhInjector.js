/**
 * 文件用途：Antigravity 2.0 桌面端渲染层 DOM 汉化引擎与沙盒内联构建器。
 * 核心职责：在页面加载及 DOM 增量变化时，仅对安全 UI 区域的文本节点与提示属性
 *          应用中文词典替换，避免修改 DOM 结构或污染代码、输入框及聊天正文；
 *          同时支持导出零 require 的自包含 IIFE，兼容 Electron sandbox preload。
 */

'use strict';

const fs = require('fs');
const { EXACT_MAP, REGEX_RULES } = require('./zhDict');

// 通过字符串拼接定义标记常量，避免 indexOf 误命中常量声明自身
const RUNTIME_START_MARKER = '// === ' + 'ZH_RUNTIME_START ===';
const RUNTIME_END_MARKER = '// === ' + 'ZH_RUNTIME_END ===';

// === ZH_RUNTIME_START ===
// 绝对不遍历子节点的标签集合
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'TEXTAREA',
  'INPUT',
  'SVG',
  'MATH',
  'KBD',
]);

// 需要尝试翻译的常见提示/无障碍属性名
const TRANSLATABLE_ATTRS = Object.freeze(['placeholder', 'title', 'aria-label']);

// 始终跳过的编辑区、代码块及显式排除容器
const HARD_SKIP_SELECTOR = [
  '[contenteditable="true"]',
  '[data-zh-skip="true"]',
  '.monaco-editor',
  '.cm-editor',
  '.hljs',
  '.shiki',
].join(',');

// 聊天正文容器：跳过普通段落文本，但允许其中的软件 UI 按钮/悬浮工具栏（如划词 Quote）翻译
const CONTENT_SKIP_SELECTOR = '.markdown-body,.prose';
const UI_CONTROL_SELECTOR = 'button,[role="button"],[role="toolbar"],[role="menu"],[role="menuitem"]';

// 词典匹配的最大文本长度阈值，覆盖设置页长说明文案同时过滤聊天长正文
const MAX_UI_TEXT_LENGTH = 320;
// 批量刷新间隔（毫秒），合并高频 DOM 变更降低开销
const FLUSH_DELAY_MS = 24;
// 防止同一窗口重复安装观察器的全局标记键
const INSTALLED_FLAG = '__ANTIGRAVITY_ZH_OVERLAY_INSTALLED__';

/**
 * 尝试将单条英文 UI 文案翻译为中文；无匹配时返回 null。
 * @param {string} rawText 原始字符串
 * @returns {string | null}
 */
function translateString(rawText) {
  if (typeof rawText !== 'string') {
    return null;
  }
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.length > MAX_UI_TEXT_LENGTH) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(EXACT_MAP, trimmed)) {
    return rawText.replace(trimmed, EXACT_MAP[trimmed]);
  }
  for (const rule of REGEX_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rawText.replace(trimmed, trimmed.replace(rule.pattern, rule.replace));
    }
  }
  return null;
}

/**
 * 判断元素或其祖先是否属于应跳过翻译的受保护区域。
 * @param {Element | null} el 待检测的 DOM 元素
 * @returns {boolean}
 */
function isProtectedElement(el) {
  if (!el || el.nodeType !== 1) {
    return true;
  }
  if (SKIP_TAGS.has(el.tagName)) {
    return true;
  }
  if (typeof el.closest !== 'function') {
    return false;
  }
  if (el.closest(HARD_SKIP_SELECTOR)) {
    return true;
  }
  if (el.closest(CONTENT_SKIP_SELECTOR)) {
    return !el.closest(UI_CONTROL_SELECTOR);
  }
  return false;
}

/**
 * 翻译单个文本节点（原地修改 nodeValue，保持 React 文本节点引用不变）。
 * @param {Text} textNode 文本节点
 */
function translateTextNode(textNode) {
  if (!textNode || textNode.nodeType !== 3) {
    return;
  }
  if (isProtectedElement(textNode.parentElement)) {
    return;
  }
  const translated = translateString(textNode.nodeValue);
  if (translated !== null && translated !== textNode.nodeValue) {
    textNode.nodeValue = translated;
  }
}

/**
 * 翻译单个元素的 placeholder / title / aria-label 属性。
 * @param {Element} el DOM 元素
 */
function translateElementAttrs(el) {
  if (!el || el.nodeType !== 1 || typeof el.getAttribute !== 'function') {
    return;
  }
  for (const attr of TRANSLATABLE_ATTRS) {
    const curVal = el.getAttribute(attr);
    if (!curVal) {
      continue;
    }
    const translated = translateString(curVal);
    if (translated !== null && translated !== curVal) {
      el.setAttribute(attr, translated);
    }
  }
}

/**
 * 递归扫描并翻译指定子树中的安全文本节点与提示属性。
 * @param {Node} rootNode 起始 DOM 节点
 */
function translateSubtree(rootNode) {
  if (!rootNode) {
    return;
  }
  if (rootNode.nodeType === 3) {
    translateTextNode(rootNode);
    return;
  }
  if (rootNode.nodeType !== 1) {
    return;
  }
  translateElementAttrs(rootNode);
  if (SKIP_TAGS.has(rootNode.tagName)) {
    return;
  }
  if (typeof rootNode.closest === 'function' && rootNode.closest(HARD_SKIP_SELECTOR)) {
    return;
  }
  const children = rootNode.childNodes;
  for (let i = 0; i < children.length; i += 1) {
    translateSubtree(children[i]);
  }
}

/**
 * 创建带防抖批处理的节点调度器，合并高频 DOM 变更并执行增量翻译。
 * @param {object} globalObj 全局对象（提供 setTimeout/clearTimeout）
 * @returns {{ schedule: (node: Node) => void, dispose: () => void }}
 */
function createMutationScheduler(globalObj) {
  const pendingNodes = new Set();
  let timerId = null;

  const flushPending = () => {
    timerId = null;
    const batch = Array.from(pendingNodes);
    pendingNodes.clear();
    for (const node of batch) {
      translateSubtree(node);
    }
  };

  const schedule = (node) => {
    if (!node) {
      return;
    }
    pendingNodes.add(node);
    if (timerId === null) {
      timerId = globalObj.setTimeout(flushPending, FLUSH_DELAY_MS);
    }
  };

  const dispose = () => {
    if (timerId !== null) {
      globalObj.clearTimeout(timerId);
      timerId = null;
    }
    pendingNodes.clear();
  };

  return { schedule, dispose };
}

/**
 * 处理单批次 MutationRecord 列表，分发至属性翻译或子树防抖队列。
 * @param {MutationRecord[]} mutations 变更记录集合
 * @param {(node: Node) => void} schedule 延迟调度回调
 */
function handleMutations(mutations, schedule) {
  for (const m of mutations) {
    if (m.type === 'characterData') {
      schedule(m.target);
      continue;
    }
    if (m.type === 'attributes') {
      translateElementAttrs(m.target);
      continue;
    }
    for (let i = 0; i < m.addedNodes.length; i += 1) {
      schedule(m.addedNodes[i]);
    }
  }
}

/**
 * 在当前窗口上下文中挂载中文汉化 MutationObserver，并在 DOMContentLoaded/load 时机确保同步。
 * @param {object} [env] 可注入的运行环境对象（用于单元测试）
 * @returns {(() => void) | null} 返回清理函数；已安装时返回 null
 */
function installZhCnOverlay(env) {
  const g = env && env.globalObj ? env.globalObj : globalThis;
  if (g[INSTALLED_FLAG]) {
    return null;
  }
  const doc = env && env.doc ? env.doc : g.document;
  const ObserverCtor = env && env.MutationObserver ? env.MutationObserver : g.MutationObserver;
  if (!doc || typeof ObserverCtor !== 'function') {
    return null;
  }
  g[INSTALLED_FLAG] = true;

  const scheduler = createMutationScheduler(g);
  const observer = new ObserverCtor((mutations) => handleMutations(mutations, scheduler.schedule));
  let observedTarget = null;

  const syncAndObserve = () => {
    const target = doc.documentElement || doc.body;
    if (!target) {
      return;
    }
    translateSubtree(target);
    if (observedTarget !== target) {
      observedTarget = target;
      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATABLE_ATTRS],
      });
    }
  };

  syncAndObserve();
  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('DOMContentLoaded', syncAndObserve);
  }
  if (typeof g.addEventListener === 'function') {
    g.addEventListener('load', syncAndObserve);
  }

  return () => {
    observer.disconnect();
    scheduler.dispose();
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('DOMContentLoaded', syncAndObserve);
    }
    if (typeof g.removeEventListener === 'function') {
      g.removeEventListener('load', syncAndObserve);
    }
    delete g[INSTALLED_FLAG];
  };
}
// === ZH_RUNTIME_END ===

/**
 * 将词典与运行时代码编译为零 require 的自包含 IIFE 字符串，供 Electron 沙盒 preload 直接内联。
 * @param {{ EXACT_MAP: Record<string, string>, REGEX_RULES: Array<{ pattern: RegExp, replace: string }> }} [dict]
 * @returns {string}
 */
function buildInlinePreloadBundle(dict = { EXACT_MAP, REGEX_RULES }) {
  const selfSource = fs.readFileSync(__filename, 'utf8');
  const startIdx = selfSource.indexOf(RUNTIME_START_MARKER);
  const endIdx = selfSource.indexOf(RUNTIME_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error('zhInjector.js 缺少有效的运行时代码起止标记');
  }
  const runtimeBody = selfSource
    .slice(startIdx + RUNTIME_START_MARKER.length, endIdx)
    .trim();
  const exactJson = JSON.stringify(dict.EXACT_MAP);
  const regexItems = dict.REGEX_RULES.map(
    (r) =>
      `{ pattern: new RegExp(${JSON.stringify(r.pattern.source)}, ${JSON.stringify(r.pattern.flags)}), replace: ${JSON.stringify(r.replace)} }`
  ).join(',\n    ');

  return [
    '(function (EXACT_MAP, REGEX_RULES) {',
    "  'use strict';",
    runtimeBody,
    '  installZhCnOverlay();',
    `})(${exactJson}, [\n    ${regexItems}\n]);`,
  ].join('\n');
}

module.exports = Object.freeze({
  translateString,
  translateSubtree,
  installZhCnOverlay,
  buildInlinePreloadBundle,
});

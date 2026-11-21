/**
 * 文件用途：Antigravity 2.0 中文汉化补丁自动化测试套件。
 * 核心职责：覆盖词典翻译、受保护 DOM 排除、MutationObserver 增量汉化、
 *          ASAR 读写完整性校验，以及基于真实 app.asar 副本的安装/幂等升级/还原全流程。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawnSync } = require('child_process');

const { computeIntegrity, parseAsarHeader, readAsarFile, rewriteAsar } = require('./asarCodec');
const { translateString, translateSubtree, installZhCnOverlay } = require('./zhInjector');
const {
  resolveExecutablePath,
  normalizeCandidateToAsar,
  parseRegistryInstallPaths,
  locateAntigravityApp,
  launchAntigravity,
} = require('./appLocator');
const {
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
} = require('./patcher');

/**
 * 计算磁盘文件的 SHA-256 摘要，用于验证字节级无损还原。
 * @param {string} filePath 文件路径
 * @returns {string}
 */
function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 构造最小化内存 DOM 元素桩对象，用于离线测试 DOM 翻译与保护逻辑。
 * @param {string} tagName 标签名
 * @param {object} [opts] 属性、选择器匹配集合及子节点
 * @returns {object}
 */
function createMockElement(tagName, opts = {}) {
  const attrs = new Map(Object.entries(opts.attrs || {}));
  const matchedSelectors = new Set(opts.matchedSelectors || []);
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parentElement: null,
    childNodes: [],
    _matchedSelectors: matchedSelectors,
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, val) => attrs.set(name, String(val)),
    closest(selector) {
      const parts = selector.split(',').map((s) => s.trim().toLowerCase());
      let cur = this;
      while (cur) {
        if (parts.includes(cur.tagName.toLowerCase())) {
          return cur;
        }
        for (const s of cur._matchedSelectors) {
          if (parts.includes(s.toLowerCase())) {
            return cur;
          }
        }
        cur = cur.parentElement;
      }
      return null;
    },
  };
  for (const child of opts.children || []) {
    child.parentElement = el;
    el.childNodes.push(child);
  }
  return el;
}

/**
 * 构造最小化内存文本节点桩对象。
 * @param {string} text 文本内容
 * @returns {{ nodeType: number, nodeValue: string, parentElement: object | null }}
 */
function createMockText(text) {
  return { nodeType: 3, nodeValue: text, parentElement: null };
}

test('zhInjector.translateString 覆盖精确词典、空白保留、动态正则与超长过滤', () => {
  assert.equal(translateString('Prevent Sleep'), '防止休眠');
  assert.equal(translateString('  Open IDE  '), '  打开 IDE  ');
  assert.equal(translateString('3 agents running'), '3 个智能体运行中');
  assert.equal(translateString('Version 2.34.0'), '版本 2.34.0');
  assert.equal(translateString('Unmapped random phrase'), null);
  assert.equal(translateString('A'.repeat(200)), null);
});

test('zhInjector.translateSubtree 汉化安全 UI 并严格保护代码块与聊天正文', () => {
  const uiText = createMockText('Prevent Sleep');
  const codeText = createMockText('Settings');
  const proseText = createMockText('Save');
  const inputEl = createMockElement('input', {
    attrs: { placeholder: 'Ask anything, @ to mention, / for actions' },
  });
  const codeEl = createMockElement('code', { children: [codeText] });
  const proseEl = createMockElement('div', {
    matchedSelectors: ['.markdown-body'],
    children: [proseText],
  });
  const btnEl = createMockElement('button', {
    attrs: { 'aria-label': 'Close' },
    children: [uiText],
  });
  const root = createMockElement('div', { children: [btnEl, inputEl, codeEl, proseEl] });

  translateSubtree(root);

  assert.equal(uiText.nodeValue, '防止休眠');
  assert.equal(btnEl.getAttribute('aria-label'), '关闭');
  assert.equal(inputEl.getAttribute('placeholder'), '随时提问，输入 @ 引用上下文，输入 / 调用指令');
  // 代码块和 markdown 正文中的英文绝不被误翻译
  assert.equal(codeText.nodeValue, 'Settings');
  assert.equal(proseText.nodeValue, 'Save');
});

test('zhInjector.installZhCnOverlay 支持防重复挂载与增量 DOM 回调翻译', () => {
  let capturedCb = null;
  let disconnected = false;
  let scheduledFn = null;

  class FakeObserver {
    constructor(cb) {
      capturedCb = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }

  const fakeGlobal = {
    setTimeout: (fn) => {
      scheduledFn = fn;
      return 1;
    },
    clearTimeout: () => {
      scheduledFn = null;
    },
  };
  const body = createMockElement('body', { children: [createMockText('Application')] });
  const fakeDoc = { readyState: 'complete', body };

  const dispose = installZhCnOverlay({
    globalObj: fakeGlobal,
    doc: fakeDoc,
    MutationObserver: FakeObserver,
  });
  assert.equal(typeof dispose, 'function');
  assert.equal(body.childNodes[0].nodeValue, '应用程序');

  // 重复挂载返回 null
  assert.equal(
    installZhCnOverlay({ globalObj: fakeGlobal, doc: fakeDoc, MutationObserver: FakeObserver }),
    null
  );

  // 模拟动态新增节点触发异步批处理翻译
  const dynamicNode = createMockElement('span', { children: [createMockText('Remote Control')] });
  capturedCb([{ type: 'childList', addedNodes: [dynamicNode] }]);
  assert.equal(typeof scheduledFn, 'function');
  scheduledFn();
  assert.equal(dynamicNode.childNodes[0].nodeValue, '远程控制');

  dispose();
  assert.equal(disconnected, true);
});

test('asarCodec 与 patcher 拒绝非法路径、空备份还原及进程占用保护', () => {
  assert.throws(() => readAsarFile(DEFAULT_ASAR_PATH, '../secret.txt'), /非法/);
  assert.throws(() => computeIntegrity('not-a-buffer'), TypeError);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-edge-'));
  try {
    const missingAsar = path.join(tmpDir, 'missing.asar');
    assert.throws(
      () => installPatch({ asarPath: missingAsar, skipProcessCheck: true }),
      /未找到目标文件/
    );
    assert.throws(
      () => restorePatch({ asarPath: missingAsar, skipProcessCheck: true }),
      /未找到原始备份文件/
    );
    assert.throws(
      () => installPatch({ asarPath: missingAsar, checkRunning: () => true }),
      /正在运行/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('端到端副本集成测试：真实 app.asar 安装、幂等重复安装、版本刷新与无损还原', () => {
  const defaultBackup = `${DEFAULT_ASAR_PATH}${BACKUP_SUFFIX}`;
  const cleanFixtureSource = fs.existsSync(defaultBackup) ? defaultBackup : DEFAULT_ASAR_PATH;
  assert.equal(fs.existsSync(cleanFixtureSource), true, '需存在本机 Antigravity app.asar 供副本测试');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-e2e-'));
  const copyAsar = path.join(tmpDir, 'app.asar');
  const copyBackup = `${copyAsar}${BACKUP_SUFFIX}`;

  try {
    fs.copyFileSync(cleanFixtureSource, copyAsar);
    const origSha256 = sha256File(copyAsar);
    const origPkgBytes = readAsarFile(copyAsar, 'package.json');

    // 1. 首次安装
    const res1 = installPatch({ asarPath: copyAsar, skipProcessCheck: true });
    assert.equal(fs.existsSync(copyBackup), true);
    assert.equal(res1.trayPatched, true);
    assert.equal(res1.mainPatched, true);
    assert.equal(res1.menuPatched, true);
    assert.equal(res1.updatedCount, 4);
    assert.equal(getPatchStatus(copyAsar).patched, true);

    // 校验内联补丁、主进程托盘/菜单补丁与未修改文件均完整无损
    assert.deepEqual(readAsarFile(copyAsar, 'package.json'), origPkgBytes);
    const patchedPreloadContent = readAsarFile(copyAsar, 'dist/preload.js').toString('utf8');
    assert.ok(patchedPreloadContent.includes('防止休眠'));
    assert.ok(patchedPreloadContent.includes('installZhCnOverlay'));
    assert.doesNotMatch(patchedPreloadContent, /require\s*\(\s*['"]\./);

    const patchedMainContent = readAsarFile(copyAsar, 'dist/main.js').toString('utf8');
    assert.ok(patchedMainContent.includes("label: '当前无运行中的智能体'"));
    assert.ok(patchedMainContent.includes('label: `打开 ${electron_1.app.getName()}`'));
    assert.ok(patchedMainContent.includes("label: '退出'"));

    const patchedMenuContent = readAsarFile(copyAsar, 'dist/menu.js').toString('utf8');
    assert.ok(patchedMenuContent.includes("label: '新建窗口'"));
    assert.ok(patchedMenuContent.includes("label: '文档'"));
    assert.ok(patchedMenuContent.includes("label: '连接到 WSL'"));
    assert.ok(patchedMenuContent.includes("label: '在本地重新打开'"));
    // 确保菜单查找键未被破坏
    assert.ok(patchedMenuContent.includes("addItemToSubmenu(menu, 'File', 0,"));
    assert.ok(patchedMenuContent.includes("item.label === 'View'"));
    assert.ok(patchedMenuContent.includes("addItemToSubmenu(menu, 'Help', 0,"));

    assert.equal(buildPatchedMain('no match').matched, false);
    assert.equal(buildPatchedMenu('no match').matched, false);

    // 校验 unpacked 条目仍被完整保留
    const { header } = parseAsarHeader(copyAsar);
    assert.equal(
      header.files.node_modules.files['chrome-devtools-mcp'].files.LICENSE.unpacked,
      true
    );

    // 2. 幂等重复安装：preload.js 补丁标记仅出现一次
    installPatch({ asarPath: copyAsar, skipProcessCheck: true });
    const preloadAfterTwice = readAsarFile(copyAsar, 'dist/preload.js').toString('utf8');
    const markerCount = preloadAfterTwice.split(PATCH_MARKER_START).length - 1;
    assert.equal(markerCount, 1);

    // 3. 验证 buildPatchedPreload 与 buildPatchedTray 单元测试
    const twicePreload = buildPatchedPreload(buildPatchedPreload('console.log(1);'));
    assert.equal(twicePreload.split(PATCH_MARKER_START).length - 1, 1);
    assert.equal(buildPatchedTray('no match here').matched, false);

    // 4. 验证软件升级后（未打补丁且版本号变高）重装补丁自动刷新备份
    const bumpedPkg = JSON.stringify({ ...JSON.parse(origPkgBytes.toString('utf8')), version: '9.9.9' });
    rewriteAsar({
      sourcePath: copyBackup,
      targetPath: copyAsar,
      updates: { 'package.json': bumpedPkg },
    });
    const resUpgraded = installPatch({ asarPath: copyAsar, skipProcessCheck: true });
    assert.equal(resUpgraded.version, '9.9.9');

    // 5. 还原并重新测试从原版安装 -> 字节级无损还原
    restorePatch({ asarPath: copyAsar, skipProcessCheck: true });
    assert.equal(fs.existsSync(copyBackup), false);

    // 重新基于原始副本完整验证 restore SHA-256 100% 一致
    fs.copyFileSync(cleanFixtureSource, copyAsar);
    installPatch({ asarPath: copyAsar, skipProcessCheck: true });
    restorePatch({ asarPath: copyAsar, skipProcessCheck: true });
    assert.equal(sha256File(copyAsar), origSha256);
    assert.equal(getPatchStatus(copyAsar).patched, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('回归测试：manage.bat 必须为纯 ASCII + CRLF 且在真实 cmd.exe 中无报错退出', () => {
  const batPath = path.join(__dirname, 'manage.bat');
  const rawBuf = fs.readFileSync(batPath);
  const rawText = rawBuf.toString('binary');

  // 1. 校验无非 ASCII 字节，杜绝 cmd.exe GBK/UTF-8 编码冲突
  const nonAsciiBytes = [...rawBuf].filter((b) => b >= 128);
  assert.equal(nonAsciiBytes.length, 0, 'manage.bat 不应包含非 ASCII 字符');

  // 2. 校验所有换行均为 CRLF，不存在裸 LF 导致 goto 偏移错位
  const bareLf = rawText.replace(/\r\n/g, '').includes('\n');
  assert.equal(bareLf, false, 'manage.bat 必须全部使用 CRLF 换行');

  // 3. 在真实 cmd.exe 中依次输入 3（查看状态）和 0（退出），验证零报错且输出完整中文
  const res = spawnSync('cmd.exe', ['/d', '/c', batPath], {
    input: '3\r\n0\r\n',
    encoding: 'utf8',
    timeout: 8000,
  });
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
  assert.equal(res.status, 0, `cmd.exe 退出码异常: ${res.status}\n${combined}`);
  assert.doesNotMatch(combined, /不是内部或外部命令|not recognized as an internal/i);
  assert.match(combined, /Antigravity 2\.0 简体中文汉化补丁管理工具/);
  assert.match(combined, /补丁状态:/);
});

test('回归测试：注入到 preload.js 的补丁块必须在严格 Electron 沙盒（禁用本地 require）中生效', () => {
  const patched = buildPatchedPreload('const electron_1 = require("electron");\n');
  const startIdx = patched.indexOf(PATCH_MARKER_START);
  const endIdx = patched.indexOf(PATCH_MARKER_END);
  assert.notEqual(startIdx, -1, '未找到补丁起始标记');
  assert.notEqual(endIdx, -1, '未找到补丁结束标记');

  const patchBlock = patched.slice(startIdx, endIdx + PATCH_MARKER_END.length);
  // 严格 Electron sandbox preload 禁止任何本地相对路径 require
  assert.doesNotMatch(patchBlock, /require\s*\(\s*['"]\./, '沙盒 preload 补丁块严禁调用相对路径 require');

  const newConvText = createMockText('New Conversation');
  const autoText = createMockText('Automations');
  const codeText = createMockText('Settings');
  const rootEl = createMockElement('html', {
    children: [
      createMockElement('div', { children: [newConvText, autoText] }),
      createMockElement('code', { children: [codeText] }),
    ],
  });
  const fakeDoc = {
    readyState: 'complete',
    documentElement: rootEl,
    body: rootEl,
    addEventListener: () => {},
  };
  class FakeObserver {
    observe() {}
    disconnect() {}
  }

  // 构造严格沙盒上下文：仅允许 require('electron')，其余模块一律报错
  const sandboxGlobal = {
    document: fakeDoc,
    MutationObserver: FakeObserver,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    console,
  };
  sandboxGlobal.globalThis = sandboxGlobal;
  sandboxGlobal.require = (modName) => {
    if (modName === 'electron') {
      return {};
    }
    throw new Error(`module not found: ${modName}`);
  };

  vm.runInNewContext(patchBlock, sandboxGlobal, { filename: 'sandbox-preload.js' });

  assert.equal(newConvText.nodeValue, '新建对话');
  assert.equal(autoText.nodeValue, '自动化');
  assert.equal(codeText.nodeValue, 'Settings');
});

test('回归测试：覆盖设置各子页长文案（>180字符）、动态倒计时、欢迎语及菜单项', () => {
  // 1. 超过旧版 180 字符阈值的两条长说明必须命中，超长无关正文仍被拦截
  const creditDesc =
    "When toggled on, Antigravity will use your AI credits to fulfill model requests once you're out of model quota. Antigravity will always use your model quota first before using AI credits.";
  const customDesc =
    'The breakdown below shows token usage from customizations like rules, skills, and MCP. If a budget is exceeded, large rules are demoted to path pointers and large customizations are excluded automatically.';
  assert.ok(creditDesc.length > 180 && customDesc.length > 180);
  assert.equal(
    translateString(creditDesc),
    '开启后，当模型配额用尽时，Antigravity 将使用你的 AI 积分来满足模型请求。系统始终优先消耗模型配额，再使用 AI 积分。'
  );
  assert.equal(
    translateString(customDesc),
    '下方明细展示了规则、技能和 MCP 等自定义项的 Token 占用情况。若超出预算，较长的规则会降级为路径引用，大型自定义项将被自动排除。'
  );
  assert.equal(translateString('A'.repeat(350)), null);

  // 2. 动态插值文案：欢迎语、订阅方案、升级提示、配额倒计时、自定义明细展开
  assert.equal(
    translateString('Hey Alex, what should we build today?'),
    '你好，Alex，今天想做点什么？'
  );
  assert.equal(translateString('Your Plan: Google AI Pro'), '当前方案：Google AI Pro');
  assert.equal(
    translateString('You can upgrade to a Google AI Ultra plan to receive higher rate limits.'),
    '你可以升级到 Google AI Ultra 方案以获得更高的速率限制。'
  );
  assert.equal(
    translateString('You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.'),
    '你已使用部分每周配额，将在 6 天 22 小时后完全重置。'
  );
  assert.equal(
    translateString('You have used some of your 5-hour limit, it will fully refresh in 3 hours, 26 minutes.'),
    '你已使用部分 5 小时配额，将在 3 小时 26 分钟后完全重置。'
  );
  assert.equal(translateString('Show 3 breakdowns'), '查看 3 项明细');
  assert.equal(translateString('Show 21 breakdowns'), '查看 21 项明细');
  assert.equal(translateString('Hide 3 breakdowns'), '收起 3 项明细');

  // 3. 菜单与设置项 DOM 子树及 input placeholder 翻译
  const searchInput = createMockElement('input', {
    attrs: { placeholder: 'Search shortcuts...' },
  });
  const learnMoreLink = createMockElement('a', { children: [createMockText('Learn more.')] });
  const menuText = createMockText('Command Palette');
  const root = createMockElement('div', {
    children: [searchInput, learnMoreLink, menuText],
  });
  translateSubtree(root);
  assert.equal(searchInput.getAttribute('placeholder'), '搜索快捷键...');
  assert.equal(learnMoreLink.childNodes[0].nodeValue, '了解更多。');
  assert.equal(menuText.nodeValue, '命令面板');

  // 4. 补全快捷键、语音模式与模型配额页新增词条
  assert.equal(translateString('Move Conversation Up'), '上移对话');
  assert.equal(translateString('Move Conversation Down'), '下移对话');
  assert.equal(translateString('Previous Side Panel Tab'), '上一个侧边栏标签页');
  assert.equal(translateString('Next Side Panel Tab'), '下一个侧边栏标签页');
  assert.equal(translateString('Open Keyboard Shortcuts'), '打开快捷键设置');
  assert.equal(translateString('Open Settings'), '打开设置');
  assert.equal(translateString('Submit Prompt (Alternate to Enter)'), '提交提示词（替代回车键）');
  assert.equal(
    translateString('Enter always submits. This adds a second shortcut.'),
    '回车键始终用于提交。此项用于添加第二个快捷键。'
  );
  assert.equal(translateString('Jump to Previous Prompt'), '跳转到上一条提示词');
  assert.equal(translateString('Jump to Next Prompt'), '跳转到下一条提示词');
  assert.equal(translateString('Cancel Generation'), '取消生成');
  assert.equal(
    translateString('The voice used in Voice mode. Powered by Gemini Live.'),
    '语音模式下使用的声音，由 Gemini Live 提供支持。'
  );
  assert.equal(translateString('Microphone'), '麦克风');
  assert.equal(
    translateString('Input device for voice mode and dictation.'),
    '用于语音模式和语音听写的输入设备。'
  );
  assert.equal(translateString('System default'), '系统默认');
  assert.equal(
    translateString("How loud Antigravity's voice is."),
    '控制 Antigravity 语音播报的音量大小。'
  );
  assert.equal(translateString('Claude and GPT models'), 'Claude 与 GPT 模型');
  assert.equal(translateString('Gemini 4 Argon Weekly Limit'), 'Gemini 4 Argon 每周配额');

  // 5. 划词悬浮工具栏（Quote / Side Question）：即使位于聊天正文容器内的按钮也能汉化，同时正文段落仍受保护
  const proseParagraphText = createMockText('Save');
  const quoteBtnText = createMockText('Quote');
  const sideQBtnText = createMockText('Side Question');
  const proseContainer = createMockElement('div', {
    matchedSelectors: ['.markdown-body'],
    children: [
      createMockElement('p', { children: [proseParagraphText] }),
      createMockElement('button', { children: [quoteBtnText] }),
      createMockElement('button', { children: [sideQBtnText] }),
    ],
  });
  translateSubtree(proseContainer);
  assert.equal(proseParagraphText.nodeValue, 'Save');
  assert.equal(quoteBtnText.nodeValue, '引用');
  assert.equal(sideQBtnText.nodeValue, '侧边提问');
});

test('appLocator 自动检索路径、注册表解析、独立进程启动与 installPatch 自动拉起集成', () => {
  // 1. 路径归一化与可执行文件推导
  assert.equal(
    normalizeCandidateToAsar('"D:\\Apps\\Antigravity\\Antigravity.exe",0'),
    path.join('D:\\Apps\\Antigravity', 'resources', 'app.asar')
  );
  assert.equal(
    normalizeCandidateToAsar('E:\\Custom\\Antigravity'),
    path.join('E:\\Custom\\Antigravity', 'resources', 'app.asar')
  );
  assert.equal(
    resolveExecutablePath('D:\\Apps\\Antigravity\\resources\\app.asar'),
    path.join('D:\\Apps\\Antigravity', 'Antigravity.exe')
  );

  // 2. 注册表输出解析
  const sampleReg = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Antigravity',
    '    InstallLocation    REG_SZ    D:\\MyApps\\Antigravity',
    '    DisplayIcon    REG_SZ    "D:\\MyApps\\Antigravity\\Antigravity.exe",0',
    '    UninstallString    REG_SZ    "D:\\MyApps\\Antigravity\\Uninstall Antigravity.exe" /S',
  ].join('\r\n');
  const regPaths = parseRegistryInstallPaths(sampleReg);
  assert.equal(regPaths.length, 3);
  assert.equal(regPaths[0], path.join('D:\\MyApps\\Antigravity', 'resources', 'app.asar'));

  // 3. 真实本机自动检索应能定位到 Antigravity 2.0（而非 Antigravity IDE）
  const located = locateAntigravityApp();
  assert.ok(located, '本机应能自动检索到 Antigravity 2.0 安装路径');
  assert.ok(fs.existsSync(located.asarPath));
  assert.ok(located.exePath.endsWith('Antigravity.exe'));
  assert.doesNotMatch(located.exePath, /Antigravity IDE\.exe$/i);

  // 4. launchAntigravity 以 detached + unref 方式启动，缺失 exe 时明确报错
  let spawnArgs = null;
  let unrefCalled = false;
  const launched = launchAntigravity('D:\\Apps\\Antigravity\\resources\\app.asar', {
    existsFn: () => true,
    spawnFn: (exe, args, opts) => {
      spawnArgs = { exe, args, opts };
      return {
        pid: 4242,
        unref: () => {
          unrefCalled = true;
        },
      };
    },
  });
  assert.equal(launched.pid, 4242);
  assert.equal(spawnArgs.exe, path.join('D:\\Apps\\Antigravity', 'Antigravity.exe'));
  assert.equal(spawnArgs.opts.detached, true);
  assert.equal(unrefCalled, true);
  assert.throws(
    () => launchAntigravity('D:\\Missing\\resources\\app.asar', { existsFn: () => false }),
    /未找到 Antigravity 可执行文件/
  );

  // 5. 端到端副本验证：省略 asarPath 时通过 locateFn 自动定位，并在 autoLaunch: true 时触发启动
  const defaultBackup = `${DEFAULT_ASAR_PATH}${BACKUP_SUFFIX}`;
  const cleanFixtureSource = fs.existsSync(defaultBackup) ? defaultBackup : DEFAULT_ASAR_PATH;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-launch-'));
  const copyAsar = path.join(tmpDir, 'resources', 'app.asar');
  try {
    fs.mkdirSync(path.dirname(copyAsar), { recursive: true });
    fs.copyFileSync(cleanFixtureSource, copyAsar);
    let launchedTarget = null;
    const res = installPatch({
      skipProcessCheck: true,
      autoLaunch: true,
      locateFn: () => ({ asarPath: copyAsar, exePath: resolveExecutablePath(copyAsar), source: 'mock' }),
      launchFn: (targetAsar) => {
        launchedTarget = targetAsar;
        return { exePath: resolveExecutablePath(targetAsar), pid: 9999 };
      },
    });
    assert.equal(res.asarPath, copyAsar);
    assert.equal(launchedTarget, copyAsar);
    assert.equal(res.launchedExePath, resolveExecutablePath(copyAsar));
    assert.equal(
      resolveTargetAsarPath(undefined, () => ({ asarPath: copyAsar })),
      copyAsar
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});




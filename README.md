# Antigravity 中文汉化补丁（Google 反重力汉化）

**Google Antigravity 2.0（Google 反重力）Windows 桌面客户端简体中文汉化补丁**。支持一键安装/更新、自动备份原版、软件升级后无损重建，以及随时一键还原官方原版。

> 关键词：Google Antigravity 汉化、Google 反重力汉化、Antigravity 2.0 中文、Antigravity 中文补丁、Antigravity zh-CN

## 功能特性

- **全面覆盖常用界面**：涵盖顶部菜单栏、左侧主边栏、首页提示与欢迎语、设置页（常规、应用程序、外观、快捷键、通知、模型与用量、浏览器、项目设置）以及右下角系统托盘菜单与 WSL 菜单项。
- **零第三方依赖**：纯 Node.js 标准库实现 Electron ASAR 解析、SHA-256 分块完整性校验与重写，无需安装额外 npm 包。
- **严格保护聊天与代码区**：渲染层通过 `MutationObserver` 增量替换安全 UI 文本节点，显式跳过 `<code>`、`<pre>`、`<textarea>`、`<input>`、`.markdown-body`、`.prose`、`.monaco-editor` 等受保护区域，不破坏 React 节点结构，也不污染代码与聊天正文。
- **自动检索与一键启停体验**：自动按「常见目录 → Windows 注册表 → 快捷方式 → 本地盘符浅层目录」检索本机 Antigravity 2.0 路径（自动排除 Antigravity IDE），安装补丁完成后自动重新打开软件。
- **自动备份与一键还原**：首次安装自动备份原版 `app.asar` 为 `app.asar.orig.bak`；支持检测进程占用、JS 语法预检与字节级无损还原。
- **兼容软件自动更新**：若 Antigravity 自动升级为新版，重新运行安装会自动基于新版刷新原始备份并注入补丁。

## 环境要求

- 操作系统：Windows（自动检索本机 Antigravity 2.0 安装路径，也支持通过 `--asar` 手动指定）
- 运行环境：Node.js 18 及以上版本

## 快速使用

### 方式一：交互式一键安装（推荐）

1. 下载本仓库（点击 `Code` -> `Download ZIP` 并解压，或使用 `git clone`）。
2. **彻底退出 Antigravity**（注意右键点击任务栏右下角系统托盘图标并选择退出）。
3. 双击运行 `manage.bat`，在菜单中输入对应编号并回车：
   - `[1]` 自动检索并安装 / 更新简体中文汉化补丁（完成后自动打开软件）
   - `[2]` 一键还原官方原版
   - `[3]` 查看当前补丁状态
   - `[0]` 退出
4. 选择 `[1]` 安装完成后会自动重新打开 Antigravity 并呈现简体中文界面。

### 方式二：命令行使用

```bash
# 查看当前补丁状态（自动检索路径）
node patcher.js status

# 自动检索路径、安装/更新汉化补丁并在完成后自动打开软件
node patcher.js install

# 仅安装补丁，完成后不自动打开软件
node patcher.js install --no-launch

# 无损还原官方原版
node patcher.js restore

# 若需指定特定路径，可通过 --asar 手动覆盖
node patcher.js install --asar "D:\Path\To\antigravity\resources\app.asar"
```

## 项目文件说明

| 文件 | 说明 |
| --- | --- |
| `manage.bat` | Windows 交互式启动脚本（纯 ASCII + CRLF，避免 cmd 乱码） |
| `patcher.js` | 主控程序，负责进程占用检测、原版备份、补丁注入、语法校验与无损还原 |
| `appLocator.js` | Antigravity 2.0 安装路径多级自动检索与独立进程启动模块 |
| `asarCodec.js` | 纯 Node.js Electron ASAR 头部解析、SHA-256 分块校验与重打包模块 |
| `zhInjector.js` | 渲染层 DOM 汉化引擎与零 `require` 沙盒内联打包器 |
| `zhDict.js` | 简体中文精确词典（`EXACT_MAP`）与动态文案正则规则（`REGEX_RULES`） |
| `patcher.test.js` | 自动化测试套件（词典、DOM 保护、沙盒注入与 ASAR 副本端到端测试） |

## 补充词条与运行测试

如果你在客户端中发现了新的未汉化文案，可以直接在 `zhDict.js` 的 `EXACT_MAP`（精确匹配）或 `REGEX_RULES`（含变量/数字的动态文案）中补充条目，然后运行测试并重新执行安装：

```bash
node --test patcher.test.js
```

> 说明：`patcher.test.js` 中的端到端副本测试会以只读方式复制本机 `app.asar` 到系统临时目录进行验证，不会修改本机已安装的软件本体。

## 免责声明

本项目为社区维护的非官方第三方汉化补丁，与 Google 无任何隶属关系。补丁仅在本地修改客户端界面显示文案，不包含任何联网上报逻辑，并保留原始备份文件以便随时一键还原。

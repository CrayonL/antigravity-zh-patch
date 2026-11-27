# Antigravity 中文汉化补丁（Google 反重力汉化）

**Google Antigravity 2.0（Google 反重力）Windows 桌面客户端简体中文汉化补丁**。

> 关键词：Google Antigravity 汉化、Google 反重力汉化、Antigravity 2.0 中文、Antigravity 中文补丁、Antigravity zh-CN

## 核心功能

- **全面界面汉化**：覆盖顶部菜单、左侧边栏及右键菜单、对话操作与提示弹窗、设置各子页以及系统托盘菜单，不修改代码区与聊天正文内容。
- **自动定位与重启**：自动检索本机 Antigravity 2.0 安装路径（也支持 `--asar` 手动指定），安装完成后自动重新打开软件。
- **原版备份与一键还原**：首次安装自动备份原版 `app.asar`，支持随时一键无损恢复官方原版，并在软件自动升级后基于新版重新注入。
- **零外部依赖**：仅依赖本地 Node.js 标准库运行，无需安装第三方包。

## 环境要求

- 操作系统：Windows
- 运行环境：Node.js 18 及以上版本

## 快速使用

### 方式一：交互式一键安装（推荐）

1. 前往 [Releases](https://github.com/CrayonL/antigravity-zh-patch/releases) 下载最新版本压缩包并解压（或克隆本仓库）。
2. **彻底退出 Antigravity**（关闭窗口并右键退出任务栏右下角系统托盘图标）。
3. 双击运行 `manage.bat`，按菜单提示输入编号操作：
   - `[1]` 安装 / 更新简体中文汉化补丁（完成后自动打开软件）
   - `[2]` 一键还原官方原版
   - `[3]` 查看当前补丁状态
   - `[0]` 退出

### 方式二：命令行使用

```bash
# 安装或更新补丁（完成后自动打开软件）
node patcher.js install

# 仅安装补丁，不自动打开软件
node patcher.js install --no-launch

# 查看当前补丁状态
node patcher.js status

# 一键还原官方原版
node patcher.js restore

# 手动指定非默认路径
node patcher.js install --asar "D:\Path\To\antigravity\resources\app.asar"
```

## 自定义词条与测试

如需自行增改界面译文，可直接编辑 `zhDict.js` 后运行测试并重新安装：

```bash
node --test patcher.test.js
```

## 版本更新记录

各版本的更新内容、词典扩充与兼容性修复说明，请前往 [Releases](https://github.com/CrayonL/antigravity-zh-patch/releases) 查看。

## 免责声明

本项目为社区维护的非官方第三方汉化补丁，与 Google 无任何隶属关系。补丁仅在本地替换客户端界面显示文案，不包含任何联网上报逻辑，并保留原始备份以便随时还原。

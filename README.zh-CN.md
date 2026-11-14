# dsh-bg-control

**让 DeepSeek Harness（DSH）在后台受控操作 Windows 本地软件。**

`dsh-bg-control` 是面向 **DSH `0.2.2-rc.1`** 的原生 Cordis 插件，向 Agent 提供 7 个明确的后台控制工具：查询窗口状态、探测后台通道、隐藏/最小化启动、静默执行 CLI、调用 COM/IPC、发送定向窗口消息，以及管理异步任务。

> **状态：**实验性项目，仅支持 Windows x64。已在 DSH `0.2.2-rc.1`（桌面端）+ `0.2.2-rc.3`（npm next CLI）+ DSH 内置 Node `24.21.0` 上验证。它是 DSH 插件，不是 PI-Desktop 插件。

---

## 这解决什么问题

很多本地软件没有可直接调用的 API。直接做全局键鼠模拟会抢焦点、干扰用户正在输入的内容，也容易点错窗口。

这个插件选择更窄、更可控的路径：

- 优先使用无界面的 CLI、COM、Named Pipe 或 localhost HTTP；
- 必须出现窗口时，只允许 `hidden` / `minimized`；
- 每次操作前检查真实前台窗口、光标悬停窗口和用户输入空闲时间；
- 拒绝浏览器和 DSH 宿主窗口，不接管用户当前浏览器；
- 长任务进入异步队列，结果以文件、日志和 SHA-256 校验文件交付。

目标是桌面端的后台软件调度，不是网页版的替代品。

---

## 7 个工具

| 工具 | 风险 | Plan Mode | 功能 |
|---|---|---|---|
| `bg_query_state` | low | 只读 | 查询前台 HWND/PID/进程、光标悬停目标、用户空闲时间、同类窗口实例。 |
| `bg_verify` | low | 只读 | 按优先级探测 CLI、COM、Pipe、localhost HTTP、CLI harness、定向窗口消息。 |
| `bg_launch` | medium | 写操作 | 只以隐藏/最小化方式启动程序，递归记录 `ownedPids` 进程树。 |
| `bg_cli` | medium | 写操作 | `windowsHide=true` 执行 CLI，带焦点守卫、可见窗拦截、输出上限和工件哈希。 |
| `bg_ipc` | high | 写操作 | 调用白名单 COM（默认仅 `Scripting.Dictionary`）、Named Pipe 或本地 HTTP。 |
| `bg_window_msg` | medium | 写操作 | 向真实核验过的非浏览器/非宿主 HWND+PID 发送定向 `PostMessage`。 |
| `bg_job_control` | low/medium | 仅 `list`/`inspect` | 列出、查看、暂停、恢复、取消、关闭、检查点。 |

`bg_job_control(action="close")` 只清理插件自己启动的进程树，不碰外部 `targetPid`。

---

## 安全不变量

### 硬焦点守卫

使用 Win32 `GetForegroundWindow`、`GetAncestor(GA_ROOTOWNER)`、`WindowFromPoint`、`GetLastInputInfo`。如果目标窗口在前台，或光标停在目标窗口上且用户近期有输入，工具内部直接返回 `status: "human_intervened"`，不会抢焦点。

`bg_launch` 只接受 `hidden` / `minimized`，没有模型可填的 `normal` / `allowNormalWindow` / `userPermittedNormal` 开关。

### 浏览器与宿主边界

`bg_window_msg` 每次都用真实操作系统身份核验：

`HWND -> GetWindowThreadProcessId -> ProcessName`

不信任调用方传入的 `processName`。Edge、WebView2、Chrome、Firefox、Electron、DeepSeek Harness、DSH 等浏览器/宿主进程一律拒绝。浏览器点击、DOM 和标签页自动化不在本插件范围内，应使用 DSH 的隔离浏览器/CDP 工具。

### 进程生命周期

- 递归追踪启动器及全部子孙 `ownedPids`；
- `pause` 使用作业执行门控，不调用 `NtSuspendProcess`；
- `resume` / `cancel` / `close` / shutdown 终止前都会尝试恢复；
- `closeCompletedLaunchOnShutdown` 默认 `false`，需要显式 `bg_job_control(action="close")` 清理。

### COM 默认拒绝

默认白名单只有：

```json
["Scripting.Dictionary"]
```

对于 UI COM，只有确认“新 HWND + 新 PID”才允许隐藏、调用和退出。现有实例、身份不确定、Hwnd/PID 不完整时一律 fail-closed；绝不修改用户现有实例的 `Visible` 或调用 `Quit()`。

### 工件与路径

- `taskId` 拒绝 `.`、`..`、路径分隔符、尾点（`a.`）以及 Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`）。
- `outputName` 同样检查，并在 workspace 下做 containment。
- 写盘前拒绝 junction/symlink 重解析点逃逸。
- 交付 `result_<taskId>.json`、`result_<taskId>.sha256`、`logs/<taskId>.log`、`output/<taskId>/...`。
- 解析不到 DSH workspace 时直接报错，不静默写到别的目录。

---

## 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64 |
| 宿主 | DeepSeek Harness `0.2.2-rc.1` 桌面端 / `0.2.2-rc.3` npm next CLI |
| DSH 包范围 | `>=0.2.2-rc.1 <0.2.3-0` |
| Node | DSH 内置 Node（已验证 `24.21.0`）；`engines.node >=22` |
| Cordis | `@deepseek-ai/cordis` `~4.1.0`，由 DSH 提供 |

已实测 DSH `0.2.2-rc.1`（桌面端）和 `0.2.2-rc.3`（npm next CLI）。不要直接假定 0.2.1、后续 0.2.2 正式版或 0.3.x 兼容。

---

## 安装

### 方式 A：DSH Plugins 页面

1. 打开 DeepSeek Harness `0.2.2-rc.1`。
2. 进入 **Settings → Plugins**。
3. 选择本地 `.tgz` 包或源码目录安装。
4. 如 DSH 提示重载，确认即可。

`desktop` profile 由 Electron 桌面端管理，请通过 Plugins 页面安装；CLI 可能拒绝 `--profile desktop`。

### 方式 B：打包后用 DSH CLI 安装到非 desktop profile

```powershell
git clone https://github.com/ccwd-123/dsh-bg-control.git
cd dsh-bg-control
npm pack

$DSH_CLI = Join-Path $env:DSH_INSTALL_DIR "resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $DSH_CLI plugin --profile <profile-name> add ".\dsh-bg-control-0.2.0.tgz"
node $DSH_CLI --profile <profile-name> --dump-config
```

配置树中应出现：

```yaml
# == dsh-bg-control
- id: dsh-bg-control
  name: dsh-bg-control
```

更多细节见 [INSTALL.md](INSTALL.md)。

---

## 目录结构

```text
package.json
cordis.patch.yml
lib/
  index.js            Cordis 入口：name、inject、Config、apply(ctx, config)
  dsh-host.js         运行时解析 DSH 宿主包
  tools.js            7 个 defineTool 描述与执行器
  focus-guard.js      前台/光标/空闲冲突检查
  win32-bridge.js     Win32、COM、Pipe、HTTP 适配
  job-queue.js        DSH jobs 与生命周期
  artifacts.js        workspace、清理、SHA-256 工件
tests/
  run-tests.js        22 项 Windows/单元集成测试
verification/
  run-*.js            可选的手动探针
docs/
  COMPATIBILITY.md
  VERIFICATION.md
```

---

## 开发与测试

```powershell
# Windows，Node >= 22
npm test
```

测试覆盖 7 个工具描述、焦点守卫、浏览器真实身份、进程树归属、COM Cases A–G、路径穿越/保留名、本地 HTTP 超时与重定向、Plan Mode/审批门控以及 bundle 结构。

`verification/` 下的手动探针会接触真实 Windows 软件，不在 CI 中运行。见 [verification/README.md](verification/README.md)。

---

## 已知限制

- 仅 Windows；
- 实际只验证 DSH `0.2.2-rc.1` / `0.2.2-rc.3`；
- 不提供浏览器点击/DOM 自动化；
- 不提供 UI 面板；
- 未在本机实跑真实 Excel/WPS UI COM；相关 ProgID 默认拒绝；
- 现代 UWP 存根（如新版 Notepad）可能返回 `unsupported_uwp`；
- `<25ms` 的极短 CLI 闪窗只能 best-effort 拦截；
- 不提供“直接修改用户已有窗口”的能力。

---

## 安全

这个插件可以启动和控制本地程序。启用前请审阅代码，保持默认白名单，不要把带此插件的 profile 暴露给不可信提示。见 [SECURITY.md](SECURITY.md)。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

---

## 声明

本项目与 DeepSeek 官方无隶属或背书关系。“DeepSeek Harness”和“DSH”归其各自项目/权利人所有。请在你自己控制的机器上使用。

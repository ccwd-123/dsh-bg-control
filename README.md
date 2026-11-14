# dsh-bg-control

**Language / 语言:** [English](README.md) | [简体中文](README.zh-CN.md)

**Windows background application control for DeepSeek Harness (DSH).**

`dsh-bg-control` is a native Cordis plugin for **DSH 0.2.2-rc.1** that gives an agent seven explicit tools for inspecting, launching, and driving local Windows applications without stealing the foreground UI.

> **Status:** experimental, Windows x64 only. Verified against DSH `0.2.2-rc.1` (desktop) and `0.2.2-rc.3` (npm `next` CLI) with the DSH embedded Node `24.21.0`. This is a DSH Cordis plugin, not a PI-Desktop plugin.

---

## Why this exists

Desktop agents often need to use a local application that has no API. Blind GUI automation is fragile and intrusive: it can move the mouse, steal focus, or interfere with the window the user is typing in.

This plugin takes a narrower approach:

- prefer a headless CLI, COM, named pipe, or localhost HTTP path;
- launch windows hidden or minimized when a window must exist;
- verify the real foreground/cursor state before acting;
- refuse browser and DSH host windows instead of taking over the user's current browser;
- keep long-running work in jobs and deliver files, logs, and SHA-256 sidecars.

The target use case is a local Windows desktop, not a web replacement.

---

## The seven tools

| Tool | Risk | Plan Mode | What it does |
|---|---|---|---|
| `bg_query_state` | low | read-only | Reports foreground HWND/PID/process, cursor hover target, user idle time, and visible instances. |
| `bg_verify` | low | read-only | Probes non-invasive background channels in priority order: CLI, COM, pipe, localhost HTTP, CLI harness, directed window message. |
| `bg_launch` | medium | mutation | Launches an executable **hidden** or **minimized** only, then tracks the full descendant process tree as `ownedPids`. |
| `bg_cli` | medium | mutation | Runs a CLI command with `windowsHide: true`, a focus guard, a visible-window kill guard, and capped output artifacts. |
| `bg_ipc` | high | mutation | Calls an allowlisted COM ProgID (default: only `Scripting.Dictionary`), a named pipe, or a localhost HTTP endpoint. |
| `bg_window_msg` | medium | mutation | Sends a directed Win32 `PostMessage` to a verified non-browser, non-host HWND/PID. |
| `bg_job_control` | low/medium | only `list`/`inspect` | Lists, inspects, pauses, resumes, cancels, closes, and checkpoints plugin-owned jobs. |

`bg_job_control(action="close")` closes only processes launched by this plugin. It never touches an external `targetPid`.

---

## Safety model

### Hard foreground focus guard

The guard uses Win32 `GetForegroundWindow`, `GetAncestor(GA_ROOTOWNER)`, `WindowFromPoint`, and `GetLastInputInfo`. A target that owns foreground focus, or is under the cursor while the user is active, is blocked inside the tool. The tool returns `status: "human_intervened"` instead of trying to “wait it out” or force focus.

`bg_launch` accepts only `hidden` or `minimized`. There is no model-facing `normal`, `allowNormalWindow`, or `userPermittedNormal` escape hatch.

### Browser and host boundary

`bg_window_msg` resolves the target's real OS process name on every call:

`HWND -> GetWindowThreadProcessId -> ProcessName`

The caller's `processName` is never trusted. Browser and host processes are refused, including Edge, WebView2, Chrome, Firefox, Electron, DeepSeek Harness, and DSH. Browser clicking and DOM automation are intentionally out of scope; use DSH's isolated browser/CDP tools for those tasks.

### Process lifecycle

- `ownedPids` is tracked recursively, not just the launcher PID.
- `pause` uses job-level execution gating; it does not call `NtSuspendProcess`.
- `resume`, `cancel`, `close`, and shutdown all attempt to resume before terminating.
- `closeCompletedLaunchOnShutdown` defaults to `false`; explicit `bg_job_control(action="close")` is required to clean up completed launches.

### COM fail-closed rules

The default `comAllowlist` is only:

```json
["Scripting.Dictionary"]
```

For UI-capable COM, the plugin requires a verified new HWND and a verified new PID. If `GetActiveObject` is uncertain, returns an existing instance, or the HWND/PID relationship is incomplete, the call fails closed. Existing user instances are never hidden or quit.

### Artifact and path safety

- `taskId` rejects `.`, `..`, separators, trailing dots (`a.`), and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`).
- `outputName` uses the same checks and containment under the workspace.
- Junction/symlink reparse escapes are rejected before writing.
- Artifacts are written as `result_<taskId>.json`, `result_<taskId>.sha256`, `logs/<taskId>.log`, and `output/<taskId>/...`.
- If the DSH workspace cannot be resolved, the tool does not silently fall back to an unrelated writable directory.

---

## Requirements

| Item | Requirement |
|---|---|
| OS | Windows 10/11, x64 |
| Host | DeepSeek Harness `0.2.2-rc.1` desktop / `0.2.2-rc.3` npm `next` CLI |
| DSH package range | `>=0.2.2-rc.1 <0.2.3-0` |
| Node | DSH embedded Node (`24.21.0` verified); `engines.node >=22` |
| Cordis | `@deepseek-ai/cordis` `~4.1.0` (provided by DSH) |

DSH `0.2.2-rc.1` desktop and `0.2.2-rc.3` npm `next` CLI have been verified. Do not assume 0.2.1, the eventual 0.2.2 stable build, or 0.3.x is compatible without testing.

---

## Install

### Option A — DSH Plugins page

1. Open DeepSeek Harness `0.2.2-rc.1`.
2. Go to **Settings → Plugins**.
3. Choose the local package generated below, or the source directory.
4. Reload the profile if DSH asks.

The `desktop` profile is managed by the Electron app. Use the Plugins page for it; the CLI may reject `--profile desktop`.

### Option B — Build a tarball and use the DSH CLI on a non-desktop profile

```powershell
git clone https://github.com/ccwd-123/dsh-bg-control.git
cd dsh-bg-control
npm pack

$DSH_CLI = Join-Path $env:DSH_INSTALL_DIR "resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $DSH_CLI plugin --profile <profile-name> add ".\dsh-bg-control-0.2.0.tgz"
node $DSH_CLI --profile <profile-name> --dump-config
```

The resulting config tree should contain:

```yaml
# == dsh-bg-control
- id: dsh-bg-control
  name: dsh-bg-control
```

See [INSTALL.md](INSTALL.md) for more detail.

---

## Layout

```text
package.json
cordis.patch.yml
lib/
  index.js            Cordis entry: name, inject, Config, apply(ctx, config)
  dsh-host.js         Resolves DSH host packages at runtime
  tools.js            Seven defineTool descriptors and executors
  focus-guard.js      Foreground/cursor/idle conflict checks
  win32-bridge.js     Win32 + COM + pipe + HTTP adapters
  job-queue.js         DSH jobs integration and lifecycle
  artifacts.js        Workspace, sanitization, SHA-256 artifacts
tests/
  run-tests.js        22 Windows/unit integration tests
verification/
  run-*.js            Optional manual probes
docs/
  COMPATIBILITY.md
  VERIFICATION.md
```

---

## Development and tests

```powershell
# Windows, Node >= 22
npm test
```

The suite covers the seven tool descriptors, focus guard, browser identity checks, process-tree ownership, COM Cases A–G, path traversal/reserved names, localhost HTTP timeout/redirect handling, plan-mode/approval gates, and package/bundle shape.

The manual probes in `verification/` are optional; they touch real Windows apps and are not run in CI. See [verification/README.md](verification/README.md).

---

## Known limitations

- **Windows only.** The bundle declares `win32`.
- **DSH 0.2.2-rc.1 / rc.3 only in practice.** The package range is intentionally narrow; rc.3 was tested as the npm `next` CLI/headless host, not the desktop app.
- **No browser click/DOM automation.** Browser windows are refused; use DSH browser tooling.
- **No UI panel.** This is a host-tool plugin, not a PI-Desktop-style renderer.
- **Real Excel/WPS UI COM was not executed** on the verification machine. Those ProgIDs are denied by default; do not treat the allowlist as a guarantee that every UI COM app is safely automatable.
- **UWP stubs** such as modern Notepad may return `unsupported_uwp` because there is no controllable Win32 HWND.
- **Sub-25 ms transient CLI windows** are best-effort; user-mode polling cannot guarantee capture before the desktop composites a frame.
- **Direct edits to an existing user window** are intentionally not offered.

---

## Security

This plugin can launch and control local applications. Review the code before enabling it, keep the default allowlists, and do not expose a profile with this plugin to untrusted prompts. See [SECURITY.md](SECURITY.md).

---

## License

MIT. See [LICENSE](LICENSE).

---

## Disclaimer

This project is not affiliated with or endorsed by DeepSeek. “DeepSeek Harness” and “DSH” are names of their respective project/owner. Use at your own risk on a machine you control.

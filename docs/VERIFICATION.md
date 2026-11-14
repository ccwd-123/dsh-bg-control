# Verification summary

This document summarizes the checks performed for the `0.2.0` release. The machine-specific probe JSON (live PIDs, window titles, and local paths) is intentionally not committed.

## Environment

- Windows 11 x64
- DeepSeek Harness `0.2.2-rc.1` desktop
- DSH embedded Node `24.21.0`
- Isolated `DSH_HOME` for install/boot tests
- The existing user `desktop` profile was not modified

## Package and install

Command shape:

```powershell
node $DSH_CLI plugin --profile review add ".\dsh-bg-control-0.2.0.tgz"
node $DSH_CLI --profile review --dump-config
```

Results:

- plugin manager exit code `0`;
- profile dependency `dsh-bg-control` created;
- `dsh.profile.bundles` contains `dsh-bg-control`;
- `--dump-config` contains `id: dsh-bg-control` and `name: dsh-bg-control`;
- package tarball contains no `node_modules`, `.git`, `.env`, or symlinks;
- a second clean profile installed from the same tarball successfully.

## Profile boot

Using the DSH host's `runProfile`:

- plugin entry: `include:dsh-bg-control`;
- `disabled: false`;
- `fiberState: 2` (active);
- no failed entries;
- seven `bg_*` tools present in the DSH ToolRegistry.

## Real tool calls

Through the booted DSH `ToolRegistry`:

| Tool | Observed result |
|---|---|
| `bg_query_state` | `completed`; foreground/cursor/idle state returned |
| `bg_verify` | `completed`; CLI and COM channels available |
| `bg_job_control` (`list`) | `completed`; empty initial queue |
| `bg_cli` | `completed`; `exitCode=0`; output artifact created |
| `bg_launch` | `completed`; `charmap.exe` hidden; `visible=false`, `isForeground=false`; Chinese title preserved |
| `bg_window_msg` | `completed`; real `verifiedProcessName="charmap"`; directed `WM_NULL` |
| `bg_job_control` (`close`) | `closed`; owned `charmap` process tree terminated; no external PID touched |
| `bg_ipc` (COM) | `completed`; `Scripting.Dictionary`; `createdNew=true`, `inprocWindowless=true`, `invoked=true` |

The test used a temporary task workspace. Generated `result_*.json`, `logs/`, and `output/` files were removed after the checks. No `charmap` process remained.

## Supplemental: DSH `0.2.2-rc.3`

A higher prerelease was tested after the initial release, using the npm `next` CLI/headless host:

- installed `@deepseek-ai/dsh@0.2.2-rc.3` into an isolated host directory and used the DSH embedded Node `24.21.0`;
- installed `dsh-bg-control-0.2.0.tgz` into an isolated `DSH_HOME` profile `compat-rc3`;
- `--dump-config` contains the `dsh-bg-control` entry;
- profile boot: `fiberState=2`, `failedEntries=[]`;
- all seven `bg_*` tools present in the ToolRegistry;
- real calls: `bg_query_state` and `bg_verify` completed; `bg_cli` exit code `0`; `bg_launch` started `charmap.exe` with `visible=false` / `isForeground=false`; `bg_window_msg` reported `verifiedProcessName="charmap"`; `bg_job_control(close)` returned `closed`; `bg_ipc` COM returned `createdNew=true`, `inprocWindowless=true`, `invoked=true`;
- no `charmap` process remained.

This was a CLI/headless host test, not the DSH `0.2.2-rc.3` desktop application. The desktop build remains `0.2.2-rc.1`.

## Unit/integration suite

```powershell
npm test
```

Result: `22/22` tests passed, covering:

- seven tool descriptors and DSH `defineTool` shape;
- hard focus guard across foreground/cursor/idle/multi-instance cases;
- hidden launch and descendant `ownedPids`;
- browser identity spoofing and host refusal;
- process-tree close/cancel/pause/resume behavior;
- COM Cases A–G and fail-closed existing-instance handling;
- localhost HTTP timeout and external redirect rejection;
- task ID/output name traversal, trailing dots, and Windows reserved names;
- junction/symlink escape rejection;
- DSH `Config`, Plan Mode, and approval gates;
- package/bundle shape and absence of PI runtime globals.

## Not part of these results

- No online model conversation turn was executed; the tools were called through the real DSH ToolRegistry.
- Real Microsoft Excel/WPS UI COM was not executed. Those ProgIDs remain denied by default.
- Browser clicking/DOM automation is not provided.
- The verification was run on one Windows machine; results are evidence, not a guarantee for every application.

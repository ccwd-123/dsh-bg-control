# Changelog

## 0.2.0 — 2026-11-14

Initial public DSH Cordis release.

- Replaced the PI-Desktop packaging model with a DSH bundle:
  `package.json` + `dsh.bundle.patch` + `cordis.patch.yml` + ESM Cordis entry.
- Added seven tools:
  `bg_query_state`, `bg_verify`, `bg_launch`, `bg_cli`, `bg_ipc`,
  `bg_window_msg`, `bg_job_control`.
- Added a hard foreground focus guard with real `HWND`/PID/process and idle-time checks.
- Added hidden/minimized launch and recursive `ownedPids` lifecycle tracking.
- Added browser and DSH host process refusal based on real `HWND -> PID -> ProcessName` resolution.
- Added fail-closed COM isolation; default allowlist is only `Scripting.Dictionary`.
- Added localhost-only HTTP IPC with timeout and redirect rejection.
- Added workspace-bound artifacts with SHA-256 sidecars, task ID sanitization, and junction/symlink containment.
- Added DSH jobs integration, plan-mode gating, and approval checks.
- Verified against DSH `0.2.2-rc.1` with the DSH embedded Node `24.21.0`.
- Added supplemental verification against DSH `0.2.2-rc.3` (npm `next` CLI/headless) with the same tarball.
- Test suite: 22/22 passing.

# Contributing

Thanks for considering a contribution. This project controls real Windows applications, so safety invariants matter more than feature breadth.

## Before you start

- Use Windows 10/11 x64.
- Use Node `>=22`; DSH `0.2.2-rc.1` is the reference host.
- Read `README.md` and `lib/focus-guard.js`, `lib/tools.js`, and `lib/win32-bridge.js` before changing behavior.
- Do not weaken the focus guard, browser boundary, COM fail-closed rules, path containment, or process-ownership rules to make a test pass.

## Development flow

```powershell
git clone https://github.com/ccwd-123/dsh-bg-control.git
cd dsh-bg-control
npm test
```

The test suite must remain green:

```text
22/22 tests passed
```

For a change that affects the DSH host integration, also test a real DSH profile in an isolated `DSH_HOME`. See `INSTALL.md` and `docs/COMPATIBILITY.md`.

## What to include in a pull request

- A short description of the user-visible behavior.
- Which boundary is affected: focus, browser/host, process lifecycle, COM, path/artifacts, plan mode/approval, or packaging.
- A regression test for every fixed bypass or edge case.
- Real command output for Windows-only behavior, with local usernames, PIDs, and window titles removed.
- Any known limitation that remains.

## Things not to commit

- `node_modules/`
- `dist/` and `*.tgz`
- Local `logs/`, `output/`, `result_*.json`, `result_*.sha256`
- Raw probe JSON containing live PIDs, window titles, or personal paths
- `.env`, API keys, tokens, credentials, or screenshots containing them
- Local absolute paths such as `C:\Users\<name>` or `D:\...` in documentation or test scripts

## Safety rules for new tools

A new tool must:

1. declare its risk and whether it is plan-safe;
2. use the focus guard before any UI-affecting operation;
3. reject browser and DSH host targets;
4. avoid global input simulation (`SendInput`, `PyAutoGUI`, global keyboard/mouse hooks);
5. bind to a verified PID/HWND, not to a model-supplied process name alone;
6. keep stdout/stderr/log output bounded;
7. write artifacts under the resolved workspace with sanitized task IDs;
8. clean up only its own `ownedPids` on close.

## Reporting security issues

Do not open a public issue for a bypass. Use the private advisory flow in `SECURITY.md`.

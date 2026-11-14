# Manual verification probes

These scripts are optional Windows-only probes. They are **not** part of `npm test` and are not run in CI because they touch real desktop applications, windows, COM, and browser processes.

## What is here

| Script | Purpose |
|---|---|
| `run-probes.js` | Query, hidden launch, CLI guard, shutdown cleanup |
| `run-targeted-probes.js` | Task ID traversal, junction escape, descendant process tree, DSH session isolation |
| `run-browser-boundary-probes.js` | Real browser process-name spoofing and refusal |
| `run-launch-lifecycle-probes.js` | Completed launch close and shutdown policy |
| `run-com-isolation-probes.js` | COM Cases A–G and allowlist refusal |
| `run-dsh-host-e2e.js` | Optional full DSH install/boot/tool-call harness |

## Requirements

- Windows 10/11 x64
- Node >= 22
- A local DSH `0.2.2-rc.1` installation for `run-dsh-host-e2e.js`
- A real browser window for the browser-boundary probe
- A real `charmap.exe` for the launch/window probes

## Running a probe

```powershell
node verification/run-probes.js
```

The host E2E probe needs env vars because it must locate your local DSH installation and, optionally, an old PI-Desktop plugin for the baseline comparison:

```powershell
$env:DSH_CLI = Join-Path $env:DSH_INSTALL_DIR "resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:DSH_ANCHOR = Join-Path $env:DSH_INSTALL_DIR "resources\app\dsh\package.json"
$env:DSH_DESKTOP_PROFILE = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
# Optional: only for reproducing the old PI plugin failure
$env:OLD_PI_PLUGIN_DIR = "C:\path\to\old-pi-plugin"
node verification/run-dsh-host-e2e.js
```

Use an isolated `DSH_HOME` for install tests. Do not modify the user's live `desktop` profile.

## Data handling

The probes can print local paths, live PIDs, and window titles. Do not commit their generated JSON files. `verification/*-results.json` is intentionally ignored by `.gitignore`.

## Results

See `docs/VERIFICATION.md` for the release-level summary. A probe passing on one machine is evidence for that machine, not a universal compatibility guarantee.

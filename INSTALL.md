# Installation

This guide targets **DeepSeek Harness (DSH) `0.2.2-rc.1`** on Windows x64.

## 1. Build the package

```powershell
git clone https://github.com/ccwd-123/dsh-bg-control.git
cd dsh-bg-control
npm pack
```

The tarball name should be `dsh-bg-control-0.2.0.tgz`.

## 2. Install through the DSH desktop UI (recommended)

1. Open DeepSeek Harness `0.2.2-rc.1`.
2. Open **Settings → Plugins**.
3. Choose **install from local package**, then select `dsh-bg-control-0.2.0.tgz`.
4. Reload the profile if DSH asks.

The `desktop` profile is owned by the Electron app. Do not run `dsh plugin --profile desktop ...` from a shell; use the UI for that profile.

## 3. Install through the DSH CLI on a non-desktop profile

Set the CLI path for your installation. The example below assumes `DSH_INSTALL_DIR` points at the directory containing `resources\app\dsh`.

```powershell
$DSH_CLI = Join-Path $env:DSH_INSTALL_DIR "resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"

node $DSH_CLI plugin --profile <profile-name> add ".\dsh-bg-control-0.2.0.tgz"
node $DSH_CLI --profile <profile-name> --dump-config
```

Expected config fragment:

```yaml
# == dsh-bg-control
- id: dsh-bg-control
  name: dsh-bg-control
```

For an isolated end-to-end test, use a temporary `DSH_HOME`:

```powershell
$env:DSH_HOME = Join-Path $env:TEMP "dsh-bg-control-test"
node $DSH_CLI plugin --profile review add ".\dsh-bg-control-0.2.0.tgz"
node $DSH_CLI --profile review --dump-config
```

## 4. Verify tools after boot

The plugin registers these tools in the DSH ToolRegistry:

- `bg_query_state`
- `bg_verify`
- `bg_launch`
- `bg_cli`
- `bg_ipc`
- `bg_window_msg`
- `bg_job_control`

A quick smoke test from a booted DSH profile:

1. call `bg_query_state`;
2. call `bg_verify` with a known local program;
3. call `bg_job_control` with `action: "list"`.

For an isolated profile with no model credentials, the tool registry itself can be exercised; a model-driven conversation turn is a separate check.

## 5. Run the repository tests

```powershell
npm test
```

Expected: `22/22` tests pass on Windows.

## Version boundary

The package declares:

```json
"engines": {
  "node": ">=22",
  "dsh": ">=0.2.2-rc.1 <0.2.3-0"
}
```

Only DSH `0.2.2-rc.1` has been verified. Do not describe 0.2.1, a later 0.2.2 build, or 0.3.x as supported without running the same install/boot/tool-call checks against those versions.

## Troubleshooting

- `cannot resolve profile bundle "dsh-bg-control"`: the package is not a DSH bundle or the profile did not install it. Check `package.json` `dsh.bundle.patch`, `cordis.patch.yml`, and the profile `package.json`.
- Profile boot fails: check `--dump-config` and the DSH log for a missing peer package or a plugin load error.
- Tools do not appear: confirm the plugin entry is active and the profile was reloaded.
- `desktop` profile rejected by CLI: use the DSH Plugins UI for that profile.
- A live app window is refused: this is expected for browsers, DSH host windows, and existing UI COM instances. Use a headless/CLI path or DSH's browser tooling instead.

# Compatibility

## Verified matrix

| Host | Package | Node | Windows | Result |
|---|---|---|---|---|
| DeepSeek Harness `0.2.2-rc.1` | `dsh-bg-control` `0.2.0` | DSH embedded `24.21.0` | Windows 11 x64 | Install, profile boot, and seven tool calls verified |
| DeepSeek Harness `0.2.2-rc.1` | `dsh-bg-control` `0.2.0` | system Node `22.23.2` | Windows 11 x64 | Install, profile boot, and seven tool calls verified |
| DeepSeek Harness `0.2.2-rc.3` (npm `next`; CLI/headless) | `dsh-bg-control` `0.2.0` | DSH embedded `24.21.0` | Windows 11 x64 | Install, profile boot, and seven tool calls verified |
| PI-Desktop `0.22.0` | old PI plugin | n/a | Windows 11 x64 | **Not applicable** — PI-Desktop is a different plugin system |

The `0.2.2-rc.3` run used the npm `next` CLI/headless host, not the desktop application. The desktop build verified here remains `0.2.2-rc.1`.

The package declares:

```json
"engines": {
  "node": ">=22",
  "dsh": ">=0.2.2-rc.1 <0.2.3-0"
},
"peerDependencies": {
  "@deepseek-ai/cordis": "~4.1.0",
  "@deepseek-ai/dsh": ">=0.2.2-rc.1 <0.2.3-0"
}
```

## What “verified” means here

Verified means all of the following happened on the reference machine:

1. the `.tgz` was installed by the DSH plugin manager into an isolated `DSH_HOME`;
2. the profile booted with the plugin fiber active (`fiberState=2`);
3. all seven `bg_*` tools appeared in the DSH ToolRegistry;
4. real calls were made through that registry;
5. the temporary profile was cleaned up and the user's desktop profile was not modified.

## Not verified

- DSH `0.2.1`
- DSH `0.2.2` final (if it differs from `0.2.2-rc.1`)
- DSH `0.2.3` or `0.3.x`
- The DSH `0.2.2-rc.3` desktop application (only the npm CLI/headless host was tested)
- macOS/Linux hosts
- Real Excel/WPS UI COM automation
- Browser clicking, DOM automation, or tab control
- Model-driven conversation turns in a profile without an API key

The narrow `engines.dsh` range is intentional. If you test another version, record the exact install, boot, tool visibility, and tool-call evidence before claiming support.

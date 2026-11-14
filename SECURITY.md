# Security Policy

## Supported versions

Only the version explicitly listed below is supported for security reports:

| Version | Status |
|---|---|
| 0.2.x | Supported for the DSH `0.2.2-rc.1` target |
| Other versions | Not supported |

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could affect users' machines, such as:

- a focus-guard bypass that lets a tool steal the foreground;
- a browser/host-process verification bypass in `bg_window_msg`;
- a process-tree ownership bug that could terminate a user's own process;
- a path traversal, junction/symlink escape, or artifact-overwrite issue;
- a COM isolation bug that changes an existing user instance;
- a command-injection or argument-splitting bug in `bg_cli`.

Use GitHub's **private vulnerability reporting** / **Security advisory** flow for this repository:

https://github.com/ccwd-123/dsh-bg-control/security/advisories/new

If that is unavailable, contact the maintainer through the GitHub profile:

https://github.com/ccwd-123

Please include:

- affected version and DSH version;
- Windows version;
- exact tool call or reproducer;
- expected vs actual behavior;
- whether a real user process/window was touched;
- any log excerpt with secrets removed.

## Scope notes

This plugin intentionally launches and controls local programs. A report is especially important if the behavior crosses one of these boundaries:

- foreground focus is taken from the user;
- a browser or DSH host window is targeted by `bg_window_msg`;
- an existing COM instance is hidden or quit;
- an external `targetPid` is terminated by `bg_job_control`;
- a task writes outside its workspace;
- a model-supplied path escapes through a junction or symlink.

Reports about missing features (for example, "please add browser clicking") are feature requests, not vulnerabilities. Browser automation is deliberately out of scope.

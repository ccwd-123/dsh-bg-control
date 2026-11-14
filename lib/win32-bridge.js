import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_COM_ALLOWLIST = ["Scripting.Dictionary"];
const HIGH_RISK_COM_PROGIDS = new Set([
  "wscript.shell",
  "wscript.network",
  "shell.application",
  "scripting.filesystemobject",
  "adodb.stream",
  "msscriptcontrol.scriptcontrol",
  "htmlfile",
]);
const BROWSER_HOST_BLOCKLIST = new Set([
  "msedge",
  "msedgewebview2",
  "chrome",
  "chrome_proxy",
  "chromium",
  "firefox",
  "brave",
  "opera",
  "vivaldi",
  "iexplore",
  "browser",
  "360se",
  "360chrome",
  "qqbrowser",
  "sogouexplorer",
  "ucbrowser",
  "arc",
  "waterfox",
  "librewolf",
  "tor",
  "electron",
  "deepseek harness",
  "deepseek-harness",
  "dsh",
  "pi-desktop",
]);

function normalizeProcessBaseName(name) {
  return String(name || "")
    .trim()
    .replace(/^.*[/\\]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function isBrowserOrHostProcess(name) {
  const norm = normalizeProcessBaseName(name);
  return Boolean(norm && BROWSER_HOST_BLOCKLIST.has(norm));
}
const WIN32_CSHARP = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace DshWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  public static class Native {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT Point);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr processHandle);
    private static readonly HashSet<string> HelperClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "IME",
      "MSCTFIME UI",
      "CicMarshalWndClass",
      "GDI+ Hook Window Class",
      "OleMainThreadWndClass"
    };

    public static bool IsHelperWindowClass(string cls) {
      return !string.IsNullOrEmpty(cls) && HelperClasses.Contains(cls);
    }

    public static string GetTitle(IntPtr hWnd) {
      var sb = new StringBuilder(512);
      int len = GetWindowText(hWnd, sb, sb.Capacity);
      return len > 0 ? sb.ToString() : "";
    }

    public static string GetClass(IntPtr hWnd) {
      var sb = new StringBuilder(256);
      int len = GetClassName(hWnd, sb, sb.Capacity);
      return len > 0 ? sb.ToString() : "";
    }

    public static uint GetIdleMs() {
      var lii = new LASTINPUTINFO();
      lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      if (!GetLastInputInfo(ref lii)) return 0;
      uint tick = unchecked((uint)Environment.TickCount);
      return unchecked(tick - lii.dwTime);
    }

    public static object GetWindowInfo(IntPtr hWnd) {
      if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return null;
      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      string procName = "";
      try { procName = Process.GetProcessById((int)pid).ProcessName; } catch {}
      IntPtr rootOwner = GetAncestor(hWnd, 3);
      return new {
        hwnd = hWnd.ToInt64(),
        rootOwnerHwnd = rootOwner.ToInt64(),
        pid = (int)pid,
        processName = procName,
        title = GetTitle(hWnd),
        className = GetClass(hWnd),
        visible = IsWindowVisible(hWnd),
        minimized = IsIconic(hWnd)
      };
    }

    public static List<object> ListWindows(int filterPid, long filterHwnd, string filterProcess, string filterTitle, int maxCount, bool includeHiddenForFilter) {
      var results = new List<object>();
      IntPtr fg = GetForegroundWindow();
      var procCache = new Dictionary<int, string>();
      int cap = maxCount > 0 ? maxCount : 30;
      bool hasFilter = filterPid > 0 || filterHwnd > 0 || !string.IsNullOrEmpty(filterProcess) || !string.IsNullOrEmpty(filterTitle);

      EnumWindows((hWnd, lParam) => {
        if (!IsWindow(hWnd)) return true;
        long hVal = hWnd.ToInt64();
        if (filterHwnd > 0 && hVal != filterHwnd) return true;
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        int iPid = (int)pid;
        if (filterPid > 0 && iPid != filterPid) return true;

        string procName;
        if (!procCache.TryGetValue(iPid, out procName)) {
          procName = "";
          try { procName = Process.GetProcessById(iPid).ProcessName; } catch {}
          procCache[iPid] = procName;
        }

        if (!string.IsNullOrEmpty(filterProcess) &&
            !procName.Equals(filterProcess, StringComparison.OrdinalIgnoreCase) &&
            !procName.ToLowerInvariant().Contains(filterProcess.ToLowerInvariant())) {
          return true;
        }

        string title = GetTitle(hWnd);
        if (!string.IsNullOrEmpty(filterTitle) && title.IndexOf(filterTitle, StringComparison.OrdinalIgnoreCase) < 0) {
          return true;
        }

        bool vis = IsWindowVisible(hWnd);
        string cls = GetClass(hWnd);
        if (!hasFilter && (!vis || string.IsNullOrEmpty(title))) return true;
        if (hasFilter && !includeHiddenForFilter && !vis && string.IsNullOrEmpty(title)) return true;

        results.Add(new {
          hwnd = hVal,
          rootOwnerHwnd = GetAncestor(hWnd, 3).ToInt64(),
          isTopLevel = (GetParent(hWnd) == IntPtr.Zero),
          isHelperClass = IsHelperWindowClass(cls),
          pid = iPid,
          processName = procName,
          title = title,
          className = cls,
          visible = vis,
          minimized = IsIconic(hWnd),
          isForeground = (hWnd == fg)
        });
        return results.Count < cap;
      }, IntPtr.Zero);
      return results;
    }

    public static object FindTopLevelWindowForPid(int targetPid) {
      IntPtr fallback = IntPtr.Zero;
      string fallbackTitle = "";
      string fallbackClass = "";
      IntPtr chosen = IntPtr.Zero;
      string chosenTitle = "";
      string chosenClass = "";

      EnumWindows((hWnd, lParam) => {
        if (!IsWindow(hWnd)) return true;
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        if ((int)pid != targetPid) return true;
        if (GetParent(hWnd) != IntPtr.Zero) return true;

        string cls = GetClass(hWnd);
        string title = GetTitle(hWnd);
        if (IsHelperWindowClass(cls)) return true;

        if (!string.IsNullOrEmpty(title)) {
          chosen = hWnd;
          chosenTitle = title;
          chosenClass = cls;
          return false;
        }
        if (fallback == IntPtr.Zero) {
          fallback = hWnd;
          fallbackTitle = title;
          fallbackClass = cls;
        }
        return true;
      }, IntPtr.Zero);

      IntPtr finalHwnd = chosen != IntPtr.Zero ? chosen : fallback;
      if (finalHwnd == IntPtr.Zero) return null;
      return new {
        hwnd = finalHwnd.ToInt64(),
        title = chosen != IntPtr.Zero ? chosenTitle : fallbackTitle,
        className = chosen != IntPtr.Zero ? chosenClass : fallbackClass,
        visible = IsWindowVisible(finalHwnd),
        minimized = IsIconic(finalHwnd)
      };
    }
    public static List<int> GetProcessTreePids(int rootPid) {
      var result = new List<int>();
      if (rootPid <= 0) return result;
      result.Add(rootPid);
      var set = new HashSet<int>();
      set.Add(rootPid);
      var edges = new List<KeyValuePair<int, int>>();
      IntPtr snap = CreateToolhelp32Snapshot(0x00000002, 0);
      if (snap != IntPtr.Zero && snap.ToInt64() != -1) {
        try {
          var pe = new PROCESSENTRY32();
          pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
          if (Process32First(snap, ref pe)) {
            do {
              edges.Add(new KeyValuePair<int, int>((int)pe.th32ParentProcessID, (int)pe.th32ProcessID));
            } while (Process32Next(snap, ref pe));
          }
        } finally {
          CloseHandle(snap);
        }
      }
      bool added = true;
      while (added) {
        added = false;
        foreach (var kv in edges) {
          if (set.Contains(kv.Key) && !set.Contains(kv.Value)) {
            set.Add(kv.Value);
            result.Add(kv.Value);
            added = true;
          }
        }
      }
      return result;
    }

    public static List<object> FindTopLevelWindowsForPids(int[] pids) {
      var pidSet = new HashSet<int>(pids);
      var list = new List<object>();
      IntPtr fg = GetForegroundWindow();
      var procNames = new Dictionary<int, string>();
      EnumWindows((hWnd, lParam) => {
        if (!IsWindow(hWnd)) return true;
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        int iPid = (int)pid;
        if (!pidSet.Contains(iPid)) return true;
        if (GetParent(hWnd) != IntPtr.Zero) return true;
        string cls = GetClass(hWnd);
        if (IsHelperWindowClass(cls)) return true;
        string procName;
        if (!procNames.TryGetValue(iPid, out procName)) {
          procName = "";
          try { procName = Process.GetProcessById(iPid).ProcessName; } catch {}
          procNames[iPid] = procName;
        }
        list.Add(new {
          hwnd = hWnd.ToInt64(),
          pid = iPid,
          processName = procName,
          title = GetTitle(hWnd),
          className = cls,
          visible = IsWindowVisible(hWnd),
          minimized = IsIconic(hWnd),
          isForeground = (hWnd == fg || (fg != IntPtr.Zero && GetAncestor(fg, 3) == GetAncestor(hWnd, 3)))
        });
        return list.Count < 40;
      }, IntPtr.Zero);
      return list;
    }

    public static List<object> FindVisibleWindowsForPids(int[] pids) {
      var pidSet = new HashSet<int>(pids);
      var visibleList = new List<object>();
      EnumWindows((hWnd, lParam) => {
        if (!IsWindow(hWnd) || !IsWindowVisible(hWnd)) return true;
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        if (!pidSet.Contains((int)pid)) return true;
        string cls = GetClass(hWnd);
        if (IsHelperWindowClass(cls)) return true;
        visibleList.Add(new {
          hwnd = hWnd.ToInt64(),
          pid = (int)pid,
          title = GetTitle(hWnd),
          className = cls
        });
        return visibleList.Count < 20;
      }, IntPtr.Zero);
      return visibleList;
    }
    public static int ResumePid(int pid) {
      IntPtr h = OpenProcess(0x0800, false, pid);
      if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
      try { return NtResumeProcess(h); } finally { CloseHandle(h); }
    }
  }
}
`;

function quoteWin32Arg(arg) {
  const s = String(arg ?? "");
  if (s.length > 0 && !/[\s"\\]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      backslashes++;
    } else if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      if (backslashes > 0) {
        out += "\\".repeat(backslashes);
        backslashes = 0;
      }
      out += ch;
    }
  }
  if (backslashes > 0) out += "\\".repeat(backslashes * 2);
  out += '"';
  return out;
}

function buildWin32CommandLine(args) {
  if (!Array.isArray(args) || args.length === 0) return "";
  return args.map(quoteWin32Arg).join(" ");
}

function encodePowerShell(script) {
  const withUtf8 = [
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    script,
  ].join("\n");
  return Buffer.from(withUtf8, "utf16le").toString("base64");
}

function psEscape(str) {
  return String(str ?? "").replace(/'/g, "''");
}

/**
 * Resident PowerShell Win32 helper so Add-Type compiles once and subsequent queries take < 50ms.
 */
class Win32ResidentHelper {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.readyPromise = null;
  }

  _buildBootstrapScript() {
    return `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
${WIN32_CSHARP}
'@ -Language CSharp

function Write-Resp($id, $ok, $data, $errMsg) {
  $obj = [pscustomobject]@{
    id = $id
    ok = $ok
    data = $data
    error = $errMsg
  }
  $json = $obj | ConvertTo-Json -Depth 7 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

Write-Resp 0 $true ([pscustomobject]@{ ready = $true }) $null

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = [int64]$req.id
    $op = [string]$req.op
    $p = $req.params

    switch ($op) {
      'querySystemState' {
        $filterPid = if ($p.pid) { [int]$p.pid } else { 0 }
        $filterHwnd = if ($p.hwnd) { [int64]$p.hwnd } else { [int64]0 }
        $filterProcess = if ($p.processName) { ([string]$p.processName) -replace '\\.exe$', '' } else { '' }
        $filterTitle = if ($p.titlePattern) { [string]$p.titlePattern } else { '' }
        $maxResults = if ($p.maxInstances -and [int]$p.maxInstances -gt 0) { [int]$p.maxInstances } else { 30 }

        $fgHwnd = [DshWin32.Native]::GetForegroundWindow()
        $fgInfo = [DshWin32.Native]::GetWindowInfo($fgHwnd)
        $pt = New-Object DshWin32.POINT
        [void][DshWin32.Native]::GetCursorPos([ref]$pt)
        $hoverHwnd = [DshWin32.Native]::WindowFromPoint($pt)
        $hoverRoot = if ($hoverHwnd -ne [IntPtr]::Zero) { [DshWin32.Native]::GetAncestor($hoverHwnd, 3) } else { [IntPtr]::Zero }
        $hoverInfo = [DshWin32.Native]::GetWindowInfo($hoverRoot)
        $idleMs = [DshWin32.Native]::GetIdleMs()
        $instances = [DshWin32.Native]::ListWindows($filterPid, $filterHwnd, $filterProcess, $filterTitle, $maxResults, $true)
        $windowInfo = if ($filterHwnd -gt 0) { [DshWin32.Native]::GetWindowInfo([IntPtr]$filterHwnd) } else { $null }

        $procList = @()
        if ($filterPid -gt 0 -or $filterProcess -ne '') {
          $procs = if ($filterPid -gt 0) {
            Get-Process -Id $filterPid -ErrorAction SilentlyContinue
          } else {
            Get-Process -Name $filterProcess -ErrorAction SilentlyContinue
          }
          foreach ($pr in @($procs)) {
            if ($null -ne $pr) {
              $procList += [pscustomobject]@{
                pid = $pr.Id
                processName = $pr.ProcessName
                mainWindowHandle = $pr.MainWindowHandle.ToInt64()
                mainWindowTitle = $pr.MainWindowTitle
                responding = $pr.Responding
              }
            }
          }
        }

        $payload = [pscustomobject]@{
          timestamp = (Get-Date).ToString('o')
          foreground = $fgInfo
          windowInfo = $windowInfo
          cursor = [pscustomobject]@{
            x = $pt.X
            y = $pt.Y
            hoverHwnd = $hoverHwnd.ToInt64()
            hoverRootHwnd = $hoverRoot.ToInt64()
            hoverInfo = $hoverInfo
          }
          userIdleMs = [int64]$idleMs
          instances = @($instances)
          processes = @($procList)
        }
        Write-Resp $id $true $payload $null
      }

      'launchBackgroundProcess' {
        $exe = [string]$p.executable
        $wd = [string]$p.cwd
        $argLine = [string]$p.argLine
        $style = [string]$p.windowStyle
        $waitMs = [int]$p.waitForHwndMs
        $exeLeaf = [System.IO.Path]::GetFileNameWithoutExtension($exe)

        $resolvedSource = ''
        try {
          $cmdInfo = Get-Command $exe -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($cmdInfo -and $cmdInfo.Source) { $resolvedSource = [string]$cmdInfo.Source }
        } catch {}

        if ($resolvedSource -like '*\WindowsApps\*') {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            status = 'unsupported_uwp'
            unsupportedUwp = $true
            exitedEarly = $false
            pid = $null
            hwnd = $null
            processName = $exeLeaf
            title = ''
            windowStyle = $style
            error = "Target '$exe' resolves to a Windows Store / UWP AppExecutionAlias ($resolvedSource) which cannot be driven as a classic hidden Win32 background window."
          }) $null
          continue
        }

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exe
        if ($argLine -ne '') { $psi.Arguments = $argLine }
        if ($wd -ne '' -and (Test-Path $wd)) { $psi.WorkingDirectory = $wd }
        $psi.UseShellExecute = $true
        if ($style -eq 'Minimized') {
          $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized
        } else {
          $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        }

        $launchStartedAt = Get-Date
        $proc = [System.Diagnostics.Process]::Start($psi)
        if ($null -eq $proc) { throw "Failed to start process: $exe" }

        $actualName = ""
        try { $actualName = $proc.ProcessName } catch {}

        $seenPids = New-Object System.Collections.Generic.HashSet[int]
        [void]$seenPids.Add($proc.Id)
        $foundWins = @()
        $primaryWin = $null
        $exitedEarly = $false
        $uwpHandoff = $false
        $hideFailedConflict = $false
        $exitCode = $null
        $isConsoleHostLauncher = ($exeLeaf -match '^(powershell|pwsh|cmd|wt|conhost)$')
        $deadline = (Get-Date).AddMilliseconds([Math]::Max($waitMs, 100))

        while ($true) {
          try { $proc.Refresh() } catch {}

          # Collect parent + all descendant PIDs via Win32 Toolhelp snapshot
          $treeNow = [DshWin32.Native]::GetProcessTreePids($proc.Id)
          foreach ($tPid in $treeNow) { [void]$seenPids.Add([int]$tPid) }
          $seenArr = New-Object int[] $seenPids.Count
          $seenPids.CopyTo($seenArr)

          $foundWins = @([DshWin32.Native]::FindTopLevelWindowsForPids($seenArr))
          if ($foundWins.Count -gt 0) {
            foreach ($w in $foundWins) {
              $hPtr = [IntPtr][int64]$w.hwnd
              if ($style -eq 'Hidden') {
                [void][DshWin32.Native]::ShowWindow($hPtr, 0)
              } elseif ($style -eq 'Minimized') {
                [void][DshWin32.Native]::ShowWindow($hPtr, 6)
              }
            }
            $nonConsoleWins = @($foundWins | Where-Object { $_.className -ne 'ConsoleWindowClass' -and $_.className -ne 'PseudoConsoleWindow' })
            $descendantWins = @($nonConsoleWins | Where-Object { $_.pid -ne $proc.Id })
            $pool = if ($descendantWins.Count -gt 0) { $descendantWins } elseif ($nonConsoleWins.Count -gt 0) { $nonConsoleWins } else { $foundWins }
            $primaryWin = $pool | Sort-Object -Property @{Expression={ $_.pid -ne $proc.Id }; Descending=$true}, @{Expression={ -not [string]::IsNullOrEmpty($_.title) }; Descending=$true} | Select-Object -First 1

            if ($descendantWins.Count -gt 0) {
              break
            }
            if ($nonConsoleWins.Count -gt 0 -and -not $isConsoleHostLauncher -and $seenPids.Count -le 1) {
              break
            }
            if (-not $isConsoleHostLauncher -and ((Get-Date) - $launchStartedAt).TotalMilliseconds -ge 500) {
              break
            }
          }

          # Detect Windows 11 UWP AppExecutionAlias / Store handoff
          if ($exeLeaf -ne '') {
            $uwpMatches = @(Get-Process -Name $exeLeaf -ErrorAction SilentlyContinue | Where-Object {
              $_.Path -like '*\WindowsApps\*' -and $_.StartTime -ge $launchStartedAt.AddSeconds(-2)
            })
            if ($uwpMatches.Count -gt 0) {
              $uwpHandoff = $true
              try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
              foreach ($um in $uwpMatches) {
                try { Stop-Process -Id $um.Id -Force -ErrorAction SilentlyContinue } catch {}
              }
              break
            }
          }

          if ($proc.HasExited) {
            # Give fast-spawning descendant launchers a brief check before concluding early exit
            Start-Sleep -Milliseconds 60
            $treeGrace = [DshWin32.Native]::GetProcessTreePids($proc.Id)
            foreach ($tPid in $treeGrace) { [void]$seenPids.Add([int]$tPid) }
            $liveDesc = @()
            foreach ($sp in $seenPids) {
              if ($sp -ne $proc.Id -and (Get-Process -Id $sp -ErrorAction SilentlyContinue)) {
                $liveDesc += $sp
              }
            }
            if ($liveDesc.Count -eq 0) {
              $exitedEarly = $true
              try { $exitCode = $proc.ExitCode } catch {}
              break
            }
          }

          if ((Get-Date) -ge $deadline) { break }
          Start-Sleep -Milliseconds 25
        }

        $treeFinal = [DshWin32.Native]::GetProcessTreePids($proc.Id)
        foreach ($tPid in $treeFinal) { [void]$seenPids.Add([int]$tPid) }
        $finalArr = New-Object int[] $seenPids.Count
        $seenPids.CopyTo($finalArr)

        if (-not $uwpHandoff -and $foundWins.Count -gt 0) {
          Start-Sleep -Milliseconds 45
          $afterWins = @([DshWin32.Native]::FindTopLevelWindowsForPids($finalArr))
          foreach ($aw in $afterWins) {
            if ($aw.isForeground -or ($style -eq 'Hidden' -and $aw.visible)) {
              $hideFailedConflict = $true
            }
          }
          if ($afterWins.Count -gt 0) {
            $nonConsoleAfter = @($afterWins | Where-Object { $_.className -ne 'ConsoleWindowClass' -and $_.className -ne 'PseudoConsoleWindow' })
            $descAfter = @($nonConsoleAfter | Where-Object { $_.pid -ne $proc.Id })
            $afterPool = if ($descAfter.Count -gt 0) { $descAfter } elseif ($nonConsoleAfter.Count -gt 0) { $nonConsoleAfter } else { $afterWins }
            $primaryWin = $afterPool | Sort-Object -Property @{Expression={ $_.pid -ne $proc.Id }; Descending=$true}, @{Expression={ -not [string]::IsNullOrEmpty($_.title) }; Descending=$true} | Select-Object -First 1
            $foundWins = $afterWins
          }
          if ($hideFailedConflict) {
            foreach ($kPid in $finalArr) {
              try { & taskkill.exe /PID $kPid /T /F 2>$null | Out-Null } catch {}
              try { Stop-Process -Id $kPid -Force -ErrorAction SilentlyContinue } catch {}
            }
          }
        }
        if ($hideFailedConflict) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            conflict = $true
            status = 'human_intervened'
            conflictReason = "Launched process tree opened a visible or foreground window that remained visible/foreground after ShowWindow($style); process tree terminated."
            nextAction = 'Use a native headless CLI/COM channel instead of a visible GUI launcher.'
            pid = if ($primaryWin) { [int]$primaryWin.pid } else { $proc.Id }
            ownedRootPid = $proc.Id
            ownedPids = @($finalArr)
            hwnd = if ($primaryWin) { [int64]$primaryWin.hwnd } else { $null }
            processName = if ($primaryWin -and $primaryWin.processName) { [string]$primaryWin.processName } else { $actualName }
            title = if ($primaryWin) { [string]$primaryWin.title } else { '' }
            windowStyle = $style
          }) $null
        } elseif (($exitedEarly -or $uwpHandoff) -and $null -eq $primaryWin) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            status = 'unsupported_uwp'
            unsupportedUwp = $true
            exitedEarly = $exitedEarly
            uwpHandoff = $uwpHandoff
            exitCode = $exitCode
            pid = $proc.Id
            ownedRootPid = $proc.Id
            ownedPids = @($finalArr)
            hwnd = $null
            processName = $actualName
            title = ''
            windowStyle = $style
            error = "Launched process '$exe' (PID $($proc.Id)) is a UWP/Store stub or exited immediately (exitCode=$exitCode, uwpHandoff=$uwpHandoff) with no controllable Win32 background window."
          }) $null
        } elseif ($null -eq $primaryWin) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $true
            status = 'partial'
            exitedEarly = $false
            pid = $proc.Id
            ownedRootPid = $proc.Id
            ownedPids = @($finalArr)
            hwnd = $null
            processName = $actualName
            title = ''
            windowStyle = $style
            nextAction = 'call bg_query_state with processName to find hwnd'
          }) $null
        } else {
          $boundPid = [int]$primaryWin.pid
          $boundProcName = if ($primaryWin.processName) { [string]$primaryWin.processName } else { $actualName }
          Write-Resp $id $true ([pscustomobject]@{
            ok = $true
            status = 'completed'
            exitedEarly = $false
            pid = $boundPid
            ownedRootPid = $proc.Id
            ownedPids = @($finalArr)
            hwnd = [int64]$primaryWin.hwnd
            processName = $boundProcName
            title = [string]$primaryWin.title
            visible = [bool]$primaryWin.visible
            isForeground = [bool]$primaryWin.isForeground
            windowStyle = $style
          }) $null
        }
      }

      'postDirectedWindowMessage' {
        $hwnd = [int64]$p.hwnd
        $msg = [uint32]$p.msg
        $wParam = [int64]$p.wParam
        $lParam = [int64]$p.lParam
        $expectedPid = [int]$p.pid
        $h = [IntPtr]$hwnd
        if (-not [DshWin32.Native]::IsWindow($h)) {
          throw "Target hwnd $hwnd is not a valid window"
        }
        [uint32]$actualPid = 0
        [void][DshWin32.Native]::GetWindowThreadProcessId($h, [ref]$actualPid)
        if ($expectedPid -gt 0 -and [int]$actualPid -ne $expectedPid) {
          throw "HWND $hwnd belongs to PID $actualPid, expected PID $expectedPid"
        }
        $actualProcName = ""
        try {
          $procObj = [System.Diagnostics.Process]::GetProcessById([int]$actualPid)
          if ($null -ne $procObj) { $actualProcName = [string]$procObj.ProcessName }
        } catch {}
        if ([string]::IsNullOrWhiteSpace($actualProcName)) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            status = 'unsupported_unverified_target'
            conflict = $false
            pid = [int]$actualPid
            verifiedPid = [int]$actualPid
            verifiedProcessName = $null
            hwnd = $hwnd
            error = "Cannot resolve actual OS processName for HWND $hwnd (PID $actualPid); PostMessage refused."
          }) $null
          continue
        }
        $normProc = $actualProcName.Trim().ToLowerInvariant() -replace '\.exe$', ''
        $blockedProcs = @(
          'msedge','msedgewebview2','chrome','chrome_proxy','chromium','firefox','brave',
          'opera','vivaldi','iexplore','browser','360se','360chrome','qqbrowser',
          'sogouexplorer','ucbrowser','arc','waterfox','librewolf','tor','electron','deepseek harness','deepseek-harness','dsh','pi-desktop'
        )
        if ($blockedProcs -contains $normProc) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            status = 'unsupported'
            conflict = $false
            pid = [int]$actualPid
            verifiedPid = [int]$actualPid
            verifiedProcessName = $actualProcName
            hwnd = $hwnd
            error = "Directing Win32 PostMessage to browser/host process '$actualProcName' is unsupported."
          }) $null
          continue
        }
        $fg = [DshWin32.Native]::GetForegroundWindow()
        if ($fg -eq $h -or ([DshWin32.Native]::GetAncestor($fg, 3) -eq [DshWin32.Native]::GetAncestor($h, 3) -and $fg -ne [IntPtr]::Zero)) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            conflict = $true
            conflictReason = "Target hwnd $hwnd became foreground at dispatch boundary"
            pid = [int]$actualPid
            verifiedPid = [int]$actualPid
            verifiedProcessName = $actualProcName
            hwnd = $hwnd
          }) $null
          continue
        }
        $posted = [DshWin32.Native]::PostMessage($h, $msg, [IntPtr]$wParam, [IntPtr]$lParam)
        Write-Resp $id $true ([pscustomobject]@{
          ok = $posted
          conflict = $false
          pid = [int]$actualPid
          verifiedPid = [int]$actualPid
          verifiedProcessName = $actualProcName
          hwnd = $hwnd
          msg = [int64]$msg
          wParam = $wParam
          lParam = $lParam
        }) $null
      }

      'suspendOrResumeProcess' {
        $numPid = [int]$p.pid
        $act = [string]$p.action
        $rc = if ($act -eq 'resume') { [DshWin32.Native]::ResumePid($numPid) } else { 0 }
        Write-Resp $id $true ([pscustomobject]@{
          ok = ($rc -eq 0)
          ntStatus = $rc
          mode = if ($act -eq 'suspend') { 'gate_pause_only' } else { 'resume_safeguard' }
          pid = $numPid
          action = $act
        }) $null
      }

      'getProcessVisibleWindows' {
        $rootPid = [int]$p.pid
        $treePids = [DshWin32.Native]::GetProcessTreePids($rootPid)
        $wins = [DshWin32.Native]::FindVisibleWindowsForPids($treePids.ToArray())
        Write-Resp $id $true ([pscustomobject]@{ pids = @($treePids); windows = @($wins) }) $null
      }

      'getProcessInfo' {
        $numPid = [int]$p.pid
        $pr = Get-Process -Id $numPid -ErrorAction SilentlyContinue
        if ($null -eq $pr) {
          Write-Resp $id $true ([pscustomobject]@{ exists = $false; pid = $numPid }) $null
        } else {
          Write-Resp $id $true ([pscustomobject]@{
            exists = $true
            pid = $pr.Id
            processName = $pr.ProcessName
            hasExited = $pr.HasExited
          }) $null
        }
      }

      'verifyCli' {
        $cliCmd = [string]$p.cliCmd
        $harnessCmd = [string]$p.harnessCmd
        $foundCli = @()
        $foundHarness = @()
        foreach ($r in @(Get-Command $cliCmd -ErrorAction SilentlyContinue)) {
          if ($r -and $r.Source) { $foundCli += $r.Source }
        }
        foreach ($r in @(Get-Command $harnessCmd -ErrorAction SilentlyContinue)) {
          if ($r -and $r.Source) { $foundHarness += $r.Source }
        }
        Write-Resp $id $true ([pscustomobject]@{ cli = $foundCli; harness = $foundHarness }) $null
      }

      'verifyCom' {
        $progId = [string]$p.progId
        $t = [Type]::GetTypeFromProgID($progId)
        Write-Resp $id $true ([pscustomobject]@{
          available = ($null -ne $t)
          clsid = if ($t) { $t.GUID.ToString() } else { $null }
        }) $null
      }

      'invokeComIpc' {
        $progId = [string]$p.progId
        $method = [string]$p.method
        $argArr = if ($null -eq $p.args) { @() } else { @($p.args) }

        $tCom = [Type]::GetTypeFromProgID($progId)
        $clsidStr = if ($null -ne $tCom) { $tCom.GUID.ToString('B') } else { '' }
        $hasInproc = $false
        $hasLocalSrv = $false
        if ($clsidStr -ne '') {
          $inprocKey = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("CLSID\\$clsidStr\\InprocServer32")
          $hasInproc = ($null -ne $inprocKey)
          if ($null -ne $inprocKey) { $inprocKey.Close() }
          $localKey = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("CLSID\\$clsidStr\\LocalServer32")
          $hasLocalSrv = ($null -ne $localKey)
          if ($null -ne $localKey) { $localKey.Close() }
        }
        $isVerifiedWindowlessInproc = ($progId.Trim().ToLowerInvariant() -eq 'scripting.dictionary' -and $hasInproc -and -not $hasLocalSrv)
        $activeCheck = 'uncertain'
        $activeFound = $false
        $activeHwnd = [int64]0
        $activePid = 0
        $activeCheckError = ''
        $activeObj = $null
        try {
          $activeObj = [Runtime.InteropServices.Marshal]::GetActiveObject($progId)
          if ($null -ne $activeObj) {
            $activeCheck = 'found'
            $activeFound = $true
            try { $activeHwnd = [int64]$activeObj.Hwnd } catch {
              try { $activeHwnd = [int64]$activeObj.Application.Hwnd } catch {}
            }
            if ($activeHwnd -gt 0) {
              [uint32]$ap = 0
              [void][DshWin32.Native]::GetWindowThreadProcessId([IntPtr]$activeHwnd, [ref]$ap)
              $activePid = [int]$ap
            }
          } else {
            $activeCheck = 'none'
            $activeFound = $false
          }
        } catch {
          $ex = $_.Exception
          $inner = if ($ex.InnerException) { $ex.InnerException } else { $ex }
          $hr = [int]$inner.HResult
          $exMsg = "$($ex.Message) $($inner.Message)"
          if ($hr -eq -2147221021 -or $exMsg -match '0x800401E3|MK_E_UNAVAILABLE') {
            $activeCheck = 'none'
            $activeFound = $false
          } else {
            $activeCheck = 'uncertain'
            $activeFound = $false
            $activeCheckError = $ex.Message
          }
        } finally {
          if ($null -ne $activeObj) {
            try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($activeObj) } catch {}
            $activeObj = $null
          }
        }

        if ($activeCheck -eq 'uncertain') {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            status = 'unsupported_unverified_com'
            progId = $progId
            method = $method
            activeCheck = 'uncertain'
            activeInstanceDetected = $false
            activeHwnd = [int64]0
            activePid = 0
            newHwnd = [int64]0
            newPid = 0
            createdNew = $false
            visibleSet = $false
            invoked = $false
            quitCalled = $false
            error = "GetActiveObject('$progId') failed with non-MK_E_UNAVAILABLE error ($activeCheckError); failing closed without creating or mutating COM server."
            nextAction = 'Use a CLI or file-based channel instead of unverified COM automation.'
          }) $null
          continue
        }

        if ($activeCheck -eq 'found' -and ($activeHwnd -le 0 -or $activePid -le 0)) {
          Write-Resp $id $true ([pscustomobject]@{
            ok = $false
            status = 'unsupported_unverified_com'
            progId = $progId
            method = $method
            activeCheck = 'found'
            activeInstanceDetected = $true
            activeHwnd = $activeHwnd
            activePid = $activePid
            newHwnd = [int64]0
            newPid = 0
            createdNew = $false
            visibleSet = $false
            invoked = $false
            quitCalled = $false
            error = "Active COM instance for '$progId' has incomplete identity (activeHwnd=$activeHwnd, activePid=$activePid); failing closed before New-Object."
            nextAction = 'Close the existing application instance or use a CLI/file-based workflow.'
          }) $null
          continue
        }

        $obj = $null
        $createdNew = $false
        $shouldQuit = $false
        $visibleSet = $false
        $invoked = $false
        $quitCalled = $false
        $newHwnd = [int64]0
        $newPid = 0
        try {
          $obj = New-Object -ComObject $progId
          if ($null -eq $obj) {
            Write-Resp $id $true ([pscustomobject]@{
              ok = $false
              status = 'unsupported_unverified_com'
              progId = $progId
              method = $method
              activeCheck = $activeCheck
              activeInstanceDetected = $activeFound
              activeHwnd = $activeHwnd
              activePid = $activePid
              newHwnd = [int64]0
              newPid = 0
              createdNew = $false
              visibleSet = $false
              invoked = $false
              quitCalled = $false
              error = "New-Object -ComObject '$progId' returned null."
            }) $null
            continue
          }

          if ($isVerifiedWindowlessInproc -and $activeCheck -eq 'none') {
            $createdNew = ($activeCheck -eq 'none')
            $res = $null
            if ($method.StartsWith('get:')) {
              $prop = $method.Substring(4)
              $res = $obj.$prop
            } elseif ($method.StartsWith('set:')) {
              $prop = $method.Substring(4)
              $obj.$prop = if ($argArr.Count -gt 0) { $argArr[0] } else { $null }
              $res = $obj.$prop
            } else {
              $res = $obj.GetType().InvokeMember($method, [System.Reflection.BindingFlags]::InvokeMethod, $null, $obj, [object[]]$argArr)
            }
            $invoked = $true
            Write-Resp $id $true ([pscustomobject]@{
              ok = $true
              progId = $progId
              method = $method
              activeCheck = 'none'
              activeInstanceDetected = $false
              activeHwnd = [int64]0
              activePid = 0
              newHwnd = [int64]0
              newPid = 0
              createdNew = $createdNew
              inprocWindowless = $true
              visibleSet = $false
              invoked = $invoked
              quitCalled = $false
              result = if ($null -eq $res) { $null } else { "$res" }
            }) $null
            continue
          }

          # Inspect new object's Hwnd and PID BEFORE setting Visible or calling any mutating method
          try { $newHwnd = [int64]$obj.Hwnd } catch {
            try { $newHwnd = [int64]$obj.Application.Hwnd } catch {}
          }
          if ($newHwnd -gt 0) {
            [uint32]$np = 0
            [void][DshWin32.Native]::GetWindowThreadProcessId([IntPtr]$newHwnd, [ref]$np)
            $newPid = [int]$np
          }

          if ($activeCheck -eq 'found') {
            if ($newHwnd -le 0) {
              Write-Resp $id $true ([pscustomobject]@{
                ok = $false
                status = 'unsupported_unverified_com'
                progId = $progId
                method = $method
                activeCheck = $activeCheck
                activeInstanceDetected = $true
                activeHwnd = $activeHwnd
                activePid = $activePid
                newHwnd = $newHwnd
                newPid = $newPid
                createdNew = $false
                visibleSet = $false
                invoked = $false
                quitCalled = $false
                error = "Cannot verify newHwnd for COM server '$progId' while active instance exists; failing closed."
                nextAction = 'Use a CLI or file-based channel instead of unverified COM automation.'
              }) $null
              continue
            }
            if ($newHwnd -eq $activeHwnd) {
              Write-Resp $id $true ([pscustomobject]@{
                ok = $false
                status = 'unsupported_existing_instance'
                progId = $progId
                method = $method
                activeCheck = $activeCheck
                activeInstanceDetected = $true
                activeHwnd = $activeHwnd
                activePid = $activePid
                newHwnd = $newHwnd
                newPid = $newPid
                createdNew = $false
                visibleSet = $false
                invoked = $false
                quitCalled = $false
                error = "COM server '$progId' matched existing activeHwnd=$activeHwnd; refused to modify Visible or Quit() user instance."
                nextAction = 'Ask the user to close the existing instance or switch to a headless CLI/file-based workflow.'
              }) $null
              continue
            }
            if ($newPid -le 0) {
              Write-Resp $id $true ([pscustomobject]@{
                ok = $false
                status = 'unsupported_unverified_com'
                progId = $progId
                method = $method
                activeCheck = $activeCheck
                activeInstanceDetected = $true
                activeHwnd = $activeHwnd
                activePid = $activePid
                newHwnd = $newHwnd
                newPid = $newPid
                createdNew = $false
                visibleSet = $false
                invoked = $false
                quitCalled = $false
                error = "Cannot verify newPid for COM server '$progId' (newHwnd=$newHwnd); failing closed without touching Visible or Quit()."
                nextAction = 'Use a CLI or file-based channel instead of unverified COM automation.'
              }) $null
              continue
            }
            if ($newPid -eq $activePid) {
              Write-Resp $id $true ([pscustomobject]@{
                ok = $false
                status = 'unsupported_existing_instance'
                progId = $progId
                method = $method
                activeCheck = $activeCheck
                activeInstanceDetected = $true
                activeHwnd = $activeHwnd
                activePid = $activePid
                newHwnd = $newHwnd
                newPid = $newPid
                createdNew = $false
                visibleSet = $false
                invoked = $false
                quitCalled = $false
                error = "COM server '$progId' matched existing activePid=$activePid; refused to modify Visible or Quit() user instance."
                nextAction = 'Ask the user to close the existing instance or switch to a headless CLI/file-based workflow.'
              }) $null
              continue
            }
          } else {
            if ($newHwnd -le 0 -or $newPid -le 0) {
              Write-Resp $id $true ([pscustomobject]@{
                ok = $false
                status = 'unsupported_unverified_com'
                progId = $progId
                method = $method
                activeCheck = $activeCheck
                activeInstanceDetected = $false
                activeHwnd = [int64]0
                activePid = 0
                newHwnd = $newHwnd
                newPid = $newPid
                createdNew = $false
                visibleSet = $false
                invoked = $false
                quitCalled = $false
                error = "Cannot verify isolated newHwnd/newPid for COM server '$progId' (newHwnd=$newHwnd, newPid=$newPid); failing closed."
                nextAction = 'Use a CLI or file-based channel instead of unverified COM automation.'
              }) $null
              continue
            }
          }

          # Confirmed isolated new out-of-process COM instance
          $createdNew = ($newHwnd -gt 0 -and $newPid -gt 0 -and (
            $activeCheck -eq 'none' -or
            ($activeCheck -eq 'found' -and $activeHwnd -gt 0 -and $activePid -gt 0 -and $newHwnd -ne $activeHwnd -and $newPid -ne $activePid)
          ))
          $shouldQuit = $createdNew
          try {
            $obj.Visible = $false
            $visibleSet = $true
          } catch {}
          try { $obj.DisplayAlerts = $false } catch {}

          $res = $null
          if ($method.StartsWith('get:')) {
            $prop = $method.Substring(4)
            $res = $obj.$prop
          } elseif ($method.StartsWith('set:')) {
            $prop = $method.Substring(4)
            $obj.$prop = if ($argArr.Count -gt 0) { $argArr[0] } else { $null }
            $res = $obj.$prop
          } else {
            $res = $obj.GetType().InvokeMember($method, [System.Reflection.BindingFlags]::InvokeMethod, $null, $obj, [object[]]$argArr)
          }
          $invoked = $true

          $quitBeforeResp = $false
          if ($shouldQuit) {
            try { $obj.Quit(); $quitBeforeResp = $true; $quitCalled = $true } catch {}
          }

          Write-Resp $id $true ([pscustomobject]@{
            ok = $true
            progId = $progId
            method = $method
            activeCheck = $activeCheck
            activeInstanceDetected = $activeFound
            activeHwnd = $activeHwnd
            activePid = $activePid
            newHwnd = $newHwnd
            newPid = $newPid
            createdNew = $createdNew
            visibleSet = $visibleSet
            invoked = $invoked
            quitCalled = $quitBeforeResp
            result = if ($null -eq $res) { $null } else { "$res" }
          }) $null
        } finally {
          if ($null -ne $obj) {
            if ($shouldQuit -and -not $quitCalled) {
              try { $obj.Quit(); $quitCalled = $true } catch {}
            }
            try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) } catch {}
            $obj = $null
          }
          [GC]::Collect()
          [GC]::WaitForPendingFinalizers()
        }
      }

      default {
        Write-Resp $id $false $null "Unknown resident helper operation: $op"
      }
    }
  } catch {
    $errId = if ($req -and $req.id) { [int64]$req.id } else { 0 }
    Write-Resp $errId $false $null $_.Exception.Message
  }
}
`;
  }

  ensureStarted() {
    if (!IS_WINDOWS) {
      return Promise.reject(new Error("Win32 PowerShell bridge requires Windows."));
    }
    if (this.readyPromise && this.proc && !this.proc.killed) {
      return this.readyPromise;
    }

    const scriptPath = path.join(os.tmpdir(), `dsh-win32-helper-${process.pid}.ps1`);
    fs.writeFileSync(scriptPath, "\uFEFF" + this._buildBootstrapScript(), "utf8");
    this.scriptPath = scriptPath;
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    // Allow host process to exit cleanly if only idle helper exists
    proc.unref();

    this.proc = proc;
    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
    });

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.rl = rl;

    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      let readySettled = false;
      const readyTimer = setTimeout(() => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new Error(`Win32 helper startup timed out: ${stderrBuf}`));
        }
      }, 15000);

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (msg.id === 0 && !readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          if (msg.ok) resolveReady();
          else rejectReady(new Error(msg.error || "Win32 helper failed init"));
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (pending.abortCleanup) pending.abortCleanup();
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || "Win32 helper error"));
      });

      proc.on("close", (code) => {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          rejectReady(new Error(`Win32 helper exited during startup (${code}): ${stderrBuf}`));
        }
        this.proc = null;
        this.readyPromise = null;
        for (const [id, p] of this.pending.entries()) {
          clearTimeout(p.timer);
          if (p.abortCleanup) p.abortCleanup();
          p.reject(new Error(`Win32 helper closed (exit ${code})`));
          this.pending.delete(id);
        }
      });

      proc.on("error", (err) => {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(readyTimer);
          rejectReady(err);
        }
      });
    });

    return this.readyPromise;
  }

  async call(op, params = {}, options = {}) {
    await this.ensureStarted();
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Win32 resident helper stdin is not writable");
    }
    const id = this.nextId++;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Win32 helper op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let abortCleanup = null;
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          return reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
        }
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, { resolve, reject, timer, abortCleanup });
      const payload = JSON.stringify({ id, op, params }) + "\n";
      this.proc.stdin.write(payload, "utf8");
    });
  }

  shutdown() {
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill("SIGKILL"); } catch {}
      this.proc = null;
    }
    if (this.scriptPath) {
      try { fs.unlinkSync(this.scriptPath); } catch {}
      this.scriptPath = null;
    }
    this.readyPromise = null;
  }
}

const residentHelper = new Win32ResidentHelper();

async function prewarmResidentHelper() {
  if (!IS_WINDOWS) return false;
  await residentHelper.ensureStarted();
  return true;
}

function shutdownResidentHelper() {
  residentHelper.shutdown();
}

async function querySystemState(query = {}, options = {}) {
  const filterPid = Number.isFinite(Number(query.pid)) && Number(query.pid) > 0 ? Number(query.pid) : 0;
  const filterHwnd = Number.isFinite(Number(query.hwnd)) && Number(query.hwnd) > 0 ? Number(query.hwnd) : 0;
  const filterProcess = String(query.processName || "").replace(/\.exe$/i, "");
  const filterTitle = String(query.titlePattern || "");
  const maxInstances = Number(query.maxInstances) > 0 ? Number(query.maxInstances) : 30;

  return residentHelper.call(
    "querySystemState",
    {
      pid: filterPid,
      hwnd: filterHwnd,
      processName: filterProcess,
      titlePattern: filterTitle,
      maxInstances,
    },
    options
  );
}

/**
 * Launch a local process silently in hidden/minimized mode and locate its top-level HWND
 * (including hidden windows via EnumWindows). Explicitly refuses model-requested normal windows.
 */
async function launchBackgroundProcess(params, options = {}) {
  const executable = String(params.executable || "").trim();
  if (!executable) throw new Error("executable is required");
  const args = Array.isArray(params.args) ? params.args.map(String) : [];
  const cwd = params.cwd ? String(params.cwd) : process.cwd();
  const requestedMode = String(params.windowMode || "hidden").toLowerCase();
  if (requestedMode !== "hidden" && requestedMode !== "minimized") {
    throw new Error(`Unsupported windowMode "${requestedMode}". Only "hidden" or "minimized" is allowed.`);
  }
  const windowStyle = requestedMode === "minimized" ? "Minimized" : "Hidden";
  const waitForHwndMs = Math.min(Math.max(Number(params.waitForHwndMs ?? 2000), 100), 10000);
  const argLine = buildWin32CommandLine(args);

  return residentHelper.call(
    "launchBackgroundProcess",
    {
      executable,
      cwd,
      argLine,
      windowStyle,
      waitForHwndMs,
    },
    { ...options, timeoutMs: Math.max(20000, waitForHwndMs + 8000) }
  );
}

async function postDirectedWindowMessage(params, options = {}) {
  const hwnd = Number(params.hwnd);
  if (!Number.isFinite(hwnd) || hwnd <= 0 || hwnd === 0xffff) {
    throw new Error("Valid non-broadcast target hwnd (> 0 and != 0xFFFF) is required");
  }
  const msg = Number(params.msg);
  if (!Number.isFinite(msg) || msg < 0) {
    throw new Error("Valid numeric Win32 message id (msg) is required");
  }
  const wParam = Number.isFinite(Number(params.wParam)) ? Number(params.wParam) : 0;
  const lParam = Number.isFinite(Number(params.lParam)) ? Number(params.lParam) : 0;
  const expectedPid = Number.isFinite(Number(params.pid)) && Number(params.pid) > 0 ? Number(params.pid) : 0;

  return residentHelper.call(
    "postDirectedWindowMessage",
    { hwnd, pid: expectedPid, msg, wParam, lParam },
    options
  );
}

async function suspendOrResumeProcess(pid, action, options = {}) {
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 0) {
    throw new Error("Valid pid is required");
  }
  if (action !== "suspend" && action !== "resume") {
    throw new Error(`Invalid suspendOrResumeProcess action: ${action}`);
  }
  return residentHelper.call("suspendOrResumeProcess", { pid: numPid, action }, options);
}

async function getProcessVisibleWindows(pid, options = {}) {
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 0) return { pids: [], windows: [] };
  return residentHelper.call("getProcessVisibleWindows", { pid: numPid }, options);
}

async function getProcessInfo(pid, options = {}) {
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 0) return { exists: false, pid: numPid };
  return residentHelper.call("getProcessInfo", { pid: numPid }, options);
}

async function terminateProcessTree(pid) {
  const numPid = Number(pid);
  if (!Number.isFinite(numPid) || numPid <= 0) return { ok: false, reason: "invalid_pid" };
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(numPid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    killer.stdout.on("data", (d) => { out += d.toString("utf8"); });
    killer.stderr.on("data", (d) => { err += d.toString("utf8"); });
    killer.on("close", (code) => {
      resolve({ ok: code === 0, exitCode: code, stdout: out.trim(), stderr: err.trim() });
    });
    killer.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

function isComProgIdAllowed(progId, allowlist) {
  const normalized = String(progId || "").trim().toLowerCase();
  if (!normalized) return false;
  const effectiveList = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist : DEFAULT_COM_ALLOWLIST;
  const allowedLower = new Set(effectiveList.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean));
  if (!allowedLower.has(normalized)) return false;
  if (HIGH_RISK_COM_PROGIDS.has(normalized) && !(Array.isArray(allowlist) && allowlist.some((x) => x.toLowerCase() === normalized))) {
    return false;
  }
  return true;
}

/**
 * Invoke an allowlisted Windows COM / OLE object with forced hidden state and Quit/Release cleanup.
 */
async function invokeComIpc(params, options = {}) {
  const progId = String(params.progId || "").trim();
  const method = String(params.method || "").trim();
  const args = Array.isArray(params.args) ? params.args : [];
  if (!progId) throw new Error("progId is required for COM IPC");
  if (!method) throw new Error("method is required for COM IPC");

  if (params.attachActive !== undefined) {
    throw new Error("attachActive cannot be controlled by caller/model; only isolated new hidden COM instances are permitted.");
  }
  if (params.quitOnExit === false) {
    throw new Error("quitOnExit=false is prohibited; newly created COM servers must always Quit() on exit.");
  }
  if (params.keepHidden === false && options.allowVisibleCom !== true) {
    throw new Error("Visible COM automation (keepHidden=false) is prohibited without explicit host user authorization.");
  }

  const allowlist = options.comAllowlist || params.comAllowlist || DEFAULT_COM_ALLOWLIST;
  if (!isComProgIdAllowed(progId, allowlist)) {
    throw new Error(
      `COM ProgID "${progId}" is not in the configured allowlist (${allowlist.join(", ")}); high-risk COM servers such as WScript.Shell are refused by default.`
    );
  }

  if (options.comAdapter && typeof options.comAdapter.createNew === "function") {
    return runIsolatedComSession({ progId, method, args }, options.comAdapter);
  }

  return residentHelper.call(
    "invokeComIpc",
    {
      progId,
      method,
      args,
    },
    { ...options, timeoutMs: params.timeoutMs || 20000 }
  );
}

function isMkEUnavailableError(err) {
  if (!err) return false;
  const hr = Number(err.hresult ?? err.errno ?? NaN);
  if (hr === 0x800401e3 || hr === -2147221021) return true;
  const code = String(err.code || "");
  if (/^(MK_E_UNAVAILABLE|0x800401E3)$/i.test(code)) return true;
  const msg = String(err.message || err);
  if (/\bnot\s+MK_E_UNAVAILABLE\b/i.test(msg)) return false;
  return /0x800401e3|\bMK_E_UNAVAILABLE\b/i.test(msg);
}

/**
 * Verifiable COM isolation state machine (mirrored in resident PowerShell invokeComIpc):
 * 1. Only MK_E_UNAVAILABLE (0x800401E3) or explicit null/{exists:false} counts as activeCheck="none";
 *    any other GetActiveObject error is activeCheck="uncertain" -> fail closed immediately.
 * 2. If activeCheck="found" and (activeHwnd<=0 or activePid<=0) -> fail closed BEFORE createNew.
 * 3. If activeCheck="found" and both activeHwnd>0 & activePid>0:
 *    newHwnd<=0 -> unsupported_unverified_com;
 *    newHwnd===activeHwnd -> unsupported_existing_instance;
 *    newPid<=0 -> unsupported_unverified_com;
 *    newPid===activePid -> unsupported_existing_instance;
 *    only when newHwnd!==activeHwnd AND newPid!==activePid -> createdNew=true, Visible=false, invoke, Quit().
 * 4. If activeCheck="none":
 *    requires newHwnd>0 && newPid>0 (except verified windowless in-proc Scripting.Dictionary) -> createdNew=true.
 */
async function runIsolatedComSession({ progId, method, args = [] }, adapter) {
  let activeCheck = "uncertain";
  let activeFound = false;
  let activeHwnd = 0;
  let activePid = 0;
  let activeError = "";

  if (adapter && typeof adapter.getActiveObject === "function") {
    try {
      const activeInfo = await adapter.getActiveObject(progId);
      if (activeInfo && activeInfo.exists !== false) {
        activeCheck = "found";
        activeFound = true;
        activeHwnd = Number(activeInfo.hwnd) > 0 ? Number(activeInfo.hwnd) : 0;
        activePid = Number(activeInfo.pid) > 0 ? Number(activeInfo.pid) : 0;
      } else {
        activeCheck = "none";
        activeFound = false;
      }
    } catch (err) {
      if (isMkEUnavailableError(err)) {
        activeCheck = "none";
        activeFound = false;
      } else {
        activeCheck = "uncertain";
        activeFound = false;
        activeError = err?.message || String(err);
      }
    }
  }

  if (activeCheck === "uncertain") {
    return {
      ok: false,
      status: "unsupported_unverified_com",
      progId,
      method,
      activeCheck: "uncertain",
      activeInstanceDetected: false,
      activeHwnd: 0,
      activePid: 0,
      newHwnd: 0,
      newPid: 0,
      createdNew: false,
      visibleSet: false,
      invoked: false,
      quitCalled: false,
      error: `GetActiveObject("${progId}") failed with non-MK_E_UNAVAILABLE error (${activeError || "missing active check"}); failing closed without creating or mutating COM server.`,
      nextAction: "Use a CLI or file-based channel instead of unverified COM automation.",
    };
  }

  if (activeCheck === "found" && (activeHwnd <= 0 || activePid <= 0)) {
    return {
      ok: false,
      status: "unsupported_unverified_com",
      progId,
      method,
      activeCheck: "found",
      activeInstanceDetected: true,
      activeHwnd,
      activePid,
      newHwnd: 0,
      newPid: 0,
      createdNew: false,
      visibleSet: false,
      invoked: false,
      quitCalled: false,
      error: `Active COM instance for "${progId}" has incomplete identity (activeHwnd=${activeHwnd}, activePid=${activePid}); failing closed before createNew.`,
      nextAction: "Close the existing application instance or use a CLI/file-based workflow.",
    };
  }

  const instance = await adapter.createNew(progId);
  if (!instance) {
    return {
      ok: false,
      status: "unsupported_unverified_com",
      progId,
      method,
      activeCheck,
      activeInstanceDetected: activeFound,
      activeHwnd,
      activePid,
      newHwnd: 0,
      newPid: 0,
      createdNew: false,
      visibleSet: false,
      invoked: false,
      quitCalled: false,
      error: `COM createNew("${progId}") returned null.`,
    };
  }

  let visibleSet = false;
  let invoked = false;
  let quitCalled = false;
  let shouldQuit = false;
  try {
    if (instance.inprocWindowless === true && activeCheck === "none") {
      const createdNew = activeCheck === "none";
      const result = await instance.invoke(method, args);
      invoked = true;
      return {
        ok: true,
        progId,
        method,
        activeCheck: "none",
        activeInstanceDetected: false,
        activeHwnd: 0,
        activePid: 0,
        newHwnd: 0,
        newPid: 0,
        createdNew,
        inprocWindowless: true,
        visibleSet: false,
        invoked,
        quitCalled: false,
        result,
      };
    }

    const rawNewHwnd = Number(typeof instance.getHwnd === "function" ? await instance.getHwnd() : instance.hwnd || 0);
    const rawNewPid = Number(typeof instance.getPid === "function" ? await instance.getPid() : instance.pid || 0);
    const newHwnd = rawNewHwnd > 0 ? rawNewHwnd : 0;
    const newPid = rawNewPid > 0 ? rawNewPid : 0;

    if (activeCheck === "found") {
      if (newHwnd <= 0) {
        return {
          ok: false,
          status: "unsupported_unverified_com",
          progId,
          method,
          activeCheck,
          activeInstanceDetected: true,
          activeHwnd,
          activePid,
          newHwnd,
          newPid,
          createdNew: false,
          visibleSet: false,
          invoked: false,
          quitCalled: false,
          error: `Cannot verify newHwnd for COM server "${progId}" while active instance exists; failing closed.`,
          nextAction: "Use a CLI or file-based channel instead of unverified COM automation.",
        };
      }
      if (newHwnd === activeHwnd) {
        return {
          ok: false,
          status: "unsupported_existing_instance",
          progId,
          method,
          activeCheck,
          activeInstanceDetected: true,
          activeHwnd,
          activePid,
          newHwnd,
          newPid,
          createdNew: false,
          visibleSet: false,
          invoked: false,
          quitCalled: false,
          error: `COM server "${progId}" matched existing activeHwnd=${activeHwnd}; refused to modify Visible or Quit() user instance.`,
          nextAction: "Ask the user to close the existing instance or switch to a headless CLI/file-based workflow.",
        };
      }
      if (newPid <= 0) {
        return {
          ok: false,
          status: "unsupported_unverified_com",
          progId,
          method,
          activeCheck,
          activeInstanceDetected: true,
          activeHwnd,
          activePid,
          newHwnd,
          newPid,
          createdNew: false,
          visibleSet: false,
          invoked: false,
          quitCalled: false,
          error: `Cannot verify newPid for COM server "${progId}" (newHwnd=${newHwnd}); failing closed without touching Visible or Quit().`,
          nextAction: "Use a CLI or file-based channel instead of unverified COM automation.",
        };
      }
      if (newPid === activePid) {
        return {
          ok: false,
          status: "unsupported_existing_instance",
          progId,
          method,
          activeCheck,
          activeInstanceDetected: true,
          activeHwnd,
          activePid,
          newHwnd,
          newPid,
          createdNew: false,
          visibleSet: false,
          invoked: false,
          quitCalled: false,
          error: `COM server "${progId}" matched existing activePid=${activePid}; refused to modify Visible or Quit() user instance.`,
          nextAction: "Ask the user to close the existing instance or switch to a headless CLI/file-based workflow.",
        };
      }
    } else {
      if (newHwnd <= 0 || newPid <= 0) {
        return {
          ok: false,
          status: "unsupported_unverified_com",
          progId,
          method,
          activeCheck,
          activeInstanceDetected: false,
          activeHwnd: 0,
          activePid: 0,
          newHwnd,
          newPid,
          createdNew: false,
          visibleSet: false,
          invoked: false,
          quitCalled: false,
          error: `Cannot verify isolated newHwnd/newPid for COM server "${progId}" (newHwnd=${newHwnd}, newPid=${newPid}); failing closed.`,
          nextAction: "Use a CLI or file-based channel instead of unverified COM automation.",
        };
      }
    }

    const createdNew =
      newHwnd > 0 &&
      newPid > 0 &&
      (activeCheck === "none" ||
        (activeCheck === "found" &&
          activeHwnd > 0 &&
          activePid > 0 &&
          newHwnd !== activeHwnd &&
          newPid !== activePid));
    shouldQuit = createdNew;
    if (typeof instance.setVisible === "function") {
      await instance.setVisible(false);
      visibleSet = true;
    }
    if (typeof instance.setDisplayAlerts === "function") {
      await instance.setDisplayAlerts(false);
    }
    const result = await instance.invoke(method, args);
    invoked = true;
    if (shouldQuit && typeof instance.quit === "function") {
      await instance.quit();
      quitCalled = true;
    }
    return {
      ok: true,
      progId,
      method,
      activeCheck,
      activeInstanceDetected: activeFound,
      activeHwnd,
      activePid,
      newHwnd,
      newPid,
      createdNew,
      visibleSet,
      invoked,
      quitCalled,
      result,
    };
  } finally {
    if (shouldQuit && !quitCalled && typeof instance.quit === "function") {
      try {
        await instance.quit();
        quitCalled = true;
      } catch {}
    }
    if (typeof instance.release === "function") {
      try { await instance.release(); } catch {}
    }
  }
}

function invokeNamedPipe(pipeName, payload, options = {}) {
  const normalized = pipeName.startsWith("\\\\.\\pipe\\") ? pipeName : `\\\\.\\pipe\\${pipeName}`;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  return new Promise((resolve, reject) => {
    const client = net.connect(normalized);
    let data = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error(`Named pipe ${normalized} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      const err = new Error("Named pipe IPC aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (options.signal) {
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    client.on("connect", () => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
      client.write(text + "\n");
      if (options.halfClose !== false) client.end();
    });
    client.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    client.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      let parsed = data.trim();
      try { parsed = JSON.parse(parsed); } catch {}
      resolve({ ok: true, pipe: normalized, response: parsed });
    });
    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

async function verifyChannels(params = {}, options = {}) {
  const program = String(params.program || "").trim();
  const comProgId = String(params.comProgId || "").trim();
  const pipeName = String(params.pipeName || "").trim();
  const httpUrl = String(params.httpUrl || "").trim();
  const hwnd = Number(params.hwnd || 0);
  const pid = Number(params.pid || 0);

  const channels = {
    cli: { available: false, paths: [] },
    cliAnything: { available: false, harnesses: [] },
    com: { available: false, progId: comProgId || null },
    pipe: { available: false, pipe: null },
    http: { available: false, url: httpUrl || null },
    windowMsg: { available: false, instances: [] },
  };

  if (program) {
    try {
      const res = await residentHelper.call(
        "verifyCli",
        {
          cliCmd: program,
          harnessCmd: `cli-anything-${program.replace(/\.exe$/i, "")}`,
        },
        options
      );
      if (res?.cli?.length) {
        channels.cli = { available: true, paths: Array.isArray(res.cli) ? res.cli : [res.cli] };
      }
      if (res?.harness?.length) {
        channels.cliAnything = { available: true, harnesses: Array.isArray(res.harness) ? res.harness : [res.harness] };
      }
    } catch {}
  }

  if (comProgId) {
    try {
      const res = await residentHelper.call("verifyCom", { progId: comProgId }, options);
      if (res?.available) {
        channels.com = { available: true, progId: comProgId, clsid: res.clsid };
      }
    } catch {}
  }

  if (pipeName) {
    const normalized = pipeName.startsWith("\\\\.\\pipe\\") ? pipeName : `\\\\.\\pipe\\${pipeName}`;
    try {
      channels.pipe = { available: fs.existsSync(normalized), pipe: normalized };
    } catch {
      channels.pipe = { available: false, pipe: normalized };
    }
  }

  if (httpUrl) {
    try {
      const u = new URL(httpUrl);
      const isLocal = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
      if (isLocal) {
        const timeoutSig = AbortSignal.timeout(Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : 5000);
        const combinedSig = options.signal ? AbortSignal.any([options.signal, timeoutSig]) : timeoutSig;
        const resp = await fetch(httpUrl, { method: "GET", redirect: "manual", signal: combinedSig });
        channels.http = { available: resp.ok || (resp.status >= 200 && resp.status < 400), status: resp.status, url: httpUrl };
      } else {
        channels.http = { available: false, url: httpUrl, reason: "Only local loopback endpoints are probed automatically" };
      }
    } catch (e) {
      channels.http = { available: false, url: httpUrl, reason: e.message };
    }
  }

  if (hwnd > 0 || pid > 0 || program) {
    try {
      const state = await querySystemState({ hwnd, pid, processName: program }, options);
      const instances = Array.isArray(state?.instances) ? state.instances : [];
      channels.windowMsg = { available: instances.length > 0, instances };
    } catch {}
  }

  const priorityOrder = [];
  if (channels.cli.available) priorityOrder.push("cli");
  if (channels.com.available) priorityOrder.push("ipc:com");
  if (channels.pipe.available) priorityOrder.push("ipc:pipe");
  if (channels.http.available) priorityOrder.push("ipc:http");
  if (channels.cliAnything.available) priorityOrder.push("cli-anything");
  if (channels.windowMsg.available) priorityOrder.push("window_msg");

  return {
    channels,
    recommendedOrder: priorityOrder,
    hasSafeBackgroundPath: priorityOrder.length > 0,
  };
}

/**
 * Run a background CLI command with windowsHide=true, bounded output, abort support, and callbacks.
 */
function runBackgroundCli(params, callbacks = {}, signal) {
  const command = String(params.command || "").trim();
  if (!command) throw new Error("command is required");
  const args = Array.isArray(params.args) ? params.args.map(String) : [];
  const cwd = params.cwd ? String(params.cwd) : process.cwd();
  const shell = params.shell === true;
  const timeoutMs = Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : 60000;
  const maxOutputBytes = Number(params.maxOutputBytes) > 0 ? Number(params.maxOutputBytes) : DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      env: params.env ? { ...process.env, ...params.env } : process.env,
      stdio: [params.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (typeof callbacks.onSpawn === "function" && child.pid) {
      callbacks.onSpawn(child.pid);
    }

    if (params.stdin != null && child.stdin) {
      child.stdin.write(String(params.stdin));
      child.stdin.end();
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const getStdoutText = () => Buffer.concat(stdoutChunks).toString("utf8");
    const getStderrText = () => Buffer.concat(stderrChunks).toString("utf8");

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      if (child.pid) await terminateProcessTree(child.pid);
      const err = new Error(`CLI command timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      err.stdout = getStdoutText();
      err.stderr = getStderrText();
      reject(err);
    }, timeoutMs);

    const onAbort = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) await terminateProcessTree(child.pid);
      const err = new Error("CLI job cancelled/aborted");
      err.name = "AbortError";
      err.stdout = getStdoutText();
      err.stderr = getStderrText();
      reject(err);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (stdoutBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stdoutBytes;
        const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
        if (buf.length > remaining) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
      if (typeof callbacks.onStdout === "function") {
        callbacks.onStdout(buf.toString("utf8"));
      }
    });

    child.stderr.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (stderrBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stderrBytes;
        const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
        if (buf.length > remaining) stderrTruncated = true;
      } else {
        stderrTruncated = true;
      }
      if (typeof callbacks.onStderr === "function") {
        callbacks.onStderr(buf.toString("utf8"));
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code ?? 0,
        pid: child.pid ?? null,
        stdout: getStdoutText(),
        stderr: getStderrText(),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

export {
  IS_WINDOWS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_COM_ALLOWLIST,
  BROWSER_HOST_BLOCKLIST,
  normalizeProcessBaseName,
  isBrowserOrHostProcess,
  quoteWin32Arg,
  buildWin32CommandLine,
  isComProgIdAllowed,
  prewarmResidentHelper,
  shutdownResidentHelper,
  querySystemState,
  launchBackgroundProcess,
  postDirectedWindowMessage,
  suspendOrResumeProcess,
  getProcessVisibleWindows,
  getProcessInfo,
  terminateProcessTree,
  invokeComIpc,
  isMkEUnavailableError,
  runIsolatedComSession,
  invokeNamedPipe,
  verifyChannels,
  runBackgroundCli,
};
export default {
  IS_WINDOWS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_COM_ALLOWLIST,
  BROWSER_HOST_BLOCKLIST,
  normalizeProcessBaseName,
  isBrowserOrHostProcess,
  quoteWin32Arg,
  buildWin32CommandLine,
  isComProgIdAllowed,
  prewarmResidentHelper,
  shutdownResidentHelper,
  querySystemState,
  launchBackgroundProcess,
  postDirectedWindowMessage,
  suspendOrResumeProcess,
  getProcessVisibleWindows,
  getProcessInfo,
  terminateProcessTree,
  invokeComIpc,
  isMkEUnavailableError,
  runIsolatedComSession,
  invokeNamedPipe,
  verifyChannels,
  runBackgroundCli,
};

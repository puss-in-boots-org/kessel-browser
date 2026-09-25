# Lists the standard Windows dialogs (Save As, Open, ...) showing for a
# process and everything it started (WebView2's own processes show some of
# them), as JSON: [{ "title": "...", "pid": 1234, "class": "#32770" }].
# With -All: every visible top-level window of theirs, whatever its kind.
#
#   dialogs.ps1 -ProcessId 1234 [-All]

param([Parameter(Mandatory = $true)][int]$ProcessId, [switch]$All)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class KesselDialogs {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);

  public static List<string[]> Find(HashSet<int> pids, bool all) {
    var found = new List<string[]>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains((int)pid) || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (!all && cls.ToString() != "#32770") return true;
      var title = new StringBuilder(256); GetWindowText(h, title, 256);
      found.Add(new[] { title.ToString(), pid.ToString(), cls.ToString() });
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# The process and all its descendants.
$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$tree = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$tree.Add($ProcessId)
do {
  $added = $false
  foreach ($p in $procs) {
    if ($tree.Contains([int]$p.ParentProcessId) -and $tree.Add([int]$p.ProcessId)) { $added = $true }
  }
} while ($added)

$list = @([KesselDialogs]::Find($tree, [bool]$All) | ForEach-Object { [pscustomobject]@{ title = $_[0]; pid = [int]$_[1]; class = $_[2] } })
ConvertTo-Json -InputObject $list -Compress

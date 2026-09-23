<#
.SYNOPSIS
    Shows how much memory Kessel really uses: kessel.exe plus every WebView2
    process working for it.

.DESCRIPTION
    kessel.exe is only the small Rust host that creates and positions the
    webviews, so Task Manager's "Kessel" line looks tiny. The actual work runs
    in msedgewebview2.exe processes: WebView2's main process, a GPU process
    (drawing, video decoding), network/audio/storage helpers, and one
    renderer per page -- the toolbar is one of those renderers, every tab and
    pop-out another.

    Kessel's WebView2 processes are recognised by their --user-data-dir,
    which contains Kessel's app identifier. "Memory" is the private working
    set, the same number Task Manager's Memory column shows.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\kessel-memory.ps1

.EXAMPLE
    # Refresh every 5 seconds (Ctrl+C to stop)
    powershell -ExecutionPolicy Bypass -File scripts\kessel-memory.ps1 -Watch 5
#>
param(
    # "identifier" in tauri-browser/src-tauri/tauri.conf.json -- WebView2
    # keeps its data under %LOCALAPPDATA%\<identifier>\EBWebView.
    [string]$AppId = 'com.example.kessel',
    [string]$HostProcess = 'kessel',
    # Seconds between refreshes; 0 = show once.
    [int]$Watch = 0
)

function Get-KesselProcesses {
    $found = @()
    foreach ($p in Get-Process -Name $HostProcess -ErrorAction SilentlyContinue) {
        $found += [pscustomobject]@{ Id = $p.Id; Role = "$HostProcess.exe (Rust host)" }
    }
    $webviews = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
        Where-Object { $_.CommandLine -like "*\$AppId\*" }
    foreach ($w in $webviews) {
        $cmd = $w.CommandLine
        $role = if ($cmd -notmatch '--type=([\w-]+)') {
            'WebView2 main process'
        } else {
            switch ($Matches[1]) {
                'renderer'         { 'page renderer (toolbar / a tab / a pop-out)' }
                'gpu-process'      { 'GPU (drawing + video decoding)' }
                'crashpad-handler' { 'crash reporter' }
                'utility' {
                    if ($cmd -match '--utility-sub-type=([\w]+)\.') { "helper: $($Matches[1])" } else { 'helper' }
                }
                default { $Matches[1] }
            }
        }
        $found += [pscustomobject]@{ Id = [int]$w.ProcessId; Role = $role }
    }
    $found
}

function Show-KesselMemory {
    $procs = @(Get-KesselProcesses)
    if (-not $procs) {
        Write-Host "Kessel isn't running (no '$HostProcess' process and no WebView2 process for '$AppId')."
        return
    }

    # Private working set per PID -- what Task Manager's Memory column shows.
    $ids = $procs.Id
    $privateWs = @{}
    Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue |
        Where-Object { $ids -contains [int]$_.IDProcess } |
        ForEach-Object { $privateWs[[int]$_.IDProcess] = [double]$_.WorkingSetPrivate }

    $rows = foreach ($p in $procs) {
        $proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
        if (-not $proc) { continue }  # exited while we were looking
        # Fall back to the full working set if perf counters are unavailable.
        $mem = if ($privateWs.ContainsKey($p.Id)) { $privateWs[$p.Id] } else { [double]$proc.WorkingSet64 }
        [pscustomobject]@{
            PID           = $p.Id
            Process       = $p.Role
            'Memory (MB)' = [math]::Round($mem / 1MB, 1)
            'CPU (s)'     = [math]::Round($proc.CPU, 1)
        }
    }
    $rows = @($rows | Sort-Object 'Memory (MB)' -Descending)
    $rows | Format-Table -AutoSize | Out-String -Width 160 | Write-Host

    $total = ($rows | Measure-Object 'Memory (MB)' -Sum).Sum
    $renderers = @($rows | Where-Object { $_.Process -like 'page renderer*' }).Count
    Write-Host ("Total: {0:N1} MB across {1} processes ({2} page renderers)" -f $total, $rows.Count, $renderers)
}

if ($Watch -gt 0) {
    while ($true) {
        Clear-Host
        Write-Host "Kessel memory -- $(Get-Date -Format 'HH:mm:ss')  (Ctrl+C to stop)`n"
        Show-KesselMemory
        Start-Sleep -Seconds $Watch
    }
} else {
    Show-KesselMemory
}

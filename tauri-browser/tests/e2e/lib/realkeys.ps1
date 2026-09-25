# Presses real keys in a running Kessel window, through Windows itself
# (keybd_event), for the few tests that must go through WebView2's own
# keyboard handling -- DevTools-protocol key events never reach it.
# "WheelUp" / "WheelDown" (with modifiers: "Ctrl+WheelUp") turn the mouse
# wheel once over the middle of the window's page area; the pointer goes
# back where it was straight after.
#
# Safety: the keys are only sent while the target window really is the
# foreground window; the check runs before every key, and the script stops
# with an error if focus went elsewhere (so keys can't land in another app).
#
#   realkeys.ps1 -ProcessId 1234 -Keys "Ctrl+T|F5" [-Title "Kessel"]

param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Keys,
  [string]$Title = "Kessel",
  [int]$DelayMs = 120
)
$KeyList = @($Keys -split '\|' | Where-Object { $_ -ne '' })

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class KesselRealKeys {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  // One notch of the wheel over the page area (the middle, two thirds of
  // the way down -- below the toolbar), with `mods` held.
  public static void Wheel(IntPtr hwnd, byte[] mods, int delta) {
    RECT r; GetWindowRect(hwnd, out r);
    POINT old; GetCursorPos(out old);
    SetCursorPos((r.Left + r.Right) / 2, r.Top + (r.Bottom - r.Top) * 2 / 3);
    System.Threading.Thread.Sleep(60);
    foreach (var m in mods) keybd_event(m, (byte)MapVirtualKey(m, 0), 0, UIntPtr.Zero);
    mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
    for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], (byte)MapVirtualKey(mods[i], 0), 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    SetCursorPos(old.X, old.Y);
  }

  public static IntPtr Find(int pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != (uint)pid || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Activate(IntPtr hwnd) {
    if (GetForegroundWindow() == hwnd) return true;
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    // A tap of Alt makes this process allowed to change the foreground
    // window. Only while another window is in front: tapped inside Kessel
    // it would toggle Windows' menu mode, which swallows the next key.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hwnd);
    for (int i = 0; i < 30 && GetForegroundWindow() != hwnd; i++) System.Threading.Thread.Sleep(50);
    return GetForegroundWindow() == hwnd;
  }

  static bool Extended(byte vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90;
  }

  public static void Press(byte[] mods, byte key) {
    foreach (var m in mods) keybd_event(m, (byte)MapVirtualKey(m, 0), 0, UIntPtr.Zero);
    uint ext = Extended(key) ? 1u : 0u;
    keybd_event(key, (byte)MapVirtualKey(key, 0), ext, UIntPtr.Zero);
    keybd_event(key, (byte)MapVirtualKey(key, 0), ext | 2u, UIntPtr.Zero);
    for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], (byte)MapVirtualKey(mods[i], 0), 2, UIntPtr.Zero);
  }
}
"@

$named = @{
  "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B; "space" = 0x20; "backspace" = 0x08;
  "pageup" = 0x21; "pagedown" = 0x22; "end" = 0x23; "home" = 0x24; "left" = 0x25; "up" = 0x26; "right" = 0x27; "down" = 0x28;
  "insert" = 0x2D; "delete" = 0x2E; "plus" = 0xBB; "=" = 0xBB; "minus" = 0xBD; "-" = 0xBD
}

$hwnd = [KesselRealKeys]::Find($ProcessId, $Title)
if ($hwnd -eq [IntPtr]::Zero) { throw "No visible window titled '$Title' in process $ProcessId" }

foreach ($combo in $KeyList) {
  if (-not [KesselRealKeys]::Activate($hwnd)) { throw "Couldn't bring '$Title' to the front; not sending $combo" }
  $mods = New-Object System.Collections.Generic.List[byte]
  $key = $null
  $wheel = 0
  foreach ($part in ($combo -split '\+' | Where-Object { $_ -ne '' })) {
    switch ($part.ToLower()) {
      "ctrl" { $mods.Add(0x11); continue }
      "shift" { $mods.Add(0x10); continue }
      "alt" { $mods.Add(0x12); continue }
      "wheelup" { $wheel = 120; continue }
      "wheeldown" { $wheel = -120; continue }
      default {
        $p = $part.ToLower()
        if ($named.ContainsKey($p)) { $key = [byte]$named[$p] }
        elseif ($p -match '^f([1-9]|1[0-2])$') { $key = [byte](0x6F + [int]$Matches[1]) }
        elseif ($p.Length -eq 1) { $key = [byte][char]$p.ToUpper() }
        else { throw "Unknown key '$part' in '$combo'" }
      }
    }
  }
  if ($null -eq $key -and $wheel -eq 0) { throw "No key in '$combo'" }
  # Last check right before the keys go out.
  if ([KesselRealKeys]::GetForegroundWindow() -ne $hwnd) { throw "'$Title' lost the foreground; not sending $combo" }
  if ($wheel -ne 0) { [KesselRealKeys]::Wheel($hwnd, $mods.ToArray(), $wheel) }
  else { [KesselRealKeys]::Press($mods.ToArray(), $key) }
  Start-Sleep -Milliseconds $DelayMs
}
"sent: $($KeyList -join ', ')"

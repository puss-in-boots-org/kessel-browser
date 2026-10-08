# Moves every visible top-level window of a process by (Dx, Dy) -- the
# test's own off-screen windows, which stay off every screen.
param([int]$ProcessId, [int]$Dx, [int]$Dy)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MoveWindows {
  public delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static int By(uint want, int dx, int dy) {
    int moved = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r;
      if (pid != want || !IsWindowVisible(h) || !GetWindowRect(h, out r) || r.R - r.L < 100) return true;
      // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
      if (SetWindowPos(h, IntPtr.Zero, r.L + dx, r.T + dy, 0, 0, 0x0001 | 0x0004 | 0x0010)) moved++;
      return true;
    }, IntPtr.Zero);
    return moved;
  }
}
"@
[MoveWindows]::By([uint32]$ProcessId, $Dx, $Dy)

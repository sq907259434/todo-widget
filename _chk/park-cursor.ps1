param([int]$X = 0, [int]$Y = 0)
# Park the OS cursor at a physical-pixel coordinate (mouse hover drives the card expand).
$sig = @'
using System;
using System.Runtime.InteropServices;
public class PK {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
Add-Type -TypeDefinition $sig
[void][PK]::SetProcessDPIAware()
if ($X -gt 0 -and $Y -gt 0) { [void][PK]::SetCursorPos($X, $Y) }
$p = New-Object PK+POINT
[void][PK]::GetCursorPos([ref]$p)
Write-Output ("CURSOR={0},{1}" -f $p.X, $p.Y)

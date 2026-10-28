param(
  [string]$Title = "",
  [ValidateSet("title","middle")][string]$Mode = "title",
  [int]$DX = 60,
  [int]$DY = 40,
  [int]$Steps = 8,
  [int]$PerStepMs = 70,
  [string]$ShotDir = "",
  [int]$GrabX = -1,
  [int]$GrabY = -1,
  [switch]$Probe,
  [switch]$NoUp,
  [switch]$ReleaseOnly,
  [int]$TitleOffPx = 22   # 展开后抓取点距窗口顶的物理像素；200% DPI 下顶栏在 T+32..T+76，默认 22 会落空
)
# Real-button drag against a widget window, driven by the OS input path
# (SetCursorPos + mouse_event), i.e. indistinguishable from a human drag --
# this is the only way to exercise the native caption drag loop at all.
# Pure ASCII output.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RD {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
        if (sb.ToString() == title) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Down(uint f) { mouse_event(f, 0, 0, 0, IntPtr.Zero); }
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing, System.Windows.Forms

[void][RD]::SetProcessDPIAware()

if ($ReleaseOnly) {
  # second half of a split test: the button is still held from a -NoUp run
  $up = 0x0004
  if ($Mode -eq "middle") { $up = 0x0040 }
  [RD]::Down($up)
  Start-Sleep -Milliseconds 220
  $h2 = [RD]::Find($Title)
  if ($h2 -ne [IntPtr]::Zero) {
    $rr = New-Object RD+RECT; [void][RD]::GetWindowRect($h2, [ref]$rr)
    Write-Output ("AFTER={0},{1},{2},{3}" -f $rr.L, $rr.T, ($rr.R - $rr.L), ($rr.B - $rr.T))
  }
  Write-Output "DONE=1"
  exit 0
}

$h = [RD]::Find($Title)
if ($h -eq [IntPtr]::Zero) { Write-Output "ERR=notfound"; exit 1 }

function Get-Rect { $r = New-Object RD+RECT; [void][RD]::GetWindowRect($h, [ref]$r); return $r }

if ($Probe) {
  $rp = Get-Rect
  Write-Output ("BEFORE={0},{1},{2},{3}" -f $rp.L, $rp.T, ($rp.R - $rp.L), ($rp.B - $rp.T))
  exit 0
}

# 1) park the cursor on the card so it expands (the title bar only exists when expanded)
$r0 = Get-Rect
# 无论是否给了 Grab 覆盖，先停到卡片中心让卡片展开（展开后顶栏才存在）；
# 第二步再按 Grab 覆盖或默认规则计算真正的抓取点
$gx = [int](($r0.L + $r0.R) / 2)
$gy = [int](($r0.T + $r0.B) / 2)
[void][RD]::SetCursorPos($gx, $gy)
Start-Sleep -Milliseconds 750

# 2) re-read: expanded windows grow upward, so the grab point has to be recomputed
$r1 = Get-Rect
if ($GrabX -ge 0 -and $GrabY -ge 0) {
  $gx = $GrabX; $gy = $GrabY
} else {
  $gx = [int](($r1.L + $r1.R) / 2)
  if ($Mode -eq "title") { $gy = [int]($r1.T + $TitleOffPx) } else { $gy = [int]($r1.B - 34) }
}
[void][RD]::SetCursorPos($gx, $gy)
Start-Sleep -Milliseconds 120

Write-Output ("BEFORE={0},{1},{2},{3}" -f $r1.L, $r1.T, ($r1.R - $r1.L), ($r1.B - $r1.T))
Write-Output ("GRAB={0},{1}" -f $gx, $gy)

$down = 0x0002
if ($Mode -eq "middle") { $down = 0x0020 }
[RD]::Down($down)
Start-Sleep -Milliseconds 80

$shotAt = [int]($Steps / 2)
for ($i = 1; $i -le $Steps; $i++) {
  $x = $gx + [int]($DX * $i / $Steps)
  $y = $gy + [int]($DY * $i / $Steps)
  [void][RD]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds $PerStepMs
  if ($i -eq $shotAt -and $ShotDir -ne "") {
    # let the window settle first, otherwise CopyFromScreen tears mid-move
    Start-Sleep -Milliseconds 220
    $rr = Get-Rect
    Add-Type -AssemblyName System.Drawing
    $pad = 30
    $cx = $rr.L - $pad; $cy = $rr.T - $pad
    $cw = ($rr.R - $rr.L) + $pad * 2; $ch = ($rr.B - $rr.T) + $pad * 2
    if ($cw -gt 0 -and $ch -gt 0) {
      $bmp = New-Object System.Drawing.Bitmap $cw, $ch
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($cx, $cy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
      if (-not (Test-Path $ShotDir)) { New-Item -ItemType Directory -Path $ShotDir -Force | Out-Null }
      $bmp.Save((Join-Path $ShotDir "drag-mid.png"), [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      Write-Output ("SHOT={0}" -f (Join-Path $ShotDir "drag-mid.png"))
    }
  }
}

if (-not $NoUp) {
  $up = 0x0004
  if ($Mode -eq "middle") { $up = 0x0040 }
  [RD]::Down($up)
}
Start-Sleep -Milliseconds 260

$r2 = Get-Rect
$p = New-Object RD+POINT; [void][RD]::GetCursorPos([ref]$p)
Write-Output ("AFTER={0},{1},{2},{3}" -f $r2.L, $r2.T, ($r2.R - $r2.L), ($r2.B - $r2.T))
Write-Output ("CURSOR={0},{1}" -f $p.X, $p.Y)
if ($NoUp) { Write-Output "HOLDING=1" } else { Write-Output "DONE=1" }

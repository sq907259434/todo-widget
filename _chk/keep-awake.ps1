param([int]$Seconds = 90)
# Wake the display and keep it awake for a while (SetThreadExecutionState).
$sig = @'
using System;
using System.Runtime.InteropServices;
public class WK {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
Add-Type -TypeDefinition $sig
$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001
$ES_DISPLAY_REQUIRED = 0x00000002
[void][WK]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_DISPLAY_REQUIRED -bor $ES_SYSTEM_REQUIRED)
Write-Output ("AWAKE_FOR=" + $Seconds + "s")
Start-Sleep -Seconds $Seconds
[void][WK]::SetThreadExecutionState($ES_CONTINUOUS)
Write-Output "DONE"

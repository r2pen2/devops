<#
.SYNOPSIS
  Prepare a Windows 11 PC to host the joed.dev stack (bouldergeist). Run once, in PowerShell as Administrator.

.DESCRIPTION
  The stack runs inside a WSL2 Ubuntu distro (systemd + Docker Engine), not Docker Desktop, so every Linux deploy
  script works unchanged. This script:
    1. installs WSL2 and the Ubuntu distro (first launch asks for a username: use the one in hosts/hosts.json, "joe");
    2. writes %UserProfile%\.wslconfig: most of the RAM for the stack, and no idle shutdown of the VM or distro;
    3. adds a scheduled task that starts the distro AT BOOT, signed in or not, and keeps it running (asks once for
       this account's Windows password, which Windows stores with the task);
    4. stops Windows Update from restarting the PC on its own (move the stack to the other host, then restart);
    5. stops the PC from sleeping or hibernating on mains power.
  Then, inside the distro: bash ci/scripts/host/bootstrap.sh bouldergeist   (see docs/hosts.md).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File host\windows\setup.ps1
  powershell -ExecutionPolicy Bypass -File host\windows\setup.ps1 -Distro Ubuntu-24.04 -MemoryGB 12
#>
param(
  [string]$Distro = "Ubuntu-24.04",
  [int]$MemoryGB = 0
)
$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this in PowerShell as Administrator." }

Write-Host "`n== WSL2 and $Distro"
$installed = (wsl.exe --list --quiet 2>$null) -replace "`0", "" | Where-Object { $_ -eq $Distro }
if (-not $installed) {
  wsl.exe --install --no-launch -d $Distro
  Write-Host "Installed. If Windows asks to restart, restart and run this script again."
  Write-Host "Then open '$Distro' from the Start menu once and create the user 'joe'."
} else {
  Write-Host "$Distro is installed."
}
wsl.exe --set-default $Distro 2>$null | Out-Null
wsl.exe --update 2>$null | Out-Null

Write-Host "`n== .wslconfig"
if ($MemoryGB -le 0) {
  $totalGB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
  $MemoryGB = [math]::Max(6, [math]::Floor($totalGB * 0.75))
}
$wslconfig = @"
# Written by r2pen2/devops host/windows/setup.ps1: this PC hosts the joed.dev stack in WSL2.
[wsl2]
memory=${MemoryGB}GB
# Never stop the VM for being idle: the stack serves traffic around the clock.
vmIdleTimeout=-1

[general]
instanceIdleTimeout=-1
"@
Set-Content -Path "$env:USERPROFILE\.wslconfig" -Value $wslconfig -Encoding ascii
Write-Host "memory=${MemoryGB}GB, no idle shutdown ($env:USERPROFILE\.wslconfig)"

Write-Host "`n== Start the stack at boot (no sign-in needed)"
# A sign-in trigger left the sites down for five hours after a Windows Update restart: Windows came back, nobody
# signed in, WSL never started. This task starts at boot and runs whether or not anyone is signed in, which
# needs the account's password stored with the task (Windows keeps it; it isn't written anywhere else).
$taskName = "joed.dev host ($Distro)"
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d $Distro --exec /bin/sh -c 'exec sleep infinity'"
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = "PT30S"
# Also at sign-in, in case the boot-time start lost a race with the WSL service.
$triggers = @($boot, (New-ScheduledTaskTrigger -AtLogOn -User $user))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Hidden
$cred = Get-Credential -UserName $user -Message "Windows password for $user, so the stack starts at boot without a sign-in"
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings `
  -User $user -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Task '$taskName' starts $Distro at boot and keeps it running, signed in or not."

Write-Host "`n== Windows Update: no automatic restarts"
# Updates still download; Windows asks before restarting instead of picking a time itself. Restart when the
# stack is on the other host (promote.mjs <other> --yes), then promote back.
$au = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
New-Item -Path $au -Force | Out-Null
Set-ItemProperty -Path $au -Name NoAutoRebootWithLoggedOnUsers -Value 1 -Type DWord
Set-ItemProperty -Path $au -Name AUOptions -Value 3 -Type DWord   # download automatically, install when told
Set-ItemProperty -Path $au -Name NoAutoUpdate -Value 0 -Type DWord
$ux = "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings"
New-Item -Path $ux -Force | Out-Null
Set-ItemProperty -Path $ux -Name ActiveHoursStart -Value 6 -Type DWord   # widest window Windows allows: 18 hours
Set-ItemProperty -Path $ux -Name ActiveHoursEnd -Value 0 -Type DWord
Write-Host "Windows Update won't restart this PC on its own; active hours 06:00-00:00 as a backstop."

Write-Host "`n== Power: never sleep on mains"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
Write-Host "Sleep and hibernate are off while plugged in."

Write-Host "`n== Next"
Write-Host "Open $Distro and run (as joe):"
Write-Host "  sudo apt-get install -y gh && gh auth login && gh repo clone r2pen2/devops && cd devops"
Write-Host "  bash ci/scripts/host/bootstrap.sh bouldergeist"

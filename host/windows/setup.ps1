<#
.SYNOPSIS
  Prepare a Windows 11 PC to host the joed.dev stack (bouldergeist). Run once, in PowerShell as Administrator.

.DESCRIPTION
  The stack runs inside a WSL2 Ubuntu distro (systemd + Docker Engine), not Docker Desktop, so every Linux deploy
  script works unchanged. This script:
    1. installs WSL2 and the Ubuntu distro (first launch asks for a username: use the one in hosts/hosts.json, "joe");
    2. writes %UserProfile%\.wslconfig: most of the RAM for the stack, and no idle shutdown of the VM or distro;
    3. adds a scheduled task that starts the distro at sign-in and keeps it running (so the sites come back after
       a reboot; turn on automatic sign-in for this account so that happens unattended);
    4. stops the PC from sleeping or hibernating on mains power.
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

Write-Host "`n== Start the stack at sign-in"
$taskName = "joed.dev host ($Distro)"
$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d $Distro --exec /bin/sh -c 'exec sleep infinity'"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Task '$taskName' keeps $Distro running. For unattended reboots, turn on automatic sign-in for $env:USERNAME."

Write-Host "`n== Power: never sleep on mains"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
Write-Host "Sleep and hibernate are off while plugged in."

Write-Host "`n== Next"
Write-Host "Open $Distro and run (as joe):"
Write-Host "  sudo apt-get install -y gh && gh auth login && gh repo clone r2pen2/devops && cd devops"
Write-Host "  bash ci/scripts/host/bootstrap.sh bouldergeist"

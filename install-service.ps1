# Installs whatsarr as a Windows service via NSSM (https://nssm.cc).
# Re-runnable: removes any existing service of the same name first.
# Run as Administrator.
#
# ---- EDIT THESE FOR YOUR SETUP ----
$svc  = "Whatsarr"                                # service name
$nssm = "C:\Tools\nssm\nssm.exe"                  # full path to nssm.exe
$wd   = "C:\Whatsarr"                             # path you cloned whatsarr into
$npm  = "C:\Program Files\nodejs\npm.cmd"         # full path to npm.cmd
# -----------------------------------

$ErrorActionPreference = "Stop"
$logDir  = "$wd\logs"
$stdout  = "$logDir\service.out.log"
$stderr  = "$logDir\service.err.log"

if (-not (Test-Path $nssm)) { throw "NSSM not found at $nssm" }
if (-not (Test-Path $wd))   { throw "Working dir $wd missing" }
if (-not (Test-Path $npm))  { throw "npm.cmd not found at $npm" }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

# Remove any prior install so the script is idempotent.
$existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping and removing existing $svc service..."
  & $nssm stop $svc 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  & $nssm remove $svc confirm 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}

Write-Host "Installing $svc..."
& $nssm install $svc $npm start
& $nssm set $svc AppDirectory   $wd
& $nssm set $svc AppRestartDelay 5000              # 5s delay before restart
& $nssm set $svc AppExit Default Restart           # always restart on exit
& $nssm set $svc AppStdout      $stdout
& $nssm set $svc AppStderr      $stderr
& $nssm set $svc AppRotateFiles 1                  # rotate log files
& $nssm set $svc AppRotateOnline 1
& $nssm set $svc AppRotateBytes 10485760           # rotate at 10 MB
& $nssm set $svc Start          SERVICE_AUTO_START # auto-start on boot
& $nssm set $svc DisplayName    "Whatsarr (WhatsApp request bot)"
& $nssm set $svc Description    "WhatsApp -> Seerr request bot. Source at $wd"

# Run as LocalSystem (no user dependency, can bind to all interfaces incl. tailnet).
& $nssm set $svc ObjectName LocalSystem

Write-Host "Starting $svc..."
& $nssm start $svc
Start-Sleep -Seconds 3

$state = (Get-Service -Name $svc).Status
Write-Host "Service status: $state"
if ($state -ne "Running") {
  Write-Host "Service failed to reach Running state. Check $stderr"
  Get-Content $stderr -ErrorAction SilentlyContinue -Tail 20
  exit 1
}
Write-Host "OK. Logs at $logDir"

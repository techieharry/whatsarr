# Boot-time fix for the Tailscale<->Docker startup race.
#
# If your Seerr docker-compose binds the host port to a specific Tailscale IP
# (e.g. `100.x.x.x:5055`), and Docker Desktop starts before Tailscale has
# registered that interface, the bind silently fails and the container runs
# without a published host port. This script polls until Docker and Tailscale
# are both ready, then restarts the seerr container so the bind succeeds.
#
# Idempotent: a no-op when seerr is already correctly bound.
# Triggered: at user logon (90 s delay), via Scheduled Task — see
# install-boot-fix.cmd for the registration step.
#
# Required environment variables (set in the Scheduled Task or your shell):
#   WHATSARR_TAILSCALE_IP     — your Tailscale IP (e.g. 100.64.10.5)
#   WHATSARR_DOCKER_EXE       — full path to docker.exe
#   WHATSARR_TAILSCALE_EXE    — full path to tailscale.exe
#   WHATSARR_BOOTFIX_LOG      — full path to write the boot-fix log
#   WHATSARR_SEERR_CONTAINER  — name of the seerr container in docker (default: seerr)

$tailscaleIp = if ($env:WHATSARR_TAILSCALE_IP) { $env:WHATSARR_TAILSCALE_IP } else { '' }
$dockerExe   = if ($env:WHATSARR_DOCKER_EXE) { $env:WHATSARR_DOCKER_EXE } else { 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' }
$tsExe       = if ($env:WHATSARR_TAILSCALE_EXE) { $env:WHATSARR_TAILSCALE_EXE } else { 'C:\Program Files\Tailscale\tailscale.exe' }
$logFile     = if ($env:WHATSARR_BOOTFIX_LOG) { $env:WHATSARR_BOOTFIX_LOG } else { 'C:\Whatsarr\boot-fix.log' }
$container   = if ($env:WHATSARR_SEERR_CONTAINER) { $env:WHATSARR_SEERR_CONTAINER } else { 'seerr' }

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

if (-not $tailscaleIp) { Log "WHATSARR_TAILSCALE_IP not set; abort"; exit 1 }
Log "boot-fix start (target IP $tailscaleIp, container $container)"

# Wait for Tailscale up to 3 min.
$tsReady = $false
for ($i = 0; $i -lt 36; $i++) {
  $ping = Test-NetConnection -ComputerName $tailscaleIp -Port 22 -WarningAction SilentlyContinue -InformationLevel Quiet
  if ($ping -or (Test-Connection -ComputerName $tailscaleIp -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
    $tsReady = $true
    Log "tailscale ready after ~$($i * 5)s"
    break
  }
  Start-Sleep -Seconds 5
}
if (-not $tsReady) { Log "tailscale never came up; abort"; exit 1 }

# Wait for Docker daemon up to 3 min.
$dockerReady = $false
for ($i = 0; $i -lt 36; $i++) {
  $null = & $dockerExe info 2>&1
  if ($LASTEXITCODE -eq 0) {
    $dockerReady = $true
    Log "docker ready after ~$($i * 5)s"
    break
  }
  Start-Sleep -Seconds 5
}
if (-not $dockerReady) { Log "docker never responded; abort"; exit 1 }

# Check if seerr's port is bound to the tailscale IP.
$ports = & $dockerExe port $container 2>&1
Log "$container ports: $ports"
if ($ports -match $tailscaleIp) {
  Log "$container port already bound correctly; nothing to do"
  exit 0
}

Log "$container port not bound to $tailscaleIp; restarting"
$out = & $dockerExe restart $container 2>&1
Log "restart result: $out"
Start-Sleep -Seconds 5

$portsAfter = & $dockerExe port $container 2>&1
Log "$container ports after restart: $portsAfter"
if ($portsAfter -match $tailscaleIp) {
  Log "fixed"
  exit 0
} else {
  Log "still not bound after restart; manual investigation needed"
  exit 1
}

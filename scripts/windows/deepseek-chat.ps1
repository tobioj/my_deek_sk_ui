# deepseek-chat (Windows): start the DeepSeek chat app if it isn't running, and open it in its own window.
#   deepseek-chat           open the app
#   deepseek-chat start     start the background server without opening a window
#   deepseek-chat status    show whether the server is running
#   deepseek-chat stop      stop the background server
#   deepseek-chat restart   restart it (rebuilds if the code changed)
#   deepseek-chat logs      follow the server log (Ctrl+C to stop)
param([string]$Command = "open")

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts\windows -> the app folder
$Port = 3456
$Url = "http://127.0.0.1:$Port"
$DataDir = Join-Path $AppDir "data"
$Log = Join-Path $DataDir "server.log"
$BuildLog = Join-Path $DataDir "build.log"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Location $AppDir

function Test-Up {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "$Url/api/health" | Out-Null; return $true } catch { return $false }
}

function Get-ServerProcessId {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess } else { return $null }
}

function Stop-Server {
  $serverId = Get-ServerProcessId
  if (-not $serverId) { return $false }
  # /T also ends the npm and cmd processes that started the server.
  & taskkill.exe /PID $serverId /T /F | Out-Null
  for ($i = 0; $i -lt 20 -and (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
  return $true
}

function Stop-WithError([string]$Message) {
  Write-Host $Message -ForegroundColor Red
  if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" | Out-Null }
  exit 1
}

switch ($Command) {
  "status" {
    if (Test-Up) { Write-Host "Running at $Url (pid $(Get-ServerProcessId))" } else { Write-Host "Not running. Start it with: deepseek-chat" }
    exit 0
  }
  "stop" {
    if (Stop-Server) { Write-Host "Stopped." } else { Write-Host "Not running." }
    exit 0
  }
  "restart" { Stop-Server | Out-Null; Start-Sleep -Seconds 1 }
  "logs" {
    if (-not (Test-Path $Log)) { Write-Host "No log yet." ; exit 0 }
    Get-Content -Path $Log -Wait -Tail 50
    exit 0
  }
}

if (-not (Test-Up)) {
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Stop-WithError "Node.js isn't installed (npm wasn't found). Install it from https://nodejs.org, then try again."
  }
  if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
    Write-Host "Installing the app's packages (first run)..."
    & npm.cmd install *> (Join-Path $DataDir "install.log")
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Installing packages failed. See $DataDir\install.log" }
  }
  # Build on first run, or when the code changed since the last build.
  $buildId = Join-Path $AppDir ".next\BUILD_ID"
  $needsBuild = -not (Test-Path $buildId)
  if (-not $needsBuild) {
    $built = (Get-Item $buildId).LastWriteTime
    $sources = @("app", "components", "lib", "proxy.ts", "next.config.ts", "package.json") | ForEach-Object { Join-Path $AppDir $_ }
    $newer = Get-ChildItem -Path $sources -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $built } | Select-Object -First 1
    $needsBuild = [bool]$newer
  }
  if ($needsBuild) {
    Write-Host "Building the app (first run or code changed). This takes about a minute..."
    & npm.cmd run build *> $BuildLog
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Build failed. See $BuildLog" }
  }
  # Start the server in the background, with no window, logging to data\server.log.
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm start > `"$Log`" 2>&1" -WorkingDirectory $AppDir -WindowStyle Hidden
  for ($i = 0; $i -lt 120 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Up)) { Stop-WithError "The server didn't start. See $Log" }
}

if ($Command -eq "start") { Write-Host "Running at $Url"; exit 0 }

# Open as a standalone window (no tabs or address bar): Chrome if installed, otherwise Edge.
$opened = $false
foreach ($browser in @("chrome", "msedge")) {
  try { Start-Process $browser -ArgumentList "--app=$Url" -ErrorAction Stop; $opened = $true; break } catch {}
}
if (-not $opened) { Start-Process $Url }

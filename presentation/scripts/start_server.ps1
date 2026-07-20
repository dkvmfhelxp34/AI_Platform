# 발표 대시보드 정적 서버 실행 (Windows)
# 사용법: powershell -ExecutionPolicy Bypass -File start_server.ps1 [-Port 8787]
param([int]$Port = 8787)

$baseDir = Split-Path -Parent $PSScriptRoot
$webDir = Join-Path $baseDir "web"
$logDir = Join-Path $baseDir "logs"
New-Item -ItemType Directory -Force $logDir | Out-Null

$proc = Start-Process -FilePath "python" `
    -ArgumentList "-m", "http.server", "$Port", "--bind", "0.0.0.0" `
    -WorkingDirectory $webDir `
    -RedirectStandardOutput (Join-Path $logDir "http_server_$Port.out.log") `
    -RedirectStandardError (Join-Path $logDir "http_server_$Port.err.log") `
    -PassThru -WindowStyle Hidden

Start-Sleep -Seconds 1
if (-not $proc.HasExited) {
    Set-Content (Join-Path $logDir "http_server_$Port.pid") $proc.Id
    Write-Host "시작됨: http://localhost:$Port/  (PID $($proc.Id))"
} else {
    Write-Host "시작 실패 — $logDir\http_server_$Port.err.log 확인"
    exit 1
}

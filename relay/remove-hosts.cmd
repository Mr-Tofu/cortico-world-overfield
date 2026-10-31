@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限：右键本文件 ^> 以管理员身份运行
  pause
  exit /b 1
)
set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"
powershell -NoProfile -Command "$p = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'; $lines = Get-Content -LiteralPath $p; $kept = $lines | Where-Object { $_ -notmatch 'coopanion-overfield-relay' }; if ($kept.Count -ne $lines.Count) { Set-Content -LiteralPath $p -Value $kept -Encoding ASCII; Write-Output '已移除中转 hosts 行。' } else { Write-Output '没有找到中转 hosts 行。' }"
ipconfig /flushdns >nul
pause

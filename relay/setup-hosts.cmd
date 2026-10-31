@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo 需要管理员权限：右键本文件 ^> 以管理员身份运行
  pause
  exit /b 1
)
set "HOSTS=%SystemRoot%\System32\drivers\etc\hosts"
findstr /C:"coopanion-overfield-relay" "%HOSTS%" >nul 2>&1
if not errorlevel 1 (
  echo 已经配置过，跳过。
) else (
  echo.>>"%HOSTS%"
  echo 127.0.0.1 dsp-prod-of.inutan.com # coopanion-overfield-relay>>"%HOSTS%"
  echo 已添加：127.0.0.1 dsp-prod-of.inutan.com
)
ipconfig /flushdns >nul
echo.
echo 完成。之后用 Coopanion 启动「本地中转」即可；不玩时如果 Coopanion 没开，
echo 游戏会卡在登录，运行 remove-hosts.cmd 可以撤销。
pause

@echo off
setlocal

REM Registers boot-fix-seerr.ps1 as a Scheduled Task that runs at logon.
REM Edit SCRIPT + LOG below for your install path before running.

set TASKNAME=WhatsarrBootFix
set SCRIPT=C:\Whatsarr\boot-fix-seerr.ps1
set LOG=C:\Whatsarr\logs\install-boot-fix.log

echo Installing scheduled task %TASKNAME%... > "%LOG%"

schtasks /Delete /TN "%TASKNAME%" /F >nul 2>&1

schtasks /Create ^
  /TN "%TASKNAME%" ^
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%SCRIPT%\"" ^
  /SC ONLOGON ^
  /DELAY 0001:30 ^
  /RL HIGHEST ^
  /F >> "%LOG%" 2>&1

echo errorlevel: %errorlevel% >> "%LOG%"
echo --- task info --- >> "%LOG%"
schtasks /Query /TN "%TASKNAME%" /V /FO LIST >> "%LOG%" 2>&1

exit /b 0

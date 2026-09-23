@echo off
rem Headless CLI wrapper shipped next to "aion-pak-manager.exe".
rem Usage: aion-pak <unpak|repak|decrypt> <args>
rem Captures the GUI build's stdout/stderr (no console attached) into a temp
rem file and prints it back, so output is visible from the terminal.
setlocal
set "OUT=%TEMP%\aion-pak-cli-%RANDOM%%RANDOM%.log"
"%~dp0aion-pak-manager.exe" cli %* > "%OUT%" 2>&1
set "CODE=%ERRORLEVEL%"
type "%OUT%"
del "%OUT%" >nul 2>&1
endlocal & exit /b %CODE%

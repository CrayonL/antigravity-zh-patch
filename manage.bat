@echo off
REM Pure ASCII + CRLF launcher for Antigravity ZH patch manager (UI rendered in patcher.js)
chcp 65001 >nul
setlocal

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH. Please install Node.js first.
    pause
    exit /b 1
)

node "%~dp0patcher.js" interactive
if errorlevel 1 pause
exit /b %errorlevel%

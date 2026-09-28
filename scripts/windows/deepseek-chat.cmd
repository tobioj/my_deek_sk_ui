@echo off
REM deepseek-chat for Windows. Runs deepseek-chat.ps1 without changing your PowerShell settings.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deepseek-chat.ps1" %*

@echo off
setlocal
set "DUIPAI_DATA_DIR=%~dp0data"
set "DUIPAI_USER_DATA_DIR=%~dp0.cache\electron-profile"
start "" "%~dp0release\Duipai-1.0.5-win-x64.exe"

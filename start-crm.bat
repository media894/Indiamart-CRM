@echo off
cd /d "%~dp0"
npm start >> server-out.log 2>> server-err.log

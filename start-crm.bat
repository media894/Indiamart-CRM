@echo off
cd /d "%~dp0"
python run_crm.py >> server-out.log 2>> server-err.log

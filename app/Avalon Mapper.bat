@echo off
rem Запуск Avalon Mapper с правами администратора.
rem Права нужны потому, что процесс Albion Online защищён BattlEye и работает с повышенной
rem целостностью: Windows не отдаёт события мыши/клавиатуры хуку обычного процесса,
rem пока фокус на окне игры — то есть хоткей молчал бы именно во время игры.

net session >nul 2>&1
if %errorlevel% equ 0 goto :run

rem прав нет — перезапускаем себя через UAC
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .

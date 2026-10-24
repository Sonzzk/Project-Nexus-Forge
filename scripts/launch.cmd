@echo off
rem Launches GameDev Command Center from this checkout (desktop shortcut target). Runs the dev app.
cd /d "%~dp0.."
if not exist package.json (
  echo package.json not found in %CD%.
  echo This shortcut must stay in the scripts folder of the project checkout.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Dependencies are not installed. Run "npm install" in:
  echo   %CD%
  echo.
  pause
  exit /b 1
)
call npm run dev
if errorlevel 1 (
  echo.
  echo The app exited with an error. See the output above.
  pause
)

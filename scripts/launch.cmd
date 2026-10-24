@echo off
rem Launches GameDev Command Center from this checkout. Desktop shortcut target.
rem Until Step 3 scaffolds the Electron app there is nothing to run, so say so instead of failing silently.
cd /d "%~dp0.."
if not exist package.json (
  echo GameDev Command Center is not built yet.
  echo The Electron app is scaffolded in Step 3 of docs\ROADMAP.md; only the plan exists so far.
  echo This shortcut will open the app once Step 3 is done.
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

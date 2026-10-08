@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem QuotaOps local-only Windows launcher. No administrator privileges needed.
pushd "%~dp0" >nul 2>&1
if errorlevel 1 goto error_directory

if not "%~2"=="" goto error_usage
if not "%~1"=="" if /I not "%~1"=="--check" goto error_usage

where node.exe >nul 2>&1
if errorlevel 1 goto error_node_missing

where npm.cmd >nul 2>&1
if errorlevel 1 goto error_npm_missing

node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=14)?0:1)" >nul 2>&1
if errorlevel 1 goto error_node_version

if not exist "package.json" goto error_package
if not exist "package-lock.json" goto error_lockfile

if /I "%~1"=="--check" (
  echo [QuotaOps] Launcher prerequisites OK. Nothing was started.
  popd
  exit /b 0
)

echo.
echo [QuotaOps] Starting local dashboard and collector...
echo [QuotaOps] This launcher does not require administrator rights.

rem Install only when needed, using the committed lockfile and no lifecycle scripts.
if not exist "node_modules\.bin\next.cmd" (
  echo [QuotaOps] Dependencies are missing. Running npm ci once...
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 goto error_install
)

rem Refuse to start when either loopback port is already owned by a process.
rem Never assume an unknown process on these ports belongs to QuotaOps.
node -e "const s=require('node:net').createServer();s.once('error',()=>process.exitCode=1);s.listen(4317,'127.0.0.1',()=>s.close())" >nul 2>&1
if errorlevel 1 goto error_collector_port

node -e "const s=require('node:net').createServer();s.once('error',()=>process.exitCode=1);s.listen(3000,'127.0.0.1',()=>s.close())" >nul 2>&1
if errorlevel 1 goto error_dashboard_port

rem Two visible terminals make errors inspectable and allow Ctrl+C shutdown.
start "QuotaOps - Collector" /D "%~dp0" cmd.exe /k "call npm run collector:start"
if errorlevel 1 goto error_launch

rem Explicit localhost binding, independent of npm dev defaults.
start "QuotaOps - Dashboard" /D "%~dp0" cmd.exe /k "call node_modules\.bin\next.cmd dev --hostname 127.0.0.1"
if errorlevel 1 goto error_launch

echo [QuotaOps] Checking dashboard readiness at 127.0.0.1:3000...
for /L %%I in (1,1,45) do (
  node -e "fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
  if not errorlevel 1 goto dashboard_ready
  timeout /t 1 /nobreak >nul
)

echo [QuotaOps] Dashboard did not become ready. Check the two terminal windows.
echo [QuotaOps] No external website was opened.
popd
pause
exit /b 1

:dashboard_ready
echo [QuotaOps] Dashboard is ready. Opening your browser...
start "" "http://127.0.0.1:3000/"
echo [QuotaOps] Keep the Collector and Dashboard terminal windows open.
echo [QuotaOps] Press Ctrl+C in each terminal to stop QuotaOps.
popd
exit /b 0

:error_directory
echo [QuotaOps] Cannot open the repository directory.
goto fail

:error_usage
echo Usage: start-quotaops.bat [--check]
goto fail

:error_node_missing
echo [QuotaOps] Node.js is missing. Install Node.js 22.14 or newer, then retry.
goto fail

:error_npm_missing
echo [QuotaOps] npm.cmd is not available in PATH. Check your Node.js installation.
goto fail

:error_node_version
echo [QuotaOps] Node.js 22.14 or newer is required. Recommended: 22.21.0.
goto fail

:error_package
echo [QuotaOps] package.json was not found next to this launcher.
goto fail

:error_lockfile
echo [QuotaOps] package-lock.json was not found. Refusing unlocked dependency installation.
goto fail

:error_install
echo [QuotaOps] npm ci failed. Review the output above before retrying.
goto fail

:error_collector_port
echo [QuotaOps] Port 4317 is already in use. Inspect the existing process first.
goto fail

:error_dashboard_port
echo [QuotaOps] Port 3000 is already in use. Inspect the existing process first.
goto fail

:error_launch
echo [QuotaOps] Could not open a terminal. Inspect any window that was started.
goto fail

:fail
popd
pause
exit /b 1

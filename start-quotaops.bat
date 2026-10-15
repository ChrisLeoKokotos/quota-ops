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
if not exist "node_modules\.bin\next.cmd" goto install_dependencies
rem Validate the complete production dependency tree against package.json.
rem Presence of a single executable or resolved module is not sufficient.
call npm ls --depth=0 --omit=dev >nul 2>&1
if errorlevel 1 goto install_dependencies
goto dependencies_ready

:install_dependencies
(
  echo [QuotaOps] Dependencies are missing or incomplete. Running npm ci...
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 goto error_install
)

:dependencies_ready
rem The collector still uses a fixed port, so refuse to start when it is
rem already owned. Never assume an unknown process on it belongs to QuotaOps.
node -e "const s=require('node:net').createServer();s.once('error',()=>process.exitCode=1);s.listen(4317,'127.0.0.1',()=>s.close())" >nul 2>&1
if errorlevel 1 goto error_collector_port

rem The dashboard takes an OS-allocated port, so there is no fixed port to
rem pre-check. The server itself refuses to start beside a live instance.

rem Two visible terminals make errors inspectable and allow Ctrl+C shutdown.
start "QuotaOps - Collector" /D "%~dp0" cmd.exe /k "call npm run collector:start"
if errorlevel 1 goto error_launch

rem Always start through the package script. Invoking Next.js directly
rem bypasses the trusted dashboard server that enforces the loopback peer
rem boundary, which leaves the snapshot route correctly failing closed.
start "QuotaOps - Dashboard" /D "%~dp0" cmd.exe /k "call npm run dev"
if errorlevel 1 goto error_launch

rem A 200 from the dashboard shell does not prove the collector started, and
rem the dashboard port is allocated at launch. The probe confirms the listener
rem is this QuotaOps instance, checks the collector separately, and prints the
rem dashboard URL on its last line.
echo [QuotaOps] Waiting for the dashboard and collector to come up...
set "QUOTAOPS_URL="
set "QUOTAOPS_OUT=%TEMP%\quotaops-readiness-%RANDOM%%RANDOM%.txt"

rem Redirect rather than pipe: `for /f` would mask the probe's exit code.
node --experimental-strip-types "%~dp0scripts\launcher-readiness.ts" > "%QUOTAOPS_OUT%" 2>&1
set "QUOTAOPS_RC=%ERRORLEVEL%"
if exist "%QUOTAOPS_OUT%" type "%QUOTAOPS_OUT%"
if not "%QUOTAOPS_RC%"=="0" goto error_not_ready

rem The probe prints the dashboard URL as its last line.
for /f "usebackq delims=" %%U in ("%QUOTAOPS_OUT%") do set "QUOTAOPS_LAST=%%U"
del "%QUOTAOPS_OUT%" >nul 2>&1

rem Only accept a loopback http:// address as the URL to open.
echo %QUOTAOPS_LAST%| findstr /b /c:"http://127.0.0.1:" >nul 2>&1
if errorlevel 1 goto error_no_url
set "QUOTAOPS_URL=%QUOTAOPS_LAST%"
goto services_ready

:error_no_url
echo [QuotaOps] The readiness probe did not report a dashboard address.
goto error_not_ready

:error_not_ready
if exist "%QUOTAOPS_OUT%" del "%QUOTAOPS_OUT%" >nul 2>&1
echo [QuotaOps] QuotaOps did not start completely. Read the reason above,
echo [QuotaOps] then check the Collector and Dashboard terminal windows.
echo [QuotaOps] No external website was opened.
popd
pause
exit /b 1

:services_ready
echo [QuotaOps] Dashboard and collector are running. Opening your browser...
start "" "%QUOTAOPS_URL%"
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

:error_launch
echo [QuotaOps] Could not open a terminal. Inspect any window that was started.
goto fail

:fail
popd
pause
exit /b 1

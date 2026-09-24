@echo off
REM Runs cargo on the Tauri app inside the MSVC environment Kessel builds
REM with on Windows: Visual Studio 2022's C++ tools and the Windows 10 SDK
REM 10.0.19041.0. Newer toolsets (Visual Studio 2026 / MSVC 14.50) fail on
REM the vswhom-sys crate, and a plain terminal picks the newest one -- see
REM the README. Same environment as kessel-dev.bat, but it finds Visual
REM Studio 2022 wherever it's installed.
REM
REM   scripts\cargo-msvc.cmd build
REM   scripts\cargo-msvc.cmd build --features tauri/custom-protocol --target-dir target\e2e
setlocal
REM vcvarsall runs vswhere.exe from its own folder, which fails when this is
REM set (some shells set it to stop programs running from the current folder).
set "NoDefaultCurrentDirectoryInExePath="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Installer not found. Install Visual Studio 2022 with "Desktop development with C++".
  exit /b 1
)
set "VS2022="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -version [17.0^,18.0^) -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS2022=%%i"
if not defined VS2022 (
  echo Visual Studio 2022 with the C++ tools isn't installed.
  exit /b 1
)
call "%VS2022%\VC\Auxiliary\Build\vcvarsall.bat" amd64 10.0.19041.0 >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0..\tauri-browser\src-tauri"
cargo %*

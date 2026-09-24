@echo off
REM Loads the MSVC build environment (pinned to the older Windows SDK
REM that avoids the compiler bug we hit earlier) and jumps into the
REM Kessel project folder. Leaves you at a normal prompt -- run
REM `npm run dev` yourself whenever you're ready.

call "D:\visual studio\product\VC\Auxiliary\Build\vcvarsall.bat" amd64 10.0.19041.0
cd /d "%~dp0tauri-browser"
cmd /k

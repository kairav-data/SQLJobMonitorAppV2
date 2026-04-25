@echo off
echo ============================================
echo  SQL Job Monitor  —  Building .exe
echo ============================================

:: Activate virtual environment
call venv\Scripts\activate

:: Clean previous builds
rmdir /s /q build dist 2>nul

:: Build using the fixed spec file which correctly bundles the web/ folder
pyinstaller --noconfirm SQL_Job_Monitor_v1.spec

echo.
if exist dist\SQL_Job_Monitor_v1.exe (
  echo  [OK] Build complete: dist\SQL_Job_Monitor_v1.exe
) else (
  echo  [FAIL] Build failed — check output above.
)
echo ============================================
pause

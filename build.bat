@echo off
echo ============================================
echo  SQL Job Monitor  -  Building .exe
echo ============================================

:: Check if venv exists, create it if not
if not exist venv (
    echo [INFO] Creating virtual environment...
    python -m venv venv
)

:: Activate virtual environment
echo [INFO] Activating virtual environment...
call venv\Scripts\activate

:: Install requirements and pyinstaller
echo [INFO] Installing dependencies...
python -m pip install --upgrade pip
pip install -r requirements.txt
pip install pyinstaller pywebview pyodbc

:: Clean previous builds
echo [INFO] Cleaning old builds...
rmdir /s /q build dist 2>nul

:: Build using the fixed spec file which correctly bundles the web/ folder
echo [INFO] Building executable...
pyinstaller --noconfirm SQL_Job_Monitor_v1.spec
if exist app_db_config.json (
    echo [INFO] Copying app_db_config.json to dist...
    copy /y app_db_config.json dist\
)
if exist app_db_config.example.json (
    echo [INFO] Copying app_db_config.example.json to dist...
    copy /y app_db_config.example.json dist\
)

echo.
if exist dist\SQL_Job_Monitor_v1.exe (
  echo  [OK] Build complete: dist\SQL_Job_Monitor_v1.exe
) else (
  echo  [FAIL] Build failed - check output above.
)
echo ============================================
pause

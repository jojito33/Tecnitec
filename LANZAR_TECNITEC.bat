@echo off
TITLE TECNITEC CORE v31.81 - Lanzador
color 1f

echo ======================================================
echo           TECNITEC CORE v31.81 - SISTEMA
echo ======================================================
echo.

:: 1. Ir al directorio del proyecto
cd /d "%~dp0"

:: 2. Verificar Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado. Instalalo desde nodejs.org
    pause
    exit /b
)

:: 3. Instalar dependencias si faltan
if not exist "node_modules\" (
    echo [SISTEMA] Instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Fallo la instalacion de dependencias.
        pause
        exit /b
    )
)

:: 4. Reconstruir modulo nativo para Electron
echo [SISTEMA] Reconstruyendo modulo nativo para Electron...
call npm run rebuild
if errorlevel 1 (
    echo [SISTEMA] Fallo electron-rebuild, intentando npm rebuild...
    call npm rebuild better-sqlite3
)
if errorlevel 1 (
    echo [ERROR] No se pudo reconstruir better-sqlite3.
    pause
    exit /b
)

:: 5. Verificar binario de Electron
if not exist "node_modules\electron\dist\electron.exe" (
    echo [SISTEMA] Instalando binario de Electron...
    node install-electron.js
    if errorlevel 1 (
        echo [ERROR] No se pudo instalar Electron.
        pause
        exit /b
    )
)

:: 6. Lanzar aplicacion Electron
echo [SISTEMA] Iniciando TECNITEC CORE...
echo ------------------------------------------------------

node_modules\electron\dist\electron.exe --no-sandbox --disable-disk-cache .

echo.
echo [SISTEMA] Aplicacion cerrada.
pause
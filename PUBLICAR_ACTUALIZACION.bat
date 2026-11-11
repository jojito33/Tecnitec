@echo off
setlocal enabledelayedexpansion
title TECNITEC - Auto-Publicador de Actualizaciones
color 0a

:: Posicionarse en la carpeta del proyecto
cd /d "%~dp0"

echo ============================================================
echo   TECNITEC - AUTO-PUBLICADOR DE ACTUALIZACIONES
echo ============================================================
echo  Directorio: %CD%
echo  Monitoreando cambios en el proyecto automaticamente...
echo  Cada vez que guardes cambios, se publicara a GitHub.
echo  Presiona Ctrl+C en cualquier momento para detener.
echo ============================================================
echo.

:check_changes
set "HAS_CHANGES="
for /f "delims=" %%A in ('git status --porcelain 2^>nul') do (
    set "HAS_CHANGES=1"
)

if not defined HAS_CHANGES goto no_changes

echo.
echo ============================================================
echo [%TIME%] Cambios detectados en el proyecto:
echo ============================================================
for /f "delims=" %%A in ('git status --porcelain 2^>nul') do (
    echo   %%A
)
echo.
echo Esperando 3 segundos para confirmar guardado completo...
ping 127.0.0.1 -n 4 >nul

echo [1/3] Guardando cambios locales...
git add -A
git commit -m "actualizacion automatica [%DATE% %TIME%]"
if errorlevel 1 (
    echo [ERROR] No se pudo realizar el commit local.
    if "%~1"=="--once" exit /b 1
    ping 127.0.0.1 -n 6 >nul
    goto loop
)

echo.
echo [2/3] Incrementando version con npm version patch...
call npm version patch
if errorlevel 1 (
    echo [ERROR] No se pudo incrementar la version en package.json.
    if "%~1"=="--once" exit /b 1
    ping 127.0.0.1 -n 6 >nul
    goto loop
)

echo.
echo [3/3] Subiendo cambios y version a GitHub...
git push origin main --follow-tags
if errorlevel 1 (
    echo [ERROR] Error al hacer git push a GitHub. Verifica conexion a internet.
    if "%~1"=="--once" exit /b 1
    ping 127.0.0.1 -n 11 >nul
    goto loop
)

echo.
echo ============================================================
echo  [OK] Actualizacion publicada exitosamente a las %TIME%
echo  GitHub Actions construira el nuevo instalador.
echo ============================================================
powershell -NoProfile -Command "[console]::beep(1000, 200)" >nul 2>&1
if "%~1"=="--once" (
    pause
    exit /b 0
)

echo.
echo Monitoreando nuevos cambios...
goto loop

:no_changes
if "%~1"=="--once" (
    echo No hay cambios pendientes para publicar.
    pause
    exit /b 0
)

:loop
REM Esperar 5 segundos antes de volver a verificar cambios
ping 127.0.0.1 -n 6 >nul
goto check_changes

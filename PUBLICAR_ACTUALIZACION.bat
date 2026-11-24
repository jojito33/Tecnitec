@echo off
setlocal enabledelayedexpansion
title TECNITEC - Auto-Publicador de Actualizaciones
color 0a

:: Acepta --once (una pasada) y --dry-run (solo muestra que haria)
cd /d "%~dp0"
set "ARG=%~1"
if /i "%ARG%"=="--once" set "MODO=once"
if /i "%ARG%"=="--dry-run" set "MODO=dry"
if not defined MODO set "MODO=loop"

echo ============================================================
echo   TECNITEC - AUTO-PUBLICADOR DE ACTUALIZACIONES
echo ============================================================
echo  Directorio: %CD%
echo  Modo: %MODO%
echo  Ctrl+C en cualquier momento para detener.
echo ============================================================

git fetch origin --quiet >nul 2>&1

:check
set "HAS_CHANGES="
for /f "delims=" %%A in ('git status --porcelain 2^>nul') do set "HAS_CHANGES=1"

set "PENDIENTES=0"
for /f "delims=" %%A in ('git rev-list --count origin/main..HEAD 2^>nul') do set "PENDIENTES=%%A"

if defined HAS_CHANGES goto con_cambios
if "%PENDIENTES%"=="0" goto sin_nada

echo.
echo [INFO] Sin cambios locales, pero hay %PENDIENTES% commit(s) sin publicar.
if "%MODO%"=="dry" (
    echo [DRY-RUN] git push origin main --follow-tags
    goto fin
)
echo [1/1] Subiendo commits pendientes a GitHub...
git push origin main --follow-tags
if errorlevel 1 goto error_push
echo [OK] Commits publicados. GitHub Actions va a construir el instalador.
goto fin

:con_cambios
echo.
echo ============================================================
echo [%TIME%] Cambios detectados en el proyecto:
echo ============================================================
for /f "delims=" %%A in ('git status --porcelain 2^>nul') do echo   %%A
echo.
echo Esperando 3 segundos para confirmar guardado completo...
ping 127.0.0.1 -n 4 >nul

if "%MODO%"=="dry" (
    echo [DRY-RUN] git add -A
    echo [DRY-RUN] git commit -m "actualizacion automatica [%DATE% %TIME%]"
    echo [DRY-RUN] npm version patch
    echo [DRY-RUN] git push origin main --follow-tags
    goto fin
)

echo [1/3] Guardando cambios locales...
git add -A
git commit -m "actualizacion automatica [%DATE% %TIME%]"
if errorlevel 1 (
    echo [ERROR] No se pudo hacer el commit local.
    goto error_generico
)

echo [2/3] Incrementando version con npm version patch...
call npm version patch
if errorlevel 1 (
    echo [ERROR] No se pudo incrementar la version en package.json.
    goto error_generico
)

echo [3/3] Publicando en GitHub...
git push origin main --follow-tags
if errorlevel 1 goto error_push

echo.
echo [OK] Actualizacion publicada a las %TIME%.
echo GitHub Actions construira el nuevo instalador.
goto fin

:sin_nada
echo.
echo [INFO] No hay cambios para commitear ni commits sin publicar.
goto fin

:error_push
echo.
echo [ERROR] Fallo git push. Revisa conexion, credenciales de GitHub o conflictos.
goto error_generico

:error_generico
if "%MODO%"=="once" (
    echo.
    pause
    exit /b 1
)
echo.
echo Reintentando en 10 segundos... (Ctrl+C para salir)
ping 127.0.0.1 -n 11 >nul
goto check

:fin
if /i "%MODO%"=="dry" goto :eof
if /i "%MODO%"=="once" (
    echo.
    pause
    goto :eof
)
echo.
echo [INFO] Monitoreando cambios cada 5 segundos... (Ctrl+C para salir)
ping 127.0.0.1 -n 6 >nul
goto check

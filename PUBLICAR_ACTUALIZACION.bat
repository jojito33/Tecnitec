@echo off
title TECNITEC - Publicar Actualizacion
echo ========================================
echo  Publicando actualizacion de TECNITEC
echo ========================================
echo.

echo [1/3] Guardando cambios locales...
git add -A
git commit -m "actualizacion"
echo.

echo [2/3] Subiendo version...
call npm version patch
echo.

echo [3/3] Subiendo a GitHub...
git push origin main
echo.

echo ========================================
echo  Actualizacion publicada exitosamente
echo  GitHub Actions construira el instalador
echo ========================================
pause

@echo off
TITLE Quantum Cost Control - Servidor OFICIAL
echo ==========================================
echo   Quantum Cost Control - Sistema de Costeo
echo ==========================================
echo [+] Verificando entorno de Node.js...

cd /d "%~dp0"

if not exist node_modules (
    echo [!] Instalando dependencias necesarias...
    call npm install
)

echo [+] Iniciando servidor en el puerto 8001...
echo [+] Una vez iniciado, abre http://localhost:8001 en tu navegador.
echo.
node server-recetas.js
pause
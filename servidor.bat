@echo off
REM Simple HTTP Server usando certutil (Windows built-in)
REM Sirve archivos del directorio actual en puerto 8000

setlocal enabledelayedexpansion

set "PORT=8000"
set "ROOT=%CD%"

echo Iniciando servidor HTTP en http://localhost:%PORT%
echo Raiz del directorio: %ROOT%
echo Presione Ctrl+C para detener

REM Crear un listener simple usando netsh (Windows built-in)
netsh http add urlacl url=http://+:%PORT%/ user=everyone

REM Usar una alternativa: crear un servidor Python embebido
python -m http.server %PORT% --directory "%ROOT%"

pause

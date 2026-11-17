@echo off
REM Cofilius - abre o painel (dois cliques neste arquivo). Deixe a janela aberta enquanto usa.
title Cofilius
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js nao esta instalado neste computador.
  echo  Vou abrir a pagina de download: instale a versao LTS e depois abra o Cofilius de novo.
  echo.
  start "" "https://nodejs.org/pt"
  pause
  exit /b 1
)

echo.
echo  Preparando o Cofilius (na primeira vez leva alguns minutos)...
call npm.cmd install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo  Nao consegui instalar as dependencias. Confira a internet e tente de novo.
  pause
  exit /b 1
)

echo.
echo  Abrindo o painel no navegador...
echo  IMPORTANTE: deixe esta janela aberta enquanto usa o Cofilius. Para fechar, feche esta janela.
echo.
call npm.cmd run painel
echo.
echo  O painel foi encerrado.
pause

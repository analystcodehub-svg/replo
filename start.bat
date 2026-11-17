@echo off
title Female Expert Node.js Client - Calling & Messaging
color 0A
set "PATH=C:\Users\aem\AppData\Local\Programs\NodeJS;%PATH%"
cd /d "C:\Users\aem\Desktop\female_node_client"
echo ========================================================
echo       Starting Female Expert Node.js Client...
echo ========================================================
node index.js
if %errorlevel% neq 0 (
    echo.
    echo Node.js client terminated with an error code: %errorlevel%
    pause
)

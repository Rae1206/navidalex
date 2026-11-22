@echo off
rem Windows adaptation: Herdr starts mod commands with a PATH that has no Node,
rem and the bin shims npx runs call "node" from PATH. Put Node first, then run the
rem given command (main.js passes: npx -y agenttrail@<version> <repo> --no-open).
set "PATH=%LOCALAPPDATA%\pi-node\current;%ProgramFiles%\nodejs;%PATH%"
%*

# Installs Parley's desktop app on Windows, the terminal way:
#   irm https://<this site>/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$installer = Join-Path $env:TEMP 'Parley-setup.exe'
Write-Host 'Downloading Parley...'
Invoke-WebRequest -UseBasicParsing -OutFile $installer `
  -Uri 'https://github.com/lepreem/parley/releases/latest/download/Parley-windows-x64.exe'
Unblock-File $installer
Start-Process -FilePath $installer -Wait
Remove-Item $installer
Write-Host 'Installed. Open Parley from the Start menu.'

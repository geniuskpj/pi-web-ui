# robust pi-web-ui restart: kill whoever owns :8787, start fresh, verify
$owner = (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($owner) { Stop-Process -Id $owner -Force; Start-Sleep -Milliseconds 1000 }
Start-Process -FilePath "C:\node-v26.5.0-win-x64\node.exe" -ArgumentList "server.mjs" -WorkingDirectory "C:\pi-windows-x64\ws\pi-web-ui" -WindowStyle Hidden -RedirectStandardOutput "C:\pi-windows-x64\ws\pi-web-ui\server-out.log" -RedirectStandardError "C:\pi-windows-x64\ws\pi-web-ui\server-err.log"
Start-Sleep -Seconds 3
$p = (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if (-not $p) { Write-Output "SERVER FAILED TO START"; exit 1 }
Write-Output ("pid: $p started: " + (Get-Process -Id $p).StartTime)

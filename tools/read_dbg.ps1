$c = Get-Content "$env:TEMP\cas_dbg.html" -Raw
$m = [regex]::Match($c, 'data-dbg="([^"]*)"')
Write-Host ("dbg: " + $m.Groups[1].Value)
$m2 = [regex]::Match($c, 'id="hud-dist"[^>]*>([^<]*)')
Write-Host ("hud: " + $m2.Groups[1].Value)

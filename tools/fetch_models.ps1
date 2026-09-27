# Download NASA official Cassini-Huygens GLB models (offline build input)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/Cassini-Huygens%20(A)/'
$out = Join-Path $PSScriptRoot '..\data_raw\models'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$files = @(
  'Cassini-Huygens (A).glb',
  'Cassini-Huygens (A) (without Cassini).glb',
  'Cassini-Huygens (A) (without Hyugens).glb'
)
foreach ($f in $files) {
  $enc = [Uri]::EscapeDataString($f)
  $dest = Join-Path $out $f
  Invoke-WebRequest -Uri ($base + $enc) -OutFile $dest
  Write-Host ("{0} -> {1} bytes" -f $f, (Get-Item $dest).Length)
}

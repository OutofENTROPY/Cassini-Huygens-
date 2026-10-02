# Download the official Cassini model used by NASA Eyes on the Solar System
# https://eyes.nasa.gov/apps/solar-system/#/sc_cassini
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://eyes.nasa.gov/assets/static/models/sc_cassini/'
$out = Join-Path $PSScriptRoot '..\data_raw\eyes_cassini'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$files = @(
  'Cassini.gltf',
  'cassini.bin',
  'foil_normal.png',
  'cassini_dish_ao.jpg',
  'cassini_normal.png',
  'cassini_albedo.jpg',
  'cassini_pbr.jpg'
)
foreach ($f in $files) {
  $dest = Join-Path $out $f
  Invoke-WebRequest -Uri ($base + $f) -OutFile $dest
  Write-Host ("{0} -> {1} bytes" -f $f, (Get-Item $dest).Length)
}

# Download three.js r147 example loaders + Draco decoder (exact version match with lib/three.min.js)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = 'https://unpkg.com/three@0.147.0/examples/js/'
$lib = Join-Path $PSScriptRoot '..\lib'
New-Item -ItemType Directory -Force -Path $lib | Out-Null
$files = @(
  @{ url = $base + 'loaders/GLTFLoader.js';   out = 'GLTFLoader.js' },
  @{ url = $base + 'loaders/DRACOLoader.js';  out = 'DRACOLoader.js' },
  @{ url = $base + 'libs/draco/draco_wasm_wrapper.js'; out = 'draco_wasm_wrapper.js' },
  @{ url = $base + 'libs/draco/draco_decoder.wasm';    out = 'draco_decoder.wasm' }
)
foreach ($f in $files) {
  $dest = Join-Path $lib $f.out
  Invoke-WebRequest -Uri $f.url -OutFile $dest
  Write-Host ("{0} -> {1} bytes" -f $f.out, (Get-Item $dest).Length)
}
# sanity: check the loaders are non-module builds (attach to THREE global)
$g = Get-Content (Join-Path $lib 'GLTFLoader.js') -TotalCount 5 -Encoding UTF8 | Out-String
Write-Host ("GLTFLoader head: " + ($g.Substring(0, [Math]::Min(160, $g.Length))).Replace("`n", ' '))

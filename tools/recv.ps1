# Local HTTP listener to receive baked dataset from the browser page.
# POST /save  body = raw JSON text  -> written to data\cassini_data.json
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:8790/save/')
$listener.Start()
Write-Host "listening on http://127.0.0.1:8790/save/"
$outDir = 'D:\Programming\HTML\Cassini\data'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
        if ($ctx.Request.HttpMethod -eq 'OPTIONS') {
            $ctx.Response.Headers['Access-Control-Allow-Origin'] = '*'
            $ctx.Response.Headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
            $ctx.Response.Headers['Access-Control-Allow-Headers'] = '*'
            $ctx.Response.StatusCode = 204
            $ctx.Response.Close()
            continue
        }
        $ms = New-Object System.IO.MemoryStream
        $ctx.Request.InputStream.CopyTo($ms)
        $bytes = $ms.ToArray()
        $outPath = Join-Path $outDir ('cassini_data_' + (Get-Date -Format 'HHmmss') + '.json')
        [System.IO.File]::WriteAllBytes($outPath, $bytes)
        Write-Host ("saved " + $outPath + " (" + $bytes.Length + " bytes)")
        $ctx.Response.Headers['Access-Control-Allow-Origin'] = '*'
        $buf = [System.Text.Encoding]::UTF8.GetBytes('saved ' + $bytes.Length)
        $ctx.Response.ContentLength64 = $buf.Length
        $ctx.Response.ContentType = 'text/plain'
        $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
        $ctx.Response.OutputStream.Close()
        $ctx.Response.Close()
    } catch {
        Write-Host "error: $_"
        try { $ctx.Response.Close() } catch {}
    }
}

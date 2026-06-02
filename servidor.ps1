# Servidor HTTP Simple en PowerShell
$port = 8000
$root = "C:\Users\venta\OneDrive\Aplicaciones\proyecto-recetas"

Write-Host "Iniciando servidor HTTP en http://localhost:$port"
Write-Host "Raiz: $root"
Write-Host "Presiona Ctrl+C para detener"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    
    while ($true) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $path = $request.Url.LocalPath
        if ($path -eq "/") { $path = "/index.html" }
        
        $filepath = Join-Path $root $path.TrimStart("/")
        
        if (Test-Path $filepath -PathType Leaf) {
            try {
                $file = [System.IO.File]::ReadAllBytes($filepath)
                $response.ContentLength64 = $file.Length
                
                # Establecer tipo de contenido
                if ($filepath -match "\.js$") {
                    $response.ContentType = "application/javascript"
                } elseif ($filepath -match "\.html$") {
                    $response.ContentType = "text/html"
                } elseif ($filepath -match "\.css$") {
                    $response.ContentType = "text/css"
                } else {
                    $response.ContentType = "application/octet-stream"
                }
                
                $response.OutputStream.Write($file, 0, $file.Length)
                Write-Host "[200] $($request.Url.LocalPath)"
            } catch {
                $response.StatusCode = 500
                Write-Host "[500] Error: $_"
            }
        } else {
            $response.StatusCode = 404
            Write-Host "[404] $($request.Url.LocalPath)"
        }
        
        $response.OutputStream.Close()
    }
} finally {
    $listener.Stop()
    Write-Host "Servidor detenido"
}

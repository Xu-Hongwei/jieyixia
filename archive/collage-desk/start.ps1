param([ValidateRange(1024, 65535)][int]$Port = 5189)
$ErrorActionPreference = 'Stop'
Write-Host "Collage desk: http://127.0.0.1:$Port/?view=inbox"
Write-Host 'Press Ctrl+C to stop.'
python -m http.server $Port --bind 127.0.0.1 --directory $PSScriptRoot

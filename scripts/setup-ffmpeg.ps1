$ErrorActionPreference = 'Stop'
$ffmpegRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tools\ffmpeg'))
$ffmpegArchive = Join-Path $ffmpegRoot 'release.zip'
$ffmpegExtract = Join-Path $ffmpegRoot 'distribution'
$ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
New-Item -ItemType Directory -Path $ffmpegRoot -Force | Out-Null
$ffmpegExpected = ((Invoke-WebRequest -Uri ($ffmpegUrl + '.sha256') -UseBasicParsing).Content -split '\s+')[0].Trim()
if ($ffmpegExpected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Checksum FFmpeg inválido.' }
Write-Output 'Baixando FFmpeg Essentials e verificando SHA-256...'
Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegArchive -UseBasicParsing
if ((Get-FileHash -LiteralPath $ffmpegArchive -Algorithm SHA256).Hash -ne $ffmpegExpected) { throw 'SHA-256 do FFmpeg não confere; pacote não será executado.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ffmpegZip = [IO.Compression.ZipFile]::OpenRead($ffmpegArchive)
try {
  $ffmpegPrefix = [IO.Path]::GetFullPath($ffmpegExtract).TrimEnd('\') + '\'
  foreach ($ffmpegEntry in $ffmpegZip.Entries) {
    $ffmpegTarget = [IO.Path]::GetFullPath((Join-Path $ffmpegExtract $ffmpegEntry.FullName))
    if (-not $ffmpegTarget.StartsWith($ffmpegPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Caminho fora do diretório do FFmpeg.' }
  }
} finally { $ffmpegZip.Dispose() }
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegExtract -Force
$ffmpegExecutable = Get-ChildItem -LiteralPath $ffmpegExtract -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
if (-not $ffmpegExecutable) { throw 'FFmpeg não encontrado no pacote.' }
New-Item -ItemType Directory -Path (Join-Path $ffmpegRoot 'bin') -Force | Out-Null
Copy-Item -LiteralPath $ffmpegExecutable.FullName -Destination (Join-Path $ffmpegRoot 'bin\ffmpeg.exe') -Force
Write-Output 'FFmpeg instalado em tools/ffmpeg/bin. Licença e distribuição preservadas em tools/ffmpeg/distribution.'

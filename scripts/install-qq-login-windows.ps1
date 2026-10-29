param(
    [Parameter(Mandatory = $true)][string]$SourceRuntime,
    [string]$Destination = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Destination) { $Destination = Join-Path $PSScriptRoot '../core/qq-login/native/win32-x64' }
$sourceRoot = (Resolve-Path -LiteralPath $SourceRuntime).Path
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.qqVersion -ne '9.9.35-52892' -or $manifest.napcatVersion -ne '4.18.41' -or
    $manifest.wrapperSha256 -ne 'e698a0abb086a912f1eede06b8d8c6f86f9c1de90ad0c68b1e1c2ee0108f0cbc') {
    throw 'The runtime does not match the verified Windows version.'
}
$programFiles = @($manifest.files.PSObject.Properties)
if ($programFiles.Count -lt 10) { throw 'Incomplete runtime manifest.' }
foreach ($entry in $programFiles) {
    $relative = $entry.Name.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
    if (-not $candidate.StartsWith($sourceRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $entry.Name -match '(^|/)(config|cache|logs|qq-data|state|accounts)(/|$)' -or
        $entry.Name -match '\.(log|dmp)$') {
        throw "Non-program path in runtime manifest: $($entry.Name)"
    }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    if ($actual -ne $entry.Value) { throw "Runtime checksum failed: $($entry.Name)" }
}
if ($sourceRoot.TrimEnd('\') -ne $destinationRoot.TrimEnd('\')) {
    New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
    foreach ($entry in $programFiles) {
        $target = Join-Path $destinationRoot $entry.Name
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourceRoot $entry.Name) -Destination $target -Force
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'manifest.json') -Destination $destinationRoot -Force
}
Write-Host "QQ scan runtime verified: $($programFiles.Count) program files."

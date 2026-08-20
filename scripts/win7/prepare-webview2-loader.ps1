[CmdletBinding()]
param(
  [string]$RepositoryRoot,
  [string]$DownloadDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
if ([string]::IsNullOrWhiteSpace($DownloadDirectory)) {
  $DownloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "goldprice-win7-webview2"
}

$sdkVersion = "1.0.1020.30"
$sdkPackageSha256 = "fbc554d8e06c8c7653cd3adab2afe97faec02a75613bf9f2f8daa5e61348acab"
$legacyLoaderSha256 = "1d8977604839607a0d1563a305862ca31412469dbd88d7652bf42dcbef1dbaef"
$webview2ComSysVersion = "0.19.0"
$upstreamLoaderSha256 = "64d8b1fb0b54bf0d2f03d6f1a8bea02d63bf461c321e6e2ba632397602d497e3"

$repositoryPath = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$manifestPath = Join-Path $repositoryPath "src-tauri\Cargo.toml"
$generatedRoot = Join-Path $repositoryPath "src-tauri\.win7\vendor"
$patchedCrate = Join-Path $generatedRoot "webview2-com-sys"

$metadata = (& cargo metadata --manifest-path $manifestPath --locked --format-version 1 | Out-String) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
  throw "cargo metadata failed while locating webview2-com-sys."
}
$packages = @($metadata.packages | Where-Object { $_.name -eq "webview2-com-sys" -and $_.version -eq $webview2ComSysVersion })
if ($packages.Count -ne 1) {
  throw "Expected exactly one webview2-com-sys $webview2ComSysVersion package, found $($packages.Count)."
}
$sourceCrate = Split-Path -Parent $packages[0].manifest_path
$sourceLoader = Join-Path $sourceCrate "x64\WebView2LoaderStatic.lib"
if (!(Test-Path -LiteralPath $sourceLoader -PathType Leaf)) {
  throw "Missing upstream WebView2 loader: $sourceLoader"
}
$sourceHash = (Get-FileHash -LiteralPath $sourceLoader -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -notin @($upstreamLoaderSha256, $legacyLoaderSha256)) {
  throw "Unknown webview2-com-sys loader SHA256: $sourceHash"
}

if (Test-Path -LiteralPath $patchedCrate) {
  $resolvedPatched = [System.IO.Path]::GetFullPath($patchedCrate)
  $resolvedGenerated = [System.IO.Path]::GetFullPath($generatedRoot)
  if (!$resolvedPatched.StartsWith($resolvedGenerated + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear unexpected generated crate directory: $resolvedPatched"
  }
  Remove-Item -LiteralPath $resolvedPatched -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $generatedRoot | Out-Null
Copy-Item -LiteralPath $sourceCrate -Destination $patchedCrate -Recurse

New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null
$packagePath = Join-Path $DownloadDirectory "Microsoft.Web.WebView2.$sdkVersion.nupkg"
if (!(Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$sdkVersion" -OutFile $packagePath -UseBasicParsing
}
$packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($packageHash -ne $sdkPackageSha256) {
  throw "WebView2 SDK SHA256 mismatch. Expected $sdkPackageSha256, got $packageHash."
}

$extractDirectory = Join-Path $DownloadDirectory "loader-sdk-$sdkVersion"
if (Test-Path -LiteralPath $extractDirectory) {
  Remove-Item -LiteralPath $extractDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDirectory | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $extractDirectory)
$legacyLoader = Join-Path $extractDirectory "build\native\x64\WebView2LoaderStatic.lib"
if (!(Test-Path -LiteralPath $legacyLoader -PathType Leaf)) {
  throw "WebView2 SDK $sdkVersion does not contain the x64 static loader."
}
$legacyHash = (Get-FileHash -LiteralPath $legacyLoader -Algorithm SHA256).Hash.ToLowerInvariant()
if ($legacyHash -ne $legacyLoaderSha256) {
  throw "Legacy WebView2 loader SHA256 mismatch. Expected $legacyLoaderSha256, got $legacyHash."
}

$patchedLoader = Join-Path $patchedCrate "x64\WebView2LoaderStatic.lib"
Copy-Item -LiteralPath $legacyLoader -Destination $patchedLoader -Force
$installedHash = (Get-FileHash -LiteralPath $patchedLoader -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installedHash -ne $legacyLoaderSha256) {
  throw "Failed to install the Win7-compatible WebView2 loader."
}
Write-Host "Prepared isolated webview2-com-sys $webview2ComSysVersion patch at $patchedCrate"

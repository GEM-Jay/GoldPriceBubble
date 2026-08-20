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

$runtimeVersion = "109.0.1518.78"
$runtimeFolderName = "Microsoft.WebView2.FixedVersionRuntime.$runtimeVersion.x64"
$archiveName = "$runtimeFolderName.cab"
$runtimeUrl = "https://github.com/westinyang/WebView2RuntimeArchive/releases/download/$runtimeVersion/$archiveName"
$runtimeSha256 = "7622281cf83de1a35e3a471f432f7a897d65f0a7d3975df08512b7b253dd45c7"
$runtimeArchiveBytes = 207090243

$repositoryPath = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$tauriRoot = (Resolve-Path -LiteralPath (Join-Path $repositoryPath "src-tauri")).Path
$runtimeDirectory = Join-Path $tauriRoot "webview2-fixed-runtime"
$runtimeParent = Split-Path -Parent $runtimeDirectory
if (![System.IO.Path]::GetFullPath($runtimeDirectory).StartsWith($runtimeParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to prepare WebView2 outside the Tauri directory: $runtimeDirectory"
}

New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null
$archivePath = Join-Path $DownloadDirectory $archiveName
if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
  $cachedLength = (Get-Item -LiteralPath $archivePath).Length
  if ($cachedLength -eq $runtimeArchiveBytes) {
    $cachedHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedHash -ne $runtimeSha256) {
      Remove-Item -LiteralPath $archivePath -Force
    }
  } elseif ($cachedLength -gt $runtimeArchiveBytes) {
    Remove-Item -LiteralPath $archivePath -Force
  }
}
if (!(Test-Path -LiteralPath $archivePath -PathType Leaf) -or (Get-Item -LiteralPath $archivePath).Length -lt $runtimeArchiveBytes) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($null -ne $curl) {
    & $curl.Source -L --fail --retry 4 --retry-delay 2 --continue-at - --output $archivePath $runtimeUrl
    if ($LASTEXITCODE -ne 0) {
      throw "curl.exe failed to download WebView2 runtime (exit code $LASTEXITCODE)."
    }
  } else {
    Invoke-WebRequest -Uri $runtimeUrl -OutFile $archivePath -UseBasicParsing
  }
}

$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $runtimeSha256) {
  throw "WebView2 runtime SHA256 mismatch. Expected $runtimeSha256, got $actualHash."
}

$extractDirectory = Join-Path $DownloadDirectory "extracted-$runtimeVersion"
if (Test-Path -LiteralPath $extractDirectory) {
  $resolvedExtract = [System.IO.Path]::GetFullPath($extractDirectory)
  $resolvedDownload = [System.IO.Path]::GetFullPath($DownloadDirectory)
  if (!$resolvedExtract.StartsWith($resolvedDownload + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clear unexpected extraction directory: $resolvedExtract"
  }
  Remove-Item -LiteralPath $resolvedExtract -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDirectory | Out-Null

$expand = Join-Path $env:SystemRoot "System32\expand.exe"
& $expand $archivePath "-F:*" $extractDirectory | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to extract WebView2 runtime (exit code $LASTEXITCODE)."
}

$extractedRuntime = Join-Path $extractDirectory $runtimeFolderName
$runtimeExe = Join-Path $extractedRuntime "msedgewebview2.exe"
if (!(Test-Path -LiteralPath $runtimeExe -PathType Leaf)) {
  throw "Extracted WebView2 runtime is missing msedgewebview2.exe."
}
$productVersion = (Get-Item -LiteralPath $runtimeExe).VersionInfo.ProductVersion
if ($productVersion -notlike "$runtimeVersion*") {
  throw "Unexpected WebView2 runtime version: $productVersion"
}
$signature = Get-AuthenticodeSignature -LiteralPath $runtimeExe
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
  throw "WebView2 runtime is not validly signed by Microsoft Corporation: $runtimeExe"
}

if (Test-Path -LiteralPath $runtimeDirectory) {
  Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force
}
Move-Item -LiteralPath $extractedRuntime -Destination $runtimeDirectory
Write-Host "Prepared Microsoft WebView2 $runtimeVersion at $runtimeDirectory"

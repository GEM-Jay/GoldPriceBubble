[CmdletBinding()]
param(
  [string]$RepositoryRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

$libraries = @(
  @{
    version = "0.39.0"
    file = "windows.lib"
    sha256 = "6c6d7c46201dde65bda21e1beb307c40a3172933c01578ec08e99278ad0449b8"
  },
  @{
    version = "0.48.5"
    file = "windows.0.48.5.lib"
    sha256 = "6ebeba999507cb792a7220b6fe751324d05564fc8e867d5804496c6e733a4468"
  }
)
$repositoryPath = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$tauriRoot = (Resolve-Path -LiteralPath (Join-Path $repositoryPath "src-tauri")).Path
$manifestPath = Join-Path $tauriRoot "Cargo.toml"
$destinationDirectory = Join-Path $tauriRoot ".win7\link-libs"

$metadataJson = (& cargo metadata --manifest-path $manifestPath --locked --format-version 1 2>$null | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to resolve Cargo metadata for the Win7 link library."
}
$metadata = $metadataJson | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
foreach ($library in $libraries) {
  $package = @($metadata.packages | Where-Object {
    $_.name -eq "windows_x86_64_msvc" -and $_.version -eq $library.version
  }) | Select-Object -First 1
  if ($null -eq $package) {
    throw "Cargo metadata does not contain windows_x86_64_msvc $($library.version)."
  }
  $packageRoot = Split-Path -Parent $package.manifest_path
  $source = Join-Path $packageRoot "lib\$($library.file)"
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "windows_x86_64_msvc $($library.version) is missing $($library.file): $source"
  }
  $actualHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $library.sha256) {
    throw "$($library.file) SHA256 mismatch. Expected $($library.sha256), got $actualHash."
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDirectory $library.file) -Force
}
Write-Host "Prepared Win7 windows.lib at $destinationDirectory"

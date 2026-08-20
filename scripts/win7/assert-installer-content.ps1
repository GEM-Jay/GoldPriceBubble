[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
$sevenZip = if ($null -ne $sevenZipCommand) { $sevenZipCommand.Source } else { $null }
if ([string]::IsNullOrWhiteSpace($sevenZip)) {
  $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  $sevenZip = @(
    (Join-Path $env:ProgramFiles "7-Zip\7z.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe"),
    (Join-Path $repositoryRoot "src-tauri\.win7\7zip-full\7z.exe")
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($sevenZip)) { throw "7-Zip is required to inspect the Win7 NSIS installer." }
if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Win7 installer does not exist: $InstallerPath"
}
$listing = (& $sevenZip l $InstallerPath 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "7-Zip failed while inspecting $InstallerPath" }
if ($listing -notmatch "webview2-fixed-runtime.*msedgewebview2\.exe") {
  throw "Win7 installer does not contain the WebView2 fixed runtime."
}
Write-Host "Win7 installer contains the WebView2 fixed runtime: $InstallerPath"

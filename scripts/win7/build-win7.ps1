[CmdletBinding()]
param(
  [switch]$SkipToolchainInstall,
  [switch]$SkipRuntimePreparation,
  [switch]$SkipBundle
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$tauriRoot = Join-Path $repositoryRoot "src-tauri"
$win7ConfigPath = Join-Path $tauriRoot "tauri.win7.conf.json"
$target = "x86_64-win7-windows-msvc"
$tauriTarget = "x86_64-pc-windows-msvc"
$toolchain = "nightly-2026-07-22"
$patchedCrate = Join-Path $tauriRoot ".win7\vendor\webview2-com-sys"
$win7LockPath = Join-Path $tauriRoot ".win7\Cargo.lock"
$win7ManifestPath = Join-Path $tauriRoot ".win7\Cargo.toml"
$win7LinkDirectory = Join-Path $tauriRoot ".win7\link-libs"
$tauriCli = Join-Path $repositoryRoot "node_modules\.bin\tauri.cmd"
$cargoRunner = Join-Path $PSScriptRoot "cargo-win7-runner.cmd"

Push-Location $repositoryRoot
try {
  if (!$SkipToolchainInstall) {
    & rustup toolchain install $toolchain --profile minimal --component rust-src
    if ($LASTEXITCODE -ne 0) { throw "Failed to install Rust toolchain $toolchain." }
  }

  if (!$SkipRuntimePreparation) {
    & (Join-Path $PSScriptRoot "prepare-webview2-runtime.ps1") -RepositoryRoot $repositoryRoot
    & (Join-Path $PSScriptRoot "prepare-webview2-loader.ps1") -RepositoryRoot $repositoryRoot
  }
  if (!(Test-Path -LiteralPath (Join-Path $tauriRoot "webview2-fixed-runtime\msedgewebview2.exe") -PathType Leaf)) {
    throw "WebView2 109 fixed runtime has not been prepared."
  }
  if (!(Test-Path -LiteralPath (Join-Path $patchedCrate "x64\WebView2LoaderStatic.lib") -PathType Leaf)) {
    throw "Win7-compatible WebView2 loader has not been prepared."
  }
  & (Join-Path $PSScriptRoot "prepare-windows-link-lib.ps1") -RepositoryRoot $repositoryRoot
  if (!(Test-Path -LiteralPath (Join-Path $win7LinkDirectory "windows.lib") -PathType Leaf)) {
    throw "Win7 windows.lib has not been prepared."
  }
  if (!(Test-Path -LiteralPath $tauriCli -PathType Leaf)) {
    throw "Tauri CLI is missing. Run npm install first."
  }
  if (!(Test-Path -LiteralPath $cargoRunner -PathType Leaf)) {
    throw "Win7 Cargo runner is missing: $cargoRunner"
  }

  $patchPath = [System.IO.Path]::GetFullPath($patchedCrate).Replace('\', '/')
  $cargoPatch = "patch.crates-io.webview2-com-sys.path='$patchPath'"
  Copy-Item -LiteralPath (Join-Path $tauriRoot "Cargo.lock") -Destination $win7LockPath -Force
  Copy-Item -LiteralPath (Join-Path $tauriRoot "Cargo.toml") -Destination $win7ManifestPath -Force
  $previousRustFlags = $env:RUSTFLAGS
  $previousEncodedRustFlags = $env:CARGO_ENCODED_RUSTFLAGS
  $previousTauriConfig = $env:TAURI_CONFIG
  $previousRustupToolchain = $env:RUSTUP_TOOLCHAIN
  try {
    $env:RUSTFLAGS = $null
    $env:CARGO_ENCODED_RUSTFLAGS = @(
      "-C",
      "target-feature=+crt-static",
      "-L",
      "native=$win7LinkDirectory",
      "-C",
      "link-arg=/NODEFAULTLIB:ucrt.lib",
      "-C",
      "link-arg=libucrt.lib"
    ) -join [char]31
    $env:TAURI_CONFIG = Get-Content -LiteralPath $win7ConfigPath -Raw
    $env:RUSTUP_TOOLCHAIN = $toolchain
    $bundleTarget = if ($SkipBundle) { "none" } else { "nsis" }
    & $tauriCli build `
      --runner $cargoRunner `
      --target $tauriTarget `
      --bundles $bundleTarget `
      --config $win7ConfigPath `
      -- `
      -Z build-std=std,panic_abort `
      --config $cargoPatch
    if ($LASTEXITCODE -ne 0) { throw "Win7 Tauri build failed." }

    $binaryPath = Join-Path $tauriRoot "target\$target\release\goldprice.exe"
    $reportPath = Join-Path $tauriRoot "target\$target\release\win7-pe-imports.txt"
    & (Join-Path $PSScriptRoot "assert-pe-compat.ps1") -BinaryPath $binaryPath -ReportPath $reportPath

    if (!$SkipBundle) {
      $bundleDirectory = Join-Path $tauriRoot "target\$tauriTarget\release\bundle\nsis"
      $installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter "*.exe" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
      if ($null -eq $installer) { throw "Unable to locate the Win7 NSIS installer." }
      & (Join-Path $PSScriptRoot "assert-installer-content.ps1") -InstallerPath $installer.FullName

      $version = (Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json).version
      $artifactDirectory = Join-Path $repositoryRoot "win7-artifacts"
      New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null
      $artifactPath = Join-Path $artifactDirectory "GoldPrice_${version}_windows_x64-win7-webview2-109-offline-setup.exe"
      Copy-Item -LiteralPath $installer.FullName -Destination $artifactPath -Force
      Copy-Item -LiteralPath $reportPath -Destination (Join-Path $artifactDirectory "win7-pe-imports.txt") -Force
      Write-Host "Win7 installer: $artifactPath"
    }
  }
  finally {
    Copy-Item -LiteralPath $win7LockPath -Destination (Join-Path $tauriRoot "Cargo.lock") -Force
    Copy-Item -LiteralPath $win7ManifestPath -Destination (Join-Path $tauriRoot "Cargo.toml") -Force
    $env:RUSTFLAGS = $previousRustFlags
    $env:CARGO_ENCODED_RUSTFLAGS = $previousEncodedRustFlags
    $env:TAURI_CONFIG = $previousTauriConfig
    $env:RUSTUP_TOOLCHAIN = $previousRustupToolchain
  }
}
finally {
  Pop-Location
}

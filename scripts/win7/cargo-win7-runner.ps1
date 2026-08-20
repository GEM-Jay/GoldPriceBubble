[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CargoArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$declaredTarget = "x86_64-pc-windows-msvc"
$actualTarget = "x86_64-win7-windows-msvc"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$tauriRoot = Join-Path $repositoryRoot "src-tauri"

$forwardedArguments = @($CargoArguments | ForEach-Object {
  if ($_ -eq $declaredTarget) { $actualTarget } else { $_ }
})

& cargo @forwardedArguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($forwardedArguments -contains "build") {
  $profile = if ($forwardedArguments -contains "--release") { "release" } else { "debug" }
  $actualBinary = Join-Path $tauriRoot "target\$actualTarget\$profile\goldprice.exe"
  $declaredDirectory = Join-Path $tauriRoot "target\$declaredTarget\$profile"
  if (!(Test-Path -LiteralPath $actualBinary -PathType Leaf)) {
    throw "Win7 runner did not produce the expected binary: $actualBinary"
  }
  New-Item -ItemType Directory -Force -Path $declaredDirectory | Out-Null
  Copy-Item -LiteralPath $actualBinary -Destination (Join-Path $declaredDirectory "goldprice.exe") -Force
}

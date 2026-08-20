[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath,
  [string]$ReportPath = "win7-pe-imports.txt"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-Dumpbin {
  $command = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (!(Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Unable to find Visual Studio vswhere.exe."
  }
  $visualStudio = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $toolsRoot = Join-Path $visualStudio "VC\Tools\MSVC"
  $match = Get-ChildItem -LiteralPath $toolsRoot -Filter dumpbin.exe -Recurse |
    Where-Object { $_.FullName -match '\\bin\\Hostx64\\x64\\dumpbin\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($null -eq $match) { throw "Unable to locate dumpbin.exe." }
  $match.FullName
}

if (!(Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
  throw "Win7 PE audit target does not exist: $BinaryPath"
}
$dumpbin = Find-Dumpbin
$imports = (& $dumpbin /nologo /imports $BinaryPath 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "dumpbin failed while auditing $BinaryPath" }
Set-Content -LiteralPath $ReportPath -Value $imports -Encoding UTF8

$forbidden = @(
  "combase.dll",
  "api-ms-win-core-winrt-",
  "CoIncrementMTAUsage",
  "EventSetInformation",
  "GetSystemTimePreciseAsFileTime",
  "GetDpiForWindow",
  "GetSystemMetricsForDpi",
  "SetThreadDpiAwarenessContext",
  "VCRUNTIME140.dll",
  "VCRUNTIME140_1.dll",
  "MSVCP140.dll",
  "ucrtbase.dll",
  "api-ms-win-crt-"
)
$violations = @($forbidden | Where-Object { $imports -match [regex]::Escape($_) })
if ($violations.Count -gt 0) {
  throw "Windows 7 incompatible PE imports detected:`n$($violations -join "`n")"
}
Write-Host "Windows 7 PE import audit passed: $BinaryPath"

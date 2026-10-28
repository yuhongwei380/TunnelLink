# Standalone tests; no Pester dependency and no driver installation or elevation.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\windows\install-tap-driver.ps1')

function Assert-Test($condition, [string]$message) {
  if (-not $condition) { throw $message }
}

# Test hardware filtering before replacing the adapter lookup for flow tests.
function Get-CimInstance {
  @(
    [pscustomobject]@{ServiceName='tap_ovpnconnect';ConfigManagerErrorCode=0;PNPDeviceID='connect'},
    [pscustomobject]@{ServiceName='ovpn-dco';ConfigManagerErrorCode=0;PNPDeviceID='dco'},
    [pscustomobject]@{ServiceName='tap0901';ConfigManagerErrorCode=22;PNPDeviceID='disabled'},
    [pscustomobject]@{ServiceName='tap0901';ConfigManagerErrorCode=45;PNPDeviceID='removed'},
    [pscustomobject]@{ServiceName='tap0901';ConfigManagerErrorCode=0;PNPDeviceID='ready'}
  )
}
$found = @(Get-HealthyTapAdapters)
Assert-Test ($found.Count -eq 1 -and $found[0].PNPDeviceID -eq 'ready') 'Adapter filtering accepted an incompatible or unhealthy adapter.'

# Regression: the bundled manifest.json is BOM-less UTF-8 with a Chinese comment; on an
# ANSI (GBK) host Windows PowerShell 5.1 default decoding corrupts the JSON (installer bug 2026-10).
$testCache = Join-Path $PSScriptRoot '../../.cache/tmp'
New-Item -ItemType Directory -Path $testCache -Force | Out-Null
$manifestRoot = Join-Path $testCache ('tap-driver-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $manifestRoot | Out-Null
try {
  $manifestText = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\resources\settings\windows-tap-driver.json') -Raw -Encoding UTF8
  $manifestLock = $manifestText | ConvertFrom-Json
  foreach ($name in @('devcon.exe', 'OemVista.inf', 'tap0901.cat', 'tap0901.sys')) {
    $payloadFile = Join-Path $manifestRoot $name
    Set-Content -LiteralPath $payloadFile -Value "test payload: $name" -Encoding ASCII
    $actual = (Get-FileHash -LiteralPath $payloadFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestText = $manifestText.Replace($manifestLock.files.$name, $actual)
  }
  [IO.File]::WriteAllText((Join-Path $manifestRoot 'manifest.json'), $manifestText, (New-Object Text.UTF8Encoding($false)))
  $DriverDirectory = $manifestRoot
  $failure = $null
  try { Test-TapDriverPayload } catch { $failure = $_.Exception.Message }
  Assert-Test ($failure -match 'signature is invalid') "Bundled manifest.json was not parsed as UTF-8 JSON: $failure"
} finally {
  Remove-Item -LiteralPath $manifestRoot -Recurse -Force
}
Write-Output 'PASS: bundled manifest.json parses as UTF-8 and reaches the signature check.'

function Assert-TapInstallEnvironment {}
function Test-TapDriverPayload {}
function Write-DriverLog {}
function Start-Sleep {}
function Invoke-TapDeviceInstall { $script:installCalls++; return $script:deviceExitCode }
function Get-HealthyTapAdapters {
  $script:adapterChecks++
  if ($script:adapterChecks -ge $script:readyOnCheck) { [pscustomobject]@{ServiceName='tap0901'} }
}
function Reset-TestState([int]$readyOnCheck, [int]$deviceExitCode = 0) {
  $script:readyOnCheck = $readyOnCheck
  $script:deviceExitCode = $deviceExitCode
  $script:adapterChecks = 0
  $script:installCalls = 0
}

Reset-TestState -readyOnCheck 1
Assert-Test ((Install-BundledTapDriver) -eq 0) 'Existing adapter was rejected.'
Assert-Test ($script:installCalls -eq 0) 'Reinstall created a duplicate adapter.'

Reset-TestState -readyOnCheck 3
Assert-Test ((Install-BundledTapDriver) -eq 0) 'New adapter was not detected.'
Assert-Test ($script:installCalls -eq 1) 'Expected exactly one driver install.'

Reset-TestState -readyOnCheck 100 -deviceExitCode 1
Assert-Test ((Install-BundledTapDriver) -eq 3010) 'Reboot-required result was not propagated.'

foreach ($code in @(2, 3)) {
  Reset-TestState -readyOnCheck 100 -deviceExitCode $code
  $rejected = $false
  try { Install-BundledTapDriver | Out-Null } catch { $rejected = $_.Exception.Message -match 'devcon exit code' }
  Assert-Test $rejected "Driver failure code $code was accepted."
}

Reset-TestState -readyOnCheck 100
$rejected = $false
try { Install-BundledTapDriver | Out-Null } catch { $rejected = $_.Exception.Message -match 'no healthy tap0901 adapter' }
Assert-Test $rejected 'Success without a usable adapter was accepted.'
Write-Output 'PASS: adapter filtering, idempotent install, delayed detection, reboot, failures, and missing adapter.'

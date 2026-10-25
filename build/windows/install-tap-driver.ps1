param(
  [string]$DriverDirectory,
  [string]$LogPath
)

$ErrorActionPreference = "Stop"

function Write-DriverLog([string]$message) {
  $line = "$(Get-Date -Format o) $message"
  Write-Output $line | Out-Host
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Assert-TapInstallEnvironment {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Administrator privileges are required to install the VPN driver."
  }
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Major -lt 10) {
    throw "The bundled VPN driver requires 64-bit PowerShell on Windows 10/11 x64."
  }
}

function Test-TapDriverPayload {
  $manifest = Get-Content -LiteralPath (Join-Path $DriverDirectory 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.componentId -ne 'tap0901') { throw 'Unexpected bundled TAP ComponentId.' }
  foreach ($name in @('devcon.exe', 'OemVista.inf', 'tap0901.cat', 'tap0901.sys')) {
    $file = Join-Path $DriverDirectory $name
    $expected = $manifest.files.$name
    if (-not $expected -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $expected) {
      throw "Bundled VPN driver integrity check failed: $name"
    }
  }
  foreach ($name in @('devcon.exe', 'tap0901.cat', 'tap0901.sys')) {
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $DriverDirectory $name)
    if ($signature.Status -ne 'Valid') { throw "Bundled VPN driver signature is invalid: $name ($($signature.Status))" }
  }
}

function Get-HealthyTapAdapters {
  Get-CimInstance -ClassName Win32_NetworkAdapter -Filter "ServiceName = 'tap0901'" |
    Where-Object { $_.ServiceName -eq 'tap0901' -and $_.ConfigManagerErrorCode -eq 0 -and $_.PNPDeviceID }
}

function Invoke-TapDeviceInstall {
  $tool = Join-Path $DriverDirectory 'devcon.exe'
  $inf = Join-Path $DriverDirectory 'OemVista.inf'
  # No -r: the enclosing installer owns any reboot prompt.
  $output = & $tool install $inf tap0901 2>&1
  $code = $LASTEXITCODE
  foreach ($line in $output) { Write-DriverLog ([string]$line) }
  return $code
}

function Install-BundledTapDriver {
  Assert-TapInstallEnvironment
  Test-TapDriverPayload
  $existing = @(Get-HealthyTapAdapters)
  if ($existing.Count -gt 0) {
    Write-DriverLog "Reusing a healthy tap0901 adapter; no driver update is needed."
    return 0
  }
  Write-DriverLog 'Installing the bundled TAP-Windows6 driver and creating a tap0901 adapter.'
  $code = Invoke-TapDeviceInstall
  if ($code -eq 1) {
    Write-DriverLog 'Driver installation succeeded; Windows requires a restart.'
    return 3010
  }
  if ($code -ne 0) { throw "TAP driver installation failed (devcon exit code $code)." }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (@(Get-HealthyTapAdapters).Count -gt 0) {
      Write-DriverLog 'TAP-Windows6 adapter is ready.'
      return 0
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'Driver installation returned success, but no healthy tap0901 adapter appeared.'
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    if (-not $DriverDirectory -or -not $LogPath) { throw 'DriverDirectory and LogPath are required.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
    Write-DriverLog 'Starting bundled VPN driver setup.'
    $result = Install-BundledTapDriver
    exit $result
  } catch {
    if ($LogPath) { Write-DriverLog "ERROR: $($_.Exception.Message)" }
    Write-Error $_ -ErrorAction Continue
    exit 1
  }
}

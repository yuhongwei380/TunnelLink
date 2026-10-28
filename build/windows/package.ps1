param(
  [switch]$ForceOpenVpnBuild,
  [switch]$SkipOpenVpnBuild,
  [switch]$NoAutoInstallDeps
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $ProjectRoot
$releaseLock = Get-Content -LiteralPath (Join-Path $ProjectRoot 'config/openvpn3-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json

$OpenVpnBinDir = Join-Path $ProjectRoot "native\bin\windows-x64"
$OpenVpnExe = Join-Path $ProjectRoot "native\bin\windows-x64\ovpncli.exe"
$BuildOpenVpnScript = Join-Path $PSScriptRoot "build-openvpn3.ps1"

$engineMatchesBundledDriver = $false
if (Test-Path -LiteralPath $OpenVpnExe) {
  try {
    $engineMetadata = Get-Content -LiteralPath (Join-Path $OpenVpnBinDir 'ovpncli-build.json') -Raw | ConvertFrom-Json
    $engineMatchesBundledDriver = $engineMetadata.tapComponentId -eq 'tap0901' -and
      $engineMetadata.platform -eq 'x64' -and
      $engineMetadata.version -eq $releaseLock.version -and
      $engineMetadata.sourceRef -eq $releaseLock.ref -and
      $engineMetadata.sourceCommit -eq $releaseLock.commit -and
      $engineMetadata.sha256 -eq (Get-FileHash -LiteralPath $OpenVpnExe -Algorithm SHA256).Hash
  }
  catch { $engineMatchesBundledDriver = $false }
}
if ($SkipOpenVpnBuild -and -not $engineMatchesBundledDriver) {
  throw 'The bundled driver requires a verified x64 tap0901 engine. Remove SkipOpenVpnBuild to rebuild it.'
}

Write-Host "[1/5] Preparing OpenVPN3 binary (ovpncli.exe)..."
if ($SkipOpenVpnBuild) {
  Write-Host "SkipOpenVpnBuild is enabled."
}
elseif ($ForceOpenVpnBuild -or -not $engineMatchesBundledDriver) {
  $autoInstall = if ($NoAutoInstallDeps) { $false } else { $true }
  & $BuildOpenVpnScript -AutoInstallDeps:$autoInstall
}
else {
  Write-Host "Existing ovpncli.exe found: $OpenVpnExe"
}

if (-not (Test-Path $OpenVpnExe)) {
  throw "ovpncli.exe is missing: $OpenVpnExe"
}

$sslDll = Get-ChildItem -Path $OpenVpnBinDir -Filter "libssl-*.dll" -File -ErrorAction SilentlyContinue | Select-Object -First 1
$cryptoDll = Get-ChildItem -Path $OpenVpnBinDir -Filter "libcrypto-*.dll" -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ((-not $sslDll) -or (-not $cryptoDll)) {
  $missing = @()
  if (-not $sslDll) { $missing += "libssl-*.dll" }
  if (-not $cryptoDll) { $missing += "libcrypto-*.dll" }
  $missingText = $missing -join ", "
  throw "OpenVPN runtime DLLs are missing under ${OpenVpnBinDir}: $missingText"
}

Write-Host "[2/5] Installing dependencies..."
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)." }

Write-Host "[3/5] Checking Rust toolchain..."
node build/tauri.mjs cargo --version
if ($LASTEXITCODE -ne 0) { throw "Install Rust stable (MSVC) with rustup before packaging." }

Write-Host "[4/5] Building Windows installer..."
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed (exit code $LASTEXITCODE)." }

Write-Host "[5/5] Verifying Tauri artifacts..."
$artifacts = Get-ChildItem -Path "build\dist\*-Setup-*.exe" -ErrorAction SilentlyContinue
if (-not $artifacts) {
  throw "No Windows setup .exe generated under build\dist\."
}

Write-Host "Build completed. Windows installer:"
$artifacts | ForEach-Object { Write-Host $_.FullName }

param(
  [switch]$ForceOpenVpnBuild,
  [switch]$SkipOpenVpnBuild,
  [switch]$NoAutoInstallDeps
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $ProjectRoot

$OpenVpnBinDir = Join-Path $ProjectRoot ".cache\native\bin\windows-x64"
$OpenVpnExe = Join-Path $ProjectRoot ".cache\native\bin\windows-x64\ovpncli.exe"
$BuildOpenVpnScript = Join-Path $PSScriptRoot "build-openvpn3.ps1"
$OpenVpnEngineWorkRoot = if ($env:OPENVPN_ENGINE_WORK_ROOT) {
  [IO.Path]::GetFullPath($env:OPENVPN_ENGINE_WORK_ROOT)
}
else {
  Join-Path $ProjectRoot ".cache\work\windows"
}

& node make/engine-cache.mjs verify windows x64 Release tap0901
$engineMatchesBundledDriver = $LASTEXITCODE -eq 0
if ($SkipOpenVpnBuild -and -not $engineMatchesBundledDriver) {
  throw 'The bundled driver requires a verified x64 tap0901 engine. Remove SkipOpenVpnBuild to rebuild it.'
}

Write-Host "[1/5] Preparing OpenVPN3 binary (ovpncli.exe)..."
if ($SkipOpenVpnBuild) {
  Write-Host "SkipOpenVpnBuild is enabled."
}
elseif ($ForceOpenVpnBuild -or -not $engineMatchesBundledDriver) {
  $autoInstall = if ($NoAutoInstallDeps) { $false } else { $true }
  & $BuildOpenVpnScript -AutoInstallDeps:$autoInstall -Force:$ForceOpenVpnBuild -WorkRoot $OpenVpnEngineWorkRoot
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
node make/install-dependencies.mjs
if ($LASTEXITCODE -ne 0) { throw "Dependency preparation failed (exit code $LASTEXITCODE)." }

Write-Host "[3/5] Checking Rust toolchain..."
node make/tauri.mjs cargo --version
if ($LASTEXITCODE -ne 0) { throw "Install Rust stable (MSVC) with rustup before packaging." }

Write-Host "[4/5] Building Windows installer..."
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed (exit code $LASTEXITCODE)." }

Write-Host "[5/5] Verifying Tauri artifacts..."
$outputDirectory = if ($env:OPENVPN_BUILD_OUTPUT) { $env:OPENVPN_BUILD_OUTPUT } else { Join-Path $ProjectRoot 'build_dist/windows' }
$artifacts = Get-ChildItem -LiteralPath $outputDirectory -Filter '*-Setup-*.exe' -ErrorAction SilentlyContinue
if (-not $artifacts) {
  throw "No Windows setup .exe generated under $outputDirectory."
}

Write-Host "Build completed. Windows installer:"
$artifacts | ForEach-Object { Write-Host $_.FullName }

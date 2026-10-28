param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [string]$SevenZip = 'C:\Program Files\7-Zip\7z.exe'
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
if (-not (Test-Path -LiteralPath $SevenZip)) { throw '7-Zip is required to inspect the installer without installing it.' }
$inspectionRoot = Join-Path $projectRoot ('.cache\tauri-verification-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $inspectionRoot | Out-Null
& $SevenZip x $installerPath ('-o' + $inspectionRoot) -y -bso0 -bsp0
if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the NSIS installer.' }

$engineRoot = Join-Path $inspectionRoot 'bin\windows-x64'
$metadata = Get-Content -LiteralPath (Join-Path $engineRoot 'ovpncli-build.json') -Raw | ConvertFrom-Json
$engine = Join-Path $engineRoot 'ovpncli.exe'
$releaseLock = Get-Content -LiteralPath (Join-Path $projectRoot 'config/openvpn3-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.version -ne $releaseLock.version -or $metadata.sourceRef -ne $releaseLock.ref -or $metadata.sourceCommit -ne $releaseLock.commit) { throw 'Packaged OpenVPN release differs from the release lock.' }
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'resources/legal') -File -Recurse) {
  $relative = $file.FullName.Substring((Join-Path $projectRoot 'resources/legal').Length).TrimStart('\', '/')
  $packaged = Join-Path (Join-Path $inspectionRoot 'legal') $relative
  if ((Get-FileHash -LiteralPath $packaged).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw ('Packaged agreement/license differs: ' + $relative) }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'LICENSES') -File -Recurse) {
  $relative = $file.FullName.Substring((Join-Path $projectRoot 'LICENSES').Length).TrimStart('\', '/')
  $packaged = Join-Path (Join-Path $inspectionRoot 'legal\licenses') $relative
  if ((Get-FileHash -LiteralPath $packaged).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw ('Packaged license differs: ' + $relative) }
}
if (Test-Path -LiteralPath (Join-Path $engineRoot 'openvpn3-source.tar.gz')) { throw 'OpenVPN source archive must not be bundled.' }
if ($metadata.tapComponentId -ne 'tap0901' -or $metadata.platform -ne 'x64') { throw 'Unexpected native engine target.' }
if ((Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash -ne $metadata.sha256) { throw 'Packaged engine hash mismatch.' }
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectRoot 'native\bin\windows-x64') -File) {
  $packaged = Join-Path $engineRoot $file.Name
  if ((Get-FileHash -LiteralPath $packaged -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) {
    throw ('Native resource differs from its verified input: ' + $file.Name)
  }
}
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'config\windows-tap-driver.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$driverRoot = Join-Path $inspectionRoot 'drivers\windows-x64\tap-windows6'
if (Test-Path -LiteralPath (Join-Path $driverRoot $manifest.source.name)) { throw 'Driver source archive must not be bundled.' }
foreach ($entry in $manifest.files.PSObject.Properties) {
  if ((Get-FileHash -LiteralPath (Join-Path $driverRoot $entry.Name) -Algorithm SHA256).Hash -ne $entry.Value) {
    throw ('Driver hash mismatch: ' + $entry.Name)
  }
}
$signatures = foreach ($name in @('devcon.exe', 'tap0901.sys', 'tap0901.cat')) {
  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $driverRoot $name)
  if ($signature.Status -ne 'Valid') { throw ('Invalid driver signature: ' + $name + ': ' + $signature.Status) }
  [pscustomobject]@{ file=$name; status=[string]$signature.Status }
}
$driverScript = Join-Path $inspectionRoot 'windows\install-tap-driver.ps1'
if ((Get-FileHash -LiteralPath $driverScript).Hash -ne (Get-FileHash -LiteralPath (Join-Path $projectRoot 'build\windows\install-tap-driver.ps1')).Hash) {
  throw 'Driver installation script is missing or differs from the source.'
}
$versionOutput = & $engine --version 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw ('Packaged engine cannot start: ' + $versionOutput) }
if ($versionOutput -notmatch ('OpenVPN core ' + [regex]::Escape($releaseLock.version) + '\b')) { throw 'Engine runtime version differs from the pinned release.' }
$app = Join-Path $inspectionRoot 'OpenVPNClient.exe'
if (-not (Test-Path -LiteralPath $app)) { throw 'Tauri executable is missing.' }
if ((Get-Item -LiteralPath $app).VersionInfo.ProductVersion -ne $releaseLock.version) { throw 'Client executable version differs from the pinned release.' }
$forbiddenRuntimeFiles = @(Get-ChildItem -LiteralPath $inspectionRoot -File -Recurse | Where-Object {
  $_.Name -match '^(app\.asar|electron\.exe|node\.exe|LICENSE\.electron\.txt|chrome_\d+_percent\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin)$'
})
if ($forbiddenRuntimeFiles.Count -gt 0) { throw ('Unexpected desktop runtime payload: ' + ($forbiddenRuntimeFiles.Name -join ', ')) }
$result = [ordered]@{
  installer=$installerPath
  bytes=(Get-Item -LiteralPath $installerPath).Length
  sha256=(Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  engineVersion=$versionOutput.Trim()
  release=$releaseLock
  agreementAndLicensesVerified=$true
  desktopRuntime='Tauri 2'
  legacyRuntimeFilesAbsent=$true
  driverComponent=$metadata.tapComponentId
  driverSignatures=$signatures
  appSignature=[string](Get-AuthenticodeSignature -LiteralPath $app).Status
  inspectionDirectory=$inspectionRoot
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path (Split-Path $installerPath) 'package-verification.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 5

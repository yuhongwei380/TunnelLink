param(
  [string]$OpenVpn3RepoUrl = "https://github.com/OpenVPN/openvpn3.git",
  [string]$OpenVpn3Ref = "",
  [string]$Configuration = "Release",
  [string]$Generator = "Visual Studio 17 2022",
  [string]$Platform = "x64",
  [ValidateSet("tap0901", "tap_ovpnconnect")]
  [string]$TapComponentId = "tap0901",
  [string]$WorkRoot = "",
  [string]$WorkDir = "",
  [switch]$KeepWorkDir,
  [switch]$Force,
  [bool]$AutoInstallDeps = $true,
  [string]$CMakeMsiUrlX64 = "https://github.com/Kitware/CMake/releases/download/v4.3.1/cmake-4.3.1-windows-x86_64.msi",
  [string]$CMakeMsiUrlArm64 = "https://github.com/Kitware/CMake/releases/download/v4.3.1/cmake-4.3.1-windows-arm64.msi",
  [string]$AsioZipUrl = "https://github.com/chriskohlhoff/asio/archive/refs/heads/master.zip",
  [string]$FmtZipUrl = "https://github.com/fmtlib/fmt/archive/refs/heads/master.zip"
)

$ErrorActionPreference = "Stop"
$ScriptVersion = "2026-10-28.1"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
. (Join-Path $PSScriptRoot 'openssl.ps1')
$releaseLock = Get-Content -LiteralPath (Join-Path $ProjectRoot 'resources/settings/openvpn3-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $OpenVpn3Ref) { $OpenVpn3Ref = $releaseLock.ref }
if ($OpenVpn3Ref -ne $releaseLock.ref) { throw 'OpenVpn3Ref must match resources/settings/openvpn3-release.json.' }
if ([string]::IsNullOrWhiteSpace($WorkDir)) {
  $cacheVariant = ($Generator + '-' + $Platform + '-' + $Configuration + '-' + $TapComponentId + '-' + $ScriptVersion) -replace '[^A-Za-z0-9_.-]', '_'
  $cacheRoot = if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    Join-Path $ProjectRoot ".cache/work/windows"
  }
  else {
    [IO.Path]::GetFullPath($WorkRoot)
  }
  $WorkDir = Join-Path $cacheRoot ("openvpn3-" + $releaseLock.commit + '-' + $cacheVariant)
}

$SrcDir = Join-Path $WorkDir "openvpn3"
$BuildDir = Join-Path $WorkDir "build"
$OutputBin = Join-Path $ProjectRoot ".cache\native\bin\windows-x64\ovpncli.exe"
# Keep source and CMake outputs for incremental builds, including after failures.
$WorkDir = [IO.Path]::GetFullPath($WorkDir)
$SrcDir = Join-Path $WorkDir 'openvpn3'
$BuildDir = Join-Path $WorkDir 'build'

if (-not $Force) {
  & node (Join-Path $ProjectRoot 'make/engine-cache.mjs') verify windows $Platform.ToLowerInvariant() $Configuration $TapComponentId
  if ($LASTEXITCODE -eq 0) { return }
}

function Write-PatchedFile([string]$Path, [string]$Contents) {
  if ([IO.File]::ReadAllText($Path) -cne $Contents) {
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
  }
}

function Refresh-PathInCurrentSession {
  $extra = @(
    "C:\Program Files\Git\cmd",
    "C:\Program Files\CMake\bin",
    "C:\Program Files (x86)\Microsoft Visual Studio\Installer"
  )
  foreach ($p in $extra) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
      $env:PATH = "$p;$env:PATH"
    }
  }
}

function Get-CommandPathOrNull([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  if ($name -ieq "git" -and (Test-Path "C:\Program Files\Git\cmd\git.exe")) {
    return "C:\Program Files\Git\cmd\git.exe"
  }
  if ($name -ieq "cmake" -and (Test-Path "C:\Program Files\CMake\bin\cmake.exe")) {
    return "C:\Program Files\CMake\bin\cmake.exe"
  }
  return $null
}

function Test-OpenSSLRootValid([string]$root) {
  if ([string]::IsNullOrWhiteSpace($root)) {
    return $false
  }
  $inc = Join-Path $root "include\openssl\ssl.h"
  $hasLibDir = Test-Path (Join-Path $root "lib")
  return (Test-Path $inc) -and $hasLibDir
}

function Test-AsioIncludeValid([string]$includeDir) {
  if ([string]::IsNullOrWhiteSpace($includeDir)) {
    return $false
  }
  return Test-Path (Join-Path $includeDir "asio.hpp")
}

function Test-FmtIncludeValid([string]$includeDir) {
  if ([string]::IsNullOrWhiteSpace($includeDir)) {
    return $false
  }
  return Test-Path (Join-Path $includeDir "fmt\core.h")
}

function Get-AsioIncludeOrNull {
  $envProcess = [Environment]::GetEnvironmentVariable("ASIO_INCLUDE_DIR", "Process")
  if (Test-AsioIncludeValid $envProcess) {
    return $envProcess
  }

  $envMachine = [Environment]::GetEnvironmentVariable("ASIO_INCLUDE_DIR", "Machine")
  if (Test-AsioIncludeValid $envMachine) {
    return $envMachine
  }

  $candidates = @(
    (Join-Path $ProjectRoot ".cache\deps\asio\asio\include"),
    (Join-Path $ProjectRoot ".cache\deps\asio\include")
  )
  foreach ($candidate in $candidates) {
    if (Test-AsioIncludeValid $candidate) {
      return $candidate
    }
  }
  return $null
}

function Get-FmtIncludeOrNull {
  $envProcess = [Environment]::GetEnvironmentVariable("FMT_INCLUDE_DIR", "Process")
  if (Test-FmtIncludeValid $envProcess) {
    return $envProcess
  }

  $envMachine = [Environment]::GetEnvironmentVariable("FMT_INCLUDE_DIR", "Machine")
  if (Test-FmtIncludeValid $envMachine) {
    return $envMachine
  }

  $candidates = @(
    (Join-Path $ProjectRoot ".cache\deps\fmt-master\include"),
    (Join-Path $ProjectRoot ".cache\deps\fmt\include")
  )
  foreach ($candidate in $candidates) {
    if (Test-FmtIncludeValid $candidate) {
      return $candidate
    }
  }
  return $null
}

function Get-OpenSSLRootOrNull {
  $envRoot = [Environment]::GetEnvironmentVariable("OPENSSL_ROOT_DIR", "Process")
  if (Test-OpenSSLRootValid $envRoot) {
    return $envRoot
  }

  $machineEnvRoot = [Environment]::GetEnvironmentVariable("OPENSSL_ROOT_DIR", "Machine")
  if (Test-OpenSSLRootValid $machineEnvRoot) {
    return $machineEnvRoot
  }

  $candidates = @(
    "C:\Program Files\OpenSSL-Win64",
    "C:\Program Files\OpenSSL-Win32",
    "C:\OpenSSL-Win64",
    "C:\OpenSSL-Win32"
  )

  foreach ($root in $candidates) {
    if (Test-OpenSSLRootValid $root) {
      return $root
    }
  }

  return $null
}

function Ensure-WingetInstalled {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install App Installer from Microsoft Store first."
  }
}

function Invoke-WingetInstall([string]$Id, [string]$OverrideArgs = "") {
  $args = @(
    "install",
    "--id", $Id,
    "-e",
    "--accept-source-agreements",
    "--accept-package-agreements"
  )
  if (-not [string]::IsNullOrWhiteSpace($OverrideArgs)) {
    $args += @("--override", $OverrideArgs)
  }

  & winget @args
  if ($LASTEXITCODE -ne 0) {
    throw "winget install failed for $Id (exit code: $LASTEXITCODE)"
  }
}

function Ensure-OpenSSLRoot {
  $root = Get-OpenSSLRootOrNull
  if ($root) {
    return $root
  }

  if (-not $AutoInstallDeps) {
    throw "OpenSSL root not found. Set OPENSSL_ROOT_DIR to your OpenSSL installation path."
  }

  Ensure-WingetInstalled
  $ids = @(
    "ShiningLight.OpenSSL.Light",
    "ShiningLight.OpenSSL"
  )
  foreach ($id in $ids) {
    Write-Host "Installing OpenSSL via winget: $id"
    try {
      Invoke-WingetInstall -Id $id
    }
    catch {
      Write-Warning "winget install failed for ${id}: $($_.Exception.Message)"
    }
    $root = Get-OpenSSLRootOrNull
    if ($root) {
      return $root
    }
  }

  throw "OpenSSL was not detected. Install OpenSSL and set OPENSSL_ROOT_DIR, e.g. C:\Program Files\OpenSSL-Win64"
}

function Resolve-OpenSSLDllPath([string]$openSslRoot, [string[]]$patterns) {
  $binDir = Join-Path $openSslRoot "bin"
  if (-not (Test-Path $binDir)) {
    return $null
  }
  foreach ($pattern in $patterns) {
    $candidate = Get-ChildItem -Path $binDir -Filter $pattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }
  return $null
}

function Copy-OpenSSLRuntimeDlls([string]$openSslRoot, [string]$destinationDir) {
  $required = @(
    @{ Name = "OpenSSL SSL"; Patterns = @("libssl-3-x64.dll", "libssl-3.dll", "libssl-*.dll") },
    @{ Name = "OpenSSL Crypto"; Patterns = @("libcrypto-3-x64.dll", "libcrypto-3.dll", "libcrypto-*.dll") }
  )

  foreach ($item in $required) {
    $dllPath = Resolve-OpenSSLDllPath -openSslRoot $openSslRoot -patterns $item.Patterns
    if (-not $dllPath) {
      $binDir = Join-Path $openSslRoot "bin"
      throw "$($item.Name) DLL not found under $binDir. Please ensure OpenSSL runtime DLLs are installed."
    }
    Copy-Item -Path $dllPath -Destination (Join-Path $destinationDir (Split-Path -Leaf $dllPath)) -Force
  }
  $licensePath = Join-Path $openSslRoot 'license.txt'
  if (Test-Path -LiteralPath $licensePath) {
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $destinationDir 'LICENSE.OpenSSL.txt') -Force
  }
}

function Copy-MsvcRuntimeDlls([string]$visualStudioPath, [string]$destinationDir, [string]$targetPlatform) {
  $runtimeArch = if ($targetPlatform -ieq 'Win32') { 'x86' } else { $targetPlatform.ToLowerInvariant() }
  $redistRoot = Join-Path $visualStudioPath 'VC\Redist\MSVC'
  $versions = Get-ChildItem -LiteralPath $redistRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [Version]$_.Name } -Descending
  foreach ($version in $versions) {
    $archDirectory = Join-Path $version.FullName $runtimeArch
    $crtDirectory = Get-ChildItem -LiteralPath $archDirectory -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($crtDirectory) {
      # App-local redistributable DLLs also satisfy OpenSSL's VCRUNTIME dependency.
      Get-ChildItem -LiteralPath $crtDirectory.FullName -Filter '*.dll' -File |
        Copy-Item -Destination $destinationDir -Force
      Write-Host "Bundled MSVC runtime: $($crtDirectory.FullName)"
      return
    }
  }
  throw "MSVC redistributable runtime was not found for $targetPlatform under $redistRoot."
}

function Ensure-AsioIncludeDir {
  $existing = Get-AsioIncludeOrNull
  if ($existing) {
    return $existing
  }

  if (-not $AutoInstallDeps) {
    throw "ASIO include dir not found. Set ASIO_INCLUDE_DIR to a folder containing asio.hpp."
  }

  $thirdPartyRoot = Join-Path $ProjectRoot ".cache/deps"
  $asioRoot = Join-Path $thirdPartyRoot "asio"
  $zipPath = Join-Path $thirdPartyRoot "asio-master.zip"

  New-Item -ItemType Directory -Path $thirdPartyRoot -Force | Out-Null
  if (Test-Path $asioRoot) {
    Remove-Item -Recurse -Force $asioRoot -ErrorAction SilentlyContinue
  }

  Write-Host "Downloading asio headers: $AsioZipUrl"
  Invoke-WebRequest -Uri $AsioZipUrl -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $thirdPartyRoot -Force

  $found = Get-ChildItem -Path $thirdPartyRoot -Recurse -File -Filter "asio.hpp" | Select-Object -First 1
  if (-not $found) {
    throw "Failed to locate asio.hpp after download."
  }
  $includeDir = Split-Path -Parent $found.FullName
  if (-not (Test-AsioIncludeValid $includeDir)) {
    throw "Resolved ASIO include dir is invalid: $includeDir"
  }
  return $includeDir
}

function Ensure-FmtIncludeDir {
  $existing = Get-FmtIncludeOrNull
  if ($existing) {
    return $existing
  }

  if (-not $AutoInstallDeps) {
    throw "fmt include dir not found. Set FMT_INCLUDE_DIR to a folder containing fmt/core.h."
  }

  $thirdPartyRoot = Join-Path $ProjectRoot ".cache/deps"
  $fmtRoot = Join-Path $thirdPartyRoot "fmt-master"
  $zipPath = Join-Path $thirdPartyRoot "fmt-master.zip"

  New-Item -ItemType Directory -Path $thirdPartyRoot -Force | Out-Null
  if (Test-Path $fmtRoot) {
    Remove-Item -Recurse -Force $fmtRoot -ErrorAction SilentlyContinue
  }

  Write-Host "Downloading fmt headers: $FmtZipUrl"
  Invoke-WebRequest -Uri $FmtZipUrl -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $thirdPartyRoot -Force

  $found = Get-ChildItem -Path $thirdPartyRoot -Recurse -File -Filter "core.h" | Where-Object { $_.FullName -like "*\fmt\core.h" } | Select-Object -First 1
  if (-not $found) {
    throw "Failed to locate fmt/core.h after download."
  }
  $includeDir = Split-Path -Parent (Split-Path -Parent $found.FullName)
  if (-not (Test-FmtIncludeValid $includeDir)) {
    throw "Resolved fmt include dir is invalid: $includeDir"
  }
  return $includeDir
}

function Install-CMakeFallbackMsi {
  $isArm64 = $env:PROCESSOR_ARCHITECTURE -eq "ARM64"
  $url = if ($isArm64) { $CMakeMsiUrlArm64 } else { $CMakeMsiUrlX64 }
  $downloadDirectory = Join-Path $ProjectRoot '.cache/downloads'
  New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
  $msi = Join-Path $downloadDirectory ([System.IO.Path]::GetFileName($url))

  Write-Host "Downloading CMake MSI: $url"
  Invoke-WebRequest -Uri $url -OutFile $msi

  Write-Host "Installing CMake MSI silently..."
  $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart ADD_CMAKE_TO_PATH=System" -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "CMake MSI install failed with exit code $($proc.ExitCode)."
  }
}

function Get-VsWherePath {
  $path = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $path) {
    return $path
  }
  return $null
}

function Get-VisualStudioWithCppPath {
  $vswhere = Get-VsWherePath
  if (-not $vswhere) {
    return $null
  }
  $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ([string]::IsNullOrWhiteSpace($installationPath)) {
    return $null
  }
  return $installationPath.Trim()
}

function Get-AnyVisualStudioPath {
  $vswhere = Get-VsWherePath
  if (-not $vswhere) {
    return $null
  }
  $installationPath = & $vswhere -latest -products * -property installationPath 2>$null
  if ([string]::IsNullOrWhiteSpace($installationPath)) {
    return $null
  }
  return $installationPath.Trim()
}

function Get-VsInstallerExecutablePath {
  $candidates = @(
    "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe",
    "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }
  return $null
}

function Test-IsElevatedProcess {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  catch {
    return $false
  }
}

function Add-VcToolsWorkloadToExistingVisualStudio([string]$installPath) {
  $installer = Get-VsInstallerExecutablePath
  if (-not $installer) {
    throw "Visual Studio Installer executable was not found."
  }

  Write-Host "Adding C++ workload to existing Visual Studio instance: $installPath"
  $args = @(
    "modify",
    "--installPath", $installPath,
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--includeRecommended",
    "--norestart"
  )
  if (Test-IsElevatedProcess) {
    $args += "--passive"
  }
  else {
    Write-Warning "Current shell is not elevated. Running Visual Studio Installer in interactive mode."
  }
  $proc = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "Visual Studio Installer modify failed with exit code $($proc.ExitCode)."
  }
}

function Ensure-CommandWithInstall([string]$name, [scriptblock]$installAction) {
  $resolved = Get-CommandPathOrNull $name
  if ($resolved) {
    return $resolved
  }

  if (-not $AutoInstallDeps) {
    throw "Required command not found: $name"
  }

  & $installAction
  Refresh-PathInCurrentSession
  $resolved = Get-CommandPathOrNull $name
  if (-not $resolved) {
    throw "Required command not found after auto-install: $name"
  }
  return $resolved
}

function Invoke-NativeChecked([string]$exe, [string[]]$ArgumentList, [string]$step) {
  & $exe @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$step failed (exit code: $LASTEXITCODE). Command: $exe $($ArgumentList -join ' ')"
  }
}

function Patch-OpenVpn3ForMinimalWindowsCliBuild(
  [string]$sourceDir,
  [string]$fmtIncludeDir,
  [ValidateSet("tap0901", "tap_ovpnconnect")]
  [string]$tapComponentId = "tap0901"
) {
  $findCoreDepsPath = Join-Path $sourceDir "cmake\findcoredeps.cmake"
  $ovpnCliCmakePath = Join-Path $sourceDir "test\ovpncli\CMakeLists.txt"

  if (-not (Test-Path $findCoreDepsPath)) {
    throw "Patch target not found: $findCoreDepsPath"
  }
  if (-not (Test-Path $ovpnCliCmakePath)) {
    throw "Patch target not found: $ovpnCliCmakePath"
  }

  $findCoreDeps = Get-Content -Raw -Path $findCoreDepsPath
  # TAP adapters are filtered by this compile-time ComponentId. Connect uses
  # tap_ovpnconnect, while the Community driver uses tap0901.
  $tapDefinitionPattern = '-DTAP_WIN_COMPONENT_ID=[A-Za-z_][A-Za-z0-9_]*'
  if ($findCoreDeps -notmatch $tapDefinitionPattern) {
    throw "TAP_WIN_COMPONENT_ID definition not found in $findCoreDepsPath. Review the upstream Windows build configuration before building."
  }
  $findCoreDeps = $findCoreDeps -replace $tapDefinitionPattern, ("-DTAP_WIN_COMPONENT_ID=" + $tapComponentId.ToLowerInvariant())
  if ($findCoreDeps -notmatch 'OPENVPN_CLIENT_CUS_WIN_PATCH_TAP_HEADER') {
    $tapIncludeDirectory = Join-Path $ProjectRoot 'LICENSES\tap-windows6'
    if (-not (Test-Path -LiteralPath (Join-Path $tapIncludeDirectory 'tap-windows.h'))) {
      throw 'The bundled TAP interface header LICENSES/tap-windows6/tap-windows.h is missing.'
    }
    $tapIncludeCMake = $tapIncludeDirectory -replace '\\', '/'
    $includeAnchor = 'target_include_directories(${target} PRIVATE ${CORE_DIR})'
    if (-not $findCoreDeps.Contains($includeAnchor)) {
      throw "Core include directory definition not found in $findCoreDepsPath."
    }
    $tapIncludeLine = 'target_include_directories(${target} PRIVATE "' + $tapIncludeCMake + '") # OPENVPN_CLIENT_CUS_WIN_PATCH_TAP_HEADER'
    $findCoreDeps = $findCoreDeps.Replace($includeAnchor, $includeAnchor + "`n    " + $tapIncludeLine)
  }
  if ($findCoreDeps -notmatch '(?m)^\s*# OPENVPN_CLIENT_CUS_WIN_PATCH\s*$') {
    $patchedAddSsl = @'
function(add_ssl_library target)
    # OPENVPN_CLIENT_CUS_WIN_PATCH
    # Windows minimal build: avoid pkg-config dependency chain and link OpenSSL via CMake package.
    if (WIN32)
        find_package(OpenSSL REQUIRED)
        set(SSL_LIBRARY OpenSSL::SSL OpenSSL::Crypto)
        target_compile_definitions(${target} PRIVATE -DUSE_OPENSSL)
        target_link_libraries(${target} ${SSL_LIBRARY})
        return()
    endif()

    find_package(PkgConfig REQUIRED)
    if (${USE_MBEDTLS})
        pkg_search_module(mbedTLS IMPORTED_TARGET mbedtls3.6 mbedtls)
        if (mbedTLS_FOUND)
            pkg_search_module(mbedCrypto REQUIRED IMPORTED_TARGET mbedcrypto3.6 mbedcrypto)
            pkg_search_module(mbedX509 REQUIRED IMPORTED_TARGET mbedx5093.6 mbedx509)
            set(SSL_LIBRARY PkgConfig::mbedTLS PkgConfig::mbedCrypto PkgConfig::mbedX509)
        else ()
            find_package(mbedTLS REQUIRED)
            set(SSL_LIBRARY mbedTLS::mbedTLS)
        endif ()
        target_compile_definitions(${target} PRIVATE -DUSE_MBEDTLS)
    else ()
        pkg_search_module(OpenSSL REQUIRED IMPORTED_TARGET openssl)
        set(SSL_LIBRARY PkgConfig::OpenSSL)
        target_compile_definitions(${target} PRIVATE -DUSE_OPENSSL)
    endif ()

    target_link_libraries(${target} ${SSL_LIBRARY})
endfunction()
'@
    $updated = [regex]::Replace($findCoreDeps, 'function\(add_ssl_library target\)[\s\S]*?endfunction\(\)', $patchedAddSsl, 1)
    if ($updated -eq $findCoreDeps) {
      throw "Failed to patch add_ssl_library in $findCoreDepsPath"
    }
    $findCoreDeps = $updated
  }

  if ($findCoreDeps -notmatch "OPENVPN_CLIENT_CUS_WIN_PATCH_NO_LZ4") {
    # Windows minimal build: disable hard lz4 dependency to avoid extra native dependency chain.
    $findCoreDeps = $findCoreDeps -replace '-DHAVE_LZ4', '-DOPENVPN_CLIENT_CUS_WIN_PATCH_NO_LZ4'
    $findCoreDeps = $findCoreDeps -replace '(?ms)\n\s*find_package\(lz4 REQUIRED\)\s*\n\s*target_link_libraries\(\$\{target\} lz4::lz4\)\s*', "`n"
  }

  if ($findCoreDeps -notmatch "OPENVPN_CLIENT_CUS_WIN_PATCH_FMT_HEADER_ONLY") {
    $fmtIncludeCMake = ($fmtIncludeDir -replace '\\', '/')
    $patchedFmt = @"
    # OPENVPN_CLIENT_CUS_WIN_PATCH_FMT_HEADER_ONLY
    target_compile_definitions(`${target} PRIVATE FMT_HEADER_ONLY=1)
    target_include_directories(`${target} PRIVATE `"$fmtIncludeCMake`")
"@
    $findCoreDeps = $findCoreDeps -replace '(?ms)\n\s*find_package\(fmt REQUIRED\)\s*\n\s*target_link_libraries\(\$\{target\} fmt::fmt\)\s*', "`n$patchedFmt`n"
  }
  else {
    # A reused checkout may point at a different local fmt installation now.
    $fmtIncludeCMake = ($fmtIncludeDir -replace '\\', '/')
    $fmtPattern = '(# OPENVPN_CLIENT_CUS_WIN_PATCH_FMT_HEADER_ONLY\r?\n\s*target_compile_definitions\([^\r\n]+\)\r?\n\s*target_include_directories\(\$\{target\} PRIVATE ")[^"]*("\))'
    $findCoreDeps = [regex]::Replace($findCoreDeps, $fmtPattern, [Text.RegularExpressions.MatchEvaluator]{ param($match) $match.Groups[1].Value + $fmtIncludeCMake + $match.Groups[2].Value })
  }

  if ($findCoreDeps -match "OPENVPN_CLIENT_CUS_WIN_PATCH|OPENVPN_CLIENT_CUS_WIN_PATCH_NO_LZ4") {
    Write-PatchedFile $findCoreDepsPath $findCoreDeps
  }

  $ovpnCliCmake = Get-Content -Raw -Path $ovpnCliCmakePath
  if ($ovpnCliCmake -notmatch "OPENVPN_CLIENT_CUS_WIN_PATCH_OVPNCLIAGENT") {
    # Disable ovpncliagent target on Windows for minimal build to avoid jsoncpp/pkg-config dependency path.
    $ovpnCliCmake = $ovpnCliCmake -replace 'if \(WIN32\)', 'if (WIN32 AND FALSE) # OPENVPN_CLIENT_CUS_WIN_PATCH_OVPNCLIAGENT'
    Write-PatchedFile $ovpnCliCmakePath $ovpnCliCmake
  }

  # Recent Core releases configure additional JSON/agent executables at the
  # repository root. This client only launches ovpncli, so exclude those targets
  # rather than requiring their unrelated dependencies during configuration.
  $rootCmakePath = Join-Path $sourceDir "CMakeLists.txt"
  $rootCmake = Get-Content -LiteralPath $rootCmakePath -Raw
  foreach ($directory in @('openvpn/omi', 'openvpn/ovpnagent/win')) {
    $pattern = '(?m)^\s*add_subdirectory\(' + [regex]::Escape($directory) + '\)\s*$'
    $rootCmake = [regex]::Replace($rootCmake, $pattern, "# OPENVPN_CLIENT_CUS_WIN_PATCH_MINIMAL_TARGETS: skipped $directory")
  }
  Write-PatchedFile $rootCmakePath $rootCmake
}

Write-Host "[1/6] Checking/installing required commands..."
Write-Host "make/windows/build-openvpn3.ps1 version: $ScriptVersion"
Write-Host "Target TAP ComponentId: $TapComponentId (the matching driver and adapter must be installed on the client machine)."
Refresh-PathInCurrentSession

$gitPath = Ensure-CommandWithInstall "git" {
  Ensure-WingetInstalled
  Write-Host "Installing Git via winget..."
  Invoke-WingetInstall -Id "Git.Git"
}

$cmakePath = Ensure-CommandWithInstall "cmake" {
  Ensure-WingetInstalled
  Write-Host "Installing CMake via winget..."
  try {
    Invoke-WingetInstall -Id "Kitware.CMake"
  }
  catch {
    Write-Warning "winget CMake install failed: $($_.Exception.Message)"
  }
  if (-not (Get-CommandPathOrNull "cmake")) {
    Write-Warning "winget CMake install did not expose cmake in PATH. Falling back to MSI."
    Install-CMakeFallbackMsi
  }
}

if (-not (Get-VisualStudioWithCppPath)) {
  if (-not $AutoInstallDeps) {
    throw "Visual Studio Build Tools with C++ workload not found."
  }

  $existingVsPath = Get-AnyVisualStudioPath
  if ($existingVsPath) {
    try {
      Add-VcToolsWorkloadToExistingVisualStudio -installPath $existingVsPath
    }
    catch {
      Write-Warning "Failed to modify existing Visual Studio instance: $($_.Exception.Message)"
      Ensure-WingetInstalled
      Write-Host "Trying winget install for Visual Studio 2022 Build Tools..."
      try {
        Invoke-WingetInstall -Id "Microsoft.VisualStudio.2022.BuildTools" -OverrideArgs "--wait --quiet --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
      }
      catch {
        Write-Warning "winget install for VS Build Tools failed: $($_.Exception.Message)"
      }
    }
  }
  else {
    Ensure-WingetInstalled
    Write-Host "Installing Visual Studio Build Tools via winget: Microsoft.VisualStudio.2022.BuildTools"
    Invoke-WingetInstall -Id "Microsoft.VisualStudio.2022.BuildTools" -OverrideArgs "--wait --quiet --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  }
  Refresh-PathInCurrentSession
}

$vsPath = Get-VisualStudioWithCppPath
if (-not $vsPath) {
  throw "Visual Studio Build Tools with C++ workload is still not detected. Open Visual Studio Installer and install 'Desktop development with C++', then rerun."
}
$openSslRoot = Ensure-OpenSslSdk -AutoInstall $AutoInstallDeps
$asioIncludeDir = Ensure-AsioIncludeDir
$fmtIncludeDir = Ensure-FmtIncludeDir
Write-Host "Using CMake generator: $Generator"
Write-Host "Using OpenSSL root: $openSslRoot"
Write-Host "Using ASIO include dir: $asioIncludeDir"
Write-Host "Using fmt include dir: $fmtIncludeDir"
Write-Host "Build directories:"
Write-Host "  WorkDir : $WorkDir"
Write-Host "  SrcDir  : $SrcDir"
Write-Host "  BuildDir: $BuildDir"

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

try {
  Write-Host "[2/6] Checking cached OpenVPN3 source ($OpenVpn3Ref)..."
  Invoke-NativeChecked -exe 'node' -ArgumentList @((Join-Path $ProjectRoot 'make/engine-cache.mjs'), 'source', $WorkDir, $OpenVpn3RepoUrl) -step 'prepare cached engine source'
  if (-not (Test-Path $SrcDir)) {
    throw "git clone returned success but source directory does not exist: $SrcDir"
  }
  $sourceCommit = (& $gitPath -C $SrcDir rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sourceCommit -ne $releaseLock.commit) { throw 'Fetched source does not match the pinned OpenVPN release commit.' }

  Write-Host "[2.5/6] Applying minimal Windows build patch (skip non-essential targets/deps)..."
  Patch-OpenVpn3ForMinimalWindowsCliBuild -sourceDir $SrcDir -fmtIncludeDir $fmtIncludeDir -tapComponentId $TapComponentId

  Write-Host "[3/6] Configuring OpenVPN3 build..."
  $cmakeConfigureArgs = @(
    "-S", $SrcDir,
    "-B", $BuildDir,
    "-G", $Generator,
    "-A", $Platform,
    "-DCMAKE_BUILD_TYPE=$Configuration",
    "-DBUILD_TESTING=OFF",
    "-DOPENSSL_ROOT_DIR=$openSslRoot",
    "-DASIO_INCLUDE_DIR=$asioIncludeDir",
    # fmt static_assert requires MSVC to compile source as UTF-8.
    "-DCMAKE_C_FLAGS=/utf-8",
    "-DCMAKE_CXX_FLAGS=/utf-8 /EHsc"
  )
  Invoke-NativeChecked -exe $cmakePath -ArgumentList $cmakeConfigureArgs -step "cmake configure"
  if (-not (Test-Path $BuildDir)) {
    throw "CMake configure reported success but build directory does not exist: $BuildDir"
  }

  Write-Host "[4/6] Building ovpncli..."
  $cmakeBuildArgs = @("--build", $BuildDir, "--config", $Configuration, "--target", "ovpncli")
  if ($Force) { $cmakeBuildArgs += '--clean-first' }
  Invoke-NativeChecked -exe $cmakePath -ArgumentList $cmakeBuildArgs -step "cmake build ovpncli"

  $Candidates = @(
    (Join-Path $BuildDir "test\ovpncli\$Configuration\ovpncli.exe"),
    (Join-Path $BuildDir "test\ovpncli\ovpncli.exe"),
    (Join-Path $BuildDir "msvc\amd64\test\ovpncli\$Configuration\ovpncli.exe")
  )

  $BuiltBin = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $BuiltBin) {
    throw "ovpncli.exe not found under build output."
  }

  Write-Host "[5/6] Installing ovpncli.exe into .cache/native/bin/windows-x64..."
  $outputDir = Split-Path $OutputBin -Parent
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
  Copy-Item -Path $BuiltBin -Destination $OutputBin -Force
  Copy-OpenSSLRuntimeDlls -openSslRoot $openSslRoot -destinationDir $outputDir
  Copy-MsvcRuntimeDlls -visualStudioPath $vsPath -destinationDir $outputDir -targetPlatform $Platform
  # Bind the selected driver to the actual binary so packaging cannot reuse a
  # Connect-specific or stale engine with the standalone tap0901 driver.
  Invoke-NativeChecked -exe 'node' -ArgumentList @((Join-Path $ProjectRoot 'make/record-engine-build.mjs'), $SrcDir, $OutputBin, $Platform.ToLowerInvariant(), $TapComponentId.ToLowerInvariant(), $Configuration) -step 'record release provenance and licenses'
  Write-Host "[6/6] Done. ovpncli.exe available at: $OutputBin"
}
finally {
  Write-Host "Source and compiler cache retained: $WorkDir"
}

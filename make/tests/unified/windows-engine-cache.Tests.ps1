param([Parameter(Mandatory = $true)][string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'make/windows/build-openvpn3.ps1'), [ref]$null, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($name in @('Write-PatchedFile', 'Patch-OpenVpn3ForMinimalWindowsCliBuild')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$source = Join-Path $WorkDirectory 'patched-source'
New-Item -ItemType Directory -Path (Join-Path $source 'cmake'), (Join-Path $source 'test/ovpncli') -Force | Out-Null
$core = Join-Path $source 'cmake/findcoredeps.cmake'
@'
target_compile_definitions(${target} PRIVATE -DTAP_WIN_COMPONENT_ID=tap_ovpnconnect)
target_include_directories(${target} PRIVATE ${CORE_DIR})
function(add_ssl_library target)
    find_package(OpenSSL REQUIRED)
endfunction()
target_compile_definitions(${target} PRIVATE -DHAVE_LZ4)
find_package(lz4 REQUIRED)
target_link_libraries(${target} lz4::lz4)
find_package(fmt REQUIRED)
target_link_libraries(${target} fmt::fmt)
'@ | Set-Content -LiteralPath $core -Encoding UTF8
[IO.File]::WriteAllText((Join-Path $source 'test/ovpncli/CMakeLists.txt'), 'if (WIN32)')
[IO.File]::WriteAllText((Join-Path $source 'CMakeLists.txt'), "add_subdirectory(openvpn/omi)`nadd_subdirectory(openvpn/ovpnagent/win)`n")
Patch-OpenVpn3ForMinimalWindowsCliBuild $source 'C:\fmt first\include' tap0901
$files = @($core, (Join-Path $source 'CMakeLists.txt'), (Join-Path $source 'test/ovpncli/CMakeLists.txt'))
$fixedTime = [DateTime]::new(2020, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
foreach ($file in $files) { [IO.File]::SetLastWriteTimeUtc($file, $fixedTime) }
Patch-OpenVpn3ForMinimalWindowsCliBuild $source 'C:\fmt first\include' tap0901
foreach ($file in $files) {
    if ([IO.File]::GetLastWriteTimeUtc($file) -ne $fixedTime) { throw "Unchanged patch invalidated compiler cache: $file" }
}
Patch-OpenVpn3ForMinimalWindowsCliBuild $source 'D:\fmt second\include' tap0901
if (-not ([IO.File]::ReadAllText($core).Contains('D:/fmt second/include'))) { throw 'A changed fmt dependency path was not updated.' }
Write-Host 'Windows cached source patches remain incremental and follow dependency paths.'

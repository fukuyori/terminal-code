<#
.SYNOPSIS
    Builds and stages terminal-code for Windows.

.DESCRIPTION
    Compiles the TypeScript and web assets and stages the install under
    out\check\tode, to try it or check that it assembles. This is not the release
    build: it makes no archive or installer, signs nothing, and writes nowhere
    near out\windows-release, which holds what build-release.ps1 and
    build-installer.ps1 made and publish-windows.ps1 publishes.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Channel = "windows",
    [string]$OutputDirectory = "",
    [switch]$SkipPixel
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "stage-windows.ps1")
if (-not $Version) { $Version = $TodeWindowsVersion }

$root = Split-Path -Parent $PSScriptRoot
$out = if ($OutputDirectory) {
    $candidate = if ([IO.Path]::IsPathRooted($OutputDirectory)) {
        $OutputDirectory
    } else {
        Join-Path $root $OutputDirectory
    }
    [IO.Path]::GetFullPath($candidate)
} else {
    Join-Path $root "out\check"
}
$stage = Join-Path $out "tode"
$resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\')
$resolvedOut = [IO.Path]::GetFullPath($out).TrimEnd('\')
if (-not $resolvedOut.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to replace build output outside the repository: $resolvedOut"
}

Invoke-TodeBuild $root -SkipPixel:$SkipPixel

Write-Output "==> staging $Version"
if (Test-Path -LiteralPath $out) {
    Remove-Item -LiteralPath $out -Recurse -Force
}
New-TodeStage $root $stage $Version $Channel

$required = @(
    "bin\tode.cmd", "dist\main.js", "package.json", "VERSION", "CHANNEL", "PIXEL", "runtime\node.exe",
    "node_modules\@zenbu-labs\pixel\electron\dist\pixel.exe",
    "node_modules\@zenbu-labs\pixel-native-win32-x64\pixel.node"
)
foreach ($relativePath in $required) {
    $path = Join-Path $stage $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "build did not create required payload file: $path"
    }
}

Write-Output "built $Version"
Write-Output "  payload $stage"
Write-Output "try it: $stage\bin\tode.cmd   release: scripts\build-release.ps1 -Sign"

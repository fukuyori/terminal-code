<#
.SYNOPSIS
    Builds and stages terminal-code for Windows.

.DESCRIPTION
    Compiles the TypeScript and web assets, then creates the payload consumed by
    package-windows.ps1 under out\windows-release\tode. This script does not
    create an archive or installer and does not modify the installed copy.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Channel = "windows",
    [string]$OutputDirectory = ""
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
    Join-Path $root "out\windows-release"
}
$stage = Join-Path $out "tode"
$resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\')
$resolvedOut = [IO.Path]::GetFullPath($out).TrimEnd('\')
if (-not $resolvedOut.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to replace build output outside the repository: $resolvedOut"
}

Invoke-TodeBuild $root

Write-Output "==> staging $Version"
if (Test-Path -LiteralPath $out) {
    Remove-Item -LiteralPath $out -Recurse -Force
}
New-TodeStage $root $stage $Version $Channel

$required = @("bin\tode.cmd", "dist\main.js", "package.json", "VERSION", "CHANNEL")
foreach ($relativePath in $required) {
    $path = Join-Path $stage $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "build did not create required payload file: $path"
    }
}

Write-Output "built $Version"
Write-Output "  payload $stage"
Write-Output "next: scripts\package-windows.ps1"

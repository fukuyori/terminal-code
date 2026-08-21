<#
.SYNOPSIS
    Publishes the built Windows release to GitHub.

.DESCRIPTION
    Step 3 of cutting a Windows release: hands the zip, the manifests and the
    installer from out\windows-release to `gh release create v<version>`.
    That tag is where the windows channel looks — releases/latest/download/
    latest.json for `tode --upgrade`, the tag's own manifest.json for a
    pinned --version. The posix counterpart is scripts/publish-r2.sh.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Repo = "fukuyori/terminal-code",
    [switch]$AllowUnsigned
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "stage-windows.ps1")
if (-not $Version) { $Version = $TodeWindowsVersion }

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "out\windows-release"

$zip = Join-Path $out "tode-$Version-win32-x64.zip"
$latest = Join-Path $out "latest.json"
$pinned = Join-Path $out "manifest.json"
foreach ($file in @($zip, $latest, $pinned)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "missing $file; run scripts\release-windows.ps1 first"
    }
}
$built = (Get-Content -LiteralPath $latest -Raw | ConvertFrom-Json).version
if ($built -ne $Version) {
    throw "out\windows-release holds $built, not $Version; re-run scripts\release-windows.ps1"
}

$assets = @($zip, $latest, $pinned)
$installer = Get-ChildItem -LiteralPath $out -Filter "tode-*-windows-x64.exe" -File |
    Select-Object -First 1
if ($installer) {
    if ((Get-AuthenticodeSignature $installer.FullName).Status -ne "Valid" -and -not $AllowUnsigned) {
        throw "$($installer.Name) is unsigned; run scripts\installer-windows.ps1 -Sign, or pass -AllowUnsigned"
    }
    $assets += $installer.FullName
} else {
    Write-Warning "no installer in $out; publishing the zip alone (scripts\installer-windows.ps1 builds one)"
}

Write-Output "==> publishing v$Version to $Repo"
$notes = @(
    "Windows x64 build. ``tode --upgrade`` picks this up."
    ""
    if ($installer) { "``$($installer.Name)`` installs per-user; the zip is what the upgrade channel downloads." }
    else { "The zip is what the upgrade channel downloads." }
) -join "`n"
& gh release create "v$Version" @assets --repo $Repo --title "tode $Version" --notes $notes
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

Write-Output "published https://github.com/$Repo/releases/tag/v$Version"

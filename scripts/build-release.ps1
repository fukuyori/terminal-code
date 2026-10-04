<#
.SYNOPSIS
    Builds the Windows release artifacts: the staged payload, the zip the
    upgrade downloads, and the manifests beside it.

.DESCRIPTION
    Step 1 of cutting a Windows release; build-installer.ps1 wraps the
    payload this leaves behind into a signed installer, and
    publish-windows.ps1 hands everything to a GitHub release. The posix
    counterpart is scripts/release.sh.

    Everything lands in out\windows-release: tode\ (the staged payload,
    kept for the installer), tode-<version>-win32-x64.zip, latest.json,
    manifest.json and release.json (the record of what this run made).
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Channel = "windows",
    [string]$Repo = "fukuyori/terminal-code",
    [switch]$Sign
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "stage-windows.ps1")
if (-not $Version) { $Version = $TodeWindowsVersion }

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "out\windows-release"

Invoke-TodeBuild $root

Write-Output "==> staging $Version"
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
# the directory name becomes the archive's single top level, which the
# upgrade extracts with --strip-components 1
$stage = Join-Path $out "tode"
New-TodeStage $root $stage $Version $Channel

if ($Sign) {
    # before the zip, so the copy an upgrade downloads carries the signatures too
    Write-Output "==> signing the payload"
    & (Join-Path $PSScriptRoot "sign-windows.ps1") -Payload
    if ($LASTEXITCODE -ne 0) { throw "signing the payload failed" }
}

Write-Output "==> packaging"
$file = "tode-$Version-win32-x64.zip"
$zip = Join-Path $out $file
# System32's bsdtar, the same binary the upgrade extracts with. It writes
# forward-slash entry names; Compress-Archive historically wrote
# backslashes, which everything but Windows reads as literal filenames.
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
& $tar -a -cf $zip -C $out tode
if ($LASTEXITCODE -ne 0) { throw "tar failed" }

$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zip).Length
$manifest = [ordered]@{
    version = $Version
    channel = $Channel
    platforms = [ordered]@{
        "win32-x64" = [ordered]@{
            file = $file
            sha256 = $sha
            size = $size
            url = "https://github.com/$Repo/releases/download/v$Version/$file"
        }
    }
} | ConvertTo-Json -Depth 4
# the same document twice: latest.json is what the stable
# releases/latest/download alias serves, manifest.json is what a pinned
# --version download reads out of its own tag
Set-Content -LiteralPath (Join-Path $out "latest.json") -Value $manifest -Encoding ascii
Set-Content -LiteralPath (Join-Path $out "manifest.json") -Value $manifest -Encoding ascii

# What build-installer.ps1 and publish-windows.ps1 trust: that this directory was
# made by this script, which version and which zip. A directory made by any other
# script has no such record, and they refuse it.
$record = [ordered]@{
    madeBy = "build-release.ps1"
    version = $Version
    channel = $Channel
    signed = [bool]$Sign
    builtAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    zip = [ordered]@{ file = $file; sha256 = $sha }
}
Set-Content -LiteralPath (Join-Path $out "release.json") -Value ($record | ConvertTo-Json -Depth 4) -Encoding ascii

Write-Output "packaged $Version"
Write-Output "  payload   $stage"
Write-Output "  zip       $zip"
Write-Output "  manifests $(Join-Path $out 'latest.json'), $(Join-Path $out 'manifest.json')"
Write-Output "next: scripts\build-installer.ps1 -Sign, then scripts\publish-windows.ps1"

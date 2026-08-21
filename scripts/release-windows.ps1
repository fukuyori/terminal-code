<#
.SYNOPSIS
    Builds the Windows release artifacts: the staged payload, the zip the
    upgrade downloads, and the manifests beside it.

.DESCRIPTION
    Step 1 of cutting a Windows release; installer-windows.ps1 wraps the
    payload this leaves behind into a signed installer, and
    publish-windows.ps1 hands everything to a GitHub release. The posix
    counterpart is scripts/release.sh.

    Everything lands in out\windows-release: tode\ (the staged payload,
    kept for the installer), tode-<version>-win32-x64.zip, latest.json and
    manifest.json.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Channel = "windows",
    [string]$Repo = "fukuyori/terminal-code"
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

Write-Output "packaged $Version"
Write-Output "  payload   $stage"
Write-Output "  zip       $zip"
Write-Output "  manifests $(Join-Path $out 'latest.json'), $(Join-Path $out 'manifest.json')"
Write-Output "next: scripts\installer-windows.ps1 -Sign, then scripts\publish-windows.ps1"

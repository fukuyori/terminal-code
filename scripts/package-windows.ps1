<#
.SYNOPSIS
    Packages a staged Windows build using ZIP and Inno Setup.

.DESCRIPTION
    Reads the payload created by build-windows.ps1, creates the upgrade ZIP and
    manifests, and compiles the per-user installer with Inno Setup. terminal-code
    has no native tode.exe; its launcher is bin\tode.cmd, so this script has no
    signing option. Inno Setup includes its standard uninstaller in the installer.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Repo = "fukuyori/terminal-code",
    [string]$IsccPath = "",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

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
$resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\')
$resolvedOut = [IO.Path]::GetFullPath($out).TrimEnd('\')
if (-not $resolvedOut.StartsWith("$resolvedRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to package outside the repository: $resolvedOut"
}
$payload = Join-Path $out "tode"
$iss = Join-Path $root "installer\tode.iss"

$required = @("bin\tode.cmd", "dist\main.js", "package.json", "VERSION", "CHANNEL")
foreach ($relativePath in $required) {
    $path = Join-Path $payload $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "missing payload file: $path; run scripts\build-windows.ps1 first"
    }
}

$payloadVersion = (Get-Content -LiteralPath (Join-Path $payload "VERSION") -Raw).Trim()
if (-not $Version) { $Version = $payloadVersion }
if ($Version -ne $payloadVersion) {
    throw "the payload is $payloadVersion, not $Version; rebuild it with scripts\build-windows.ps1 -Version $Version"
}

$match = [regex]::Match($Version, '^v?(?<base>\d+\.\d+\.\d+)(?:-win\.(?<fork>\d+))?$')
if (-not $match.Success) {
    throw "invalid Windows release version: $Version; expected a version such as 0.3.4-win.1"
}
$fork = if ($match.Groups["fork"].Success) { $match.Groups["fork"].Value } else { "0" }
$fileVersion = "$($match.Groups['base'].Value).$fork"

$file = "tode-$Version-win32-x64.zip"
$zip = Join-Path $out $file
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

Write-Output "==> creating upgrade archive"
$windowsRoot = if ($env:SystemRoot) { $env:SystemRoot } else { "C:\Windows" }
$tar = Join-Path $windowsRoot "System32\tar.exe"
if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) {
    throw "tar.exe was not found: $tar"
}
& $tar -a -cf $zip -C $out tode
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }

$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zip).Length
$manifest = [ordered]@{
    version = $Version
    channel = (Get-Content -LiteralPath (Join-Path $payload "CHANNEL") -Raw).Trim()
    platforms = [ordered]@{
        "win32-x64" = [ordered]@{
            file = $file
            sha256 = $sha
            size = $size
            url = "https://github.com/$Repo/releases/download/v$Version/$file"
        }
    }
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $out "latest.json") -Value $manifest -Encoding ascii
Set-Content -LiteralPath (Join-Path $out "manifest.json") -Value $manifest -Encoding ascii

if (-not $IsccPath) {
    $command = Get-Command iscc -ErrorAction SilentlyContinue
    if ($command) {
        $IsccPath = $command.Source
    } else {
        $candidates = @(
            "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
            "C:\Program Files\Inno Setup 6\ISCC.exe",
            "C:\Program Files (x86)\Inno Setup 7\ISCC.exe",
            "C:\Program Files\Inno Setup 7\ISCC.exe"
        )
        $IsccPath = $candidates |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
    }
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
    throw "ISCC.exe was not found; install Inno Setup or pass -IsccPath"
}

Write-Output "==> creating Inno Setup installer"
$baseName = "tode-$fileVersion-windows-x64"
$installer = Join-Path $out "$baseName.exe"
if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force }
& $IsccPath "/DMyAppVersion=$fileVersion" "/DPayloadDir=$payload" "/O$out" "/F$baseName" $iss
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Inno Setup did not create the expected installer: $installer"
}

Write-Output "packaged $Version"
Write-Output "  zip       $zip"
Write-Output "  installer $installer"
Write-Output "  manifests $(Join-Path $out 'latest.json'), $(Join-Path $out 'manifest.json')"

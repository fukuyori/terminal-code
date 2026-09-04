<#
.SYNOPSIS
    Compiles the Inno Setup installer from the payload release-windows.ps1
    staged, signing it when asked.

.DESCRIPTION
    Step 2 of cutting a Windows release. The payload is out\windows-release\tode;
    the installer lands beside it as tode-<numeric-version>-windows-x64.exe.
    -Sign hands Inno a SignTool that runs scripts\sign-windows.ps1, so the
    setup and the uninstaller it assembles are both signed with the
    certificate CODESIGN_CERT names. The shape follows terminal-browser's
    package-windows-inno.ps1.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^$|^\d+\.\d+\.\d+(?:\.\d+)?$')]
    [string]$Version = "",
    [string]$IsccPath = "",
    [switch]$Sign
)

$ErrorActionPreference = "Stop"

# A parent PowerShell 7 leaves its module directories in PSModulePath, and they
# hide Windows PowerShell's own copies of cmdlets such as Get-FileHash.
if ($PSVersionTable.PSEdition -eq "Desktop") {
    $system = Join-Path $PSHOME "Modules"
    $others = ($env:PSModulePath -split ";") | Where-Object { $_ -and $_ -ne $system }
    $env:PSModulePath = (@($system) + $others) -join ";"
}

$root = Split-Path -Parent $PSScriptRoot
$payload = Join-Path $root "out\windows-release\tode"
$output = Join-Path $root "out\windows-release"
$iss = Join-Path $root "installer\tode.iss"

$required = @("bin\tode.cmd", "dist\main.js", "package.json", "VERSION", "CHANNEL")
foreach ($relativePath in $required) {
    $path = Join-Path $payload $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "missing payload file: $path; run scripts\release-windows.ps1 first"
    }
}

if (-not $Version) {
    # A Windows file version is four numbers, so the fork revision of
    # 0.3.4-win.1 becomes the fourth one: 0.3.4.1.
    $payloadVersion = (Get-Content -LiteralPath (Join-Path $payload "VERSION") -Raw).Trim()
    $match = [regex]::Match($payloadVersion, '^v?(?<base>\d+\.\d+\.\d+)(?:-win\.(?<fork>\d+))?$')
    if ($match.Success) {
        $fork = if ($match.Groups["fork"].Success) { $match.Groups["fork"].Value } else { "0" }
        $Version = "$($match.Groups['base'].Value).$fork"
    } else {
        $Version = "0.0.0.0"
        Write-Warning "'$payloadVersion' is not a release version, so the installer says 0.0.0.0"
    }
}

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
        $IsccPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
    throw "ISCC.exe was not found; install Inno Setup 6 or pass -IsccPath"
}

$baseName = "tode-$Version-windows-x64"
$options = @("/DMyAppVersion=$Version", "/O$output", "/F$baseName")
if ($Sign) {
    # Inno signs the uninstaller as well, which it assembles on the user's
    # machine, so that one cannot wait for a signing pass afterwards. Inno
    # expands $f to the file to sign, quotes included, and $q to a quote of
    # our own.
    $signer = Join-Path $PSScriptRoot "sign-windows.ps1"
    $command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `$q$signer`$q `$f"
    $options += "/DSignTool=tode"
    $options += "/Stode=$command"
}
& $IsccPath @options $iss
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE"
}

$installer = Join-Path $output "$baseName.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Inno Setup did not create the expected installer: $installer"
}
if ($Sign -and (Get-AuthenticodeSignature $installer).Status -ne "Valid") {
    throw "$installer is not validly signed"
}

Write-Output $installer

<#
.SYNOPSIS
    Signs the Windows installer (or any files passed in) with the certificate
    named by CODESIGN_CERT.

.DESCRIPTION
    The same shape as terminal-browser's sign-windows.ps1, so the two release
    flows sign the same way. Inno Setup calls this per file for the setup and
    the uninstaller it assembles; run with no arguments it finds whatever in
    out\windows-release still needs a signature. The payload itself ships no
    native binaries — the .cmd and .js files are not signable — so the
    installer is the whole surface.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Path,
    [string]$CertSubject = $env:CODESIGN_CERT,
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [string]$SignTool = ""
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

function ResolveSignTool([string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) {
            throw "signtool not found: $Explicit"
        }
        return $Explicit
    }
    $kit = "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\signtool.exe"
    if (Test-Path -LiteralPath $kit -PathType Leaf) { return $kit }
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $bins = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")
    $candidates = foreach ($bin in $bins) {
        if (Test-Path -LiteralPath $bin) {
            Get-ChildItem -LiteralPath $bin -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -like "*\x64\*" }
        }
    }
    $newest = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $newest) {
        throw "signtool.exe not found; install the Windows SDK signing tools or pass -SignTool"
    }
    return $newest.FullName
}

function DefaultTargets {
    $out = Join-Path $root "out\windows-release"
    $targets = @()
    if (Test-Path -LiteralPath $out) {
        $targets += (Get-ChildItem -LiteralPath $out -Filter "tode-*-windows-x64.exe" -File).FullName
    }
    return $targets | Where-Object {
        $_ -and (Get-AuthenticodeSignature $_).Status -ne "Valid"
    }
}

if (-not $CertSubject) {
    throw "no signing certificate: set CODESIGN_CERT to the certificate's subject name, or pass -CertSubject"
}
$certificates = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -like "*$CertSubject*" })
if ($certificates.Count -eq 0) {
    throw "no code signing certificate matches '$CertSubject'; if it lives on a token, plug it in"
}

$targets = @(if ($Path) { $Path } else { DefaultTargets })
if ($targets.Count -eq 0) {
    Write-Output "everything is signed already"
    return
}
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "missing file: $target" }
}

# One call so a token asks for its PIN once.
$signtool = ResolveSignTool $SignTool
& $signtool sign /fd SHA256 /n $CertSubject /tr $TimestampUrl /td SHA256 @targets
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }

foreach ($target in $targets) {
    $signature = Get-AuthenticodeSignature $target
    if ($signature.Status -ne "Valid") {
        throw "$target is $($signature.Status) after signing"
    }
    Write-Output $target
}

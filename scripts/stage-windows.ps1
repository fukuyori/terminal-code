<#
.SYNOPSIS
    The staging shared by dist-windows.ps1 and release-windows.ps1.

.DESCRIPTION
    Dot-source this file for Invoke-TodeBuild and New-TodeStage. A dev install
    and a release zip carry the identical layout (dist\, assets\, config\,
    bin\tode.cmd, VERSION, CHANNEL, package.json), so the layout is written
    once, here, and the callers only differ in where the stage goes next.
#>

# The version a Windows build reports: the upstream version this fork builds
# on plus its own revision, the way terminal-browser's Windows builds are
# named. Both entry scripts default to this line — edit it to cut a new one.
$TodeWindowsVersion = "0.1.0-win.2"

function Invoke-TodeBuild([string]$Root) {
    Write-Output "==> building"
    Push-Location $Root
    try {
        & npm run -s build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }
}

function New-TodeStage([string]$Root, [string]$Stage, [string]$Version, [string]$Channel) {
    if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
    New-Item -ItemType Directory -Path $Stage -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $Root "dist") -Destination (Join-Path $Stage "dist") -Recurse
    Copy-Item -LiteralPath (Join-Path $Root "assets") -Destination (Join-Path $Stage "assets") -Recurse
    if (Test-Path -LiteralPath (Join-Path $Root "config")) {
        Copy-Item -LiteralPath (Join-Path $Root "config") -Destination (Join-Path $Stage "config") -Recurse
    }
    Set-Content -LiteralPath (Join-Path $Stage "VERSION") -Value $Version -Encoding ascii
    Set-Content -LiteralPath (Join-Path $Stage "CHANNEL") -Value $Channel -Encoding ascii
    # dist\ is CommonJS; without a package boundary here node walks up, and a
    # parent package.json with "type": "module" turns the install into broken ESM
    Set-Content -LiteralPath (Join-Path $Stage "package.json") -Value '{"type":"commonjs"}' -Encoding ascii

    # The launcher. Windows cannot exec a shell script, so this is the .cmd every
    # other entry point (the PATH entry, the bridge, an upgrade) copies around. It
    # prefers the node.exe terminal-browser ships, which is the one build tode is
    # tested against, and falls back to whatever node is on PATH.
    $launcher = @'
@echo off
setlocal
if not defined TODE_INSTALL_ROOT set "TODE_INSTALL_ROOT=%~dp0.."
set "TODE_NODE=%LOCALAPPDATA%\Programs\terminal-browser\runtime\node.exe"
if not exist "%TODE_NODE%" set "TODE_NODE=%TODE_INSTALL_ROOT%\vendor\terminal-browser\runtime\node.exe"
if not exist "%TODE_NODE%" set "TODE_NODE=node"
"%TODE_NODE%" "%TODE_INSTALL_ROOT%\dist\main.js" %*
endlocal & exit /b %ERRORLEVEL%
'@
    New-Item -ItemType Directory -Path (Join-Path $Stage "bin") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $Stage "bin\tode.cmd") -Value $launcher -Encoding ascii
}

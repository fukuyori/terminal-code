<#
.SYNOPSIS
    The staging shared by the Windows build and development-install scripts.

.DESCRIPTION
    Dot-source this file for Invoke-TodeBuild and New-TodeStage. A dev install
    and a packaged build carry the identical layout (dist\, assets\, config\,
    bin\tode.cmd, VERSION, CHANNEL, package.json), so the layout is written
    once, here, and the callers only differ in where the stage goes next.
#>

# The version a Windows build reports: the upstream version this fork builds
# on plus its own revision, the way terminal-browser's Windows builds are
# named. Both entry scripts default to this line — edit it to cut a new one.
$TodeWindowsVersion = "0.4.2-win.1"

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

# Where the Windows build of pixel comes from. npm publishes pixel for macOS and
# Linux only, so the window process on Windows is the one built in the
# terminal-browser fork (its pixel\ directory). Name that repository's root with
# -TerminalBrowser on the build scripts, or with TODE_TERMINAL_BROWSER.
function Resolve-TodePixel([string]$TerminalBrowser) {
    if (-not $TerminalBrowser) { $TerminalBrowser = $env:TODE_TERMINAL_BROWSER }
    if (-not $TerminalBrowser) {
        throw "name the terminal-browser checkout that holds the Windows build of pixel: -TerminalBrowser <dir>, or set TODE_TERMINAL_BROWSER"
    }
    $repo = [IO.Path]::GetFullPath($TerminalBrowser)
    $package = Join-Path $repo "pixel\packages\pixel"
    $native = Join-Path $repo "pixel\packages\native\win32-x64"
    $required = @(
        (Join-Path $package "package.json"),
        (Join-Path $package "dist\index.js"),
        (Join-Path $package "electron\dist\pixel.exe"),
        (Join-Path $package "electron\dist\.zenbu-electron-sha256"),
        (Join-Path $native "package.json"),
        (Join-Path $native "pixel.node")
    )
    foreach ($path in $required) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "pixel is not built in ${repo}: missing $path (build it there first, see that repository's scripts\build-windows.ps1)"
        }
    }
    [pscustomobject]@{ Repo = $repo; Package = $package; Native = $native }
}

# The stage gets the dependencies the lock file names, exactly as upstream's
# dist.sh installs them, and then pixel is swapped for the Windows build: its
# dist, its patched electron, and the native engine beside it.
function Add-TodeDependencies([string]$Root, [string]$Stage, $Pixel) {
    $work = "$Stage.deps"
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    try {
        Copy-Item -LiteralPath (Join-Path $Root "package.json") -Destination $work
        Copy-Item -LiteralPath (Join-Path $Root "package-lock.json") -Destination $work
        Push-Location $work
        try {
            & npm ci --omit=dev --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        } finally {
            Pop-Location
        }
        Move-Item -LiteralPath (Join-Path $work "node_modules") -Destination (Join-Path $Stage "node_modules")
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }

    $scope = Join-Path $Stage "node_modules\@zenbu-labs"
    $target = Join-Path $scope "pixel"
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $target "electron") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Pixel.Package "package.json") -Destination $target
    Copy-Item -LiteralPath (Join-Path $Pixel.Package "dist") -Destination (Join-Path $target "dist") -Recurse
    Copy-Item -LiteralPath (Join-Path $Pixel.Package "electron\dist") -Destination (Join-Path $target "electron\dist") -Recurse

    $native = Join-Path $scope "pixel-native-win32-x64"
    if (Test-Path -LiteralPath $native) { Remove-Item -LiteralPath $native -Recurse -Force }
    New-Item -ItemType Directory -Path $native -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Pixel.Native "package.json") -Destination $native
    Copy-Item -LiteralPath (Join-Path $Pixel.Native "pixel.node") -Destination $native

    # the engine and the js that drives it have to come from the same build
    $built = (Get-FileHash -LiteralPath (Join-Path $Pixel.Native "pixel.node") -Algorithm SHA256).Hash
    $staged = (Get-FileHash -LiteralPath (Join-Path $native "pixel.node") -Algorithm SHA256).Hash
    if ($built -ne $staged) { throw "the engine binary changed while it was copied: $built, $staged" }

    # where this pixel came from, for the next person who has to ask
    $commit = (& git -C $Pixel.Repo rev-parse HEAD 2>$null)
    $dirty = if ((& git -C $Pixel.Repo status --porcelain -- pixel 2>$null)) { " (uncommitted changes in pixel\)" } else { "" }
    $pixelVersion = (Get-Content -LiteralPath (Join-Path $Pixel.Package "package.json") -Raw | ConvertFrom-Json).version
    $record = @(
        "pixel $pixelVersion",
        "terminal-browser $commit$dirty",
        "pixel.node sha256 $built"
    )
    Set-Content -LiteralPath (Join-Path $Stage "PIXEL") -Value $record -Encoding ascii
}

function New-TodeStage([string]$Root, [string]$Stage, [string]$Version, [string]$Channel, [string]$TerminalBrowser = "") {
    $pixel = Resolve-TodePixel $TerminalBrowser
    if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
    New-Item -ItemType Directory -Path $Stage -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $Root "dist") -Destination (Join-Path $Stage "dist") -Recurse
    Add-TodeDependencies $Root $Stage $pixel
    Copy-Item -LiteralPath (Join-Path $Root "assets") -Destination (Join-Path $Stage "assets") -Recurse
    if (Test-Path -LiteralPath (Join-Path $Root "config")) {
        Copy-Item -LiteralPath (Join-Path $Root "config") -Destination (Join-Path $Stage "config") -Recurse
    }
    Set-Content -LiteralPath (Join-Path $Stage "VERSION") -Value $Version -Encoding ascii
    Set-Content -LiteralPath (Join-Path $Stage "CHANNEL") -Value $Channel -Encoding ascii
    # dist\ is CommonJS; without a package boundary here node walks up, and a
    # parent package.json with "type": "module" turns the install into broken ESM
    Set-Content -LiteralPath (Join-Path $Stage "package.json") -Value '{"type":"commonjs"}' -Encoding ascii

    # A real node.exe travels with the install. The window process attaches to
    # the console of the process that opened it, and electron's pixel.exe is a
    # GUI program with no console of its own, even when it runs as node, so the
    # command has to be a console program: AttachConsole fails otherwise.
    $node = (Get-Command node -ErrorAction Stop).Source
    New-Item -ItemType Directory -Path (Join-Path $Stage "runtime") -Force | Out-Null
    Copy-Item -LiteralPath $node -Destination (Join-Path $Stage "runtime\node.exe")

    # The launcher. Windows cannot exec a shell script, so this is the .cmd every
    # other entry point (the PATH entry, the bridge, an upgrade) copies around.
    $launcher = @'
@echo off
setlocal
if not defined TODE_INSTALL_ROOT set "TODE_INSTALL_ROOT=%~dp0.."
"%TODE_INSTALL_ROOT%\runtime\node.exe" --disable-warning=ExperimentalWarning "%TODE_INSTALL_ROOT%\dist\main.js" %*
endlocal & exit /b %ERRORLEVEL%
'@
    New-Item -ItemType Directory -Path (Join-Path $Stage "bin") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $Stage "bin\tode.cmd") -Value $launcher -Encoding ascii
}

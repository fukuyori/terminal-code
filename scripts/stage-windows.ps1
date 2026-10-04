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

function Invoke-TodeBuild([string]$Root, [switch]$SkipPixel) {
    if (-not $SkipPixel) {
        & (Join-Path $Root "scripts\build-pixel.ps1")
        if (-not $?) { throw "building pixel failed" }
    }
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
# Linux only, so the window process on Windows is built from the copy of pixel
# kept in this repository (pixel\, see docs\pixel-origin.md) by
# scripts\build-pixel.ps1, and the stage takes its output from there.
function Resolve-TodePixel([string]$Root) {
    $package = Join-Path $Root "pixel\packages\pixel"
    $native = Join-Path $Root "pixel\packages\native\win32-x64"
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
            throw "pixel is not built: missing $path (run scripts\build-pixel.ps1)"
        }
    }
    [pscustomobject]@{ Repo = $Root; Package = $package; Native = $native }
}

# The pixel source a build used, named by what is in it rather than by a commit,
# so the name is the same before and after the change is committed and a build
# does not have to wait for one. Each file under pixel\ (tracked or not, build
# output and other ignored files left out) is hashed the way git would store it,
# which does not depend on how this checkout writes line endings, and the
# "path blob" lines in path order are hashed together.
function Get-TodePixelSource([string]$Root) {
    $files = @(& git -C $Root ls-files --cached --others --exclude-standard -- pixel 2>$null)
    if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ Hash = "unknown"; Count = 0 } }
    $files = [string[]]@($files | Where-Object { Test-Path -LiteralPath (Join-Path $Root $_) -PathType Leaf })
    if ($files.Count -eq 0) { return [pscustomobject]@{ Hash = "unknown"; Count = 0 } }
    [Array]::Sort($files, [StringComparer]::Ordinal)
    # the paths go to git through a file: Windows PowerShell puts a byte order
    # mark in front of what it pipes to a program, and git would read it as part
    # of the first path
    $list = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($list, (($files -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
        $blobs = @(& cmd.exe /c "git -C `"$Root`" hash-object --stdin-paths < `"$list`"" 2>$null)
        $status = $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $list -Force -ErrorAction SilentlyContinue
    }
    if ($status -ne 0 -or $blobs.Count -ne $files.Count) { return [pscustomobject]@{ Hash = "unknown"; Count = 0 } }
    $lines = for ($i = 0; $i -lt $files.Count; $i++) { "$($files[$i]) $($blobs[$i])" }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")
    $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
    [pscustomobject]@{ Hash = $hash; Count = $files.Count }
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
    $source = Get-TodePixelSource $Pixel.Repo
    $commit = (& git -C $Pixel.Repo rev-parse HEAD 2>$null)
    $dirty = if ((& git -C $Pixel.Repo status --porcelain 2>$null)) { " (the working tree had uncommitted changes)" } else { "" }
    $pixelVersion = (Get-Content -LiteralPath (Join-Path $Pixel.Package "package.json") -Raw | ConvertFrom-Json).version
    $origin = ""
    $originFile = Join-Path $Pixel.Repo "docs\pixel-origin.md"
    if (Test-Path -LiteralPath $originFile) {
        $match = [regex]::Match((Get-Content -LiteralPath $originFile -Raw), 'Source commit \| `(?<sha>[0-9a-f]{40})`')
        if ($match.Success) { $origin = $match.Groups["sha"].Value }
    }
    $record = @(
        "pixel $pixelVersion",
        "pixel source: terminal-browser $origin (docs\pixel-origin.md)",
        "pixel source sha256 $($source.Hash) ($($source.Count) files)",
        "pixel.node sha256 $built",
        "terminal-code $commit$dirty"
    )
    Set-Content -LiteralPath (Join-Path $Stage "PIXEL") -Value $record -Encoding ascii
}

function New-TodeStage([string]$Root, [string]$Stage, [string]$Version, [string]$Channel) {
    $pixel = Resolve-TodePixel $Root
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

<#
.SYNOPSIS
    Builds the copy of pixel in pixel\ for Windows.

.DESCRIPTION
    The window tode draws into the terminal is pixel, and npm publishes it for
    macOS and Linux only, so the Windows build is made from the snapshot kept in
    this repository (see docs\pixel-origin.md). Everything lands inside pixel\
    and is ignored by git:

      pixel\packages\pixel\dist                       the TypeScript package
      pixel\packages\native\win32-x64\pixel.node      the engine (Rust)
      pixel\packages\pixel\electron\dist              the Electron pixel runs in

    The engine needs a Rust toolchain with the MSVC build tools; the first build
    fetches the crates and compiles all of them, which takes a few minutes.
    Electron is downloaded from its releases, checked against their SHA-256 sums,
    and left alone on later runs while it is intact.

    stage-windows.ps1 copies these into the install; build-check.ps1,
    build-release.ps1 and dist-windows.ps1 run this first.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# A parent PowerShell 7 leaves its module directories in PSModulePath, and they
# hide Windows PowerShell's own copies of cmdlets such as Get-FileHash.
if ($PSVersionTable.PSEdition -eq "Desktop") {
    $system = Join-Path $PSHOME "Modules"
    $others = ($env:PSModulePath -split ";") | Where-Object { $_ -and $_ -ne $system }
    $env:PSModulePath = (@($system) + $others) -join ";"
}

$root = Split-Path -Parent $PSScriptRoot
$pixel = Join-Path $root "pixel"
$package = Join-Path $pixel "packages\pixel"
$native = Join-Path $pixel "packages\native\win32-x64"

if (-not [Environment]::Is64BitOperatingSystem) { throw "Windows x64 is required" }
if (-not (Test-Path -LiteralPath (Join-Path $package "package.json"))) {
    throw "no pixel source at $pixel; see docs\pixel-origin.md"
}
foreach ($tool in @("node", "npm", "cargo")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not on PATH; building pixel needs Node.js, npm and a Rust toolchain (rustup)"
    }
}

# tsc leaves the output of deleted sources behind, and a failed native build
# leaves the last engine, so these two are made again from scratch.
foreach ($stale in @((Join-Path $package "dist"), (Join-Path $native "pixel.node"))) {
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Recurse -Force }
}

Push-Location $package
try {
    Write-Output "==> pixel: dependencies"
    # the postinstall is run on its own below, so that a failed download says so
    if (Test-Path -LiteralPath "package-lock.json") {
        & npm ci --ignore-scripts --no-audit --no-fund
    } else {
        & npm install --ignore-scripts --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) { throw "installing pixel's dependencies failed" }

    Write-Output "==> pixel: electron"
    # before the TypeScript: the types of the electron API it is written against
    # (electron.d.ts) come with the download
    & node scripts\postinstall.mjs
    if ($LASTEXITCODE -ne 0) { throw "fetching electron failed" }

    Write-Output "==> pixel: TypeScript"
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "building pixel's TypeScript failed" }

    Write-Output "==> pixel: engine (cargo, release)"
    & node scripts\build-native.mjs --release
    if ($LASTEXITCODE -ne 0) { throw "building pixel's engine failed" }
} finally {
    Pop-Location
}

$outputs = @(
    (Join-Path $package "dist\index.js"),
    (Join-Path $native "pixel.node"),
    (Join-Path $package "electron\dist\pixel.exe"),
    (Join-Path $package "electron\dist\.zenbu-electron-sha256")
)
foreach ($path in $outputs) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "pixel's build did not create $path" }
}

$version = (Get-Content -LiteralPath (Join-Path $package "package.json") -Raw | ConvertFrom-Json).version
$hash = (Get-FileHash -LiteralPath (Join-Path $native "pixel.node") -Algorithm SHA256).Hash
Write-Output "built pixel $version"
Write-Output "  pixel.node sha256 $hash"

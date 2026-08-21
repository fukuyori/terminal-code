<#
.SYNOPSIS
    Builds the working tree and installs it the way a Windows release lands.

.DESCRIPTION
    The posix counterpart is scripts/dist.sh. The staged layout is the same
    (dist\, assets\, config\, bin\, VERSION, CHANNEL) and the swap into the
    install root is the same rename dance, so a failure leaves the working
    install exactly as it was.

    terminal-browser is not copied in by default. Its Windows build installs
    itself under %LOCALAPPDATA%\Programs\terminal-browser and updates itself
    there, and tode resolves that install directly — copying a few hundred
    megabytes of Electron on every dev install would buy nothing. Pass
    -VendorBrowser to stage a private copy anyway.

    -Package cuts a release instead of installing: the same stage, zipped as
    out\windows-release\tode-<version>-win32-x64.zip next to the latest.json /
    manifest.json that `tode --upgrade` reads. -Publish uploads those three to
    a GitHub release tagged v<version>, which is where the windows channel
    looks for them.
#>
[CmdletBinding()]
param(
    [string]$Version = "0.1.0-win.2",
    [string]$Channel = "windows",
    [switch]$VendorBrowser,
    [switch]$SkipPath,
    [switch]$Package,
    [switch]$Publish,
    [string]$Repo = "fukuyori/terminal-code"
)

$ErrorActionPreference = "Stop"

if ($Publish) { $Package = $true }
if ($Package -and $VendorBrowser) {
    throw "-VendorBrowser is a dev-install shortcut; a release zip resolves the installed terminal-browser"
}

# A raw registry write is invisible to programs already running, and to anything
# Explorer starts later, until it is told. SetEnvironmentVariable does this part
# by itself; doing the write by hand means doing this by hand too.
function Announce-EnvironmentChange {
    if (-not ("TodeEnv" -as [type])) {
        Add-Type -Namespace "" -Name TodeEnv -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
"@
    }
    $out = [UIntPtr]::Zero
    # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG
    [void][TodeEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, "Environment", 2, 3000, [ref]$out)
}

$root = Split-Path -Parent $PSScriptRoot
$app = if ($env:TODE_INSTALL_ROOT) {
    $env:TODE_INSTALL_ROOT
} else {
    Join-Path $env:LOCALAPPDATA "Programs\tode"
}

Write-Output "==> building"
Push-Location $root
try {
    & npm run -s build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally {
    Pop-Location
}

Write-Output "==> staging $Version"
if ($Package) {
    # the directory name becomes the archive's single top level, which the
    # upgrade extracts with --strip-components 1
    $out = Join-Path $root "out\windows-release"
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
    $stage = Join-Path $out "tode"
} else {
    $stage = "$app.new"
}
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $root "dist") -Destination (Join-Path $stage "dist") -Recurse
Copy-Item -LiteralPath (Join-Path $root "assets") -Destination (Join-Path $stage "assets") -Recurse
if (Test-Path -LiteralPath (Join-Path $root "config")) {
    Copy-Item -LiteralPath (Join-Path $root "config") -Destination (Join-Path $stage "config") -Recurse
}
Set-Content -LiteralPath (Join-Path $stage "VERSION") -Value $Version -Encoding ascii
Set-Content -LiteralPath (Join-Path $stage "CHANNEL") -Value $Channel -Encoding ascii
# dist\ is CommonJS; without a package boundary here node walks up, and a
# parent package.json with "type": "module" turns the install into broken ESM
Set-Content -LiteralPath (Join-Path $stage "package.json") -Value '{"type":"commonjs"}' -Encoding ascii

$browserRoot = Join-Path $env:LOCALAPPDATA "Programs\terminal-browser"
if (-not $Package -and -not (Test-Path -LiteralPath (Join-Path $browserRoot "cli\dist\main.js"))) {
    Write-Warning "terminal-browser is not installed at $browserRoot"
    Write-Warning "  install it from https://github.com/fukuyori/terminal-browser/releases before running tode"
}

if ($VendorBrowser) {
    if (-not (Test-Path -LiteralPath $browserRoot)) { throw "nothing to vendor: $browserRoot is not there" }
    Write-Output "==> vendoring terminal-browser"
    $vendor = Join-Path $stage "vendor"
    New-Item -ItemType Directory -Path $vendor -Force | Out-Null
    Copy-Item -LiteralPath $browserRoot -Destination (Join-Path $vendor "terminal-browser") -Recurse
}

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
New-Item -ItemType Directory -Path (Join-Path $stage "bin") -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stage "bin\tode.cmd") -Value $launcher -Encoding ascii

if ($Package) {
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
    Remove-Item -LiteralPath $stage -Recurse -Force

    Write-Output "packaged $Version"
    Write-Output "  zip       $zip"
    Write-Output "  manifests $(Join-Path $out 'latest.json'), $(Join-Path $out 'manifest.json')"

    if ($Publish) {
        Write-Output "==> publishing v$Version to $Repo"
        & gh release create "v$Version" $zip (Join-Path $out "latest.json") (Join-Path $out "manifest.json") `
            --repo $Repo --title "tode $Version" --notes "Windows x64 build. ``tode --upgrade`` picks this up; a fresh install still builds from the checkout (see README)."
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    } else {
        Write-Output "publish with: gh release create v$Version <zip> <latest.json> <manifest.json> --repo $Repo (or re-run with -Publish)"
    }
    exit 0
}

Write-Output "==> installing to $app"
$previous = "$app.old"
if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination $previous }
New-Item -ItemType Directory -Path (Split-Path -Parent $app) -Force | Out-Null
Move-Item -LiteralPath $stage -Destination $app
if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

$bin = Join-Path $app "bin"
if (-not $SkipPath) {
    # Not [Environment]::SetEnvironmentVariable: it writes the value back as a
    # plain REG_SZ, so a user PATH held as REG_EXPAND_SZ loses its %USERPROFILE%
    # and friends — expanded once, frozen forever. The raw key keeps the kind.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try {
        $kind = try { $key.GetValueKind("Path") } catch { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = $raw.Split(";") | Where-Object { $_ }
        if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $bin.TrimEnd("\") })) {
            $key.SetValue("Path", ((@($entries) + $bin) -join ";"), $kind)
            Announce-EnvironmentChange
            Write-Output "added $bin to the user PATH (open a new terminal to pick it up)"
        }
    } finally {
        $key.Close()
    }
}

Write-Output "installed $Version"
Write-Output "  app  $app"
Write-Output "  bin  $(Join-Path $bin 'tode.cmd')"

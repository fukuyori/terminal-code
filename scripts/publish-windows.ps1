<#
.SYNOPSIS
    Publishes the built Windows release to GitHub.

.DESCRIPTION
    Step 3 of cutting a Windows release: hands the zip, the manifests and the
    installer from out\windows-release to `gh release create v<version>`.
    That tag is where the windows channel looks — releases/latest/download/
    latest.json for `tode --upgrade`, the tag's own manifest.json for a
    pinned --version. The posix counterpart is scripts/publish-r2.sh.

    Before publishing, the artifacts go through the local Windows Defender
    engine — the same one that would flag them on a user's machine — and a
    detection stops the release. With VT_API_KEY set, the installer is also
    uploaded to VirusTotal (which shares samples with AV vendors, so this is
    itself a form of publication — the key being set is the opt-in) and a
    malicious verdict stops the release too. -ScanOnly runs those checks and
    stops; -SkipScan is the emergency hatch past them.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Repo = "fukuyori/terminal-code",
    # gh cuts the tag from the repo's default branch, which is upstream's main
    # here — the windows build lives on this branch, so the tag must too
    [string]$Target = "windows-native",
    [switch]$AllowUnsigned,
    [switch]$ScanOnly,
    [switch]$SkipScan
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "stage-windows.ps1")
if (-not $Version) { $Version = $TodeWindowsVersion }

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "out\windows-release"

$zip = Join-Path $out "tode-$Version-win32-x64.zip"
$latest = Join-Path $out "latest.json"
$pinned = Join-Path $out "manifest.json"
foreach ($file in @($zip, $latest, $pinned)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "missing $file; run scripts\build-windows.ps1 and scripts\package-windows.ps1 first"
    }
}
$built = (Get-Content -LiteralPath $latest -Raw | ConvertFrom-Json).version
if ($built -ne $Version) {
    throw "out\windows-release holds $built, not $Version; rebuild and repackage it"
}

$assets = @($zip, $latest, $pinned)
$installer = Get-ChildItem -LiteralPath $out -Filter "tode-*-windows-x64.exe" -File |
    Select-Object -First 1
if ($installer) {
    $assets += $installer.FullName
} else {
    Write-Warning "no installer in $out; run scripts\package-windows.ps1 first"
}

# The updatable engine under ProgramData is the one actually running; the
# ProgramFiles copy is the version Windows shipped with and can be years stale.
function Resolve-MpCmdRun {
    $platform = Join-Path $env:ProgramData "Microsoft\Windows Defender\Platform"
    if (Test-Path -LiteralPath $platform) {
        $newest = Get-ChildItem -LiteralPath $platform -Directory | Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "MpCmdRun.exe" } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($newest) { return $newest }
    }
    $shim = Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe"
    if (Test-Path -LiteralPath $shim -PathType Leaf) { return $shim }
    return $null
}

if (-not $SkipScan) {
    $mpcmd = Resolve-MpCmdRun
    if ($mpcmd) {
        $scanTargets = @($zip) + $(if ($installer) { @($installer.FullName) } else { @() })
        foreach ($target in $scanTargets) {
            Write-Output "==> defender scan $(Split-Path -Leaf $target)"
            # -DisableRemediation: a detection should stop the release, not
            # quarantine the file we would want to inspect
            & $mpcmd -Scan -ScanType 3 -File $target -DisableRemediation
            if ($LASTEXITCODE -eq 2) {
                throw "Windows Defender flagged $target; do not publish — if it is a false positive, report it at https://www.microsoft.com/en-us/wdsi/filesubmission"
            }
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "MpCmdRun exited $LASTEXITCODE for $target (not a detection, but the scan did not finish)"
            }
        }
    } else {
        Write-Warning "Windows Defender's MpCmdRun.exe was not found; skipping the malware scan"
    }

    if ($env:VT_API_KEY -and $installer) {
        Write-Output "==> virustotal $($installer.Name)"
        # curl.exe rather than Invoke-RestMethod: Windows PowerShell 5.1 has no
        # -Form, and the System32 curl is always there
        $upload = & curl.exe -s -H "x-apikey: $env:VT_API_KEY" -F "file=@$($installer.FullName)" `
            "https://www.virustotal.com/api/v3/files" | ConvertFrom-Json
        if (-not $upload.data.id) { throw "virustotal upload failed" }
        $report = "https://www.virustotal.com/gui/file/$((Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
        $analysis = $null
        foreach ($attempt in 1..40) {
            Start-Sleep -Seconds 15
            $analysis = & curl.exe -s -H "x-apikey: $env:VT_API_KEY" `
                "https://www.virustotal.com/api/v3/analyses/$($upload.data.id)" | ConvertFrom-Json
            if ($analysis.data.attributes.status -eq "completed") { break }
        }
        if ($analysis.data.attributes.status -eq "completed") {
            $stats = $analysis.data.attributes.stats
            if ($stats.malicious -gt 0) {
                throw "virustotal: $($stats.malicious) engine(s) call it malicious; do not publish — $report"
            }
            if ($stats.suspicious -gt 0) {
                Write-Warning "virustotal: $($stats.suspicious) engine(s) call it suspicious — $report"
            }
            Write-Output "virustotal: clean ($report)"
        } else {
            Write-Warning "virustotal did not finish within 10 minutes; check $report before announcing"
        }
    }
}

if ($ScanOnly) {
    Write-Output "scan finished; nothing published"
    return
}

if ($installer -and (Get-AuthenticodeSignature $installer.FullName).Status -ne "Valid" -and -not $AllowUnsigned) {
    throw "$($installer.Name) is unsigned; pass -AllowUnsigned to publish this unsigned build"
}

Write-Output "==> publishing v$Version to $Repo"
$notes = @(
    "Windows x64 build. ``tode --upgrade`` picks this up."
    ""
    if ($installer) { "``$($installer.Name)`` installs per-user; the zip is what the upgrade channel downloads." }
    else { "The zip is what the upgrade channel downloads." }
) -join "`n"
& gh release create "v$Version" @assets --repo $Repo --target $Target --title "tode $Version" --notes $notes
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

Write-Output "published https://github.com/$Repo/releases/tag/v$Version"

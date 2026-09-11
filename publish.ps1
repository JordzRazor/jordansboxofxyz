# Publish this site: rebuild sniper, commit, push, wait for the deploy, prove it landed.
#
#   .\publish.ps1 "tweak the hero copy"     build + commit + push + verify
#   .\publish.ps1 -SkipSniper "css only"    don't touch sniper/
#   .\publish.ps1 -NoWait "wip"             push and return immediately
#
# Deploys run through GitHub Actions (.github/workflows/azure-static-web-apps-
# lemon-plant-0086fdd10.yml). `swa deploy` does NOT work from this machine --
# it fails at the content handshake against a healthy app, so don't reach for it.

[CmdletBinding()]
param(
    [Parameter(Position = 0)] [string]$Message = "update site",
    [switch]$SkipSniper,
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = 'JordzRazor/jordansboxofxyz'
$site = 'https://lemon-plant-0086fdd10.3.azurestaticapps.net'
$sniperSite = 'C:\Users\South\sniper\site'

Push-Location $here
try {
    # --- 1. sniper -------------------------------------------------------
    # Never hand-copy sniper.user.js: the working copy has the relay key inline
    # and build.py is what strips it. Copying by hand publishes the key.
    if (-not $SkipSniper -and (Test-Path (Join-Path $sniperSite 'build.py'))) {
        Write-Host '== rebuilding sniper ==' -ForegroundColor Cyan
        python (Join-Path $sniperSite 'build.py')
        if ($LASTEXITCODE -ne 0) { throw 'build.py failed - nothing published.' }

        Copy-Item (Join-Path $sniperSite 'dist\index.html')     (Join-Path $here 'sniper\index.html')     -Force
        Copy-Item (Join-Path $sniperSite 'dist\sniper.user.js') (Join-Path $here 'sniper\sniper.user.js') -Force

        # Belt and braces: refuse to publish if the live key reached the tree.
        $keyFile = 'C:\Users\South\sniper\.sniper_key'
        if (Test-Path $keyFile) {
            $key = (Get-Content $keyFile -Raw).Trim()
            $hit = Select-String -Path (Join-Path $here 'sniper\*') -Pattern ([regex]::Escape($key)) -SimpleMatch -Quiet
            if ($hit) { throw 'ABORT: the sniper relay key is present in sniper\ - refusing to publish.' }
        }
    }

    # --- 2. commit -------------------------------------------------------
    git add -A
    $staged = git diff --cached --name-only
    if (-not $staged) { Write-Host 'nothing to publish - working tree clean.' -ForegroundColor Yellow; return }

    Write-Host '== publishing ==' -ForegroundColor Cyan
    $staged | ForEach-Object { Write-Host "   $_" }
    git commit --quiet -m $Message
    if ($LASTEXITCODE -ne 0) { throw 'commit failed.' }

    git push --quiet origin main
    if ($LASTEXITCODE -ne 0) { throw 'push failed.' }

    $sha = (git rev-parse HEAD).Trim()
    Write-Host "pushed $($sha.Substring(0,8))" -ForegroundColor Green
    if ($NoWait) { return }

    # --- 3. wait ---------------------------------------------------------
    # Key the wait to THIS commit. Asking for "the latest run" right after a
    # push returns the PREVIOUS run -- GitHub has not registered the new one
    # yet -- so it reports the last deploy's success and you believe a deploy
    # landed that never ran.
    Write-Host '== waiting for the deploy ==' -ForegroundColor Cyan
    $status = $null
    foreach ($i in 1..40) {
        try {
            $runs = Invoke-RestMethod "https://api.github.com/repos/$repo/actions/runs?per_page=10" `
                                      -Headers @{ 'User-Agent' = 'publish.ps1' }
            $run = $runs.workflow_runs | Where-Object { $_.head_sha -eq $sha } | Select-Object -First 1
        } catch { $run = $null }

        if ($null -eq $run)               { Write-Host "   [$i] run not registered yet" }
        elseif ($run.status -ne 'completed') { Write-Host "   [$i] $($run.status)" }
        else {
            $status = $run.conclusion
            $colour = 'Red'; if ($status -eq 'success') { $colour = 'Green' }
            Write-Host "   [$i] completed: $status" -ForegroundColor $colour
            break
        }
        Start-Sleep -Seconds 12
    }
    if ($status -ne 'success') {
        throw "deploy did not succeed (status: $(if($status){$status}else{'timed out'})). See https://github.com/$repo/actions"
    }

    # --- 4. prove it -----------------------------------------------------
    # A green check means the Action ran, not that the bytes changed. Azure's
    # edge can lag a little, so confirm what is actually being served.
    Write-Host '== verifying the live site ==' -ForegroundColor Cyan
    foreach ($path in @('/', '/sniper/', '/sniper/sniper.user.js')) {
        try {
            $r = Invoke-WebRequest "$site$path" -UseBasicParsing -TimeoutSec 20
            "   {0,-26} {1}  {2} B  {3}" -f $path, $r.StatusCode, $r.RawContentLength, $r.Headers['Content-Type']
        } catch {
            Write-Warning "   $path -> $($_.Exception.Message)"
        }
    }
    Write-Host "done: $site" -ForegroundColor Green
}
finally {
    Pop-Location
}

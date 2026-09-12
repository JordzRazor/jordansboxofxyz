# Publish this site: rebuild sniper, commit, push, wait for the deploy, prove it landed.
#
#   .\publish.ps1 "tweak the hero copy"     build + commit + push + verify
#   .\publish.ps1 -SkipBuild "css only"     don't rebuild the generated pages
#   .\publish.ps1 -NoWait "wip"             push and return immediately
#
# Deploys run through GitHub Actions (.github/workflows/azure-static-web-apps-
# lemon-plant-0086fdd10.yml). `swa deploy` does NOT work from this machine --
# it fails at the content handshake against a healthy app, so don't reach for it.

[CmdletBinding()]
param(
    [Parameter(Position = 0)] [string]$Message = "update site",
    [switch]$SkipBuild,
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = 'JordzRazor/jordansboxofxyz'
$site = 'https://lemon-plant-0086fdd10.3.azurestaticapps.net'
# Website building lives in its own folder, deliberately outside the projects it
# publishes. Each page's build.py reads that project's source out of
# C:\Users\South\<project>, but nothing website-shaped is stored in them.
$webbench = 'C:\Users\South\webbench'
$pages = @(
    @{ Name = 'sniper'; Src = "$webbench\sniper-page"; Dest = 'sniper' },
    @{ Name = 'zombie'; Src = "$webbench\zombie-page"; Dest = 'zombie' }
)

Push-Location $here
try {
    # --- 1. build the generated pages ------------------------------------
    # Each page builds into its own dist\ and is copied wholesale. Never
    # hand-copy sniper.user.js: the working copy has the relay key inline and
    # build.py is what strips it. Copying by hand publishes the key.
    if (-not $SkipBuild) {
        foreach ($p in $pages) {
            if (-not (Test-Path (Join-Path $p.Src 'build.py'))) {
                Write-Warning "no build.py for $($p.Name) at $($p.Src) - skipping"
                continue
            }
            Write-Host "== rebuilding $($p.Name) ==" -ForegroundColor Cyan
            python (Join-Path $p.Src 'build.py')
            if ($LASTEXITCODE -ne 0) { throw "$($p.Name): build.py failed - nothing published." }

            $dest = Join-Path $here $p.Dest
            if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
            Copy-Item (Join-Path $p.Src 'dist\*') $dest -Recurse -Force
        }

        # Belt and braces: the relay key must never reach the tree, from any
        # page. Checked across the whole repo, not just sniper\.
        $keyFile = 'C:\Users\South\sniper\.sniper_key'
        if (Test-Path $keyFile) {
            $key = (Get-Content $keyFile -Raw).Trim()
            # NOT -Quiet. Fed from a pipeline it emits $false once PER FILE, so
            # you get an Object[] of 19 falses -- and a non-empty array is
            # truthy, making the guard fire on every run. -List returns the
            # first match per file and emits nothing at all when clean.
            $hit = Get-ChildItem $here -Recurse -File |
                   Where-Object { $_.FullName -notmatch '\\\.git\\' } |
                   Select-String -Pattern ([regex]::Escape($key)) -SimpleMatch -List |
                   Select-Object -First 1
            if ($hit) {
                throw "ABORT: the sniper relay key is present in $($hit.Path) (line $($hit.LineNumber)) - refusing to publish."
            }
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
    # three.module.js is in here on purpose: if /zombie/* ever falls out of
    # navigationFallback.exclude it comes back 200 as text/html instead of
    # 404ing, and the game dies on a content-type error. Watch the type, not
    # just the status.
    foreach ($path in @('/', '/sniper/', '/sniper/sniper.user.js', '/zombie/', '/zombie/three.module.js')) {
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

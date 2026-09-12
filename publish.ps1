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
    @{ Name = 'sniper';    Src = "$webbench\sniper-page";    Dest = 'sniper' },
    @{ Name = 'zombie';    Src = "$webbench\zombie-page";    Dest = 'zombie' },
    @{ Name = 'rougelike'; Src = "$webbench\rougelike-page"; Dest = 'rougelike' },
    @{ Name = 'grip';      Src = "$webbench\grip-page";      Dest = 'grip' }
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

    # --- 2. the canonical host -------------------------------------------
    # Azure gives every app a *.azurestaticapps.net hostname, will not turn it
    # off, and staticwebapp.config.json cannot redirect it: routes match on
    # path, never on host. So the redirect to jordansboxof.xyz is one line of
    # JavaScript in <head>, injected here rather than pasted into eight pages.
    # Here, because four of those pages are generated and would lose it on the
    # next build, and because a page added later would simply forget. It fires
    # only on the Azure hostname, keeps path + query + hash, and uses
    # replace() so the ugly URL leaves no history entry to go back to.
    $canonMark = 'data-canonical-host'
    $canonTag = @'
<script data-canonical-host>(function(){var h=location.hostname;if(h!=="jordansboxof.xyz"&&/\.azurestaticapps\.net$/i.test(h)){location.replace("https://jordansboxof.xyz"+location.pathname+location.search+location.hash);}})();</script>
'@
    Get-ChildItem $here -Recurse -File -Filter *.html |
        Where-Object { -not ($_.FullName -like '*\.git\*' -or $_.FullName -like '*\node_modules\*') } |
        ForEach-Object {
            $html = [System.IO.File]::ReadAllText($_.FullName)
            if ($html.Contains($canonMark)) { return }
            $at = [regex]::Match($html, '<head[^>]*>', 'IgnoreCase')
            if (-not $at.Success) {
                Write-Warning "$($_.Name): no <head> - it will serve without the canonical redirect"
                return
            }
            $html = $html.Insert($at.Index + $at.Length, "`n" + $canonTag.TrimEnd())
            # WriteAllText with a BOM-less UTF8Encoding, NOT Set-Content -Encoding
            # utf8: in PowerShell 5.1 that writes a BOM, and a BOM in front of
            # <!doctype> is the first thing the browser reads.
            [System.IO.File]::WriteAllText($_.FullName, $html, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "   canonical redirect -> $($_.FullName.Substring($here.Length + 1))" -ForegroundColor DarkGray
        }

    # --- 3. commit -------------------------------------------------------
    git add -A
    $staged = git diff --cached --name-only
    if (-not $staged) { Write-Host 'nothing to publish - working tree clean.' -ForegroundColor Yellow; return }

    Write-Host '== publishing ==' -ForegroundColor Cyan
    $staged | ForEach-Object { Write-Host "   $_" }
    # -F, not -m. PowerShell 5.1 re-parses a string on its way to a native
    # command, so a double quote or an apostrophe in the message gets split
    # into extra arguments and git reads the remainder as pathspecs -- it
    # fails with "pathspec 'it' did not match any file(s)", which tells you
    # nothing about quoting. A file has no quoting to get wrong, and it keeps
    # multi-line messages intact as a bonus.
    $msgFile = Join-Path ([System.IO.Path]::GetTempPath()) `
                         ("sniper-commit-" + [guid]::NewGuid().ToString('N') + ".txt")
    # No BOM: git would otherwise carry it into the first line of the message.
    [System.IO.File]::WriteAllText($msgFile, $Message,
                                   (New-Object System.Text.UTF8Encoding($false)))
    try {
        git commit --quiet -F $msgFile
        if ($LASTEXITCODE -ne 0) { throw 'commit failed.' }
    } finally {
        Remove-Item $msgFile -Force -ErrorAction SilentlyContinue
    }

    git push --quiet origin main
    if ($LASTEXITCODE -ne 0) { throw 'push failed.' }

    $sha = (git rev-parse HEAD).Trim()
    Write-Host "pushed $($sha.Substring(0,8))" -ForegroundColor Green
    if ($NoWait) { return }

    # --- 4. wait ---------------------------------------------------------
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

    # --- 5. prove it -----------------------------------------------------
    # A green check means the Action ran, not that the bytes changed. Azure's
    # edge can lag a little, so confirm what is actually being served.
    Write-Host '== verifying the live site ==' -ForegroundColor Cyan
    # three.module.js is in here on purpose: if /zombie/* ever falls out of
    # navigationFallback.exclude it comes back 200 as text/html instead of
    # 404ing, and the game dies on a content-type error. Watch the type, not
    # just the status.
    # Discovered, never hardcoded. A pinned list goes stale the moment a page
    # gains a dependency or a version moves, and the failure it misses is the
    # quiet one: an asset that 200s as text/html because it fell out of
    # navigationFallback.exclude, which breaks only in a browser. So walk what
    # was actually published and check every script and archive it ships.
    $paths = @('/')
    foreach ($p in $pages) {
        $dest = Join-Path $here $p.Dest
        if (-not (Test-Path $dest)) { continue }
        $paths += "/$($p.Dest)/"
        Get-ChildItem $dest -Recurse -File -Include *.js, *.zip |
            ForEach-Object {
                $rel = $_.FullName.Substring($dest.Length).TrimStart('\').Replace('\', '/')
                $paths += "/$($p.Dest)/$rel"
            }
    }
    foreach ($path in $paths) {
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

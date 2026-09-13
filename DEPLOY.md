# Deploying this site

```
.\publish.ps1 "what changed"
```

That rebuilds sniper, commits, pushes, waits for the GitHub Action keyed to
*that commit*, and then checks what the live site actually serves. Roughly 90
seconds end to end.

## The resource

| | |
|---|---|
| Static Web App | `jordansboxofxyz` |
| Address | https://jordansboxof.xyz |
| Azure hostname | https://lemon-plant-0086fdd10.3.azurestaticapps.net |
| Resource group | `jordansboxofxyz_group` |
| Subscription | `boxofkernals` — `ba8f4b2e-48f7-40af-874c-fce350266781` |
| Tenant | `48821fc4-6d8a-4753-9e05-6fecd2628098` |
| Tier | Standard |

**The resource name is not the hostname.** `lemon-plant-0086fdd10` is the
generated host; the resource is `jordansboxofxyz`. A second app once existed
(`boxofxyz` → `witty-forest-060e07f10`) that never deployed and was deleted.
When in doubt run `az staticwebapp list -o table` — never identify the app by
its URL.

## Two hostnames, one address

`jordansboxof.xyz` is the address. The `*.azurestaticapps.net` host still
answers on everything -- Azure will not turn it off, and
`staticwebapp.config.json` cannot redirect it, because routes match on path and
never on host. So step 3 of `publish.ps1` injects a one-line redirect into the
`<head>` of every `.html` in the tree on its way out, marked with
`data-canonical-host` so it is written once and never twice. Anyone landing on
the Azure host is moved to the custom domain, path and query intact.

It is deliberately invisible to `curl`: the verification step in step 6 still
fetches the Azure host and still gets 200s, because the redirect is JavaScript
and only a browser runs it.

## How the deploy actually works

GitHub Actions, `.github/workflows/azure-static-web-apps-lemon-plant-0086fdd10.yml`,
triggered by a push to `main`. It authenticates with the repo secret
`AZURE_STATIC_WEB_APPS_API_TOKEN_LEMON_PLANT_0086FDD10`.

Deleting that workflow file is how the site silently lost its only deploy path
once before. The secret survives the file being deleted, so restoring the file
from git history is enough to fix it.

**`swa deploy` does not work from this machine.** It fails at the content
handshake against a healthy app, so it is not the app's fault and not worth
debugging again. Use the Action.

## Two traps

**Don't trust the green check.** Asking the API for "the latest run" straight
after a push returns the *previous* run, because GitHub hasn't registered the
new one yet — so it reports the last deploy's success and you believe something
landed that never ran. `publish.ps1` matches on the commit SHA, then confirms
the served bytes.

**`navigationFallback` will not 404 a missing file.** Both a glob (`/*.user.js`)
and a literal path (`/sniper.user.js`) were tried, deployed and verified; each
still returned `200 text/html` with `index.html`. So a wrong URL silently serves
a web page instead of failing. Fix bad links at the href — don't retry this.

Related: Azure serves `/sniper` without redirecting to `/sniper/`, so a
*relative* href on that page resolves one level too high. The install link is
absolute for that reason.

## The deployment token

Stored at `C:\Users\South\.azure-keys\jordansboxofxyz.swa_token`, readable only
by the owning user. It is **not** needed for normal deploys — the Action has its
own copy as a repo secret. Keep it for re-creating that secret, or deploying
from another machine.

Fetch a fresh one any time:

```powershell
az staticwebapp secrets list --name jordansboxofxyz `
   --resource-group jordansboxofxyz_group --query "properties.apiKey" -o tsv
```

A deployment token only authorises uploading content to this one app. It grants
nothing else, and it cannot be used to recover access to a subscription.

## sniper/

Generated — never edit `sniper/` by hand. The source lives in
`C:\Users\South\sniper\site`, and `build.py` strips the relay key out of
`sniper.user.js` on the way in. The working copy of that script has the key
inline; publishing it verbatim would put the relay's only credential on a public
URL. `publish.ps1` re-checks for the key and aborts if it finds it.

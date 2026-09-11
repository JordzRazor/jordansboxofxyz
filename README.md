# jordansboxofxyz

A small, self-contained website: a landing page plus two interactive pieces
(`Kessho`, a three.js/WebGL crystal scene, and `Ember`, a raw WebGPU shader
with an automatic WebGL2 fallback). Blackslate + wood palette, quiet Japanese
styling, built to run fine on an old laptop.

No build step. No framework. No dependencies beyond one CDN-hosted copy of
three.js (used only by the hub page and Kessho — Ember uses the browser's
native WebGPU/WebGL APIs directly). You can put this straight on a static
host as-is.

```
jordansboxofxyz/
├── index.html                 the hub / landing page
├── css/style.css               the whole shared theme
├── js/main.js                  hero background animation
├── demos/kessho.html + .js     three.js crystal demo
├── demos/ember.html + .js      WebGPU/WebGL ember demo
├── assets/favicon.svg
├── assets/manifest.webmanifest
└── staticwebapp.config.json    Azure Static Web Apps routing/config
```

## 1. Look at it locally first

From inside this folder:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html`. Ember needs a browser with
WebGPU (recent Chrome or Edge) to show the "real" version — anything else
will show you the WebGL fallback automatically, which looks basically the
same.

## 2. Put it on Azure Static Web Apps (free tier)

This is the easiest path and the one the setup wizard is built around. It
deploys straight from a GitHub repo, so do that part first.

**a. Get the files into a GitHub repo**

- Create a new repository on GitHub (public or private, either works) —
  e.g. `jordansboxofxyz`.
- Push everything in this folder to it, unchanged, at the repo root.

**b. Create the Static Web App**

1. In the Azure Portal, search for **Static Web Apps** and click **Create**.
2. **Subscription / Resource group** — pick your subscription; create a new
   resource group (e.g. `jordansboxofxyz-rg`) if you don't have one you want
   to reuse.
3. **Name** — `jordansboxofxyz`. Static Web App names can only contain
   letters, numbers and hyphens, so that name is valid as-is. If Azure says
   it's taken (unlikely, but names are unique per region), try
   `jordans-box-of-xyz` or add a short suffix.
4. **Plan type** — **Free**. It's genuinely free and enough for this: it
   includes generous bandwidth, custom domains, and free HTTPS certs — you'd
   only outgrow it if this became a large commercial app with API routes.
5. **Region** — pick whichever is closest to you; for the Free plan this
   only affects where the (unused, in this case) API/Functions layer would
   run, not where your static content is served from — Static Web Apps
   serves your files from a global CDN regardless.
6. **Deployment details** — source: **GitHub**. Sign in and authorize Azure
   if prompted, then pick your organization, the repo you just pushed, and
   the branch (usually `main`).
7. **Build Details** — Build presets: **Custom**. App location: `/`. Api
   location: leave blank. Output location: leave blank. (There's no build
   step — these files are served as-is.)
8. **Review + create**, then **Create**.

Azure will commit a GitHub Actions workflow file into your repo and kick off
the first deployment automatically. Give it a minute or two, then check the
**Actions** tab on the repo — once the workflow run is green, go back to the
Static Web App's **Overview** page in the Azure Portal and open the URL
listed there. It'll look like:

```
https://jordansboxofxyz-<random>.azurestaticapps.net
```

The random suffix is Azure's doing (it guarantees global uniqueness) — you
can't remove it on the Free plan, but you can point a custom domain at it
later (Static Web App → **Custom domains**) if you ever buy one, e.g.
`jordansboxofxyz.com`.

**Updating the site later:** just push new commits to that branch — the
GitHub Actions workflow redeploys automatically every time.

### If you'd rather not use GitHub

You can deploy from the CLI instead with the [SWA
CLI](https://azure.github.io/static-web-apps-cli/) (`npm install -g
@azure/static-web-apps-cli`), create the Static Web App resource with
deployment source "Other", grab its deployment token from the portal
(**Overview → Manage deployment token**), and run:

```bash
swa deploy ./jordansboxofxyz --deployment-token <token> --env production
```

This skips GitHub entirely but means you redeploy manually each time.

## 3. Wiring up ads

The site has one ad slot, styled as a small wooden noticeboard, on the hub
page under "Keeping the lights on" (`id="ad-slot"` in `index.html`). It's
deliberately placed away from the interactive canvases — ad networks
generally penalize or reject placements too close to things people click on
by accident, and it fits the vibe better as its own quiet spot anyway.

To wire it up (using Google AdSense as the example — you'll need to sign up
for an account yourself at [adsense.google.com](https://adsense.google.com),
which requires your own site to already be live and reviewed):

1. Once approved, AdSense gives you a snippet like this to put in `<head>`
   (in `index.html`):
   ```html
   <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXXX"
     crossorigin="anonymous"></script>
   ```
2. Replace the contents of the `.frame` div (`id="ad-slot"`) with the ad
   unit AdSense gives you, something like:
   ```html
   <ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"
     data-ad-slot="XXXXXXXXXX"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
   <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
   ```
3. Redeploy (push to GitHub, or `swa deploy` again).

Any other ad network will work the same way — drop their script in
`<head>` and their ad unit markup into that same `.frame` div.

## 4. Notes on the WebGPU piece

`demos/ember.js` tries `navigator.gpu` first. If it's missing, or the
adapter/device/shader validation fails for any reason, it falls back to a
hand-written WebGL2 version of the same shader and shows a small note in
the corner saying so — nothing ever just breaks or shows a blank screen.
WebGPU support as of now is Chrome/Edge 113+ by default, Safari 18+, and
Firefox behind a flag — plenty of visitors, especially on older or
lower-end laptops, will see the WebGL version, which is intentional and
looks the same.

## 5. Adding more pieces to the shelf

Each piece is just a folder-free pair of files in `demos/` (`name.html` +
`name.js`) plus one card added to the `.gallery` grid in `index.html`. Copy
the structure of `kessho.html`/`kessho.js` as a starting point — it has the
HUD, back link, and hint-text pattern the others use. Keep new pieces
gentle on performance the same way these are: cap your particle/geometry
counts, cap `devicePixelRatio` around 1.5–1.75, and pause your render loop
on `visibilitychange` when the tab is hidden.

All the colors, fonts, and textures live as CSS custom properties at the
top of `css/style.css` if you want to adjust the palette.

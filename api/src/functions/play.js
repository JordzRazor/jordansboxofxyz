// GET /api/play?game=<name>
//
// The members-only browser games. Signed in and on record as having agreed to
// the current terms: the game's compiled code (<name>.wasm, from the private
// "play" container) streamed straight to the page -- no link that outlives
// the request, no file a guessed URL can reach. Anything else: JSON and a
// status code, and the page shows the way to /terms/.
//
// Same identity, same acceptance check, same terms version as /api/download
// (shared.js); every play is written to the "plays" table next to the
// acceptance record.

"use strict";

const { app } = require("@azure/functions");
const S = require("../shared");

const GAME_OK = /^[a-z0-9-]{1,40}$/;
const PLAY_CONTAINER = "play";

app.http("play", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "play",
  handler: async (req, ctx) => {
    const game = req.query.get("game") || "";
    if (!GAME_OK.test(game)) return S.json(400, { error: "bad game name" });

    const terms = "/terms/?next=" + encodeURIComponent("/" + game + "/");
    const p = S.principal(req);
    if (!p) return S.json(401, { error: "sign in first", terms });
    const acc = await S.acceptance(p);
    if (!acc) return S.json(403, { error: "agree to the terms first", terms, version: S.TERMS_VERSION });

    const blob = S.blobService().getContainerClient(PLAY_CONTAINER).getBlockBlobClient(game + ".wasm");
    let size;
    try { size = (await blob.getProperties()).contentLength; } catch { return S.json(404, { error: "no such game: " + game }); }

    // The play log: who played what, when. Part of the same record.
    try {
      const t = await S.table("plays");
      await t.createEntity({
        partitionKey: S.who(p),
        rowKey: new Date().toISOString() + "-" + game,
        game,
        provider: p.provider,
        ip: S.ipOf(req),
        userAgent: req.headers.get("user-agent") || "",
        termsVersion: S.TERMS_VERSION,
      });
    } catch (e) {
      ctx.warn("play log failed: " + e.message);
    }

    // The game carries the Free Rider library (~31 MB raw): send the gzipped copy (<name>.wasm.gz, ~7 MB, uploaded beside it) to any
    // browser that takes gzip -- it unpacks it itself, the page sees the same bytes. The plain .wasm stays as the fallback.
    const headers = { "Content-Type": "application/wasm", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Vary": "Accept-Encoding",
                      "X-Game-Bytes": String(size) };   // the unpacked size: what the page's progress bar fills against
    let src = blob;
    if (/\bgzip\b/.test(req.headers.get("accept-encoding") || "")) {
      const gz = S.blobService().getContainerClient(PLAY_CONTAINER).getBlockBlobClient(game + ".wasm.gz");
      if (await gz.exists()) { src = gz; headers["Content-Encoding"] = "gzip"; }
    }
    const body = await src.downloadToBuffer();
    return { status: 200, body, headers };
  },
});

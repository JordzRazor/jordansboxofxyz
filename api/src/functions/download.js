// GET /api/download?file=<name>
//
// Signed in and on record as having agreed to the current terms: a 302 to a
// link that works for ten minutes. Anything else: a browser is sent to the
// terms page with the way back; a script gets JSON and a status code.

"use strict";

const { app } = require("@azure/functions");
const S = require("../shared");

app.http("download", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "download",
  handler: async (req, ctx) => {
    const name = req.query.get("file") || "";
    if (!S.NAME_OK.test(name) || name.includes("..")) return S.json(400, { error: "bad file name" });

    const back = "/terms/?next=" + encodeURIComponent("/api/download?file=" + name);
    const p = S.principal(req);
    if (!p) {
      return S.wantsHtml(req)
        ? { status: 302, headers: { Location: back, "Cache-Control": "no-store" } }
        : S.json(401, { error: "sign in first", terms: "/terms/" });
    }
    const acc = await S.acceptance(p);
    if (!acc) {
      return S.wantsHtml(req)
        ? { status: 302, headers: { Location: back, "Cache-Control": "no-store" } }
        : S.json(403, { error: "agree to the terms first", terms: "/terms/", version: S.TERMS_VERSION });
    }

    const blob = S.blobService().getContainerClient(S.CONTAINER).getBlockBlobClient(name);
    if (!(await blob.exists())) return S.json(404, { error: "no such file: " + name });

    // The download log: who took what, when. Part of the same record.
    try {
      const t = await S.table("downloads");
      await t.createEntity({
        partitionKey: S.who(p),
        rowKey: new Date().toISOString() + "-" + name,
        file: name,
        provider: p.provider,
        name: p.name,
        ip: S.ipOf(req),
        userAgent: req.headers.get("user-agent") || "",
        termsVersion: S.TERMS_VERSION,
      });
    } catch (e) {
      ctx.warn("download log failed: " + e.message);
    }

    return { status: 302, headers: { Location: S.downloadLink(name, 10), "Cache-Control": "no-store" } };
  },
});

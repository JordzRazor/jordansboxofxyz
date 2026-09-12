// POST /api/accept   {"agree": true, "version": "<terms version shown>"}
//
// Writes the acceptance record: which identity, from which provider, what
// they were shown (version), when, from where. One row per identity per
// terms version; accepting again overwrites with the newer time.

"use strict";

const { app } = require("@azure/functions");
const S = require("../shared");

app.http("accept", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "accept",
  handler: async (req) => {
    const p = S.principal(req);
    if (!p) return S.json(401, { error: "sign in first" });

    let body;
    try { body = await req.json(); } catch { return S.json(400, { error: "bad json" }); }
    if (body?.agree !== true) return S.json(400, { error: "the box was not ticked" });
    if (String(body?.version || "") !== S.TERMS_VERSION)
      return S.json(409, { error: "those are not the current terms", version: S.TERMS_VERSION });

    const t = await S.table("acceptances");
    const when = new Date().toISOString();
    await t.upsertEntity({
      partitionKey: S.who(p),
      rowKey: S.TERMS_VERSION,
      provider: p.provider,
      userId: p.id,
      name: p.name,
      acceptedUtc: when,
      ip: S.ipOf(req),
      userAgent: req.headers.get("user-agent") || "",
      termsVersion: S.TERMS_VERSION,
    }, "Replace");

    return S.json(200, { ok: true, version: S.TERMS_VERSION, acceptedUtc: when, name: p.name, provider: p.provider });
  },
});

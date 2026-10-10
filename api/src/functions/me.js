// GET /api/me - who the page is talking to, and whether they have agreed.

"use strict";

const { app } = require("@azure/functions");
const S = require("../shared");

app.http("me", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "me",
  handler: async (req) => {
    const p = S.principal(req);
    if (!p) return S.json(200, { signedIn: false, terms: S.TERMS_VERSION });
    const acc = await S.acceptance(p);
    return S.json(200, {
      signedIn: true,
      provider: p.provider,
      name: p.name,                                 // (shown to them, never stored)
      record: S.who(p),                             // the anonymous id their records are kept under: what they quote to see or delete them
      accepted: Boolean(acc),
      acceptedUtc: acc ? acc.acceptedUtc : null,
      terms: S.TERMS_VERSION,
    });
  },
});

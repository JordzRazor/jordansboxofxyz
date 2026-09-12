// shared.js - what the three functions have in common.
//
// Identity comes from Static Web Apps: after /.auth/login/<provider> every
// request to /api carries an x-ms-client-principal header, base64 JSON, set by
// the platform and not forgeable from a page. Storage is one account: a
// private blob container for the downloads and two tables, one for the
// acceptance ledger and one for the download log.
//
// Nothing here trusts the page. The file name is validated, the terms
// version is compared against the one the server knows, and the only thing a
// signed-in user can obtain is a link to a blob that expires in minutes.

"use strict";

const { TableClient } = require("@azure/data-tables");
const {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");

const CONN = process.env.STORAGE_CONNECTION || "";
const CONTAINER = "downloads";
const TERMS_VERSION = process.env.TERMS_VERSION || "2026-09-12";
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function principal(req) {
  const h = req.headers.get("x-ms-client-principal");
  if (!h) return null;
  try {
    const p = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    if (!p || !p.userId || !p.identityProvider) return null;
    return {
      provider: String(p.identityProvider),
      id: String(p.userId),
      name: String(p.userDetails || ""),
      roles: Array.isArray(p.userRoles) ? p.userRoles : [],
    };
  } catch {
    return null;
  }
}

function who(p) {
  return `${p.provider}:${p.id}`;
}

function ipOf(req) {
  return (req.headers.get("x-forwarded-for") || req.headers.get("x-client-ip") || "").split(",")[0].trim();
}

async function table(name) {
  const t = TableClient.fromConnectionString(CONN, name);
  try { await t.createTable(); } catch { /* exists */ }
  return t;
}

async function acceptance(p) {
  const t = await table("acceptances");
  try {
    return await t.getEntity(who(p), TERMS_VERSION);
  } catch {
    return null;
  }
}

function blobService() {
  return BlobServiceClient.fromConnectionString(CONN);
}

/** A read-only link to one blob that dies in `minutes`. */
function downloadLink(name, minutes) {
  const svc = blobService();
  const now = Date.now();
  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: name,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: new Date(now - 60 * 1000),
      expiresOn: new Date(now + minutes * 60 * 1000),
      contentDisposition: `attachment; filename="${name}"`,
    },
    svc.credential
  ).toString();
  return `${svc.url}${CONTAINER}/${encodeURIComponent(name)}?${sas}`;
}

function json(status, body, extra) {
  return { status, jsonBody: body, headers: Object.assign({ "Cache-Control": "no-store" }, extra || {}) };
}

function wantsHtml(req) {
  return /text\/html/.test(req.headers.get("accept") || "");
}

module.exports = { principal, who, ipOf, table, acceptance, blobService, downloadLink, json, wantsHtml,
                   CONTAINER, TERMS_VERSION, NAME_OK };

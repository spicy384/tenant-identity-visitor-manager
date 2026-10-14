/**
 * Entra sign-in against a fake Microsoft: a locally generated RSA key signs the ID
 * tokens, and a fake fetch answers the token and key endpoints.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChecker } = require("./helpers/assert");
const { createEntra, roleFromClaims } = require("../entra");

const { check, report } = createChecker("Entra ID: OpenID Connect flow and token checks");

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const AUTHORITY = "https://login.microsoftonline.com";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig" };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function makeToken(claims, { kid = "key-1", key = privateKey, alg = "RS256" } = {}) {
  const head = b64({ alg, kid, typ: "JWT" });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
let nextToken = null; // what the fake token endpoint returns
let keyFetches = 0;
let lastTokenRequest = null;

async function fakeFetch(url, init = {}) {
  const u = String(url);
  if (u.endsWith("/discovery/v2.0/keys")) {
    keyFetches += 1;
    return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
  }
  if (u.endsWith("/oauth2/v2.0/token")) {
    lastTokenRequest = new URLSearchParams(init.body);
    if (nextToken === "refuse") return { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "AADSTS70008: The code has expired.\r\nTrace ID: x" }) };
    return { ok: true, status: 200, json: async () => ({ id_token: nextToken }) };
  }
  throw new Error(`unexpected fetch ${u}`);
}

// The documents store as the database provides it, in memory here.
const docs = new Map();
const store = { read: (name, fallback) => (docs.has(name) ? JSON.parse(docs.get(name)) : fallback), write: (name, value) => docs.set(name, JSON.stringify(value)) };
const ROLES = [{ id: "admin", name: "Administrator" }, { id: "manager", name: "Manager" }, { id: "frontdesk", name: "Front desk" }, { id: "viewer", name: "Viewer" }, { id: "security-team", name: "Security team" }];
const entra = createEntra({ store, roles: () => ROLES, env: {}, fetchImpl: fakeFetch });

async function expectFail(promise, pattern) {
  try {
    await promise;
    return false;
  } catch (error) {
    return pattern.test(error.message);
  }
}

(async () => {
  check("roles: highest wins", roleFromClaims(["Viewer", "Admin"], ROLES) === "admin" && roleFromClaims(["Viewer", "Manager"], ROLES) === "manager");
  check("roles: matched by id or name, ignoring case and spacing", roleFromClaims(["FrontDesk"], ROLES) === "frontdesk" && roleFromClaims(["front-desk"], ROLES) === "frontdesk" && roleFromClaims(["Security Team"], ROLES) === "security-team");
  check("roles: none matching", roleFromClaims(["Other"], ROLES) === null && roleFromClaims(undefined, ROLES) === null && roleFromClaims(["Staff"], ROLES) === null);

  check("not ready until configured", !entra.isReady() && entra.publicConfig().enabled === false);
  check("save: domain instead of tenant GUID refused", await expectFail(Promise.resolve().then(() => entra.save({ tenantId: "contoso.onmicrosoft.com" })), /GUID/));
  check("save: cannot enable without a secret", await expectFail(Promise.resolve().then(() => entra.save({ enabled: true, tenantId: TENANT, clientId: CLIENT })), /client secret/));
  check("save: Administrator can't be the default role", await expectFail(Promise.resolve().then(() => entra.save({ defaultRole: "admin" })), /Default role/));
  const pub = entra.save({ enabled: true, tenantId: TENANT, clientId: CLIENT, clientSecret: "s3cret", defaultRole: "frontdesk" });
  check("save: ready, secret never returned", pub.ready && pub.hasSecret && !("clientSecret" in pub));
  check("save: kept in the database's documents", JSON.parse(docs.get("entra")).clientSecret === "s3cret" && entra.config().defaultRole === "frontdesk");
  entra.save({ buttonLabel: "Staff sign-in" });
  check("save: empty secret keeps the stored one", entra.config().clientSecret === "s3cret" && entra.config().buttonLabel === "Staff sign-in");

  // --- begin ---------------------------------------------------------------------
  const redirectUri = "https://directory.example.com/api/auth/entra/callback";
  const start = entra.begin({ redirectUri });
  const url = new URL(start.url);
  check("begin: tenant authorize endpoint", url.origin + url.pathname === `${AUTHORITY}/${TENANT}/oauth2/v2.0/authorize`);
  check("begin: code flow with PKCE S256, state and nonce", url.searchParams.get("response_type") === "code" && url.searchParams.get("code_challenge_method") === "S256" && url.searchParams.get("code_challenge").length >= 43 && url.searchParams.get("state") === start.state && url.searchParams.get("nonce"));
  check("begin: redirect URI and scopes", url.searchParams.get("redirect_uri") === redirectUri && url.searchParams.get("scope") === "openid profile email");

  const claimsFor = (state, extra = {}) => ({
    iss: `${AUTHORITY}/${TENANT}/v2.0`, tid: TENANT, aud: CLIENT, oid: "oid-123", nonce: new URL(state.url).searchParams.get("nonce"),
    exp: nowS() + 3600, nbf: nowS() - 10, iat: nowS() - 10, preferred_username: "Jane@Contoso.com", name: "Jane Doe", roles: ["Manager"], ...extra
  });

  // --- complete ----------------------------------------------------------------------
  nextToken = makeToken(claimsFor(start));
  const id = await entra.complete({ state: start.state, code: "the-code", cookieState: start.state });
  check("complete: identity from a valid token", id.oid === "oid-123" && id.username === "jane@contoso.com" && id.name === "Jane Doe" && id.role === "manager");
  check("complete: code exchanged with the PKCE verifier and secret", lastTokenRequest.get("code") === "the-code" && lastTokenRequest.get("code_verifier").length >= 43 && lastTokenRequest.get("client_secret") === "s3cret" && lastTokenRequest.get("redirect_uri") === redirectUri);
  check("complete: state is single use", await expectFail(entra.complete({ state: start.state, code: "x", cookieState: start.state }), /expired or was started in another browser/));

  async function attempt(extra, opts = {}) {
    const s = entra.begin({ redirectUri });
    nextToken = typeof extra === "function" ? extra(s) : makeToken(claimsFor(s, extra), opts);
    return entra.complete({ state: s.state, code: "c", cookieState: opts.cookieState === undefined ? s.state : opts.cookieState });
  }

  check("refused: state cookie from another browser", await expectFail(attempt({}, { cookieState: "other" }), /another browser/));
  check("refused: wrong audience", await expectFail(attempt({ aud: "someone-else" }), /different application/));
  check("refused: wrong issuer", await expectFail(attempt({ iss: `${AUTHORITY}/99999999-2222-3333-4444-555555555555/v2.0` }), /different tenant/));
  check("refused: wrong tid", await expectFail(attempt({ tid: "99999999-2222-3333-4444-555555555555" }), /different tenant/));
  check("refused: expired", await expectFail(attempt({ exp: nowS() - 3600 }), /expired/));
  check("refused: not yet valid", await expectFail(attempt({ nbf: nowS() + 3600 }), /not valid yet/));
  check("refused: nonce mismatch", await expectFail(attempt({ nonce: "replayed" }), /does not match/));
  check("refused: no object ID", await expectFail(attempt({ oid: undefined }), /object ID/));
  check("refused: signed by another key", await expectFail(attempt({}, { key: otherKey }), /signature/));
  check("refused: alg none", await expectFail(attempt((s) => `${b64({ alg: "none", kid: "key-1" })}.${b64(claimsFor(s))}.`), /algorithm/));
  check("refused: tampered claims", await expectFail(attempt((s) => {
    const [h, , sig] = makeToken(claimsFor(s)).split(".");
    return `${h}.${b64(claimsFor(s, { oid: "attacker" }))}.${sig}`;
  }), /signature/));
  const before = keyFetches;
  check("refused: unknown key id", await expectFail(attempt({}, { kid: "rotated-away" }), /does not publish/));
  check("keys: cached, refetch throttled", keyFetches === before);
  nextToken = "refuse";
  const s2 = entra.begin({ redirectUri });
  check("refused: Microsoft's own error, first line only", await expectFail(entra.complete({ state: s2.state, code: "c", cookieState: s2.state }), /AADSTS70008: The code has expired\.$/));

  // --- environment configuration ---------------------------------------------------------
  const envEntra = createEntra({ store, roles: () => ROLES, env: { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: "x", ENTRA_DEFAULT_ROLE: "viewer" }, fetchImpl: fakeFetch });
  check("env: wins and is read-only", envEntra.publicConfig().readOnly && envEntra.config().defaultRole === "viewer" && await expectFail(Promise.resolve().then(() => envEntra.save({ enabled: false })), /environment variables/));

  process.exit(report() ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

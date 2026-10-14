/**
 * Sign-in with Microsoft Entra ID: the OpenID Connect authorization-code flow with
 * PKCE, using only node's crypto and fetch.
 *
 * The app is a confidential client (it holds a client secret). The browser is sent to
 * Microsoft with a random state, nonce and PKCE challenge; Microsoft sends it back
 * with a code; the code is exchanged server-side for an ID token, whose signature is
 * checked against the tenant's published keys before any claim in it is believed.
 *
 * Configuration comes from the environment (ENTRA_*), which wins and is shown as
 * read-only, or from the "entra" document in the encrypted database, set under Settings.
 */
const crypto = require("crypto");

const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 300;
const HTTP_TIMEOUT_MS = 15 * 1000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Maps app-role claim values to one of `appRoles` (this app's account roles, highest
 * first): a claim matches a role by its id or its name, ignoring case, spaces and
 * punctuation, so "Admin", "FrontDesk" and "front-desk" all work. The highest wins;
 * null when none match.
 */
function roleFromClaims(claims, appRoles = [{ id: "admin", name: "Administrator" }]) {
  if (!Array.isArray(claims)) return null;
  const wanted = new Set(claims.map(squash));
  for (const role of appRoles) {
    if (wanted.has(squash(role.id)) || wanted.has(squash(role.name))) return role.id;
  }
  return null;
}

/**
 * store: { read(name, fallback), write(name, value) } over the database's documents.
 * roles(): the account roles, highest first ({ id, name }), for app-role claims and the
 * default role of a first sign-in.
 */
function createEntra({ store, roles = () => [{ id: "admin", name: "Administrator" }], env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const DOC = "entra";
  // "none", or any account role but Administrator: nobody becomes an administrator by default.
  const defaultRoles = () => ["none", ...roles().map((r) => r.id).filter((id) => id !== "admin")];
  const authorityHost = String(env.ENTRA_AUTHORITY || DEFAULT_AUTHORITY).replace(/\/+$/, "");
  const flows = new Map(); // state -> { verifier, nonce, expiresAt, returnTo }
  let jwks = { keys: [], fetchedAt: 0, tenantId: null };

  function fromEnv() {
    if (!env.ENTRA_TENANT_ID && !env.ENTRA_CLIENT_ID) return null;
    return {
      enabled: String(env.ENTRA_ENABLED || "true").toLowerCase() !== "false",
      tenantId: String(env.ENTRA_TENANT_ID || "").trim(),
      clientId: String(env.ENTRA_CLIENT_ID || "").trim(),
      clientSecret: String(env.ENTRA_CLIENT_SECRET || ""),
      defaultRole: defaultRoles().includes(env.ENTRA_DEFAULT_ROLE) ? env.ENTRA_DEFAULT_ROLE : "none",
      buttonLabel: String(env.ENTRA_BUTTON_LABEL || "").trim() || "Sign in with Microsoft",
      source: "env"
    };
  }

  /** The effective configuration, secret included (server-side use only). */
  function config() {
    const envConfig = fromEnv();
    if (envConfig) return envConfig;
    const stored = store.read(DOC, {}) || {};
    return {
      enabled: Boolean(stored.enabled),
      tenantId: stored.tenantId || "",
      clientId: stored.clientId || "",
      clientSecret: stored.clientSecret || "",
      defaultRole: defaultRoles().includes(stored.defaultRole) ? stored.defaultRole : "none",
      buttonLabel: stored.buttonLabel || "Sign in with Microsoft",
      source: "settings"
    };
  }

  function isReady(c = config()) {
    return Boolean(c.enabled && GUID_RE.test(c.tenantId) && GUID_RE.test(c.clientId) && c.clientSecret);
  }

  /** What the Settings page shows: everything but the secret. */
  function publicConfig() {
    const c = config();
    return {
      enabled: c.enabled,
      ready: isReady(c),
      tenantId: c.tenantId,
      clientId: c.clientId,
      hasSecret: Boolean(c.clientSecret),
      defaultRole: c.defaultRole,
      buttonLabel: c.buttonLabel,
      readOnly: c.source === "env",
      authority: authorityHost
    };
  }

  function save(patch = {}) {
    if (fromEnv()) throw fail(409, "Entra ID is configured by environment variables (ENTRA_*); change it there.");
    const current = store.read(DOC, {}) || {};
    const next = { ...current };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.tenantId !== undefined) {
      const v = String(patch.tenantId || "").trim();
      if (v && !GUID_RE.test(v)) throw fail(400, "The tenant ID must be the directory (tenant) ID, a GUID, not a domain name.");
      next.tenantId = v;
    }
    if (patch.clientId !== undefined) {
      const v = String(patch.clientId || "").trim();
      if (v && !GUID_RE.test(v)) throw fail(400, "The client ID must be the application (client) ID, a GUID.");
      next.clientId = v;
    }
    // An empty secret in the form means "keep the one stored".
    if (patch.clientSecret) next.clientSecret = String(patch.clientSecret);
    if (patch.clearSecret) next.clientSecret = "";
    if (patch.defaultRole !== undefined) {
      if (!defaultRoles().includes(patch.defaultRole)) throw fail(400, `Default role must be one of: ${defaultRoles().join(", ")}.`);
      next.defaultRole = patch.defaultRole;
    }
    if (patch.buttonLabel !== undefined) next.buttonLabel = String(patch.buttonLabel || "").trim().slice(0, 60);
    if (next.enabled && !isReady({ ...next, enabled: true })) {
      throw fail(400, "To turn on Entra sign-in, enter the tenant ID, client ID and client secret.");
    }
    store.write(DOC, next);
    jwks = { keys: [], fetchedAt: 0, tenantId: null };
    return publicConfig();
  }

  // --- the flow --------------------------------------------------------------

  function pruneFlows() {
    for (const [k, v] of flows) if (now() > v.expiresAt) flows.delete(k);
  }

  /** Step 1: where to send the browser, and the state to bind to it with a cookie. */
  function begin({ redirectUri }) {
    const c = config();
    if (!isReady(c)) throw fail(409, "Entra sign-in is not configured.");
    pruneFlows();
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    flows.set(state, { verifier, nonce, redirectUri, expiresAt: now() + FLOW_TTL_MS });
    const params = new URLSearchParams({
      client_id: c.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account"
    });
    return { state, url: `${authorityHost}/${c.tenantId}/oauth2/v2.0/authorize?${params}` };
  }

  async function fetchJson(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async function signingKey(kid, tenantId) {
    const fresh = jwks.tenantId === tenantId && now() - jwks.fetchedAt < JWKS_TTL_MS;
    let key = fresh ? jwks.keys.find((k) => k.kid === kid) : null;
    // Keys rotate: an unknown kid triggers one refetch, but not more than every few minutes.
    if (!key && (!fresh || now() - jwks.fetchedAt > JWKS_REFRESH_MIN_MS)) {
      const { ok, status, body } = await fetchJson(`${authorityHost}/${tenantId}/discovery/v2.0/keys`);
      if (!ok || !Array.isArray(body.keys)) throw fail(502, `Could not fetch Microsoft's signing keys (HTTP ${status}).`);
      jwks = { keys: body.keys, fetchedAt: now(), tenantId };
      key = jwks.keys.find((k) => k.kid === kid);
    }
    if (!key) throw fail(401, "The sign-in token was signed with a key Microsoft does not publish.");
    return crypto.createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" });
  }

  /** Checks an ID token's signature and claims; returns the claims. */
  async function verifyIdToken(idToken, { nonce }) {
    const c = config();
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) throw fail(401, "Microsoft did not return a valid ID token.");
    let header;
    let claims;
    try {
      header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
      claims = JSON.parse(fromB64url(parts[1]).toString("utf8"));
    } catch {
      throw fail(401, "Microsoft did not return a valid ID token.");
    }
    if (header.alg !== "RS256") throw fail(401, `Unexpected token algorithm ${header.alg}.`);
    const key = await signingKey(header.kid, c.tenantId);
    const valid = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
    if (!valid) throw fail(401, "The sign-in token's signature is not valid.");

    const nowS = Math.floor(now() / 1000);
    if (claims.iss !== `${authorityHost}/${c.tenantId}/v2.0`) throw fail(401, "The sign-in token is from a different tenant.");
    if (claims.tid && claims.tid.toLowerCase() !== c.tenantId.toLowerCase()) throw fail(401, "The sign-in token is from a different tenant.");
    if (claims.aud !== c.clientId) throw fail(401, "The sign-in token was issued to a different application.");
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) throw fail(401, "The sign-in token has expired. Try again.");
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) throw fail(401, "The sign-in token is not valid yet; check this server's clock.");
    if (!nonce || claims.nonce !== nonce) throw fail(401, "The sign-in token does not match this sign-in attempt.");
    if (!claims.oid) throw fail(401, "The sign-in token has no object ID.");
    return claims;
  }

  /** Step 2: the browser came back. Exchanges the code and returns the verified identity. */
  async function complete({ state, code, cookieState }) {
    pruneFlows();
    const flow = flows.get(String(state || ""));
    if (!flow || !cookieState || cookieState !== state) throw fail(401, "This sign-in has expired or was started in another browser. Try again.");
    flows.delete(state);
    if (!code) throw fail(401, "Microsoft did not return an authorization code.");
    const c = config();
    const { ok, body } = await fetchJson(`${authorityHost}/${c.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
        scope: "openid profile email"
      }).toString()
    });
    if (!ok || !body.id_token) {
      const reason = body.error_description ? String(body.error_description).split("\r\n")[0] : body.error || "no ID token";
      throw fail(401, `Microsoft refused the sign-in: ${reason}`);
    }
    const claims = await verifyIdToken(body.id_token, { nonce: flow.nonce });
    return {
      oid: claims.oid,
      tenantId: claims.tid,
      username: String(claims.preferred_username || claims.email || claims.upn || "").toLowerCase(),
      name: claims.name || null,
      email: claims.email || (String(claims.preferred_username || "").includes("@") ? claims.preferred_username : null),
      role: roleFromClaims(claims.roles, roles())
    };
  }

  return { config, publicConfig, isReady, save, begin, complete, verifyIdToken, authorityHost };
}

module.exports = { createEntra, roleFromClaims, GUID_RE };

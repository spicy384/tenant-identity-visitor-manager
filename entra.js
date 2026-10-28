/**
 * Sign-in with Microsoft Entra ID: the OpenID Connect authorization-code flow with
 * PKCE, using only node's crypto and fetch.
 *
 * The app is a confidential client: it proves who it is to Microsoft with a client secret, or
 * with a certificate (entra-cert.js: a short token signed with the certificate's key, so no
 * secret is ever sent). Certificates are made here (the private key never leaves the
 * encrypted database) or uploaded; several can be kept, one in use, so one can be rotated
 * without a gap: add the new one to the app registration, then switch to it. The browser is sent to
 * Microsoft with a random state, nonce and PKCE challenge; Microsoft sends it back
 * with a code; the code is exchanged server-side for an ID token, whose signature is
 * checked against the tenant's published keys before any claim in it is believed.
 *
 * Configuration comes from the environment (ENTRA_*, with ENTRA_CERT_FILE and ENTRA_KEY_FILE or
 * ENTRA_PFX_FILE for a certificate), which wins and is shown as read-only, or from the "entra"
 * document in the encrypted database, set under Settings.
 */
const crypto = require("crypto");
const fs = require("fs");
const { generateCertificate, readPem, readPfx, certificateInfo, certificateDer, clientAssertion } = require("./entra-cert");

const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 300;
const HTTP_TIMEOUT_MS = 15 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Settings warns this many days before the certificate in use expires.
const CERT_WARN_DAYS = 30;
const MAX_CERTIFICATES = 5;
const CREDENTIALS = ["secret", "certificate"];
// Where the credential test asks for a token, by the cloud of the authority.
const GRAPH_BY_AUTHORITY = { "login.microsoftonline.us": "https://graph.microsoft.us", "login.chinacloudapi.cn": "https://microsoftgraph.chinacloudapi.cn" };

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
 * Maps app-role claim values to `appRoles` (this app's account roles, highest first): a
 * claim matches a role by its id or its name, ignoring case, spaces and punctuation, so
 * "Admin", "FrontDesk" and "front-desk" all work. Every role that matches, highest first.
 */
function rolesFromClaims(claims, appRoles = [{ id: "admin", name: "Administrator" }]) {
  if (!Array.isArray(claims)) return [];
  const wanted = new Set(claims.map(squash));
  return appRoles.filter((role) => wanted.has(squash(role.id)) || wanted.has(squash(role.name))).map((role) => role.id);
}

/** The highest role the claims match, or null. */
const roleFromClaims = (claims, appRoles) => rolesFromClaims(claims, appRoles)[0] || null;

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

  // A certificate given by files in the environment: read once, when first wanted.
  let envCertificate;
  let envCertificateError = null;
  function certificateFromEnv() {
    if (envCertificate !== undefined) return envCertificate;
    envCertificate = null;
    try {
      let pair = null;
      if (env.ENTRA_PFX_FILE) {
        const password = env.ENTRA_PFX_PASSWORD_FILE ? fs.readFileSync(env.ENTRA_PFX_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "") : String(env.ENTRA_PFX_PASSWORD || "");
        pair = readPfx(fs.readFileSync(env.ENTRA_PFX_FILE), password);
      } else if (env.ENTRA_CERT_FILE || env.ENTRA_KEY_FILE) {
        if (!env.ENTRA_CERT_FILE || !env.ENTRA_KEY_FILE) throw new Error("Set both ENTRA_CERT_FILE and ENTRA_KEY_FILE.");
        pair = readPem(fs.readFileSync(env.ENTRA_CERT_FILE, "utf8"), fs.readFileSync(env.ENTRA_KEY_FILE, "utf8"), String(env.ENTRA_KEY_PASSPHRASE || ""));
      }
      if (pair) envCertificate = { id: "env", ...certificateInfo(pair.certPem), ...pair, source: "environment", createdAt: null, active: true };
    } catch (error) {
      envCertificateError = `The certificate in the environment can't be used: ${error.message}`;
    }
    return envCertificate;
  }
  const certificateInEnv = () => Boolean(env.ENTRA_PFX_FILE || env.ENTRA_CERT_FILE || env.ENTRA_KEY_FILE);

  function fromEnv() {
    if (!env.ENTRA_TENANT_ID && !env.ENTRA_CLIENT_ID) return null;
    const certificate = certificateFromEnv();
    return {
      enabled: String(env.ENTRA_ENABLED || "true").toLowerCase() !== "false",
      tenantId: String(env.ENTRA_TENANT_ID || "").trim(),
      clientId: String(env.ENTRA_CLIENT_ID || "").trim(),
      clientSecret: String(env.ENTRA_CLIENT_SECRET || ""),
      // Certificate files win over a secret.
      credential: certificateInEnv() ? "certificate" : "secret",
      certificates: certificate ? [certificate] : [],
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
      credential: stored.credential === "certificate" ? "certificate" : "secret",
      certificates: Array.isArray(stored.certificates) ? stored.certificates : [],
      defaultRole: defaultRoles().includes(stored.defaultRole) ? stored.defaultRole : "none",
      buttonLabel: stored.buttonLabel || "Sign in with Microsoft",
      source: "settings"
    };
  }

  const activeCertificate = (c) => (c.certificates || []).find((x) => x.active) || null;

  /** Whether the chosen credential is there: a secret, or a certificate in use that hasn't expired. */
  function hasCredential(c) {
    if (c.credential === "certificate") {
      const cert = activeCertificate(c);
      return Boolean(cert && cert.notAfter > now());
    }
    return Boolean(c.clientSecret);
  }

  function isReady(c = config()) {
    return Boolean(c.enabled && GUID_RE.test(c.tenantId) && GUID_RE.test(c.clientId) && hasCredential(c));
  }

  /** A certificate as Settings shows it: never its private key. */
  function publicCertificate(cert) {
    const daysLeft = Math.floor((cert.notAfter - now()) / DAY_MS);
    return {
      id: cert.id,
      subject: cert.subject,
      thumbprint: cert.thumbprint,
      thumbprintSha256: cert.thumbprintSha256,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      source: cert.source,
      createdAt: cert.createdAt,
      active: Boolean(cert.active),
      daysLeft,
      expired: cert.notAfter <= now(),
      expiring: cert.notAfter > now() && daysLeft < CERT_WARN_DAYS
    };
  }

  /** What the Settings page shows: everything but the secret and private keys. */
  function publicConfig() {
    const c = config();
    return {
      enabled: c.enabled,
      ready: isReady(c),
      tenantId: c.tenantId,
      clientId: c.clientId,
      credential: c.credential,
      hasSecret: Boolean(c.clientSecret),
      certificates: c.certificates.map(publicCertificate),
      certificateError: c.source === "env" ? envCertificateError : null,
      warnDays: CERT_WARN_DAYS,
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
    if (patch.credential !== undefined) {
      if (!CREDENTIALS.includes(patch.credential)) throw fail(400, "The credential is a client secret or a certificate.");
      next.credential = patch.credential;
    }
    // An empty secret in the form means "keep the one stored".
    if (patch.clientSecret) next.clientSecret = String(patch.clientSecret);
    if (patch.clearSecret) next.clientSecret = "";
    if (patch.defaultRole !== undefined) {
      if (!defaultRoles().includes(patch.defaultRole)) throw fail(400, `Default role must be one of: ${defaultRoles().join(", ")}.`);
      next.defaultRole = patch.defaultRole;
    }
    if (patch.buttonLabel !== undefined) next.buttonLabel = String(patch.buttonLabel || "").trim().slice(0, 60);
    const proposed = { ...next, enabled: true, credential: next.credential === "certificate" ? "certificate" : "secret", certificates: next.certificates || [] };
    if (next.enabled && !isReady(proposed)) {
      throw fail(400, proposed.credential === "certificate"
        ? "To turn on Entra sign-in, enter the tenant ID and client ID, and have a certificate in use that hasn't expired."
        : "To turn on Entra sign-in, enter the tenant ID, client ID and client secret.");
    }
    store.write(DOC, next);
    jwks = { keys: [], fetchedAt: 0, tenantId: null };
    return publicConfig();
  }

  // --- certificates ---------------------------------------------------------

  function settingsOnly() {
    if (fromEnv()) throw fail(409, "Entra ID is configured by environment variables (ENTRA_*); change it there.");
    return store.read(DOC, {}) || {};
  }

  function addCertificate(pair, source) {
    const current = settingsOnly();
    const list = Array.isArray(current.certificates) ? current.certificates : [];
    if (list.length >= MAX_CERTIFICATES) throw fail(409, `Keep at most ${MAX_CERTIFICATES} certificates: remove one you no longer use first.`);
    const info = certificateInfo(pair.certPem);
    if (list.some((x) => x.thumbprint === info.thumbprint)) throw fail(409, "That certificate is already here.");
    if (info.notAfter <= now()) throw fail(400, "That certificate has expired.");
    // The first one is used at once; a later one waits until it is chosen (after it is added to Entra).
    const cert = { id: crypto.randomBytes(6).toString("hex"), ...info, certPem: pair.certPem, keyPem: pair.keyPem, source, createdAt: now(), active: !list.some((x) => x.active) };
    store.write(DOC, { ...current, certificates: [...list, cert] });
    return publicCertificate(cert);
  }

  /** Makes a key and a self-signed certificate valid for `years` (1 to 3); the key stays here. */
  function newCertificate({ years = 2 } = {}) {
    settingsOnly();
    const y = Number(years);
    if (![1, 2, 3].includes(y)) throw fail(400, "A certificate is made for 1, 2 or 3 years.");
    return addCertificate(generateCertificate({ commonName: "Identity and Visitor Manager", days: y * 365, now: new Date(now()) }), "generated");
  }

  /** Adds an uploaded certificate: { pfx (base64), password } or { certPem, keyPem, passphrase }. */
  function uploadCertificate(input = {}) {
    settingsOnly();
    let pair;
    if (input.pfx) {
      const bytes = Buffer.from(String(input.pfx), "base64");
      if (!bytes.length || bytes.length > 100 * 1024) throw fail(400, "Choose a PFX file (under 100 KB).");
      pair = readPfx(bytes, String(input.password ?? ""));
    } else {
      pair = readPem(input.certPem, input.keyPem, String(input.passphrase || ""));
    }
    return addCertificate(pair, "uploaded");
  }

  function findCertificate(id, c = config()) {
    const cert = c.certificates.find((x) => x.id === String(id));
    if (!cert) throw fail(404, "No such certificate.");
    return cert;
  }

  /** Uses this certificate from now on (add it to the app registration in Entra first). */
  function useCertificate(id) {
    const current = settingsOnly();
    const cert = findCertificate(id);
    if (cert.notAfter <= now()) throw fail(400, "That certificate has expired.");
    store.write(DOC, { ...current, certificates: current.certificates.map((x) => ({ ...x, active: x.id === cert.id })) });
    return publicCertificate({ ...cert, active: true });
  }

  function removeCertificate(id) {
    const current = settingsOnly();
    const c = config();
    const cert = findCertificate(id, c);
    if (cert.active && c.enabled && c.credential === "certificate") {
      throw fail(409, "Sign-in uses this certificate. Use another one first, or switch to the client secret.");
    }
    store.write(DOC, { ...current, certificates: current.certificates.filter((x) => x.id !== cert.id) });
    return publicCertificate(cert);
  }

  /** The certificate (no key) as a .cer file, to upload to the app registration. */
  function certificateFile(id) {
    const cert = findCertificate(id);
    return { der: certificateDer(cert.certPem), name: `identity-visitor-manager-${cert.thumbprint.slice(0, 8).toLowerCase()}.cer`, thumbprint: cert.thumbprint };
  }

  const tokenUrl = (c) => `${authorityHost}/${c.tenantId}/oauth2/v2.0/token`;

  /** The token request's proof of who the app is: the secret, or a client assertion signed with `certificate`. */
  function credentialParams(c, certificate = null) {
    if (certificate || c.credential === "certificate") {
      const cert = certificate || activeCertificate(c);
      if (!cert) throw fail(409, "No certificate is in use for Entra sign-in.");
      return {
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: clientAssertion({ certPem: cert.certPem, keyPem: cert.keyPem, clientId: c.clientId, audience: tokenUrl(c), now: now() })
      };
    }
    return { client_secret: c.clientSecret };
  }

  /**
   * Asks Microsoft for a token for this app on its own (client credentials), with the saved
   * credential or one certificate (by id, to try a new one before using it): whether Entra
   * accepts it. No permissions are needed for that.
   */
  async function testCredential({ certificateId = null } = {}) {
    const c = config();
    if (!GUID_RE.test(c.tenantId) || !GUID_RE.test(c.clientId)) throw fail(400, "Save the tenant ID and client ID first.");
    const certificate = certificateId ? findCertificate(certificateId, c) : null;
    const usingCertificate = Boolean(certificate) || c.credential === "certificate";
    if (!usingCertificate && !c.clientSecret) throw fail(400, "Save the client secret first.");
    const graph = GRAPH_BY_AUTHORITY[new URL(authorityHost).host] || "https://graph.microsoft.com";
    const { ok, body } = await fetchJson(tokenUrl(c), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, grant_type: "client_credentials", scope: `${graph}/.default`, ...credentialParams(c, certificate) }).toString()
    });
    const what = usingCertificate ? `the certificate ${(certificate || activeCertificate(c)).thumbprint}` : "the client secret";
    if (ok && body.access_token) return { ok: true, message: `Microsoft accepted ${what}.` };
    const reason = body.error_description ? String(body.error_description).split(/\r?\n/)[0] : body.error || "no answer";
    return { ok: false, message: `Microsoft refused ${what}: ${reason}` };
  }

  // --- the app on its own (reading Security's mailbox) ------------------------------------

  /** Microsoft Graph for the authority's cloud. */
  const graphBase = () => GRAPH_BY_AUTHORITY[new URL(authorityHost).host] || "https://graph.microsoft.com";
  let appTokenCache = null;

  /**
   * A token for Microsoft Graph as the app itself (client credentials), kept until a minute
   * before it runs out. Needs the app registration (tenant, client, and a secret or
   * certificate), not Entra sign-in turned on; what it may do is whatever application
   * permissions the registration has been granted.
   */
  async function appToken() {
    const c = config();
    if (!GUID_RE.test(c.tenantId) || !GUID_RE.test(c.clientId) || !hasCredential(c)) {
      throw fail(409, "Set up the app registration under Settings > Microsoft Entra ID first: the tenant ID, the client ID, and a client secret or certificate.");
    }
    const key = `${c.tenantId}|${c.clientId}|${c.credential}|${activeCertificate(c)?.thumbprint || ""}`;
    if (appTokenCache?.key === key && appTokenCache.expiresAt > now() + 60000) return appTokenCache.token;
    const { ok, body } = await fetchJson(tokenUrl(c), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, grant_type: "client_credentials", scope: `${graphBase()}/.default`, ...credentialParams(c) }).toString()
    });
    if (!ok || !body.access_token) {
      const reason = body.error_description ? String(body.error_description).split(/\r?\n/)[0] : body.error || "no answer";
      throw fail(502, `Microsoft refused the app's credential: ${reason}`);
    }
    appTokenCache = { key, token: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
    return body.access_token;
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
    const { ok, body } = await fetchJson(tokenUrl(c), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId,
        ...credentialParams(c),
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
      role: roleFromClaims(claims.roles, roles()),
      roles: rolesFromClaims(claims.roles, roles())
    };
  }

  return {
    config, publicConfig, isReady, save, begin, complete, verifyIdToken, authorityHost,
    newCertificate, uploadCertificate, useCertificate, removeCertificate, certificateFile, testCredential,
    activeCertificate: () => activeCertificate(config()), appToken, graphBase
  };
}

module.exports = { createEntra, roleFromClaims, rolesFromClaims, GUID_RE };

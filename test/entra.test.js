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
    // A certificate: checked as Entra would, against the certificates "uploaded" to the app registration.
    if (lastTokenRequest.get("client_assertion")) {
      const refused = assertionProblem(lastTokenRequest, u);
      if (refused) return { ok: false, status: 401, json: async () => ({ error: "invalid_client", error_description: `${refused}\r\nTrace ID: x` }) };
    } else if (lastTokenRequest.get("client_secret") !== "s3cret" && lastTokenRequest.get("client_secret") !== "x") {
      return { ok: false, status: 401, json: async () => ({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }) };
    }
    if (lastTokenRequest.get("grant_type") === "client_credentials") return { ok: true, status: 200, json: async () => ({ access_token: "app-token" }) };
    if (nextToken === "refuse") return { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "AADSTS70008: The code has expired.\r\nTrace ID: x" }) };
    return { ok: true, status: 200, json: async () => ({ id_token: nextToken }) };
  }
  throw new Error(`unexpected fetch ${u}`);
}

// Certificates the fake app registration knows, by their SHA-256 thumbprint (x5t#S256).
const registered = new Map();
const registerCert = (certPem) => registered.set(crypto.createHash("sha256").update(new crypto.X509Certificate(certPem).raw).digest("base64url"), new crypto.X509Certificate(certPem));
let lastAssertion = null;
function assertionProblem(params, tokenUrl) {
  if (params.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return "AADSTS50027: bad assertion type";
  const [h, p, sig] = params.get("client_assertion").split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  lastAssertion = { header, claims };
  const cert = registered.get(header["x5t#S256"]);
  if (!cert) return "AADSTS700027: The certificate with identifier used to sign the client assertion is not registered on application.";
  const valid = header.alg === "PS256" && crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: cert.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, "base64url"));
  if (!valid) return "AADSTS700027: Client assertion contains an invalid signature.";
  if (claims.aud !== tokenUrl || claims.iss !== CLIENT || claims.sub !== CLIENT || !claims.jti || claims.exp < nowS()) return "AADSTS700024: Client assertion is not within its valid time range or has the wrong audience.";
  return null;
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

  // --- a certificate instead of the secret --------------------------------------------------------
  const fixtures = path.join(__dirname, "fixtures", "entra");
  const pfx = (name) => fs.readFileSync(path.join(fixtures, name)).toString("base64");
  const attemptFails = async (fn, pattern) => expectFail(Promise.resolve().then(fn), pattern);
  let t = await entra.testCredential();
  check("test: the client secret, as Microsoft sees it", t.ok && lastTokenRequest.get("grant_type") === "client_credentials" && lastTokenRequest.get("scope") === "https://graph.microsoft.com/.default");
  check("certificate: can't be chosen without one in use", await attemptFails(() => entra.save({ credential: "certificate" }), /certificate in use/));
  const made = entra.newCertificate({ years: 2 });
  check("certificate: made here, in use as the first one", made.active && /^[0-9A-F]{40}$/.test(made.thumbprint) && made.daysLeft >= 729 && !made.expiring && made.source === "generated");
  check("certificate: its private key stays in the database, never in what Settings gets",
    /PRIVATE KEY/.test(JSON.parse(docs.get("entra")).certificates[0].keyPem) && !JSON.stringify(entra.publicConfig()).includes("PRIVATE KEY"));
  check("certificate: only 1 to 3 years", await attemptFails(() => entra.newCertificate({ years: 10 }), /1, 2 or 3 years/));
  const cer = entra.certificateFile(made.id);
  check("certificate: downloaded as a .cer (DER) with no key", new crypto.X509Certificate(cer.der).fingerprint.replace(/:/g, "") === made.thumbprint && !cer.der.toString("latin1").includes("PRIVATE"));
  t = await entra.testCredential({ certificateId: made.id });
  check("test: refused until it is added to the app registration", !t.ok && /AADSTS700027/.test(t.message));
  registerCert(new crypto.X509Certificate(cer.der).toString());
  check("test: accepted once added", (await entra.testCredential({ certificateId: made.id })).ok);
  const pubCert = entra.save({ credential: "certificate" });
  check("certificate: chosen as the credential", pubCert.credential === "certificate" && pubCert.ready);
  let a = await attempt({});
  check("sign-in: with the certificate, no secret sent", a.oid === "oid-123" && !lastTokenRequest.get("client_secret") && lastTokenRequest.get("grant_type") === "authorization_code");
  check("sign-in: the assertion is PS256 for the token endpoint, valid ten minutes",
    lastAssertion.header.alg === "PS256" && lastAssertion.claims.aud === `${AUTHORITY}/${TENANT}/oauth2/v2.0/token` && lastAssertion.claims.exp - lastAssertion.claims.iat === 600);

  // Rotation: a second certificate (uploaded) waits until it is chosen.
  check("upload: a wrong PFX password is refused", await attemptFails(() => entra.uploadCertificate({ pfx: pfx("modern.pfx"), password: "nope" }), /password is wrong/));
  const second = entra.uploadCertificate({ pfx: pfx("windows.pfx"), password: "fixture-pass" });
  check("upload: a PFX exported by Windows", second.thumbprint === "FDA18D8F8F8CA56EFFD8D5661AFE94984A51BF2F" && !second.active && second.source === "uploaded");
  check("upload: the same one twice is refused", await attemptFails(() => entra.uploadCertificate({ pfx: pfx("windows.pfx"), password: "fixture-pass" }), /already here/));
  check("upload: PEM with an encrypted key", entra.uploadCertificate({ certPem: fs.readFileSync(path.join(fixtures, "cert.pem"), "utf8"), keyPem: fs.readFileSync(path.join(fixtures, "key-encrypted.pem"), "utf8"), passphrase: "fixture-pass" }).subject === "CN=IVM test fixture");
  check("upload: a key that doesn't match its certificate is refused",
    await attemptFails(() => entra.uploadCertificate({ certPem: entra.config().certificates[0].certPem, keyPem: fs.readFileSync(path.join(fixtures, "key.pem"), "utf8") }), /don't belong together/));
  check("rotation: the one in use can't be removed", await attemptFails(() => entra.removeCertificate(made.id), /Use another one first/));
  entra.useCertificate(second.id);
  check("rotation: switching before Entra knows it fails with Microsoft's reason", await expectFail(attempt({}), /AADSTS700027/));
  registerCert(entra.config().certificates.find((c) => c.id === second.id).certPem);
  a = await attempt({});
  check("rotation: the new one signs in once added", a.oid === "oid-123");
  entra.removeCertificate(made.id);
  check("rotation: the old one removed", !entra.publicConfig().certificates.some((c) => c.id === made.id));
  entra.save({ credential: "secret" });
  await attempt({});
  check("secret: back to the secret", lastTokenRequest.get("client_secret") === "s3cret" && !lastTokenRequest.get("client_assertion"));

  // Expiry, with the clock moved on.
  const notAfter = entra.config().certificates.find((c) => c.id === second.id).notAfter;
  const at = (ms) => createEntra({ store, roles: () => ROLES, env: {}, fetchImpl: fakeFetch, now: () => ms });
  check("expiry: warned of within 30 days", at(notAfter - 10 * 24 * 3600 * 1000).publicConfig().certificates.find((c) => c.id === second.id).expiring);
  entra.save({ credential: "certificate" });
  check("expiry: an expired certificate turns sign-in off", entra.isReady() && !at(notAfter + 1000).isReady());
  check("expiry: and can't be chosen", await attemptFails(() => at(notAfter + 1000).useCertificate(second.id), /expired/));
  entra.save({ credential: "secret" });

  // --- environment configuration ---------------------------------------------------------
  const envEntra = createEntra({ store, roles: () => ROLES, env: { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: "x", ENTRA_DEFAULT_ROLE: "viewer" }, fetchImpl: fakeFetch });
  check("env: wins and is read-only", envEntra.publicConfig().readOnly && envEntra.config().defaultRole === "viewer" && await expectFail(Promise.resolve().then(() => envEntra.save({ enabled: false })), /environment variables/));
  const fixtures2 = path.join(__dirname, "fixtures", "entra");
  const envWith = (extra) => createEntra({ store, roles: () => ROLES, env: { ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ...extra }, fetchImpl: fakeFetch });
  const pfxEnv = envWith({ ENTRA_PFX_FILE: path.join(fixtures2, "legacy-rc2.pfx"), ENTRA_PFX_PASSWORD: "fixture-pass" });
  check("env: a PFX file (the older RC2 kind) is the credential", pfxEnv.config().credential === "certificate" && pfxEnv.isReady() && pfxEnv.publicConfig().certificates[0].subject === "CN=IVM test fixture");
  check("env: its certificate can be downloaded, not changed", pfxEnv.certificateFile("env").der.length > 500 && await expectFail(Promise.resolve().then(() => pfxEnv.newCertificate()), /environment variables/));
  const pemEnv = envWith({ ENTRA_CERT_FILE: path.join(fixtures2, "cert.pem"), ENTRA_KEY_FILE: path.join(fixtures2, "key-encrypted.pem"), ENTRA_KEY_PASSPHRASE: "fixture-pass" });
  check("env: PEM files", pemEnv.isReady() && pemEnv.config().certificates[0].active);
  const badEnv = envWith({ ENTRA_PFX_FILE: path.join(fixtures2, "modern.pfx"), ENTRA_PFX_PASSWORD: "wrong" });
  check("env: a bad one says why, and sign-in stays off", !badEnv.isReady() && /password is wrong/.test(badEnv.publicConfig().certificateError));

  process.exit(report() ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

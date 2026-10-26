// 02-auth.js: first-run setup, sign-in (password, authenticator code, recovery code,
// passkey, Microsoft Entra ID) and sign-out.

let pendingToken = null;
let entraInfo = { enabled: false };

// With Microsoft sign-in ready, it is the sign-in card's one button and local accounts (and
// passkeys) fold away behind a link, unless this browser last signed in with a local account.
// Without it, the local form is all there is and is always open.
const LAST_SIGNIN_KEY = "ivm.lastSignIn";
let localOpen = null; // null: not decided yet for this sign-in card

function lastSignIn() {
  try {
    return localStorage.getItem(LAST_SIGNIN_KEY);
  } catch {
    return null;
  }
}

function rememberSignIn(how) {
  try {
    localStorage.setItem(LAST_SIGNIN_KEY, how);
  } catch {
    // A convenience only.
  }
}

/** Shows or folds away the local sign-in (always shown without Microsoft sign-in). */
function showLocalLogin(open) {
  localOpen = open;
  const folded = entraInfo.enabled && !open;
  $("local-login").hidden = folded;
  $("local-toggle").hidden = !folded;
  $("local-toggle").setAttribute("aria-expanded", String(!folded));
  $("or-divider").hidden = !entraInfo.enabled;
  $("entra-btn").classList.toggle("prominent", folded);
}

function authStep(step) {
  $("setup-form").hidden = step !== "setup";
  $("login-block").hidden = step !== "login";
  $("mfa-form").hidden = step !== "mfa";
  $("recovery-form").hidden = step !== "recovery";
  $("auth-title").textContent = step === "setup" ? "Create the first administrator" : step === "mfa" || step === "recovery" ? "Two-factor sign-in" : "Sign in";
  if (step === "login") {
    $("entra-btn").hidden = !entraInfo.enabled;
    $("entra-label").textContent = entraInfo.label || "Sign in with Microsoft";
    $("passkey-btn").hidden = Boolean(passkeyBlocker());
    showLocalLogin(localOpen ?? lastSignIn() === "local");
  }
  const folded = step === "login" && $("local-login").hidden;
  const first = folded ? "#entra-btn" : { setup: "#setup-form input", login: "#login-form input", mfa: "#mfa-form input", recovery: "#recovery-form input" }[step];
  if (first && !matchMedia("(pointer: coarse)").matches) setTimeout(() => document.querySelector(first)?.focus(), 0);
}

$("local-toggle").addEventListener("click", () => {
  showLocalLogin(true);
  $("login-form").username.focus();
});

$("entra-btn").addEventListener("click", () => rememberSignIn("entra"));

function authMessage(message) {
  $("auth-message").textContent = message || "";
  $("auth-message").hidden = !message;
}

/** Covers the app with the sign-in card. */
function showAuth(message = "", step = "login") {
  state.me = null;
  localOpen = null;
  state.csrfToken = null;
  $("main").hidden = true;
  $("nav").hidden = true;
  $("subnav").hidden = true;
  $("header-actions").hidden = true;
  $("footer").hidden = true;
  $("auth").hidden = false;
  authMessage(message);
  authStep(step);
}

/**
 * Signed in: remember who, then hand over to the app. Signed in here (a local account or a
 * passkey) rather than resuming a session: this browser opens the local sign-in next time.
 */
async function signedIn(user, csrfToken, { resumed = false } = {}) {
  if (!resumed) rememberSignIn("local");
  state.me = user;
  state.csrfToken = csrfToken;
  pendingToken = null;
  $("auth").hidden = true;
  for (const f of ["setup-form", "login-form", "mfa-form", "recovery-form"]) $(f).reset();
  await startApp();
}

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.confirm.value) return authMessage("The passwords do not match.");
  try {
    const data = await api("/api/auth/setup", { method: "POST", body: { username: f.username.value, password: f.password.value, siteName: f.siteName.value } });
    await signedIn(data.user, data.csrfToken);
  } catch (error) {
    authMessage(error.message);
  }
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  authMessage("");
  try {
    const data = await api("/api/auth/login", { method: "POST", body: { username: f.username.value, password: f.password.value } });
    if (data.mfaRequired) {
      pendingToken = data.pendingToken;
      authStep("mfa");
      return;
    }
    await signedIn(data.user, data.csrfToken);
  } catch (error) {
    authMessage(error.message);
  }
});

$("mfa-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/auth/login/mfa", { method: "POST", body: { pendingToken, code: e.target.code.value } });
    await signedIn(data.user, data.csrfToken);
  } catch (error) {
    authMessage(error.message);
    if (/expired/i.test(error.message)) authStep("login");
  }
});

$("recovery-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/auth/login/recovery", { method: "POST", body: { pendingToken, code: e.target.code.value } });
    await signedIn(data.user, data.csrfToken);
    toast(`Signed in with a recovery code. ${data.recoveryCodesRemaining} left.`);
  } catch (error) {
    authMessage(error.message);
    if (/expired/i.test(error.message)) authStep("login");
  }
});

$("use-recovery").addEventListener("click", () => authStep("recovery"));
$("use-code").addEventListener("click", () => authStep("mfa"));

$("logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch {
    // Signed out either way.
  }
  showAuth("You have signed out.");
});

// --- passkeys (WebAuthn) ---------------------------------------------------------
//
// The browser API wants ArrayBuffers where the server speaks base64url; the newer
// PublicKeyCredential JSON helpers do that conversion natively and are used when
// present, with a small fallback for browsers that lack them.

function b64urlToBuffer(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function bufferToB64url(buf) {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function webauthnOptionsFromJson(options, kind) {
  if (kind === "create" && PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(options);
  if (kind === "get" && PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(options);
  const out = { ...options, challenge: b64urlToBuffer(options.challenge) };
  if (options.user) out.user = { ...options.user, id: b64urlToBuffer(options.user.id) };
  for (const key of ["excludeCredentials", "allowCredentials"]) {
    if (options[key]) out[key] = options[key].map((c) => ({ ...c, id: b64urlToBuffer(c.id) }));
  }
  return out;
}

function webauthnCredentialToJson(cred) {
  if (typeof cred.toJSON === "function") return cred.toJSON();
  const r = cred.response;
  const response = { clientDataJSON: bufferToB64url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufferToB64url(r.attestationObject);
    if (r.getTransports) response.transports = r.getTransports();
  } else {
    response.authenticatorData = bufferToB64url(r.authenticatorData);
    response.signature = bufferToB64url(r.signature);
    response.userHandle = r.userHandle ? bufferToB64url(r.userHandle) : null;
  }
  return { id: cred.id, rawId: bufferToB64url(cred.rawId), type: cred.type, response, clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}, authenticatorAttachment: cred.authenticatorAttachment || null };
}

/** Why passkeys cannot be used on this page, or null when they can. */
function passkeyBlocker() {
  if (!window.PublicKeyCredential || !navigator.credentials) return "This browser does not support passkeys.";
  if (!window.isSecureContext) return "Passkeys need HTTPS (or localhost).";
  const host = location.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return "Passkeys need a hostname, not an IP address; open the app by its DNS name.";
  return null;
}

$("passkey-btn").addEventListener("click", async () => {
  const btn = $("passkey-btn");
  btn.disabled = true;
  authMessage("");
  try {
    const { token, options } = await api("/api/auth/passkeys/login/options", { method: "POST", body: {} });
    const cred = await navigator.credentials.get({ publicKey: webauthnOptionsFromJson(options, "get") });
    const data = await api("/api/auth/passkeys/login/verify", { method: "POST", body: { token, response: webauthnCredentialToJson(cred) } });
    await signedIn(data.user, data.csrfToken);
  } catch (error) {
    authMessage(error.name === "NotAllowedError" ? "Passkey sign-in was cancelled." : error.message);
  } finally {
    btn.disabled = false;
  }
});

/** Where the app starts: who (if anyone) is signed in, and what the sign-in card shows. */
async function checkSession() {
  const params = new URLSearchParams(location.search);
  const entraError = params.get("signin_error");
  if (entraError) history.replaceState(null, "", location.pathname + location.hash);
  let me;
  try {
    me = await api("/api/auth/me");
  } catch (error) {
    showAuth(error.message);
    return;
  }
  entraInfo = me.entra || { enabled: false };
  applyBranding(me.branding);
  if (me.setupRequired) return showAuth("", "setup");
  if (!me.authenticated) return showAuth(entraError || "");
  await signedIn(me.user, me.csrfToken, { resumed: true });
}

// 08-account.js: the signed-in person's own account: password, authenticator code,
// passkeys and open sessions. Microsoft accounts manage all of that at Microsoft.

async function renderAccount() {
  const body = clear($("account-body"));
  const me = state.me;
  const appearance = h("select", { "aria-label": "Appearance" },
    h("option", { value: "auto", text: "Match this device" }), h("option", { value: "light", text: "Light" }), h("option", { value: "dark", text: "Dark" }));
  appearance.value = chosenTheme();
  appearance.addEventListener("change", () => { setTheme(appearance.value); toast("Saved."); });
  body.append(h("div", { class: "panel" },
    h("h3", { text: me.displayName || me.username }),
    h("dl", { class: "facts inline-facts" },
      h("dt", { text: "Username" }), h("dd", { text: me.username }),
      h("dt", { text: (me.roles || []).length > 1 ? "Roles" : "Role" }), h("dd", { text: me.roleName || me.role }),
      multiSite() || me.sites ? [h("dt", { text: "Sites" }), h("dd", { text: me.sites ? state.config.sites.map((x) => x.name).join(", ") : "Every site" })] : null,
      h("dt", { text: "Signs in with" }), h("dd", { text: me.provider === "entra" ? "Microsoft Entra ID" : "Password" }))),
    h("div", { class: "panel" },
      h("h3", { text: "Appearance" }),
      h("p", { class: "muted", text: "Light or dark, or as this device is set. The button with the moon or sun in the header switches too. Kept with your account, so it follows you." }),
      h("label", { class: "half" }, h("span", { text: "Show" }), appearance)));

  if (me.provider === "local") {
    body.append(settingsForm({
      title: "Change password",
      fields: [
        { name: "currentPassword", label: "Current password", type: "password", half: true },
        { name: "newPassword", label: "New password (12 characters or more)", type: "password", half: true }
      ],
      saveLabel: "Change password",
      onSave: async (v) => {
        const r = await api("/api/auth/password", { method: "POST", body: v });
        return r.otherSessionsEnded ? `Password changed. ${r.otherSessionsEnded} other session(s) signed out.` : "Password changed.";
      }
    }).form);
    body.append(await mfaPanel(), await passkeyPanel());
  }
  body.append(await sessionsPanel());
}

async function mfaPanel() {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Authenticator code" }));
  if (state.me.mfaEnrolled) {
    panel.append(h("p", { text: "Two-factor sign-in is on: after your password you enter a code from your authenticator app." }),
      h("button", { type: "button", class: "secondary", text: "Turn off", onclick: async () => {
        const done = await formDialog({ title: "Turn off two-factor sign-in", fields: [{ name: "password", label: "Your password", type: "password", required: true }], submitLabel: "Turn off", onSubmit: (v) => api("/api/auth/mfa/disable", { method: "POST", body: v }) });
        if (done) { state.me.mfaEnrolled = false; renderAccount(); }
      } }));
    return panel;
  }
  panel.append(h("p", { class: "muted", text: "Optional. Adds a 6-digit code from an app such as Microsoft Authenticator after your password." }),
    h("button", { type: "button", class: "secondary", text: "Set up", onclick: async () => {
      const setup = await api("/api/auth/mfa/setup", { method: "POST", body: {} });
      const codes = await formDialog({
        title: "Set up an authenticator",
        intro: h("div", { class: "stack center" },
          h("p", { text: "Scan this with your authenticator app, then enter the code it shows." }),
          h("img", { src: setup.qrDataUrl, alt: "Authenticator QR code", class: "qr" }),
          h("p", { class: "muted small-text" }, "Or enter this key: ", h("code", { text: setup.secret }))),
        fields: [{ name: "code", label: "Code", required: true, autocomplete: "one-time-code" }],
        submitLabel: "Turn on",
        onSubmit: async (v) => (await api("/api/auth/mfa/confirm", { method: "POST", body: v })).recoveryCodes
      });
      if (codes) {
        state.me.mfaEnrolled = true;
        await openDialog({ title: "Recovery codes", body: h("div", { class: "stack" }, h("p", { text: "Each code signs you in once if you lose your authenticator. Save them somewhere safe; they are not shown again." }), h("pre", { class: "code", text: codes.join("\n") })) });
        renderAccount();
      }
    } }));
  return panel;
}

async function passkeyPanel() {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Passkeys" }));
  const blocker = passkeyBlocker();
  panel.append(h("p", { class: "muted", text: "Sign in with Face ID, Touch ID or a security key instead of a password and code." }));
  const { passkeys } = await api("/api/auth/passkeys");
  if (passkeys.length) {
    panel.append(h("ul", { class: "plain-list" }, passkeys.map((p) => h("li", { class: "row-between" },
      h("span", {}, h("strong", { text: p.name }), h("span", { class: "muted small-text", text: ` added ${fmtDate(p.createdAt)}${p.lastUsedAt ? `, last used ${fmtDateTime(p.lastUsedAt)}` : ""}` })),
      h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => { if (await confirmDialog(`Remove the passkey "${p.name}"?`, { danger: true, confirmLabel: "Remove" })) { await api(`/api/auth/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); renderAccount(); } } })))));
  }
  if (blocker) panel.append(h("p", { class: "muted", text: blocker }));
  else {
    panel.append(h("button", { type: "button", class: "secondary", text: "Add a passkey", onclick: async () => {
      const name = await formDialog({ title: "Add a passkey", fields: [{ name: "name", label: "Name it", placeholder: "e.g. Front desk iPad", required: true }], submitLabel: "Continue", onSubmit: (v) => v.name });
      if (!name) return;
      try {
        const { options } = await api("/api/auth/passkeys/register/options", { method: "POST", body: {} });
        const cred = await navigator.credentials.create({ publicKey: webauthnOptionsFromJson(options, "create") });
        await api("/api/auth/passkeys/register/verify", { method: "POST", body: { name, response: webauthnCredentialToJson(cred) } });
        toast(`Passkey "${name}" added.`);
        renderAccount();
      } catch (error) {
        toast(error.name === "NotAllowedError" ? "Cancelled; nothing was added." : error.name === "InvalidStateError" ? "This device already has a passkey for your account." : error.message, "error");
      }
    } }));
  }
  return panel;
}

async function sessionsPanel() {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Where you are signed in" }));
  const { sessions } = await api("/api/auth/sessions");
  panel.append(h("ul", { class: "plain-list" }, sessions.map((s) => h("li", { class: "row-between" },
    h("span", {}, h("strong", { text: s.current ? "This device" : (s.userAgent.match(/iPad|iPhone|Android|Windows|Macintosh|Linux/) || ["Unknown device"])[0] }),
      h("span", { class: "muted small-text", text: ` ${s.ip || ""} · last active ${fmtDateTime(s.lastSeenAt)}` })),
    s.current ? null : h("button", { type: "button", class: "link-btn", text: "Sign out", onclick: async () => { await api(`/api/auth/sessions/${s.key}`, { method: "DELETE" }); renderAccount(); } })))));
  if (sessions.length > 1) {
    panel.append(h("button", { type: "button", class: "secondary small", text: "Sign out everywhere else", onclick: async () => { await api("/api/auth/sessions/sign-out-others", { method: "POST", body: {} }); renderAccount(); } }));
  }
  return panel;
}

function showAccount() {
  renderAccount().catch((error) => toast(error.message, "error"));
}

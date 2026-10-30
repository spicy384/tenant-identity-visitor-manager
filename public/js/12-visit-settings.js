// 12-visit-settings.js: Settings > Visits (how long visits are kept, the kiosk's idle
// time) and Settings > Kiosks (adding, pairing, moving and removing kiosks).

async function settingsVisits(body) {
  const s = await api("/api/settings/visits");
  const preview = h("p", { class: "muted full-row" });
  async function showPreview(months) {
    const n = Number(months);
    if (!Number.isInteger(n) || n < 0) { preview.textContent = ""; return; }
    if (n === 0) { preview.textContent = "Visits are kept until you delete them."; return; }
    try {
      const p = await api(`/api/settings/visits/preview?months=${n}`);
      preview.textContent = `Keeping ${n} month${n === 1 ? "" : "s"} would delete ${p.wouldDelete.visits} visit${p.wouldDelete.visits === 1 ? "" : "s"} and ${p.wouldDelete.visitors} unchecked visitor${p.wouldDelete.visitors === 1 ? "" : "s"} today.`;
    } catch (error) {
      preview.textContent = error.message;
    }
  }
  const { form, inputs } = settingsForm({
    title: "Visits",
    intro: "Each site's end-of-day check-out time is set under Sites.",
    fields: [
      { name: "retentionMonths", label: "Keep visits for (months)", type: "number", value: s.retentionMonths, half: true, required: true, min: 0, max: 240, step: 1, hint: "Type 0 to keep them for ever; otherwise up to 240. Older visits are deleted once a day, with visitors who registered at a kiosk, were never checked and have no visits left. Visits still open are never deleted." },
      { node: preview },
      { name: "kioskIdleSeconds", label: "Kiosk goes back to the start after (seconds)", type: "number", value: s.kioskIdleSeconds, half: true, hint: "Without a touch, from any screen. 15 to 600." }
    ],
    onSave: async (v) => {
      await api("/api/settings/visits", { method: "PUT", body: { retentionMonths: Number(v.retentionMonths), kioskIdleSeconds: Number(v.kioskIdleSeconds) } });
      return Number(v.retentionMonths) ? "Saved. The next daily run deletes older visits; use \"Delete old visits now\" not to wait." : "Saved.";
    },
    extra: (values, msg) => h("button", { type: "button", class: "secondary", text: "Delete old visits now", onclick: async () => {
      if (!Number(values().retentionMonths)) { msg.className = "message"; msg.textContent = "Retention is off: nothing to delete."; msg.hidden = false; return; }
      if (!(await confirmDialog(`${preview.textContent} Delete them now? This can't be undone.`, { danger: true, confirmLabel: "Delete" }))) return;
      try {
        await api("/api/settings/visits", { method: "PUT", body: { retentionMonths: Number(values().retentionMonths) } });
        const r = await api("/api/settings/visits/apply", { method: "POST", body: {} });
        msg.className = "message success";
        msg.textContent = `Deleted ${r.removed.visits} visits and ${r.removed.visitors} unchecked visitors.`;
        showPreview(values().retentionMonths);
      } catch (error) {
        msg.className = "message error";
        msg.textContent = error.message;
      }
      msg.hidden = false;
    } })
  });
  inputs.retentionMonths.addEventListener("input", debounce(() => showPreview(inputs.retentionMonths.value), 300));
  showPreview(s.retentionMonths);
  body.append(form);
}

// --- kiosks -------------------------------------------------------------------------------------

const KIOSK_STATUS = { paired: "Paired", waiting: "Waiting for its code", "not paired": "Not paired" };

async function settingsKiosks(body) {
  const { kiosks, kioskUrl, separatePort } = await api("/api/kiosks");
  body.append(
    h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: "Kiosks" }), h("button", { type: "button", class: "primary small", text: "Add kiosk", onclick: () => addKiosk() })),
      h("p", { class: "muted", text: `Each kiosk is an iPad in a lobby, tied to one site. It shows that site's name and logo, and its tenants.${separatePort ? " Kiosks have a port of their own, which serves nothing but the kiosk." : ""}` }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Kiosk", ...(multiSite() ? ["Site"] : []), "Status", "Last seen", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, kiosks.length ? kiosks.map((k) => h("tr", {},
          h("td", {}, h("strong", { text: k.name })),
          multiSite() ? h("td", { text: k.siteName }) : null,
          h("td", {}, h("span", { class: `badge ${k.status === "paired" ? "ok" : k.status === "waiting" ? "warn" : "muted"}`, text: KIOSK_STATUS[k.status] }), k.pairingExpiresAt ? h("div", { class: "muted small-text", text: `Code valid until ${fmtDateTime(k.pairingExpiresAt)}` }) : null),
          h("td", { class: "small-text" }, k.lastSeenAt ? fmtDateTime(k.lastSeenAt) : "Never", k.lastIp ? h("div", { class: "muted mono", text: k.lastIp }) : null),
          h("td", {}, h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Edit", onclick: () => editKiosk(k) }),
            h("button", { type: "button", class: "link-btn", text: "New pairing code", onclick: () => newKioskCode(k) }),
            h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => removeKiosk(k) }))))) : emptyRow(multiSite() ? 5 : 4, "No kiosks yet."))))),
    h("div", { class: "panel" },
      h("h3", { text: "Setting up an iPad" }),
      h("ol", { class: "plain-list numbered" },
        h("li", {}, "Add the kiosk here and note its pairing code."),
        h("li", {}, "On the iPad, open ", h("code", { class: "copy", text: kioskUrl }), " in Safari and enter the code."),
        h("li", {}, "Share > Add to Home Screen, then open it from the Home Screen so it runs full screen."),
        h("li", {}, "Settings > Accessibility > Guided Access keeps the iPad on the kiosk. Set Display & Brightness > Auto-Lock to Never."),
        h("li", {}, "If the iPad is lost, remove the kiosk or give it a new pairing code: the old device stops working at once."))));
}

/** Shows a pairing code once, with where to enter it. */
function showPairingCode(kiosk, code, kioskUrl) {
  return openDialog({
    title: `Pairing code for ${kiosk.name}`,
    body: h("div", { class: "stack center" },
      h("p", { text: `On the iPad, open ${kioskUrl || `${location.origin}/kiosk/`} and enter:` }),
      h("p", { class: "pairing-code", text: code }),
      h("p", { class: "muted", text: "The code works once, for the next 24 hours. It isn't shown again; make a new one if you need it." }))
  });
}

async function addKiosk() {
  const sites = state.config.sites.filter((s) => s.active);
  const result = await formDialog({
    title: "Add kiosk",
    fields: [
      { name: "name", label: "Name", required: true, placeholder: "Lobby iPad" },
      ...(sites.length > 1 ? [{ name: "siteId", label: "Site", type: "select", options: sites.map((s) => ({ value: String(s.id), label: s.name })) }] : [])
    ],
    submitLabel: "Add kiosk",
    onSubmit: async (v) => api("/api/kiosks", { method: "POST", body: { name: v.name, siteId: Number(v.siteId || sites[0]?.id) } })
  });
  if (!result) return;
  await showPairingCode(result.kiosk, result.code, result.kioskUrl);
  renderSettings();
}

async function editKiosk(kiosk) {
  const sites = state.config.sites;
  const saved = await formDialog({
    title: `Edit ${kiosk.name}`,
    fields: [
      { name: "name", label: "Name", required: true, value: kiosk.name },
      ...(sites.length > 1 ? [{ name: "siteId", label: "Site", type: "select", value: String(kiosk.siteId), options: sites.map((s) => ({ value: String(s.id), label: s.name })), hint: "Moving it changes the name, logo and tenants it shows straight away." }] : [])
    ],
    onSubmit: async (v) => (await api(`/api/kiosks/${kiosk.id}`, { method: "PUT", body: { name: v.name, ...(v.siteId ? { siteId: Number(v.siteId) } : {}) } })).kiosk
  });
  if (saved) renderSettings();
}

async function newKioskCode(kiosk) {
  if (kiosk.status === "paired" && !(await confirmDialog(`Make a new pairing code for ${kiosk.name}? The iPad paired now stops working until the new code is entered on it.`, { confirmLabel: "New code" }))) return;
  try {
    const result = await api(`/api/kiosks/${kiosk.id}/code`, { method: "POST", body: {} });
    await showPairingCode(result.kiosk, result.code, result.kioskUrl);
  } catch (error) {
    toast(error.message, "error");
  }
  renderSettings();
}

async function removeKiosk(kiosk) {
  if (!(await confirmDialog(`Remove ${kiosk.name}? The iPad stops working at once. Its visits stay in the log.`, { danger: true, confirmLabel: "Remove" }))) return;
  try {
    await api(`/api/kiosks/${kiosk.id}`, { method: "DELETE" });
    renderSettings();
  } catch (error) {
    toast(error.message, "error");
  }
}

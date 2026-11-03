// 27-insurance.js: certificates of insurance (Facilities > Insurance, and each company's page),
// and a company's tenant badge allotment (its page). Certificates are seen by those who see
// facilities or the books and kept by Managers and Finance; the allotment is seen with badges
// too, and adjusted by Managers and Finance.

const COVER_STATUS = {
  current: { label: "Current", cls: "ok" },
  expiring: { label: "Expiring", cls: "warn" },
  expired: { label: "Expired", cls: "bad" },
  none: { label: "None on file", cls: "muted" }
};

/** A company's cover as a badge: expiring ones say how soon. */
function coverBadge(status, cert = null) {
  const text = status === "expiring" && cert ? (cert.daysLeft === 0 ? "Expires today" : `Expires in ${cert.daysLeft} ${cert.daysLeft === 1 ? "day" : "days"}`) : COVER_STATUS[status].label;
  return h("span", { class: `badge ${COVER_STATUS[status].cls}`, text });
}

const fileSizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A link opening a certificate's copy in a new tab, or null when it has none. */
function certificateLink(cert) {
  if (!cert?.file) return null;
  return h("a", { href: `/api/insurance/files/${encodeURIComponent(cert.file.ref)}`, target: "_blank", rel: "noopener", text: cert.file.name, onclick: (e) => e.stopPropagation() });
}

/** A chosen file as a data: URL. */
function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That file can't be read."));
    reader.readAsDataURL(file);
  });
}

// --- Facilities > Insurance ------------------------------------------------------------------------------

$("insurance-search").addEventListener("input", debounce(() => loadInsurance(), 250));
$("insurance-status").addEventListener("change", () => loadInsurance());

function showInsurance() {
  loadInsurance();
}

async function loadInsurance() {
  const table = $("insurance-table");
  const head = ["Company", "Insurance", "Expires", "Insurer", "Certificate"];
  table.tHead.replaceChildren(h("tr", {}, head.map((t) => h("th", { text: t }))));
  let companies;
  try {
    ({ companies } = await api(`/api/insurance?${new URLSearchParams({ status: $("insurance-status").value, q: $("insurance-search").value.trim() })}`));
  } catch (error) {
    clear(table.tBodies[0]).append(emptyRow(head.length, error.message));
    return;
  }
  if (!companies.length) {
    clear(table.tBodies[0]).append(emptyRow(head.length, $("insurance-status").value === "attention" ? "Every company's insurance is current." : "No companies here."));
    return;
  }
  clear(table.tBodies[0]).append(...companies.map((c) => {
    const cert = c.certificate;
    const row = h("tr", { class: "clickable" },
      h("td", {}, h("strong", { text: c.companyName }), c.hasOffice ? null : h("span", { class: "muted small-text", text: " no office now" })),
      h("td", {}, coverBadge(c.status, cert)),
      h("td", { class: "nowrap small-text", text: cert ? dateText(cert.expiresOn) : "" }),
      h("td", { class: "small-text", text: cert?.insurer || "" }),
      h("td", { class: "small-text" }, certificateLink(cert) || (cert ? h("span", { class: "muted", text: "No copy" }) : "")));
    row.addEventListener("click", () => { location.hash = `#company/${c.companyId}`; });
    return row;
  }));
}

// --- a company's certificates ------------------------------------------------------------------------------

/** The Insurance panel on a company's page: its certificates, the one that runs latest first. */
function companyInsurancePanel(company) {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Insurance" }), skeletonLines());
  const refresh = () => panel.replaceWith(companyInsurancePanel(company));
  api(`/api/companies/${company.id}/insurance`).then(({ certificates }) => {
    const editor = canEditCharges();
    const open = async (cert) => { if (await editCertificate(company, cert)) refresh(); };
    const rows = certificates.map((c, i) => {
      // Older certificates stay as history, greyed.
      const row = h("tr", { class: [editor ? "clickable" : "", i > 0 ? "inactive" : ""].join(" ").trim() || null },
        h("td", {}, i > 0 && c.status === "expired" ? h("span", { class: "badge muted", text: "Replaced" }) : coverBadge(c.status, c)),
        h("td", { class: "nowrap", text: dateText(c.expiresOn) }),
        h("td", { text: c.insurer || "" }),
        h("td", { class: "small-text", text: c.coverage || "" }),
        h("td", { class: "small-text" }, certificateLink(c) || h("span", { class: "muted", text: "No copy" })));
      if (editor) row.addEventListener("click", () => open(c));
      return row;
    });
    panel.replaceChildren(
      h("div", { class: "panel-head" },
        h("div", {}, h("h3", { text: "Insurance" }), certificates.length ? null : coverBadge("none")),
        editor ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "primary small", text: "Add certificate", onclick: () => open(null) })) : null),
      rows.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "table compact phone-cards" },
          h("thead", {}, h("tr", {}, ["Status", "Expires", "Insurer", "Covers", "Copy"].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows)))
        : h("p", { class: "muted small-text", text: editor ? "No certificate of insurance on file. Add certificate keeps its expiration date and a copy." : "No certificate of insurance on file." }));
  }).catch((error) => panel.replaceChildren(h("h3", { text: "Insurance" }), h("p", { class: "message error", text: error.message })));
  return panel;
}

/** Adds a certificate (cert null) or changes one, with its copy. Resolves to the saved certificate, "deleted", or null. */
async function editCertificate(company, cert) {
  const fileInput = h("input", { type: "file", accept: "application/pdf,image/png,image/jpeg" });
  const removeBox = cert?.file ? h("input", { type: "checkbox" }) : null;
  const fileField = h("label", {},
    h("span", { text: cert?.file ? "Replace the copy" : "Copy of the certificate" }),
    fileInput,
    h("span", { class: "hint" }, cert?.file ? ["On file: ", certificateLink(cert), ` (${fileSizeText(cert.file.size)}).`] : "A PDF, or a PNG or JPEG scan, up to 3 MB."));
  const result = await formDialog({
    title: cert ? `${company.name}: certificate of insurance` : `Add ${company.name}'s certificate of insurance`,
    fields: [
      { name: "insurer", label: "Insurer", value: cert?.insurer || "", half: true, autofocus: true },
      { name: "coverage", label: "Covers (optional)", value: cert?.coverage || "", half: true, placeholder: "General liability $1M / $2M" },
      { name: "effectiveDate", label: "Cover starts", type: "date", value: cert?.effectiveDate || "", half: true },
      { name: "expiresOn", label: "Expires", type: "date", value: cert?.expiresOn || "", half: true, required: true, hint: "The earliest expiration of the policies on it." },
      { node: fileField },
      removeBox ? { node: h("label", { class: "check-row" }, removeBox, h("span", { text: "Remove the copy on file" })) } : null,
      { name: "notes", label: "Notes", type: "textarea", rows: 2, value: cert?.notes || "" }
    ].filter(Boolean),
    submitLabel: cert ? "Save" : "Add certificate",
    extraActions: cert ? [{ label: "Delete", kind: "danger", value: "delete" }] : [],
    onSubmit: async (v) => {
      const body = { insurer: v.insurer, coverage: v.coverage, effectiveDate: v.effectiveDate || null, expiresOn: v.expiresOn, notes: v.notes };
      const file = fileInput.files[0];
      if (file) {
        if (file.size > 3 * 1048576) throw new Error("That file is larger than 3 MB; save it smaller (a scan in black and white, or at a lower resolution).");
        body.file = { name: file.name, dataUrl: await fileDataUrl(file) };
      } else if (removeBox?.checked) {
        body.removeFile = true;
      }
      return (cert
        ? await api(`/api/insurance/${cert.id}`, { method: "PUT", body })
        : await api(`/api/companies/${company.id}/insurance`, { method: "POST", body })).certificate;
    }
  });
  if (result === "delete") {
    if (!(await confirmDialog(`Delete the certificate${cert.insurer ? ` from ${cert.insurer}` : ""} that expires ${dateText(cert.expiresOn)}, and its copy?`, { title: "Delete certificate", confirmLabel: "Delete", danger: true }))) return null;
    try {
      await api(`/api/insurance/${cert.id}`, { method: "DELETE" });
      toast("Certificate deleted.");
      return "deleted";
    } catch (error) {
      toast(error.message, "error");
      return null;
    }
  }
  if (result) toast(cert ? "Certificate saved." : "Certificate added.");
  return result;
}

// --- a company's tenant badges -------------------------------------------------------------------------------

const ALLOTMENT_WORDS = {
  desks: (e) => (e.note ? e.note : `${e.officeName || "An office"}: ${e.quantity} ${e.quantity === 1 ? "desk" : "desks"}`),
  paid: (e) => `Extra badge${e.badgeLabel ? ` ${e.badgeLabel}` : ""}${e.holderName ? ` for ${e.holderName}` : ""}${e.chargeId ? ", charged" : ""}`,
  lost: (e) => `Badge${e.badgeLabel ? ` ${e.badgeLabel}` : ""} lost${e.holderName ? ` by ${e.holderName}` : ""}`,
  adjust: (e) => e.note || "Adjusted"
};

/** The Tenant badges panel on a company's page: how many it may hold, why, and how many are out. */
function companyBadgeAllotmentPanel(company) {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Tenant badges" }), skeletonLines());
  const refresh = () => panel.replaceWith(companyBadgeAllotmentPanel(company));
  api(`/api/companies/${company.id}/badge-allotment`).then(({ allotment: a }) => {
    // Building staff wear personnel badges, which aren't counted.
    if (a.buildingStaff) {
      panel.remove();
      return;
    }
    const adjust = canEditCharges() ? h("button", { type: "button", class: "secondary small", text: "Adjust", onclick: async () => { if (await adjustAllotment(a)) refresh(); } }) : null;
    const head = h("div", { class: "panel-head" }, h("h3", { text: "Tenant badges" }), adjust ? h("div", { class: "btn-row" }, adjust) : null);
    if (!a.counted) {
      panel.replaceChildren(head, h("p", { class: "muted small-text", text: "Not counted yet. Set the desks on its offices (Facilities > Rooms) and each desk gives it a tenant badge; past those, each badge is charged. Until then its badges are given out without a charge." }));
      return;
    }
    const standing = a.over ? h("span", { class: "badge bad", text: `${a.over} over` }) : h("span", { class: `badge ${a.free ? "ok" : "warn"}`, text: a.free ? `${a.free} free to give` : "None free" });
    const parts = [[a.desks, "from desks"], [a.paid, "paid for"], [-a.lost, "lost"], [a.adjusted, "adjusted"]]
      .filter(([n], i) => n || i === 0).map(([n, w], i) => `${i > 0 && n > 0 ? "+" : ""}${n} ${w}`);
    const ledger = h("details", { class: "small-text" },
      h("summary", { text: "History" }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Date", "Badges", "Why", "By"].map((t) => h("th", { text: t })))),
        h("tbody", {}, a.entries.map((e) => h("tr", {},
          h("td", { class: "nowrap", text: fmtDate(e.createdAt) }),
          h("td", { class: "num", text: `${e.quantity > 0 ? "+" : ""}${e.quantity}` }),
          h("td", { text: ALLOTMENT_WORDS[e.kind] ? ALLOTMENT_WORDS[e.kind](e) : e.kind }),
          h("td", { class: "muted", text: e.createdBy || "" })))))));
    panel.replaceChildren(head,
      h("p", {}, h("strong", { text: `${a.held} of ${a.allowed}` }), ` tenant ${a.allowed === 1 ? "badge" : "badges"} out `, standing),
      h("p", { class: "muted small-text", text: `${parts.join(" · ")}. Past these, each tenant badge given is an extra one${a.price ? `, charged ${fmtMoney(a.price)}` : ""}; a badge handed back can go to anyone at the company without a charge.` }),
      ledger);
  }).catch((error) => panel.replaceChildren(h("h3", { text: "Tenant badges" }), h("p", { class: "message error", text: error.message })));
  return panel;
}

/** Adds badges to (or takes them from) what a company may hold, saying why. */
function adjustAllotment(a) {
  return formDialog({
    title: `Adjust ${a.companyName}'s tenant badges`,
    intro: h("p", { class: "muted", text: `${a.companyName} may hold ${a.allowed} tenant ${a.allowed === 1 ? "badge" : "badges"} and holds ${a.held}. Add badges it paid for before they were counted here, or take away ones counted by mistake.` }),
    fields: [
      { name: "quantity", label: "Badges to add (below zero to take away)", type: "number", step: "1", required: true, half: true, autofocus: true },
      { name: "note", label: "Why", required: true, placeholder: "Paid for before allotments were counted" }
    ],
    submitLabel: "Adjust",
    onSubmit: async (v) => (await api(`/api/companies/${a.companyId}/badge-allotment`, { method: "POST", body: { quantity: Number(v.quantity), note: v.note } })).allotment
  });
}

// 23-checkin.js: checking a visitor in at the desk, one step to a page as on the kiosk: find
// them (or add them), confirm who they are and who they visit, check their ID, then give them
// the visitor badge kept for them, or one whose number is typed in. Visitors who checked
// themselves in at a kiosk start at the ID step (or the badge step, once their ID is checked).

const CHECKIN_STEPS = [
  { key: "find", label: "Find" },
  { key: "details", label: "Confirm" },
  { key: "id", label: "ID" },
  { key: "badge", label: "Badge" }
];

const isTechnician = (v) => v?.visitorType === "Service Technician";

/**
 * Picks a visit's point of contact by name. Guests visit a tenant: someone there who can
 * host, whose company comes with them. A service technician's contact can be anyone in the
 * directory. With a site, only people there are offered; with none yet, anyone at the sites
 * the account sees, and onSite(siteId) is called with their company's site when there's only
 * one it can be. Returns { node, value() ({ companyId, hostId } or nulls), setType(type),
 * setSite(siteId) }; a new site keeps the contact if their company is there.
 */
function contactPicker({ type = "Guest", siteId = "", companyId = null, hostId = null, onSite = () => {} } = {}) {
  let mode = type === "Service Technician" ? "anyone" : "tenant";
  let site = siteId;
  let chosen = { companyId: companyId || null, hostId: hostId || null };
  // The sites (of those in use) of the chosen contact's company; null until looked up.
  let companySites = null;
  const search = h("input", { type: "search", autocomplete: "off", "aria-label": "Point of contact" });
  const hint = h("span", { class: "hint" });
  const note = h("p", { class: "message", hidden: true });
  const picked = h("div", { class: "chosen-row", hidden: true });
  const results = h("div", { class: "choices-list short", hidden: true });
  const card = h("div", { class: "contact-card", hidden: true });
  const node = h("div", { class: "full-row stack contact-picker" },
    h("label", { class: "full-row" }, h("span", { text: "Point of contact *" }), picked, search, hint), note, results, card);

  function describe() {
    search.placeholder = mode === "anyone" ? "Type a name from the directory" : "Type the name of the person they're visiting";
    hint.textContent = mode === "anyone"
      ? "Anyone in the directory: who asked for the work, or building management."
      : "Someone at a tenant who can host them; their company comes with them.";
  }

  /** The contact's details, as the caller's field access shows them. */
  function showCard(person) {
    const line = (label, value) => (value ? h("div", { class: "small-text" }, h("span", { class: "muted", text: `${label} ` }), value) : null);
    const phone = (n) => h("a", { href: `tel:${String(n).replace(/[^\d+]/g, "")}`, text: n });
    card.replaceChildren(...[
      h("div", {}, h("strong", { text: personName(person) }), person.jobTitle ? h("span", { class: "muted", text: `, ${person.jobTitle}` }) : null),
      line("Company", person.companyName),
      line("Work phone", person.workPhone ? phone(person.workPhone) : null),
      line("Mobile", person.mobile ? phone(person.mobile) : null),
      line("Email", person.email ? h("a", { href: `mailto:${person.email}`, text: person.email }) : null)
    ].filter(Boolean));
    card.hidden = false;
  }

  function reset(message = "") {
    chosen = { companyId: null, hostId: null };
    companySites = null;
    picked.hidden = true;
    card.hidden = true;
    search.hidden = false;
    search.value = "";
    results.hidden = true;
    note.textContent = message;
    note.hidden = !message;
  }

  async function sitesOf(id) {
    const { company } = await api(`/api/companies/${id}`).catch(() => ({ company: null }));
    const at = new Set((company?.sites || []).map((s) => String(s.siteId)));
    return activeSites().filter((s) => at.has(String(s.id))).map((s) => String(s.id));
  }

  async function choose(p) {
    chosen = { companyId: p.companyId, companyName: p.companyName || null, hostId: p.id, hostName: personName(p), canHost: p.canHost !== false };
    note.hidden = true;
    picked.replaceChildren(h("strong", { text: personName(p) }), h("span", { class: "muted", text: ` · ${p.companyName || ""}` }),
      h("button", { type: "button", class: "link-btn", text: "Change", onclick: () => { reset(); search.focus(); } }));
    picked.hidden = false;
    search.hidden = true;
    results.hidden = true;
    showCard(p);
    companySites = await sitesOf(p.companyId);
    // No site yet: theirs, when it can only be one.
    if (!site && chosen.hostId === p.id) {
      const one = companySites.length === 1 ? companySites[0] : companySites.includes(String(p.siteId)) ? String(p.siteId) : "";
      if (one) {
        site = one;
        onSite(one);
      }
    }
  }

  const run = debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) return (results.hidden = true);
    const { people } = await api(`/api/people?${new URLSearchParams({ q, limit: "10", ...(site ? { site: String(site) } : {}) })}`).catch(() => ({ people: [] }));
    if (search.value.trim() !== q) return null; // typed on meanwhile: a newer search is coming
    const offer = mode === "anyone" ? people : people.filter((p) => p.canHost !== false);
    results.replaceChildren(...(offer.length
      ? offer.map((p) => h("button", { type: "button", class: "pick-row", onclick: () => choose(p) }, h("strong", { text: personName(p) }),
        h("span", { class: "muted small-text", text: ` ${p.companyName || ""}${p.jobTitle ? ` · ${p.jobTitle}` : ""}` })))
      : [h("p", { class: "muted small-text", text: mode === "anyone" ? "Nobody in the directory by that name." : `Nobody by that name can host${site ? " at this site" : ""}.` })]));
    results.hidden = false;
    return null;
  }, 200);
  search.addEventListener("input", run);
  // Enter picks the first match rather than moving on.
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    results.querySelector(".pick-row")?.click();
  });

  describe();
  if (chosen.hostId) {
    api(`/api/people/${chosen.hostId}`).then(({ person }) => choose(person)).catch(() => reset());
  }
  return {
    node,
    value: () => ({ companyId: chosen.companyId, companyName: chosen.companyName ?? null, hostId: chosen.hostId, hostName: chosen.hostName ?? null }),
    setType: (t) => {
      const next = t === "Service Technician" ? "anyone" : "tenant";
      if (next === mode) return;
      mode = next;
      describe();
      // A guest's contact must be able to host.
      if (mode === "tenant" && chosen.hostId && chosen.canHost === false) reset(`${chosen.hostName} can't host guests; choose someone who can.`);
    },
    setSite: async (id) => {
      site = id;
      if (!chosen.hostId || !id) return;
      const name = chosen.hostName;
      const at = companySites ?? (await sitesOf(chosen.companyId));
      if (!at.includes(String(id))) reset(`${chosen.companyName || name}${chosen.companyName ? ` (${name})` : ""} isn't at ${siteName(id) || "that site"}; choose their point of contact there.`);
    }
  };
}

/**
 * Opens the check-in. start: { visitor } to begin at Confirm, with { event } for an expected
 * guest; { visit } for a visit already open (a kiosk arrival), at its ID or badge step; nothing
 * to search first. Resolves true when it changed anything.
 */
function checkInWizard(start = {}) {
  return new Promise((resolve) => {
    const usable = activeSites();
    const w = {
      visitor: start.visitor || null,
      visit: start.visit || null,
      event: start.event || null,
      siteId: String(start.visit?.siteId || start.event?.siteId || state.site || (usable.length === 1 ? usable[0].id : "")),
      companyId: start.visit?.companyId || start.event?.companyId || null,
      companyName: start.visit?.companyName || start.event?.companyName || null,
      hostId: start.visit?.hostId || start.event?.hostId || null,
      hostName: start.visit?.hostName || start.event?.hostName || null,
      purpose: start.visit?.purpose || start.event?.title || "",
      overrideBlock: false,
      changed: false
    };
    const stepper = h("ol", { class: "wizard-steps", "aria-label": "Check-in steps" });
    const body = h("div", { class: "wizard-body" });
    const error = h("p", { class: "message error pre", role: "alert", hidden: true });
    const footer = h("div", { class: "dialog-actions" });
    const dlg = h("dialog", { class: "dialog wide checkin-wizard" },
      h("div", { class: "dialog-head" }, h("span", { class: "sheet-grabber", "aria-hidden": "true" }), h("h3", { text: "Check in a visitor" }), h("button", { type: "button", class: "icon-close", "aria-label": "Close", onclick: () => finish() }, "×")),
      h("div", { class: "dialog-body" }, stepper, error, body),
      footer);
    let closed = false;
    function finish({ instant = false } = {}) {
      if (closed) return;
      closed = true;
      dismissDialog(dlg, { instant: instant === true });
      if (w.changed) {
        refreshCounts();
        loadBadgeAlerts();
        refreshCurrentView();
      }
      resolve(w.changed);
    }
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });

    const showError = (e) => {
      error.textContent = e ? e.message || String(e) : "";
      error.hidden = !e;
      if (e) dlg.querySelector(".dialog-body").scrollTop = 0;
    };
    /** A footer button that shows any error it throws and can't be pressed twice. */
    const btn = (label, kind, onClick) => {
      const b = h("button", { type: "button", class: kind, text: label });
      b.addEventListener("click", async () => {
        showError(null);
        b.disabled = true;
        try {
          await onClick();
        } catch (e) {
          showError(e);
        } finally {
          b.disabled = false;
        }
      });
      return b;
    };
    // The step shown last, so the next one slides in from the side the wizard is going.
    let shownAt = -1;
    function page(step, title, content, buttons) {
      const at = CHECKIN_STEPS.findIndex((s) => s.key === step);
      const dir = shownAt < 0 ? 0 : Math.sign(at - shownAt);
      shownAt = at;
      // Confirm and ID, once passed, can be gone back to until the badge is given.
      const back = { details: () => detailsStep(), id: () => idStep() };
      stepper.replaceChildren(...CHECKIN_STEPS.map((s, i) => {
        const label = i < at && back[s.key] && w.visitor && w.visit?.checkinStage !== "done"
          ? h("button", { type: "button", class: "wizard-step-link", title: `Back to ${s.label}`, onclick: back[s.key] }, s.label)
          : s.label;
        return h("li", { class: i < at ? "done" : i === at ? "current" : "", "aria-current": i === at ? "step" : null }, label);
      }));
      showError(null);
      body.replaceChildren(h("h4", { class: "wizard-title", text: title }), content);
      slideIn(body, dir);
      footer.replaceChildren(...buttons.filter(Boolean));
      dlg.querySelector(".dialog-body").scrollTop = 0;
      const first = body.querySelector("input:not([type=radio]):not([type=checkbox]):not([hidden]), select");
      if (first) setTimeout(() => first.focus(), 50);
    }
    const name = () => visitorName(w.visitor);
    const siteName = () => usable.find((s) => String(s.id) === String(w.siteId))?.name || "";

    // --- 1. find them, or add them -----------------------------------------------------------

    function findStep() {
      const results = h("div", { class: "choices-list" });
      const search = h("input", { type: "search", placeholder: "Type the visitor's name", autocomplete: "off", "aria-label": "Visitor's name" });
      const run = debounce(async () => {
        const q = search.value.trim();
        if (q.length < 2) return results.replaceChildren();
        try {
          const { visitors } = await api(`/api/visitors?${new URLSearchParams({ q, limit: "15" })}`);
          results.replaceChildren(...(visitors.length
            ? visitors.map((v) => h("button", { type: "button", class: "pick-row", onclick: () => pick(v.id) },
              h("strong", { text: visitorName(v) }), " ", visitorBadges(v),
              h("span", { class: "muted small-text", text: ` ${[v.organization, isTechnician(v) ? "Service Technician" : null, (v.companies || []).map((c) => c.companyName).join(", ")].filter(Boolean).join(" · ")}` })))
            : [h("p", { class: "muted", text: "Nobody by that name in the visitor list. Add them as a new visitor." })]));
        } catch (e) {
          showError(e);
        }
        return null;
      }, 250);
      search.addEventListener("input", run);
      page("find", "Who is checking in?", h("div", { class: "stack" },
        h("p", { class: "muted", text: "Find them in the visitor list. If they aren't on it, add them." }), search, results),
      [btn("Cancel", "secondary", finish), btn("Add a new visitor", "primary", () => newStep(search.value.trim()))]);
    }

    async function pick(id) {
      try {
        w.visitor = (await api(`/api/visitors/${id}`)).visitor;
        detailsStep();
      } catch (e) {
        showError(e);
      }
    }

    /** Fields for the visitor's company, type and citizenship; null where the caller can't change one. */
    function visitorFields(v) {
      const editable = (key) => visitorField(key)?.access === "edit";
      const org = editable("organization") ? h("input", { type: "text", value: v?.organization || "", maxlength: "120", "aria-label": "Company" }) : null;
      const type = editable("visitorType") ? h("select", { "aria-label": "Visitor type" }, ["Guest", "Service Technician"].map((t) => h("option", { value: t, text: t }))) : null;
      if (type) type.value = v?.visitorType || "Guest";
      const citizen = editable("citizenship") ? citizenshipControl(v?.citizenship || null, { required: true }) : null;
      return { org, type, citizen };
    }

    function newStep(typed) {
      const words = typed.split(/\s+/).filter(Boolean);
      const first = h("input", { type: "text", value: words[0] || "", maxlength: "80", autocapitalize: "words", "aria-label": "First name" });
      const last = h("input", { type: "text", value: words.slice(1).join(" "), maxlength: "80", autocapitalize: "words", "aria-label": "Last name" });
      const f = visitorFields(null);
      const site = siteChooser();
      const contact = contactPicker({ type: "Guest", siteId: w.siteId, onSite: (id) => { w.siteId = id; if (site) site.value = id; } });
      if (f.type) f.type.addEventListener("change", () => contact.setType(f.type.value));
      if (site) site.addEventListener("change", () => { w.siteId = site.value; contact.setSite(site.value); });
      page("find", "Add a new visitor", h("div", { class: "form-grid stack" },
        h("label", { class: "half" }, h("span", { text: "First name *" }), first),
        h("label", { class: "half" }, h("span", { text: "Last name *" }), last),
        f.org ? h("label", { class: "half" }, h("span", { text: "Company *" }), f.org) : null,
        f.type ? h("label", { class: "half" }, h("span", { text: "Visitor type" }), f.type, h("span", { class: "hint", text: "A service technician comes to do work or maintenance, not tied to a tenant." })) : null,
        f.citizen ? f.citizen.node : null,
        h("h4", { class: "form-heading", text: "Who they're visiting" }),
        site ? h("label", { class: "half" }, h("span", { text: "Site" }), site) : null,
        contact.node),
      [btn("Back", "secondary", findStep), btn("Add and continue", "primary", async () => {
        if (!first.value.trim() || !last.value.trim()) throw new Error("Enter their first and last name.");
        if (f.org && !f.org.value.trim()) throw new Error("Enter their company.");
        const problem = f.citizen?.check();
        if (problem) throw new Error(problem);
        if (!w.siteId) throw new Error("Choose the site.");
        const c = contact.value();
        if (!c.hostId) throw new Error("Choose their point of contact.");
        const body = { firstName: first.value.trim(), lastName: last.value.trim() };
        if (f.org) body.organization = f.org.value.trim();
        if (f.type) body.visitorType = f.type.value;
        if (f.citizen) body.citizenship = f.citizen.value();
        if (canEditVisitorLinks() && (!f.type || f.type.value === "Guest")) body.links = [{ companyId: c.companyId, hostId: c.hostId }];
        w.visitor = (await api("/api/visitors", { method: "POST", body })).visitor;
        w.changed = true;
        Object.assign(w, c);
        detailsStep();
      })]);
    }

    /** A site picker when the desk sees more than one site and none is fixed yet; else null. */
    function siteChooser() {
      if (w.visit || w.event || usable.length < 2) return null;
      const select = h("select", { "aria-label": "Site" }, h("option", { value: "", text: "Choose the site" }), usable.map((s) => h("option", { value: String(s.id), text: s.name })));
      select.value = w.siteId;
      return select;
    }

    // --- 2. confirm who they are and who they visit ----------------------------------------------

    function detailsStep() {
      const v = w.visitor;
      const f = visitorFields(v);
      const site = siteChooser();
      // Who they usually visit here, when nothing says otherwise.
      if (!w.hostId && !w.event && !w.visit) {
        const usual = (v.companies || []).find((c) => c.hostId);
        if (usual) Object.assign(w, { companyId: usual.companyId, companyName: usual.companyName, hostId: usual.hostId, hostName: usual.hostName });
      }
      const contact = contactPicker({ type: f.type ? f.type.value : v.visitorType, siteId: w.siteId, companyId: w.companyId, hostId: w.hostId, onSite: (id) => { w.siteId = id; if (site) site.value = id; } });
      if (f.type) f.type.addEventListener("change", () => contact.setType(f.type.value));
      if (site) site.addEventListener("change", () => { w.siteId = site.value; contact.setSite(site.value); });
      const purpose = h("input", { type: "text", value: w.purpose, maxlength: "200", placeholder: "Meeting, interview, repair…", "aria-label": "Purpose of the visit" });
      const override = h("input", { type: "checkbox" });
      override.checked = w.overrideBlock;
      const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", { text: value })] : null);
      page("details", `Confirm ${name()}'s details`, h("div", { class: "form-grid stack" },
        v.blocked ? h("div", { class: "full-row message error" }, h("strong", { text: `${name()} is blocked.` }), " Only let them in if a manager has agreed. ",
          !w.visit ? h("label", { class: "check-row" }, override, h("span", { text: "A manager has agreed to let them in" })) : null) : null,
        w.visit ? h("p", { class: "full-row muted", text: `Checked in at ${w.visit.kioskName || "the kiosk"} ${agoText(w.visit.checkedInAt)}.` }) : null,
        h("dl", { class: "full-row facts inline-facts" }, fact("Name", name()),
          !f.org ? fact("Company", v.organization) : null, !f.type ? fact("Visitor type", v.visitorType) : null, !f.citizen ? fact("Citizenship", citizenshipText(v.citizenship)) : null),
        f.org ? h("label", { class: "half" }, h("span", { text: "Company *" }), f.org) : null,
        f.type ? h("label", { class: "half" }, h("span", { text: "Visitor type" }), f.type) : null,
        f.citizen ? f.citizen.node : null,
        h("h4", { class: "form-heading", text: "Their visit" }),
        site ? h("label", { class: "half" }, h("span", { text: "Site" }), site) : null,
        contact.node,
        h("label", { class: "full-row" }, h("span", { text: "Purpose of the visit *" }), purpose)),
      [w.visit ? btn("Close", "secondary", finish) : btn("Back", "secondary", findStep), btn("Confirm", "primary", async () => {
        const changes = {};
        if (f.org) {
          if (!f.org.value.trim()) throw new Error("Enter their company.");
          if (f.org.value.trim() !== (v.organization || "")) changes.organization = f.org.value.trim();
        } else if (!v.organization) throw new Error(`${name()}'s company isn't on record, and this account can't fill it in.`);
        if (f.type && f.type.value !== v.visitorType) changes.visitorType = f.type.value;
        if (f.citizen) {
          const problem = f.citizen.check();
          if (problem) throw new Error(problem);
          if (f.citizen.value() !== (v.citizenship || null)) changes.citizenship = f.citizen.value();
        } else if (!v.citizenship) throw new Error(`${name()}'s citizenship isn't on record, and this account can't fill it in.`);
        if (!w.siteId) throw new Error("Choose the site.");
        const c = contact.value();
        if (!c.hostId) throw new Error("Choose their point of contact.");
        if (!purpose.value.trim()) throw new Error("Enter the purpose of the visit.");
        if (v.blocked && !w.visit && !override.checked) throw new Error(`${name()} is blocked. Tick the box once a manager has agreed.`);
        if (Object.keys(changes).length) {
          w.visitor = (await api(`/api/visitors/${v.id}`, { method: "PUT", body: changes })).visitor;
          w.changed = true;
        }
        Object.assign(w, c);
        w.purpose = purpose.value.trim();
        w.overrideBlock = override.checked;
        idStep();
      })]);
    }

    // --- 3. check their ID ---------------------------------------------------------------------

    function idStep() {
      const v = w.visitor;
      const idName = `id-${Math.random().toString(36).slice(2, 8)}`;
      // An Other government ID: what it was, in a box shown only for that choice.
      const otherId = state.config.checkin?.otherId;
      const otherText = h("input", { type: "text", maxlength: "80", value: w.visit?.idOther || "", placeholder: "Military ID, tribal ID, ...", "aria-label": "What ID was it?" });
      const otherBox = h("label", { class: "id-other", hidden: w.visit?.idType !== otherId }, h("span", { class: "label", text: "What ID was it?" }), otherText);
      const types = (state.config.checkin?.idTypes || []).map((t) => {
        const input = h("input", { type: "radio", name: idName, value: t });
        // Back here from the badge step: the ID recorded, to keep or change.
        input.checked = w.visit?.idType === t;
        input.addEventListener("change", () => {
          otherBox.hidden = t !== otherId;
          if (t === otherId) otherText.focus();
        });
        return h("label", { class: "id-choice" }, input, h("span", { text: t }));
      });
      const match = h("input", { type: "checkbox" });
      const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", { text: value })] : null);
      page("id", `Check ${name()}'s ID`, h("div", { class: "stack" },
        h("p", { class: "muted", text: "Ask for a driver's license or a government-issued ID (a passport, CAC or state ID), and check the name and photo against the person in front of you." }),
        h("div", { class: "id-person" },
          h("div", { class: "id-name", text: name() }),
          h("dl", { class: "facts inline-facts" },
            fact("Company", v.organization), fact("Visitor type", v.visitorType), fact("Citizenship", citizenshipText(v.citizenship)),
            fact("Visiting", w.companyName), fact("Point of contact", w.hostName),
            fact("Purpose", w.purpose), multiSite() ? fact("Site", siteName()) : null),
          h("button", { type: "button", class: "link-btn small-text", text: "Change these details", onclick: detailsStep })),
        h("fieldset", { class: "id-types" }, h("legend", { text: "Which ID did they show?" }), types),
        otherBox,
        h("label", { class: "check-row id-match" }, match, h("span", { text: `The name and photo on the ID match ${name()}` }))),
      [btn("Back", "secondary", detailsStep), btn("ID confirmed", "primary", async () => {
        const idType = body.querySelector(`input[name=${idName}]:checked`)?.value;
        if (!idType) throw new Error("Choose the ID they showed.");
        const idOther = idType === otherId ? otherText.value.trim() : null;
        if (idType === otherId && !idOther) {
          otherText.focus();
          throw new Error("Say what the other government ID was.");
        }
        if (!match.checked) throw new Error(`Tick the box once the ID matches ${name()}. If it doesn't, don't check them in.`);
        const visit = { hostId: w.hostId, companyId: w.companyId, purpose: w.purpose };
        // A visit under way (from a kiosk, or back here from the badge step): checked on that visit.
        if (w.visit && ["id", "badge"].includes(w.visit.checkinStage)) {
          w.visit = (await api(`/api/visits/${w.visit.id}/verify-id`, { method: "POST", body: { idType, idOther, ...visit } })).visit;
        } else {
          const r = await api("/api/checkins", { method: "POST", body: { visitorId: v.id, siteId: Number(w.siteId), idType, idOther, overrideBlock: w.overrideBlock, ...visit } });
          w.visit = r.visit;
          // Already in the building (from a kiosk, say): their ID is checked on that visit.
          if (r.already && w.visit.checkinStage === "id") w.visit = (await api(`/api/visits/${w.visit.id}/verify-id`, { method: "POST", body: { idType, idOther, ...visit } })).visit;
        }
        w.changed = true;
        if (w.visit.checkinStage !== "badge") return doneStep(`${name()} was checked in already.`);
        if (!canGiveBadges()) return doneStep(`${name()} is checked in. Someone who gives badges out gives them their visitor badge.`);
        return badgeStep();
      })]);
    }

    // --- 4. their badge ----------------------------------------------------------------------------

    async function badgeStep() {
      page("badge", `${name()}'s visitor badge`, h("p", { class: "muted", text: "Loading…" }), [btn("Close", "secondary", finish)]);
      let plan;
      let v = w.visitor;
      try {
        [plan, { visitor: v }] = await Promise.all([api(`/api/visits/${w.visit.id}/badge-plan`), api(`/api/visitors/${w.visitor.id}`)]);
        w.visitor = v;
      } catch (e) {
        showError(e);
        return;
      }
      const give = async (payload) => {
        const r = await api(`/api/visits/${w.visit.id}/badge`, { method: "POST", body: payload });
        w.changed = true;
        doneStep(r.already ? `${name()} has badge ${r.badge.label}. Their check-in is done.` : `${name()} is checked in with badge ${r.badge.label}.`);
      };
      const content = h("div", { class: "stack" });
      const a = plan.assigned;
      const why = { event: `Picked for ${a?.eventTitle || "the event they're expected at"}.`, reserved: "Reserved for them." };

      // The number typed in, checked against the badges: a visitor badge, valid here, they may hold.
      // The facility code is needed only when the number is under more than one; the server says so.
      const code = h("input", { type: "text", autocomplete: "off", inputmode: "numeric", maxlength: "3", class: "mono badge-code-input", placeholder: "Facility code", "aria-label": "Facility code (optional)" });
      const number = h("input", { type: "text", autocomplete: "off", spellcheck: "false", class: "mono badge-number-input", placeholder: "Badge number", "aria-label": "Badge number" });
      const issue = btn("Issue badge", "primary", async () => {
        if (!number.value.trim()) throw new Error("Enter the number on the badge.");
        await give({ number: number.value.trim(), facilityCode: code.value.trim() || undefined });
      });
      for (const input of [code, number]) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); issue.click(); } });
      const kinds = [...new Set(plan.available.map((b) => badgeLevelText(b)).filter(Boolean))];
      const free = h("div", { class: "free-badges", hidden: true }, plan.available.map((b) => h("button", { type: "button", class: "chip mono", text: b.label, onclick: () => { code.value = b.facilityCode || ""; number.value = b.number; number.focus(); } })));
      const entry = h("div", { class: "stack badge-entry" },
        h("div", { class: "badge-give" }, suggestedBadge(plan.suggested),
          h("div", { class: "stack" },
            plan.uncleared ? h("p", { class: "message warn", text: `${name()}'s clearance hasn't been validated, so give them an uncleared visitor badge.` }) : null,
            h("p", {}, plan.available.length
              ? [`Give them ${plan.uncleared ? "an uncleared" : "a"} visitor badge${!plan.uncleared && kinds.length ? ` (${kinds.join(" or ")})` : ""}, and enter its number.`, h("span", { class: "muted small-text", text: ` ${plan.available.length} free${multiSite() ? ` at ${plan.visit.siteName}` : ""}.` })]
              : h("span", { class: "message error", text: `No ${plan.uncleared ? "uncleared " : ""}visitor badge is free${multiSite() ? ` at ${plan.visit.siteName}` : ""} that ${name()} may hold.` })),
            h("div", { class: "btn-row" }, code, number, issue),
            plan.available.length ? h("button", { type: "button", class: "link-btn small-text", text: "Show the free badges", onclick: (e) => { free.hidden = !free.hidden; e.target.textContent = free.hidden ? "Show the free badges" : "Hide the free badges"; } }) : null,
            free)));

      if (a && !a.problem) {
        const handed = btn(a.heldByThem ? "Confirm they have it" : `Badge ${a.label} handed over`, "primary", () => give({ badgeId: a.id }));
        content.append(h("div", { class: "badge-assigned" },
          templateImg(a.template, { large: true, alt: `Badge ${a.label}` }),
          h("div", { class: "stack" },
            h("p", { class: "badge-assigned-label", text: a.heldByThem ? "They already have their badge" : "Give them badge" }),
            h("p", { class: "badge-assigned-number mono", text: a.label }),
            h("p", { class: "muted small-text", text: why[a.source] || "" }),
            h("div", { class: "btn-row" }, handed))));
        const other = h("button", { type: "button", class: "link-btn", text: "Can't find it? Issue a different badge", onclick: () => { entry.hidden = false; other.hidden = true; number.focus(); } });
        entry.hidden = true;
        content.append(other, entry);
      } else {
        if (a?.problem) content.append(h("p", { class: "message warn", text: `Badge ${a.label} was kept for them (${why[a.source].replace(/\.$/, "").toLowerCase()}), but it can't be given: ${a.problem} Issue another.` }));
        if (plan.holding.length) {
          const held = plan.holding[0];
          content.append(h("div", { class: "badge-assigned compact" },
            h("p", {}, "They still have badge ", h("strong", { class: "mono", text: held.label }), " from before."),
            h("div", { class: "btn-row" }, btn("Confirm they have it", "secondary", () => give({ badgeId: held.id })))));
        }
        content.append(entry);
      }

      // Their clearance: asking Security to validate it, right here.
      if (v.clearanceStatus !== undefined && canAskValidation("visitor")) {
        if (["unvalidated", "recheck"].includes(v.clearanceStatus)) {
          content.append(h("div", { class: "clearance-ask" },
            h("span", { text: v.clearanceStatus === "recheck" ? "Their clearance is due to be validated again." : "Their clearance hasn't been validated." }),
            h("button", { type: "button", class: "secondary small", text: "Request clearance validation", onclick: async () => { if (await requestValidation("visitor", v)) badgeStep(); } })));
        } else if (v.clearanceStatus === "requested") {
          content.append(h("p", { class: "muted small-text", text: "Clearance validation requested; waiting for the Security role." }));
        }
      }
      page("badge", `${name()}'s visitor badge`, content, [
        btn("Back", "secondary", idStep),
        btn("Close", "secondary", finish),
        btn("No badge needed", "secondary", async () => {
          if (!(await confirmDialog(`${name()} doesn't need a badge for this visit (escorted, say)?`, { title: "No badge needed", confirmLabel: "No badge needed" }))) return;
          await api(`/api/visits/${w.visit.id}/badge-not-needed`, { method: "POST" });
          w.changed = true;
          doneStep(`${name()} is checked in, without a badge.`);
        })
      ]);
      if (!entry.hidden) setTimeout(() => number.focus(), 50);
    }

    function doneStep(text) {
      // Finished: no going back a step any more.
      if (w.visit) w.visit = { ...w.visit, checkinStage: "done" };
      page("badge", "Done", h("div", { class: "checkin-done" },
        h("div", { class: "tick", "aria-hidden": "true" }, "✓"),
        h("p", { text })),
      [btn("Check in someone else", "secondary", () => {
        Object.assign(w, { visitor: null, visit: null, event: null, companyId: null, companyName: null, hostId: null, hostName: null, purpose: "", overrideBlock: false });
        findStep();
      }), btn("Close", "primary", finish)]);
      stepper.querySelectorAll("li").forEach((li) => { li.className = "done"; });
    }

    document.body.append(dlg);
    dlg.showModal();
    sheetGesture(dlg, () => finish({ instant: true }));
    (async () => {
      try {
        if (w.visit) {
          w.visitor = (await api(`/api/visitors/${w.visit.visitorId}`)).visitor;
          if (w.visit.checkinStage === "badge") return badgeStep();
          // A kiosk arrival: straight to their ID, unless something check-in needs is missing.
          const missing = !w.visitor.organization || !w.visitor.citizenship || !w.visit.hostId || !w.visit.purpose;
          return missing ? detailsStep() : idStep();
        }
        if (w.visitor) return detailsStep();
        return findStep();
      } catch (e) {
        findStep();
        showError(e);
        return null;
      }
    })();
  });
}

/** Opens the check-in for a visit already under way (from the banner or the dashboard). */
async function continueCheckIn(visitId) {
  try {
    const { visit } = await api(`/api/visits/${visitId}`);
    return checkInWizard({ visit });
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

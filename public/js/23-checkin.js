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
 * Picks a visit's points of contact by name: anyone in the directory, at any site, whose company
 * comes with them (a tenant may use a room at another site); after the first, more people of
 * that company can be added. Someone not assigned to the visit's site gets a warning, and can
 * still be chosen. With no site chosen yet, onSite(siteId) is called with the first contact's
 * company's site when there's only one it can be. hostIds: those to start with, loaded as the
 * picker opens; until they are, value() answers with them and `initial` ({ companyId,
 * companyName, hostName }). Returns { node, value() ({ companyId, companyName, hostId (the
 * first), hostIds, hostName (all their names) }, nulls and [] with no one), setSite(siteId) };
 * a new site keeps the contacts.
 */
function contactPicker({ siteId = "", hostIds = [], initial = {}, onSite = () => {} } = {}) {
  let site = siteId;
  let people = []; // those picked, as /api/contacts gives them, in the order picked
  let loading = hostIds.length > 0;
  const company = () => (people.length ? { id: people[0].companyId, name: people[0].companyName || null } : null);
  const search = h("input", { type: "search", autocomplete: "off", "aria-label": "Point of contact" });
  const hint = h("span", { class: "hint" });
  const note = h("p", { class: "message warn", role: "status", hidden: true });
  const cards = h("div", { class: "contact-cards", hidden: true });
  const results = h("div", { class: "choices-list short", hidden: true });
  const title = h("span", { text: "Point of contact *" });
  const node = h("div", { class: "full-row stack contact-picker" },
    h("label", { class: "full-row" }, title, cards, search, hint), note, results);

  /** A contact's details, as the caller's field access shows them, with a way to take them off. */
  function card(person) {
    const line = (label, value) => (value ? h("div", { class: "small-text" }, h("span", { class: "muted", text: `${label} ` }), value) : null);
    const phone = (n) => h("a", { href: `tel:${String(n).replace(/[^\d+]/g, "")}`, text: n });
    return h("div", { class: "contact-card" }, ...[
      h("div", { class: "row-between" },
        h("span", {}, h("strong", { text: personName(person) }), person.jobTitle ? h("span", { class: "muted", text: `, ${person.jobTitle}` }) : null),
        h("button", { type: "button", class: "link-btn", text: "Remove", "aria-label": `Remove ${personName(person)}`, onclick: (e) => { e.preventDefault(); remove(person.id); } })),
      line("Company", person.companyName),
      line("Work phone", person.workPhone ? phone(person.workPhone) : null),
      line("Mobile", person.mobile ? phone(person.mobile) : null),
      line("Email", person.email ? h("a", { href: `mailto:${person.email}`, text: person.email }) : null)
    ].filter(Boolean));
  }

  /** Warns, without stopping anyone, when a contact isn't assigned to the visit's site. */
  function warnOfSite() {
    const away = site ? people.filter((p) => p.assignedSiteIds && !p.assignedSiteIds.includes(Number(site))).map((p) => personName(p)) : [];
    note.textContent = away.length ? `${away.join(" and ")} ${away.length > 1 ? "aren't" : "isn't"} assigned to ${siteName(site) || "this site"}. You can still make them ${away.length > 1 ? "points" : "the point"} of contact.` : "";
    note.hidden = !away.length;
  }

  function render() {
    cards.replaceChildren(...people.map(card));
    cards.hidden = !people.length;
    title.textContent = people.length > 1 ? "Points of contact *" : "Point of contact *";
    const at = company();
    search.placeholder = at ? `Add another from ${at.name || "their company"}` : "Type a name from the directory";
    hint.textContent = at
      ? `Anyone else at ${at.name || "their company"} they're visiting. Remove them all to choose someone elsewhere.`
      : "Anyone in the directory, at any site; their company comes with them. More of its people can be added after.";
    results.hidden = true;
    warnOfSite();
  }

  function remove(id) {
    people = people.filter((p) => p.id !== id);
    render();
    search.focus();
  }

  async function sitesOf(id) {
    const { company: found } = await api(`/api/companies/${id}`).catch(() => ({ company: null }));
    const at = new Set((found?.sites || []).map((s) => String(s.siteId)));
    return activeSites().filter((s) => at.has(String(s.id))).map((s) => String(s.id));
  }

  async function choose(p) {
    const at = company();
    if (people.some((x) => x.id === p.id) || (at && at.id !== p.companyId)) return;
    people.push(p);
    search.value = "";
    render();
    // No site yet: the first contact's, when it can only be one.
    if (site || people.length > 1) return;
    const companySites = await sitesOf(p.companyId);
    if (!site && people[0]?.id === p.id) {
      const one = companySites.length === 1 ? companySites[0] : companySites.includes(String(p.siteId)) ? String(p.siteId) : "";
      if (one) {
        site = one;
        onSite(one);
        warnOfSite();
      }
    }
  }

  const run = debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) return (results.hidden = true);
    const { people: found } = await api(`/api/contacts?${new URLSearchParams({ q })}`).catch(() => ({ people: [] }));
    if (search.value.trim() !== q) return null; // typed on meanwhile: a newer search is coming
    // After the first, only people of the same company, and not those picked already.
    const at = company();
    const list = found.filter((p) => !people.some((x) => x.id === p.id) && (!at || p.companyId === at.id));
    results.replaceChildren(...(list.length
      ? list.map((p) => h("button", { type: "button", class: "pick-row", onclick: () => choose(p) }, h("strong", { text: personName(p) }),
        h("span", { class: "muted small-text", text: ` ${p.companyName || ""}${p.jobTitle ? ` · ${p.jobTitle}` : ""}` })))
      : [h("p", { class: "muted small-text", text: at ? `Nobody else by that name at ${at.name || "their company"}.` : "Nobody in the directory by that name." })]));
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

  render();
  // Those to start with, in their order; one who is no longer in the directory is left out.
  (async () => {
    for (const id of hostIds) {
      const { person } = await api(`/api/contacts/${id}`).catch(() => ({ person: null }));
      if (person) await choose(person);
    }
    loading = false;
  })();
  return {
    node,
    value: () => (loading
      ? { companyId: initial.companyId ?? null, companyName: initial.companyName ?? null, hostId: hostIds[0], hostIds: [...hostIds], hostName: initial.hostName ?? null }
      : { companyId: company()?.id ?? null, companyName: company()?.name ?? null, hostId: people[0]?.id ?? null, hostIds: people.map((p) => p.id), hostName: people.map((p) => personName(p)).join(", ") || null }),
    setSite: (id) => {
      site = id;
      warnOfSite();
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
      // The points of contact: the visit's, or the event's (all of them), the first being hostId.
      hostId: start.visit?.hostId || start.event?.hostId || null,
      hostIds: start.visit ? start.visit.hostIds || [start.visit.hostId].filter(Boolean) : (start.event?.hosts || []).map((p) => p.id),
      hostName: start.visit?.hostName || (start.event?.hosts || []).map((p) => p.name).join(", ") || null,
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
      const back = { details: () => detailsStep({ editing: true }), id: () => idStep() };
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
    /**
     * Cancel check-in, on every step. Before anything is on record it just closes. Once their
     * visit has begun (a kiosk arrival, or past the ID step) and until it is finished, the visit
     * is taken off the record, once the desk says so.
     */
    const cancelBtn = () => {
      const b = btn("Cancel check-in", "link-btn danger-text cancel-checkin", async () => {
        if (!w.visit || !["id", "badge"].includes(w.visit.checkinStage)) return finish();
        const reason = h("input", { type: "text", maxlength: "300", placeholder: "Wrong person, no ID with them, changed their mind…", "aria-label": "Reason (optional)" });
        const ok = await openDialog({
          title: `Cancel ${name()}'s check-in?`,
          body: h("div", { class: "stack" },
            h("p", { text: `${w.visit.kioskId ? `${w.visitor.firstName} checked in at ${w.visit.kioskName || "a kiosk"}. ` : ""}They won't be shown as in the building, and this visit is taken off the visit log. The audit log keeps that it was canceled, and by whom.` }),
            h("label", {}, h("span", { text: "Reason (optional)" }), reason)),
          actions: [{ label: "Cancel the check-in", kind: "danger", value: true }, { label: "Keep checking in", kind: "primary", value: false }]
        });
        if (!ok) return null;
        await api(`/api/visits/${w.visit.id}/cancel-checkin`, { method: "POST", body: { reason: reason.value } });
        w.changed = true;
        toast(`${name()}'s check-in canceled.`);
        return finish();
      });
      return b;
    };
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
      [cancelBtn(), btn("Add a new visitor", "primary", () => newStep(search.value.trim()))]);
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
      const contact = contactPicker({ siteId: w.siteId, onSite: (id) => { w.siteId = id; if (site) site.value = id; } });
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
      [cancelBtn(), btn("Back", "secondary", findStep), btn("Add and continue", "primary", async () => {
        if (!first.value.trim() || !last.value.trim()) throw new Error("Enter their first and last name.");
        if (f.org && !f.org.value.trim()) throw new Error("Enter their company.");
        const problem = f.citizen?.check();
        if (problem) throw new Error(problem);
        if (!w.siteId) throw new Error("Choose the site.");
        const c = contact.value();
        if (!c.hostId) throw new Error("Choose their point of contact.");
        const body = { firstName: first.value.trim(), lastName: last.value.trim(), siteId: Number(w.siteId) };
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
    //
    // What is on record is shown to read, not as boxes to fill in: only what check-in still needs
    // (their company, their citizenship, the site, a point of contact, the purpose) is asked for,
    // at the top. Edit opens all of it to change.

    function detailsStep({ editing = false } = {}) {
      const v = w.visitor;
      // Who they usually visit here, when nothing says otherwise.
      if (!w.hostId && !w.event && !w.visit) {
        const usual = (v.companies || []).find((c) => c.hostId);
        if (usual) Object.assign(w, { companyId: usual.companyId, companyName: usual.companyName, hostId: usual.hostId, hostIds: [usual.hostId], hostName: usual.hostName });
      }
      // What was typed here before Edit was pressed stays typed.
      const f = visitorFields({ ...v, ...(w.draft || {}) });
      const known = { org: Boolean(v.organization), citizen: Boolean(v.citizenship), site: Boolean(w.siteId), contact: w.hostIds.length > 0, purpose: Boolean(w.purpose) };
      // Asked for: everything when editing, else only what is missing.
      const ask = (key) => editing || !known[key];
      const org = ask("org") ? f.org : null;
      const type = editing ? f.type : null;
      const citizen = ask("citizen") ? f.citizen : null;
      const site = ask("site") ? siteChooser() : null;
      const contact = ask("contact") ? contactPicker({ siteId: w.siteId, hostIds: w.hostIds, initial: { companyId: w.companyId, companyName: w.companyName, hostName: w.hostName }, onSite: (id) => { w.siteId = id; if (site) site.value = id; } }) : null;
      if (site) site.addEventListener("change", () => { w.siteId = site.value; contact?.setSite(site.value); });
      const purpose = ask("purpose") ? h("input", { type: "text", value: w.purpose, maxlength: "200", placeholder: "Meeting, interview, repair…", "aria-label": "Purpose of the visit" }) : null;
      const override = h("input", { type: "checkbox" });
      override.checked = w.overrideBlock;
      const fact = (label, value) => (value ? [h("dt", { text: label }), h("dd", { text: value })] : null);
      // Missing, and not this account's to fill in.
      const stuck = [!known.org && !f.org ? `${name()}'s company isn't on record, and this account can't fill it in.` : null,
        !known.citizen && !f.citizen ? `${name()}'s citizenship isn't on record, and this account can't fill it in.` : null].filter(Boolean);

      /** Keeps what is typed, for the step drawn again (Edit). */
      const stash = () => {
        w.draft = { ...(f.org ? { organization: f.org.value.trim() } : {}), ...(f.type ? { visitorType: f.type.value } : {}), ...(f.citizen ? { citizenship: f.citizen.value() } : {}) };
        if (purpose) w.purpose = purpose.value.trim();
        if (contact) Object.assign(w, contact.value());
        w.overrideBlock = override.checked;
      };

      const alerts = [
        v.blocked ? h("div", { class: "full-row message error" }, h("strong", { text: `${name()} is blocked.` }), " Only let them in if a manager has agreed. ",
          !w.visit ? h("label", { class: "check-row" }, override, h("span", { text: "A manager has agreed to let them in" })) : null) : null,
        w.visit ? h("p", { class: "full-row muted", text: `Checked in at ${w.visit.kioskName || "the kiosk"} ${agoText(w.visit.checkedInAt)}.` }) : null
      ];
      const orgBox = org ? h("label", { class: "half" }, h("span", { text: "Company *" }), org) : null;
      const siteBox = site ? h("label", { class: "half" }, h("span", { text: "Site *" }), site) : null;
      const purposeBox = purpose ? h("label", { class: "full-row" }, h("span", { text: "Purpose of the visit *" }), purpose) : null;

      let content;
      if (editing) {
        content = h("div", { class: "form-grid stack" }, alerts,
          h("dl", { class: "full-row facts inline-facts" }, fact("Name", name()),
            !f.org ? fact("Company", v.organization) : null, !f.type ? fact("Visitor type", v.visitorType) : null, !f.citizen ? fact("Citizenship", citizenshipText(v.citizenship)) : null),
          orgBox,
          type ? h("label", { class: "half" }, h("span", { text: "Visitor type" }), type) : null,
          citizen ? citizen.node : null,
          h("h4", { class: "form-heading", text: "Their visit" }),
          siteBox, contact.node, purposeBox);
      } else {
        // Their points of contact, to read: names at once, then how to reach each (to say who has arrived).
        const poc = h("dd", { text: w.hostName || "" });
        if (known.contact) {
          Promise.all(w.hostIds.map((id) => api(`/api/contacts/${id}`).then((r) => r.person).catch(() => null))).then((people) => {
            const found = people.filter(Boolean);
            if (!found.length) return;
            const phone = (n) => h("a", { href: `tel:${String(n).replace(/[^\d+]/g, "")}`, text: n });
            poc.replaceChildren(...found.map((p) => h("div", {}, h("span", { text: personName(p) }), [p.workPhone, p.mobile].filter(Boolean).flatMap((n) => [h("span", { class: "muted", text: " · " }), phone(n)]))));
          });
        }
        const needed = [orgBox, citizen ? citizen.node : null, siteBox, contact ? contact.node : null, purposeBox].filter(Boolean);
        content = h("div", { class: "form-grid stack" }, alerts,
          needed.length || stuck.length ? h("div", { class: "full-row checkin-needed", role: "group", "aria-label": "Needed to check them in" },
            h("h4", { class: "checkin-needed-title", text: needed.length + stuck.length === 1 ? "One thing is needed to check them in" : "Needed to check them in" }),
            stuck.map((text) => h("p", { class: "message error", text })),
            needed.length ? h("div", { class: "form-grid stack" }, needed) : null) : null,
          h("div", { class: "full-row checkin-summary" },
            h("div", { class: "row-between" }, h("h4", { text: needed.length || stuck.length ? "On record" : "Check these are right" }),
              h("button", { type: "button", class: "secondary small", text: "Edit", onclick: () => { stash(); detailsStep({ editing: true }); } })),
            h("dl", { class: "facts checkin-facts" }, fact("Name", name()),
              known.org ? fact("Company", v.organization) : null, fact("Visitor type", v.visitorType), known.citizen ? fact("Citizenship", citizenshipText(v.citizenship)) : null,
              known.contact ? fact("Visiting", w.companyName) : null,
              known.contact ? [h("dt", { text: w.hostIds.length > 1 ? "Points of contact" : "Point of contact" }), poc] : null,
              known.purpose ? fact("Purpose", w.purpose) : null,
              multiSite() && known.site ? fact("Site", siteName()) : null)));
      }

      page("details", `Confirm ${name()}'s details`, content,
        [cancelBtn(), w.visit ? btn("Close", "secondary", finish) : btn("Back", "secondary", () => { w.draft = null; findStep(); }), btn("Confirm", "primary", async () => {
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
          const c = contact ? contact.value() : { companyId: w.companyId, companyName: w.companyName, hostId: w.hostId, hostIds: w.hostIds, hostName: w.hostName };
          if (!c.hostId) throw new Error("Choose their point of contact.");
          const why = purpose ? purpose.value.trim() : w.purpose;
          if (!why) throw new Error("Enter the purpose of the visit.");
          if (v.blocked && !w.visit && !override.checked) throw new Error(`${name()} is blocked. Tick the box once a manager has agreed.`);
          if (Object.keys(changes).length) {
            w.visitor = (await api(`/api/visitors/${v.id}`, { method: "PUT", body: changes })).visitor;
            w.changed = true;
          }
          Object.assign(w, c);
          w.purpose = why;
          w.overrideBlock = override.checked;
          w.draft = null;
          idStep();
        })]);
    }

    // --- 3. check their ID ---------------------------------------------------------------------

    function idStep() {
      const v = w.visitor;
      const idName = `id-${Math.random().toString(36).slice(2, 8)}`;
      // An Other government ID: what it was, in a box shown only for that choice.
      const otherId = state.config.checkin?.otherId;
      const otherText = h("input", { type: "text", maxlength: "80", value: w.visit?.idOther || "", placeholder: "Military ID, tribal ID…", "aria-label": "What ID was it?" });
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
            fact("Visiting", w.companyName), fact(w.hostIds.length > 1 ? "Points of contact" : "Point of contact", w.hostName),
            fact("Purpose", w.purpose), multiSite() ? fact("Site", siteName()) : null),
          h("button", { type: "button", class: "link-btn small-text", text: "Change these details", onclick: () => detailsStep({ editing: true }) })),
        h("fieldset", { class: "id-types" }, h("legend", { text: "Which ID did they show?" }), types),
        otherBox,
        h("label", { class: "check-row id-match" }, match, h("span", { text: `The name and photo on the ID match ${name()}` }))),
      [cancelBtn(), btn("Back", "secondary", () => detailsStep({ editing: true })), btn("ID confirmed", "primary", async () => {
        const idType = body.querySelector(`input[name=${idName}]:checked`)?.value;
        if (!idType) throw new Error("Choose the ID they showed.");
        const idOther = idType === otherId ? otherText.value.trim() : null;
        if (idType === otherId && !idOther) {
          otherText.focus();
          throw new Error("Say what the other government ID was.");
        }
        if (!match.checked) throw new Error(`Tick the box once the ID matches ${name()}. If it doesn't, don't check them in.`);
        const visit = { hostIds: w.hostIds, companyId: w.companyId, purpose: w.purpose };
        // Finished before now (they were in the building already), not by this.
        let already = false;
        // A visit under way (from a kiosk, or back here from the badge step): checked on that visit.
        if (w.visit && ["id", "badge"].includes(w.visit.checkinStage)) {
          w.visit = (await api(`/api/visits/${w.visit.id}/verify-id`, { method: "POST", body: { idType, idOther, ...visit } })).visit;
        } else {
          const r = await api("/api/checkins", { method: "POST", body: { visitorId: v.id, siteId: Number(w.siteId), idType, idOther, overrideBlock: w.overrideBlock, ...visit } });
          w.visit = r.visit;
          already = r.already && w.visit.checkinStage === "done";
          // Already in the building (from a kiosk, say): their ID is checked on that visit.
          if (r.already && w.visit.checkinStage === "id") w.visit = (await api(`/api/visits/${w.visit.id}/verify-id`, { method: "POST", body: { idType, idOther, ...visit } })).visit;
        }
        w.changed = true;
        // An expected guest marked as needing no badge: their ID was all there was to check.
        if (!already && w.visit.checkinStage === "done" && w.visit.badgeWaivedAt) return doneStep(`${name()} is checked in. No badge necessary: they were marked so as an expected guest${w.visit.badgeWaivedBy ? ` by ${w.visit.badgeWaivedBy}` : ""}.`);
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
      const kept = plan.kept || (a ? [a] : []);
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
      const free = h("div", { class: "free-badges", hidden: true }, plan.available.map((b) => h("button", { type: "button", class: "chip mono", text: b.reservedFor ? `${b.label} (reserved)` : b.label, title: b.reservedFor ? `Reserved for ${b.reservedFor}` : null, onclick: () => { code.value = b.facilityCode || ""; number.value = b.number; number.focus(); } })));
      const entry = h("div", { class: "stack badge-entry" },
        h("div", { class: "badge-give" }, suggestedBadge(plan.suggested),
          h("div", { class: "stack" },
            plan.uncleared ? h("p", { class: "message warn", text: `${name()}'s clearance hasn't been validated, so give them an uncleared visitor badge.` }) : null,
            h("p", {}, plan.available.length
              ? [`Give them ${plan.uncleared ? "an uncleared" : "a"} visitor badge${!plan.uncleared && kinds.length ? ` (${kinds.join(" or ")})` : ""}, and enter its number.`, h("span", { class: "muted small-text", text: ` ${plan.available.length} free${multiSite() ? ` at ${plan.visit.siteName}` : ""}.` })]
              : h("span", { class: "message error", text: plan.uncleared
                ? `No uncleared visitor badge is free${multiSite() ? ` at ${plan.visit.siteName}` : ""}.`
                : `No visitor badge at ${name()}'s clearance level is free${multiSite() ? ` at ${plan.visit.siteName}` : ""}. A lower one they may hold can still be given by its number.` })),
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
        // Others kept for them: one that is free can be handed over instead; one that isn't says why.
        const alsoFree = kept.filter((k) => k.id !== a.id && !k.problem);
        const alsoOut = kept.filter((k) => k.id !== a.id && k.problem);
        if (alsoFree.length) content.append(h("div", { class: "btn-row small-text" }, h("span", { class: "muted", text: "Also kept for them:" }), alsoFree.map((k) => btn(`Hand over ${k.label} instead`, "secondary small", () => give({ badgeId: k.id })))));
        if (alsoOut.length) content.append(h("p", { class: "muted small-text", text: alsoOut.map((k) => `Badge ${k.label} is kept for them too, but can't be given: ${k.problem}`).join(" ") }));
        const other = h("button", { type: "button", class: "link-btn", text: "Can't find it? Issue a different badge", onclick: () => { entry.hidden = false; other.hidden = true; number.focus(); } });
        entry.hidden = true;
        content.append(other, entry);
      } else {
        // None kept for them can be given: each says why, and the desk issues another.
        for (const k of kept.filter((x) => x.problem)) content.append(h("p", { class: "message warn", text: `Badge ${k.label} was kept for them (${why[k.source].replace(/\.$/, "").toLowerCase()}), but it can't be given: ${k.problem} Issue another.` }));
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
        cancelBtn(),
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
        Object.assign(w, { visitor: null, visit: null, event: null, companyId: null, companyName: null, hostId: null, hostIds: [], hostName: null, purpose: "", overrideBlock: false, draft: null });
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

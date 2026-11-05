/**
 * Importing the tenant badges people already hold, from a file of names and badge numbers, onto
 * people already on record (it adds nobody). Two steps, both from the file held by import-routes.js:
 *
 *   review   each row's badge, and who its name may be: the same name, a close one, several to
 *            choose from, or nobody. Nothing is saved.
 *   assign   gives each row's badge to the person chosen for it, adding a badge not on record yet.
 *            A row with nobody chosen, or that can't be done, is left out and listed.
 *
 * These are badges tenants have already, so none is charged for: one past what a company may hold
 * is added to what it may hold, so it can be handed on later at no charge, like any other it has.
 * A badge still has to be one the person may hold, so a clearance level is checked as always.
 */
const { FACILITY_CODE_RE, TYPE_LABELS, badgeLabel } = require("./badges");
const { UNCLEARED, isUnclearedName } = require("./clearance");
const { createNameMatcher } = require("./name-match");

const MAX_ROWS = 5000;
const MAX_CANDIDATES = 6;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createTenantBadgeImport({ db, badges, allotments, clearance, directory, access, importRows, isBlankRow, auditFrom }) {
  const staffName = (req) => req.user?.displayName || req.user?.username || null;
  const nameOf = (row) => String(row.name || [row.first_name, row.last_name].filter(Boolean).join(" ")).trim();
  const lower = (v) => String(v ?? "").trim().toLowerCase();

  /** Who may hold a tenant badge: current people of current tenants, wherever the caller sees. */
  function peopleFor(req) {
    const rows = db.raw.prepare(`SELECT p.id, p.first_name, p.last_name, p.preferred_name, c.name AS company FROM people p JOIN companies c ON c.id = p.company_id
      WHERE p.active = 1 AND c.active = 1 AND c.building_staff = 0`).all();
    const seen = req.ctx.sites ? rows.filter((r) => directory.getPerson(r.id, { sites: req.ctx.sites })) : rows;
    return seen.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, preferredName: r.preferred_name, company: r.company }));
  }

  /** Each row's badge: { problem } or { number, code, label, badge (null: to be added), level }. */
  function badgesOfRows(req, rows, where) {
    const seesLevels = access.canSeeClearances(req.ctx);
    if (!seesLevels && rows.some((r) => r.level && !isUnclearedName(r.level))) throw fail(403, "This account doesn't see clearance levels, so it can't import them; leave the level out, or ask Security.");
    const levels = clearance.levels();
    const seen = new Map();
    return rows.map((row, i) => {
      try {
        const number = String(row.number || "").trim().replace(/\s+/g, " ");
        const code = String(row.facility_code || "").trim();
        if (!number) throw new Error("The badge number is empty.");
        if (/^\d+(\.\d+)?e\+?\d+$/i.test(number)) throw new Error(`"${number}" is a number a spreadsheet shortened to scientific notation, so the badge's real number is lost. Format the column as Text in the spreadsheet, put the full numbers back, and save the CSV again.`);
        if (code && !FACILITY_CODE_RE.test(code)) throw new Error(`The facility code is 2 or 3 digits, not "${code}".`);
        const found = badges.findByNumber(number, { facilityCode: code || null });
        if (found.length > 1) throw new Error(`Number ${number} could be ${found.map((b) => b.label).join(" or ")}: import the facility code too.`);
        const label = found[0]?.label || badgeLabel(code || null, number);
        const key = found[0] ? `id:${found[0].id}` : `${code}|${number.toLowerCase()}`;
        if (seen.has(key)) throw new Error(`Badge ${label} is in the file already, on ${seen.get(key).toLowerCase()}.`);
        seen.set(key, where(i));
        let level;
        if (isUnclearedName(row.level)) {
          level = null;
        } else if (row.level) {
          level = levels.find((l) => lower(l.name) === lower(row.level))?.id;
          if (!level) throw new Error(`There is no clearance level called "${row.level}" (${[...levels.map((l) => l.name), UNCLEARED].join(", ")}).`);
        }
        return { number, code: code || null, label, level, id: found[0]?.id ?? null };
      } catch (error) {
        return { problem: error.message };
      }
    });
  }

  /** The badge on record now, if it's one to give as a tenant's own; throws why if not. */
  function currentBadge(req, parsed) {
    if (!parsed.id) return null;
    const badge = badges.get(parsed.id, { sites: req.ctx.sites });
    if (!badge) throw new Error(`Badge ${parsed.label} is valid only at sites this account can't see.`);
    if (badge.type !== "tenant") throw new Error(`Badge ${badge.label} is a ${TYPE_LABELS[badge.type].toLowerCase()} badge, not a tenant badge.`);
    if (badge.temporary) throw new Error(`Badge ${badge.label} is temporary, lent for the day rather than kept.`);
    return badge;
  }

  /**
   * Who each row may be, and how sure that is. status: exact (the one person with that name, chosen
   * for you), close (the one person with a name like it, chosen for you to check), several (to
   * choose from, including anyone with only the same last name), none, done (they hold that badge
   * already) or problem.
   */
  function review(req, rows, { where }) {
    if (!rows.length) throw fail(400, "The file has no rows under its header.");
    if (rows.length > MAX_ROWS) throw fail(400, `Assign at most ${MAX_ROWS.toLocaleString("en-US")} badges at a time.`);
    const levelNames = access.canSeeClearances(req.ctx);
    const { match } = createNameMatcher(peopleFor(req));
    const parsed = badgesOfRows(req, rows, where);
    const out = [];
    const counts = { exact: 0, close: 0, several: 0, none: 0, done: 0, problem: 0 };
    let newBadges = 0;
    rows.forEach((row, i) => {
      if (isBlankRow(row)) return;
      const entry = { row: i, where: where(i), name: nameOf(row), company: String(row.company || "").trim() || null, label: parsed[i].label || String(row.number || "").trim(), isNew: false, personId: null, candidates: [], problem: null, status: "problem" };
      out.push(entry);
      try {
        if (parsed[i].problem) throw new Error(parsed[i].problem);
        if (!entry.name) throw new Error("The name is empty.");
        const badge = currentBadge(req, parsed[i]);
        entry.isNew = !badge;
        const found = match(entry.name);
        // With a company in the file, people there first.
        const wanted = lower(row.company);
        const here = (m) => Boolean(wanted) && lower(m.person.company) === wanted;
        const sorted = wanted ? [...found.filter(here), ...found.filter((m) => !here(m))] : found;
        if (badge?.holder) {
          const theirs = badge.holder.kind === "person" && !badge.holder.temporary && found.find((m) => m.person.id === badge.holder.id);
          if (!theirs) throw new Error(`Badge ${badge.label} is with ${badge.holder.name}; take it back first.`);
          entry.status = "done";
          entry.personId = badge.holder.id;
          entry.candidates = [{ id: badge.holder.id, name: badge.holder.name, company: badge.holder.company, exact: theirs.exact, held: [], problem: null }];
          return;
        }
        const named = wanted && sorted.some((m) => here(m) && m.exact) ? sorted.filter((m) => here(m) && m.exact) : sorted.filter((m) => m.exact);
        const close = wanted && sorted.some(here) ? sorted.filter(here) : sorted;
        if (named.length === 1) {
          entry.status = "exact";
          entry.personId = named[0].person.id;
        } else if (named.length > 1) {
          entry.status = "several";
        } else if (close.length === 1 && !close[0].weak) {
          entry.status = "close";
          entry.personId = close[0].person.id;
        } else {
          entry.status = close.length ? "several" : "none";
        }
        const shown = sorted.slice(0, MAX_CANDIDATES);
        const held = badges.heldByPeople(shown.map((m) => m.person.id));
        // A badge not on record yet is checked as it will be added.
        const planned = badge || { status: "active", type: "tenant", temporary: false, label: entry.label, clearanceLevelId: parsed[i].level ?? null };
        entry.candidates = shown.map((m) => ({
          id: m.person.id,
          name: `${m.person.firstName}${m.person.preferredName && m.person.preferredName !== m.person.firstName ? ` (${m.person.preferredName})` : ""} ${m.person.lastName}`,
          company: m.person.company,
          exact: m.exact,
          weak: m.weak,
          held: (held.get(m.person.id) || []).filter((b) => !b.temporary).map((b) => b.label),
          problem: badges.refusal(planned, badges.holder("person", m.person.id), { levelNames })
        }));
      } catch (error) {
        entry.status = "problem";
        entry.problem = error.message;
      }
      if (entry.isNew && entry.status !== "problem") newBadges += 1;
    });
    for (const entry of out) counts[entry.status] += 1;
    return { rows: out, counts, newBadges };
  }

  /** Gives each row's badge to the person chosen for it. `choices`: { row: personId }. */
  function assign(req, rows, { choices, where, from = "CSV" }) {
    if (rows.length > MAX_ROWS) throw fail(400, `Assign at most ${MAX_ROWS.toLocaleString("en-US")} badges at a time.`);
    const chosen = choices && typeof choices === "object" ? choices : {};
    const by = staffName(req);
    const levelNames = access.canSeeClearances(req.ctx);
    const parsed = badgesOfRows(req, rows, where);
    const logs = [];
    const credited = new Map();
    const counts = importRows(rows, (row, i) => {
      if (parsed[i].problem) throw new Error(parsed[i].problem);
      const personId = Number(chosen[i]);
      if (!Number.isInteger(personId) || personId <= 0) throw new Error("Nobody was chosen for this row.");
      if (!directory.getPerson(personId, { sites: req.ctx.sites })) throw new Error("That person isn't at your sites.");
      let badge = currentBadge(req, parsed[i]);
      if (badge?.holder?.kind === "person" && badge.holder.id === personId && !badge.holder.temporary) return "unchanged";
      const added = !badge;
      if (added) {
        // An account limited to some sites adds it for those; any other, for every site.
        badge = badges.create({ number: parsed[i].number, facilityCode: parsed[i].code, type: "tenant", clearanceLevelId: parsed[i].level ?? null, siteIds: req.ctx.sites ? [...req.ctx.sites] : [] }, { sites: req.ctx.sites });
      }
      const extra = allotments.extraNeeded(badge, "person", personId);
      const given = badges.assign(badge.id, { kind: "person", holderId: personId }, { by, sites: req.ctx.sites, levelNames });
      if (extra) {
        allotments.adjust(extra.companyId, { quantity: 1, note: `Badge ${given.label}, already held by ${given.holder.name} when imported.` }, { by });
        credited.set(extra.companyName, (credited.get(extra.companyName) || 0) + 1);
      }
      if (added) logs.push(["badge.add", given.label, `tenant; ${given.clearanceLevelName || UNCLEARED}; imported`]);
      logs.push(["badge.assign", given.label, `to ${given.holder.name}${given.holder.company ? ` (${given.holder.company})` : ""}; imported`]);
      return added ? "added" : "updated";
    }, where, "imported", { skipProblems: true });
    for (const [action, target, detail] of logs) auditFrom(req, action, target, detail);
    for (const [company, n] of credited) auditFrom(req, "badge.allotment", company, `+${n}: already held when imported, no charge`);
    auditFrom(req, "import.tenant_badges", `${counts.added} added and assigned, ${counts.updated} assigned, ${counts.unchanged} unchanged, ${counts.skippedCount} left out`, `from ${from}`);
    const notes = [...credited].map(([company, n]) => `${company} now may hold ${n} more: ${n === 1 ? "this badge was" : "these badges were"} past its allotment, and ${n === 1 ? "was" : "were"} added to it with no charge.`);
    return { ...counts, ignored: [], notes };
  }

  return { review, assign };
}

module.exports = { createTenantBadgeImport };

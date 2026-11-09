/**
 * Words for the audit log: who a record was and now is, when a change touches that; and a long
 * list of changes cut into pieces that each fit an entry (db.js keeps 2,000 characters of one).
 *
 * Only the fields that say who someone is are ever given here (a name, a company, an
 * organization, an email): never a clearance, and nothing of a clearance request.
 */

// The most an entry's detail holds, with room for what goes before the list.
const ENTRY_ROOM = 1800;

const shown = (v) => (v === null || v === undefined || v === "" ? "(none)" : `"${String(v).slice(0, 120)}"`);

/**
 * What changed among `fields` ([label, (record) => value]) from `before` to `after`, as
 * `name: "Jon Smith" -> "John Smith"; email: (none) -> "j@x.example"`; "" when none did.
 */
function identityChanges(before, after, fields) {
  return fields
    .map(([label, of]) => [label, of(before) ?? "", of(after) ?? ""])
    .filter(([, was, now]) => String(was) !== String(now))
    .map(([label, was, now]) => `${label}: ${shown(was)} -> ${shown(now)}`)
    .join("; ");
}

/** `items` joined with `sep` into as many pieces as it takes for none to be longer than `max`. */
function chunks(items, sep = "; ", max = ENTRY_ROOM) {
  const out = [];
  let piece = "";
  for (const raw of items) {
    const item = String(raw).slice(0, max);
    if (piece && piece.length + sep.length + item.length > max) {
      out.push(piece);
      piece = "";
    }
    piece = piece ? `${piece}${sep}${item}` : item;
  }
  if (piece) out.push(piece);
  return out;
}

const PERSON_IDENTITY = [["name", (p) => `${p.firstName} ${p.lastName}`], ["company", (p) => p.companyName], ["email", (p) => p.email]];
const VISITOR_IDENTITY = [["name", (v) => `${v.firstName} ${v.lastName}`], ["organization", (v) => v.organization], ["email", (v) => v.email]];
const COMPANY_IDENTITY = [["name", (c) => c.name]];

module.exports = { identityChanges, chunks, PERSON_IDENTITY, VISITOR_IDENTITY, COMPANY_IDENTITY };

/**
 * Matching a typed name to people on record, for the kiosk.
 *
 * Case, accents, punctuation and extra spaces don't matter; the names can come in either
 * order ("Doe Jane"); each part may have one typo (a missing, extra, wrong or swapped
 * letter) when it is at least four letters long. Only a full name gets an answer: at
 * least two words, each of two or more letters, so typing "J" or "Jane" lists nobody.
 * Multi-word surnames work ("Ana de la Cruz"), and a preferred name counts as a first name.
 */

/** Lower-case letters and digits, words separated by single spaces. */
function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Damerau-Levenshtein (optimal string alignment) distance, stopping early above `max`. */
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j += 1) rows[i][j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= a.length; i += 1) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2][j - 2] + 1);
      rows[i][j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
  }
  return rows[a.length][b.length];
}

/** How closely a typed part matches a stored one: 0 exact, 1 a typo, null not at all. */
function partScore(typed, stored) {
  if (!typed || !stored) return null;
  if (typed === stored) return 0;
  // Spaces inside a part don't count ("de la cruz" = "delacruz").
  if (typed.replace(/ /g, "") === stored.replace(/ /g, "")) return 0;
  if (Math.min(typed.length, stored.length) < 4) return null;
  return editDistance(typed.replace(/ /g, ""), stored.replace(/ /g, ""), 1) <= 1 ? 1 : null;
}

/** True when `typed` is a full name: two or more words of two or more letters each. */
function isFullName(typed) {
  const words = normalizeName(typed).split(" ").filter(Boolean);
  return words.length >= 2 && words.every((w) => w.length >= 2);
}

/**
 * How well `typed` matches a person { firstName, lastName, preferredName }: 0 exact,
 * higher with typos, null for no match. Every split of the typed words into a first and
 * last part is tried, in both orders.
 */
function nameScore(typed, person) {
  const words = normalizeName(typed).split(" ").filter(Boolean);
  if (words.length < 2) return null;
  const firsts = [normalizeName(person.firstName), normalizeName(person.preferredName)].filter(Boolean);
  const last = normalizeName(person.lastName);
  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const head = words.slice(0, i).join(" ");
    const tail = words.slice(i).join(" ");
    for (const [f, l] of [[head, tail], [tail, head]]) {
      const ls = partScore(l, last);
      if (ls === null) continue;
      for (const first of firsts) {
        const fs = partScore(f, first);
        if (fs === null) continue;
        const score = fs + ls;
        if (best === null || score < best) best = score;
      }
    }
  }
  return best;
}

/**
 * The people in `candidates` that `typed` names, best first. When some match exactly,
 * only the exact ones are returned, so "Jon Smith" doesn't also offer "John Smith".
 */
function matchNames(typed, candidates) {
  if (!isFullName(typed)) return [];
  const scored = [];
  for (const c of candidates) {
    const score = nameScore(typed, c);
    if (score !== null) scored.push({ c, score });
  }
  if (!scored.length) return [];
  const bestScore = Math.min(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === bestScore).map((s) => s.c);
}

/** A first guess at first and last name from one typed line (the kiosk lets them correct it). */
function splitName(typed) {
  const words = String(typed || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { firstName: words[0] || "", lastName: "" };
  return { firstName: words[0], lastName: words.slice(1).join(" ") };
}

module.exports = { normalizeName, editDistance, nameScore, matchNames, isFullName, splitName };

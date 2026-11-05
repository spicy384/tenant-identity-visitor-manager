/**
 * Matching a name written in a file to the people on record, when it may not be spelled the same:
 * its words in any order, a middle name or initial, a nickname (Bob for Robert), a shortened name
 * (Chris for Christopher) or a typo (Jonh, Smyth).
 *
 * A last name has to be close for someone to be offered at all, and a first name too when the file
 * gives one, so John Smith isn't offered Jane Smith while anyone closer is on record. With nobody
 * closer, those with that very last name are offered as a guess (weak): no list of nicknames has
 * every one, and Moe may well be Maurice, but only a person can say so.
 */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
// How alike two words must be to count, and how good a match must be to offer.
const MIN_WORD = 0.7;
const MIN_MATCH = 0.6;

const NICKNAMES = [
  ["robert", "bob", "bobby", "rob", "robbie"], ["william", "bill", "billy", "will", "willie", "liam"], ["richard", "rick", "ricky", "rich", "dick"],
  ["james", "jim", "jimmy", "jamie"], ["john", "jack", "johnny"], ["michael", "mike", "mikey", "mick"], ["thomas", "tom", "tommy"],
  ["joseph", "joe", "joey"], ["charles", "chuck", "charlie"], ["christopher", "chris", "topher"], ["daniel", "dan", "danny"], ["david", "dave", "davey"],
  ["edward", "ed", "eddie", "ted", "ned"], ["stephen", "steven", "steve"], ["anthony", "tony"], ["andrew", "andy", "drew"], ["matthew", "matt"],
  ["nicholas", "nick", "nicky"], ["patrick", "pat", "paddy"], ["peter", "pete"], ["benjamin", "ben", "benny"], ["jonathan", "jon", "jonny"],
  ["timothy", "tim", "timmy"], ["gregory", "greg"], ["kenneth", "ken", "kenny"], ["donald", "don", "donnie"], ["ronald", "ron", "ronnie"],
  ["lawrence", "laurence", "larry"], ["gerald", "jerry"], ["samuel", "sam", "sammy"], ["alexander", "alex", "xander"], ["jeffrey", "geoffrey", "jeff", "geoff"],
  ["elizabeth", "liz", "lizzy", "beth", "betty", "eliza"], ["katherine", "catherine", "kathryn", "kate", "katie", "kathy", "cathy"], ["margaret", "maggie", "meg", "peggy"],
  ["jennifer", "jen", "jenny"], ["jessica", "jess", "jessie"], ["susan", "sue", "susie"], ["patricia", "pat", "patty", "trish"], ["deborah", "debra", "deb", "debbie"],
  ["rebecca", "becky", "becca"], ["kimberly", "kim"], ["barbara", "barb"], ["christine", "christina", "chris", "tina"], ["victoria", "vicky", "tori"],
  ["sandra", "sandy"], ["pamela", "pam"], ["cynthia", "cindy"], ["alexandra", "alex", "sandy"], ["angela", "angie"], ["michelle", "shelly"]
];
const nicknameGroups = new Map();
NICKNAMES.forEach((group, i) => {
  for (const name of group) nicknameGroups.set(name, [...(nicknameGroups.get(name) || []), i]);
});

const plain = (name) => String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A name's words, lowercase without accents or punctuation, leaving out initials and Jr, Sr, II... */
function nameWords(name) {
  return plain(name).split(" ").filter((w) => w.length > 1 && !SUFFIXES.has(w));
}

/** Letters to change, add, remove or swap with their neighbor to turn one word into the other. */
function editDistance(a, b) {
  let before = null;
  let last = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      let d = Math.min(last[j] + 1, row[j - 1] + 1, last[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      row.push(d);
    }
    before = last;
    last = row;
  }
  return last[b.length];
}

/** How alike two words are, from 0 (not at all) to 1 (the same). */
function wordSimilarity(a, b) {
  if (a === b) return 1;
  const groups = nicknameGroups.get(a);
  if (groups && (nicknameGroups.get(b) || []).some((g) => groups.includes(g))) return 0.92;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return 0.85;
  if (long.length - short.length > long.length * 0.3) return 0;
  const similarity = 1 - editDistance(a, b) / long.length;
  return similarity >= MIN_WORD ? similarity : 0;
}

/** How well a name in the file fits one spelling of a person's name, from 0 to 1. */
function fitOf(file, first, last) {
  if (file.compact === first.compact + last.compact || file.compact === last.compact + first.compact) return 0.98;
  const used = new Set();
  let sum = 0;
  let hits = 0;
  for (const word of last.words) {
    let best = 0;
    let at = -1;
    file.words.forEach((w, i) => {
      const s = used.has(i) ? 0 : wordSimilarity(w, word);
      if (s > best) { best = s; at = i; }
    });
    if (at >= 0) { used.add(at); sum += best; hits += 1; }
  }
  if (!hits) return 0;
  const lastFit = (sum / hits) * (hits < last.words.length ? 0.9 : 1);
  const rest = file.words.filter((_, i) => !used.has(i));
  let firstFit = 0;
  for (const w of rest) for (const word of first.words) firstFit = Math.max(firstFit, wordSimilarity(w, word));
  const matched = firstFit > 0;
  if (!matched) {
    const initial = first.tokens[0]?.[0];
    if (initial && (file.initials.includes(initial) || (first.tokens[0].length === 1 && rest.some((w) => w[0] === initial)))) firstFit = 0.7;
    else if (!rest.length && !file.initials.length) firstFit = 0.55; // the last name alone
    else return 0;
  }
  // Words the record doesn't have, such as a middle name.
  const extras = Math.max(0, rest.length - 1);
  return Math.max(0, 0.55 * lastFit + 0.45 * firstFit - 0.04 * extras);
}

const spelled = (name) => {
  const tokens = plain(name).split(" ").filter(Boolean);
  return { tokens, words: tokens.filter((w) => w.length > 1 && !SUFFIXES.has(w)), compact: tokens.join("") };
};

/**
 * Prepares `people` ({ firstName, lastName, preferredName }, and anything else) for matching.
 * match(name) answers [{ person, score, exact, weak }], the best first. exact: the same words as
 * their name (or preferred and last name) in any order, leaving out initials and Jr, Sr, II...
 * weak: only their last name is the same, and nobody closer was found.
 */
function createNameMatcher(people) {
  const byLastWord = new Map();
  const entries = people.map((person) => {
    const last = spelled(person.lastName);
    if (!last.words.length) last.words = [last.compact];
    const firsts = [spelled(person.firstName)];
    if (person.preferredName && person.preferredName !== person.firstName) firsts.push(spelled(person.preferredName));
    const entry = { person, last, firsts, exactSets: firsts.map((f) => new Set([...f.words, ...last.words])) };
    for (const word of new Set([...last.words, last.compact])) byLastWord.set(word, [...(byLastWord.get(word) || []), entry]);
    return entry;
  });
  // Which last names each word in a file is close to: asked again and again for the same words.
  const closeTo = new Map();
  const lastNamesNear = (word) => {
    if (!closeTo.has(word)) closeTo.set(word, [...byLastWord.keys()].filter((w) => wordSimilarity(word, w) > 0));
    return closeTo.get(word);
  };

  function match(name) {
    const tokens = plain(name).split(" ").filter(Boolean);
    const words = tokens.filter((w) => w.length > 1 && !SUFFIXES.has(w));
    if (!words.length) return [];
    const file = { words, initials: tokens.filter((w) => w.length === 1), compact: tokens.filter((w) => !SUFFIXES.has(w)).join("") };
    const pool = new Set();
    for (const word of words) for (const last of lastNamesNear(word)) for (const e of byLastWord.get(last)) pool.add(e);
    // Written apart in one place and together in the other: De La Cruz, Delacruz.
    for (let i = 0; i < words.length; i += 1) {
      for (let j = i + 2; j <= words.length; j += 1) for (const e of byLastWord.get(words.slice(i, j).join("")) || []) pool.add(e);
    }
    const unique = new Set(words);
    const found = [];
    for (const e of pool) {
      const exact = unique.size >= 2 && e.exactSets.some((set) => set.size === unique.size && words.every((w) => set.has(w)));
      const score = exact ? 1 : Math.max(...e.firsts.map((first) => fitOf(file, first, e.last)));
      if (exact || score >= MIN_MATCH) found.push({ person: e.person, score, exact, weak: false });
    }
    if (!found.length) {
      for (const e of pool) if (e.last.words.every((w) => unique.has(w))) found.push({ person: e.person, score: 0.4, exact: false, weak: true });
    }
    return found.sort((a, b) => b.score - a.score || String(a.person.lastName).localeCompare(String(b.person.lastName)) || String(a.person.firstName).localeCompare(String(b.person.firstName)));
  }

  return { match };
}

module.exports = { nameWords, wordSimilarity, createNameMatcher };

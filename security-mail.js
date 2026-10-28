/**
 * Reading the two kinds of email Security gets in the shared mailbox:
 *
 * - Alarm notices from the monitoring center (the DMP intrusion panel's events, as Rapid
 *   Response's RapidWeb3000 sends them): an HTML body set in a fixed-width font, the account
 *   and the alarm at the top, then the event log, newest first, in columns under a header line
 *   ("Date...  Event/Operator Action...  Phone...  Point/User..."), each event followed by its
 *   Disposition and Comment lines.
 * - The guard company's daily activity report (Belfry Software): a PDF attached to the email.
 *   A summary (site, the time range, counts), then a table: the time (under a date heading),
 *   the kind of entry, its status and the officer, and the details, with checkpoint questions
 *   indented under them.
 *
 * classify() tells them apart by what is in them, not by who sent them, so a forwarded copy
 * or a file dropped in by hand reads the same. Anything else is left alone.
 */
const { pdfText, pdfLines } = require("./pdf-text");

// --- text from HTML ------------------------------------------------------------------------------

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };

/** An HTML body as lines of text, spaces kept as they are (the alarm notice lines up columns with them). */
function htmlLines(html) {
  const body = /<body[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(String(html || ""))?.[1] ?? String(html || "");
  return body
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\r?\n/g, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return code === 160 ? " " : String.fromCodePoint(code);
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n");
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

// --- alarm notices ---------------------------------------------------------------------------------

const ALARM_HEADER = /^Date\.\.\.\s+Event\/Operator Action\.\.\./;
const LOG_LINE = /^(\d{1,2})\/(\d{1,2}) (\d{2}:\d{2}:\d{2})/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whether a message's body is a monitoring center alarm notice. */
const isAlarm = (lines) => lines.some((l) => ALARM_HEADER.test(l));

/**
 * An alarm notice: the account, the alarm, and its event log (oldest first), with what it
 * came to (summary). Times are as the monitoring center wrote them, in the account's local time.
 */
function parseAlarm({ subject = "", html = "", text = "" }) {
  const lines = html ? htmlLines(html) : String(text).split(/\r?\n/);
  const headerAt = lines.findIndex((l) => ALARM_HEADER.test(l));
  if (headerAt < 0) return null;
  const top = lines.slice(0, headerAt).map(clean);
  const out = { center: null, centerPhone: null, account: null, accountName: null, address: [], reference: null, event: null, zone: null, zoneName: null, area: null, when: null, eventNumber: null, link: null, log: [] };

  // The monitoring center: its name and phone number, on the first line.
  const first = top.find(Boolean) || "";
  const phone = /(\(?\d{3}\)?[-. ]?\d{3}[-. ]\d{4})\s*$/.exec(first);
  out.center = clean(phone ? first.slice(0, phone.index) : first) || null;
  out.centerPhone = phone ? phone[1] : null;

  // The account, then its name and address up to a blank line.
  const acc = top.findIndex((l) => /^Account:/i.test(l));
  if (acc >= 0) {
    out.account = clean(top[acc].replace(/^Account:/i, "")) || null;
    for (let i = acc + 1; i < top.length && top[i]; i += 1) {
      if (!out.accountName) out.accountName = top[i];
      else out.address.push(top[i]);
    }
  }
  // The alarm: the reference, then what it was, its zone, area and when.
  const ref = top.findIndex((l) => /^Reference\s*#/i.test(l));
  for (let i = ref < 0 ? acc + 1 : ref; i >= 0 && i < top.length; i += 1) {
    const l = top[i];
    if (!l) continue;
    let m;
    if ((m = /^Reference\s*#\s*(\S+)/i.exec(l))) out.reference = m[1];
    else if ((m = /^Zone\s+(\S+)\s*(.*)$/i.exec(l))) { out.zone = m[1]; out.zoneName = clean(m[2]) || null; }
    else if ((m = /^Area\s+(.*)$/i.exec(l))) out.area = clean(m[1]) || null;
    else if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}( \d{1,2}:\d{2})?$/.test(l)) out.when = l;
    else if (ref >= 0 && !out.event) out.event = l;
  }
  const subj = /event\s*#\s*(\d+)\s*(.*)$/i.exec(clean(subject));
  if (subj) {
    out.eventNumber = subj[1];
    if (!out.event && subj[2]) out.event = clean(subj[2]);
  }

  // The log, in the header line's columns.
  const header = lines[headerAt];
  const col = (label) => header.indexOf(label);
  const cols = [0, col("Event/Operator"), col("Phone..."), col("Point/User")];
  const year = Number(/\d{4}/.exec(out.when || "")?.[0]) || null;
  const whenMonth = out.when ? MONTHS.indexOf(out.when.slice(0, 3)) + 1 : null;
  let entry = null;
  for (const raw of lines.slice(headerAt + 1)) {
    const line = raw.replace(/\s+$/, "");
    const m = LOG_LINE.exec(line);
    if (m) {
      const cut = (a, b) => clean(cols[a] >= 0 ? line.slice(cols[a], b !== undefined && cols[b] >= 0 ? cols[b] : undefined) : "");
      const month = Number(m[1]);
      // The log may reach back over a new year.
      const y = year && whenMonth && month > whenMonth ? year - 1 : year;
      entry = {
        date: y ? `${y}-${String(month).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}` : null,
        time: m[3],
        action: cut(1, 2),
        phone: cut(2, 3) || null,
        who: cut(3) || null,
        disposition: null,
        comment: null
      };
      out.log.push(entry);
      continue;
    }
    const t = clean(line);
    if (!t) continue;
    let k;
    if (entry && (k = /^(Comment|Disposition):\s*(.*)$/i.exec(t))) {
      entry[k[1].toLowerCase()] = clean(k[2]) || null;
    } else if (/^For more detail/i.test(t)) {
      out.link = /(https?:\/\/\S+)/.exec(t)?.[1]?.replace(/[.,]$/, "") || null;
      entry = null;
    } else if (entry) {
      entry.comment = clean(`${entry.comment || ""} ${t}`);
    }
  }
  out.log.reverse();
  out.summary = alarmSummary(out.log);
  return out;
}

/**
 * What an alarm came to, from its log: when the panel signaled, who disarmed it, whom the
 * monitoring center called and how each call went, whether someone verified, whether
 * dispatch was asked for, and when it was cleared.
 */
function alarmSummary(log) {
  const panel = (re) => log.find((e) => re.test(e.action));
  const signal = panel(/ALARM/i);
  const restore = panel(/RESTORAL/i);
  const disarm = log.find((e) => /OPENING|DISARM|CANCEL/i.test(e.action) && e.who);
  const verified = log.filter((e) => /^Valid User Passcode/i.test(e.action));
  const unverified = log.filter((e) => /^Invalid Passcode/i.test(e.action));
  // Each call, with the passcode check made on it (logged at the same moment).
  const calls = log.filter((e) => /^Call\b/i.test(e.action)).map((e) => {
    const check = [...verified, ...unverified].find((v) => v.time === e.time && v.date === e.date);
    return {
      time: e.time,
      phone: e.phone,
      who: e.who || check?.who || null,
      outcome: e.disposition || null,
      verified: check ? verified.includes(check) : null,
      note: check?.comment || e.comment || null
    };
  });
  const decision = log.filter((e) => /Action Plan Decision/i.test(e.action) && e.comment).pop();
  const dispatched = log.find((e) => /dispatch/i.test(e.action) && !/Decision|Window/i.test(e.action));
  const cleared = log.filter((e) => /Full Clear|Clear\b/i.test(e.action)).pop();
  return {
    signalAt: signal?.time || null,
    signal: signal ? clean(signal.action.replace(/^[A-Z0-9]+ - /, "")) : null,
    restoredAt: restore?.time || null,
    disarmedAt: disarm?.time || null,
    disarmedBy: disarm?.who || null,
    // The panel's user number, from the opening or the cancel ("User# 1005").
    disarmUser: log.map((e) => (/OPENING|DISARM|CANCEL/i.test(e.action) ? /User#\s*(\d+)/i.exec(e.comment || "")?.[1] : null)).find(Boolean) || null,
    verified: verified.map((e) => ({ time: e.time, who: e.who, note: e.comment })),
    unverified: unverified.map((e) => ({ time: e.time, note: e.comment })),
    calls,
    // "Did the contact request dispatch?/No dispatch requested": the answer.
    dispatch: decision ? clean(decision.comment.split("/").pop()) : dispatched ? clean(dispatched.action) : null,
    clearedAt: cleared?.time || null
  };
}

// --- guard daily activity reports ------------------------------------------------------------------

const ZONES = { EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8, AKDT: -8, AKST: -9, HST: -10, UTC: 0, GMT: 0 };
const TIME_CELL = /^(!\s*)?(\d{1,2}):(\d{2}) ([AP]M)(?: ([A-Z]{2,4}))?$/;
const DATE_CELL = /^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4})$/;
const LABELED = /^(Location|Summary|Notes?|Severity|Priority|Category|Incident Type|Type|Reported By):\s*(.*)$/i;

/** Ligatures (ﬁ, ﬃ, ...) as their letters, and any run of spaces as one. */
const plain = (s) => clean(String(s || "").replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC")));

/** "Oct 27th, 2026" and "4:57 PM EDT" as a time, or null when the zone isn't known. */
function guardTime(date, h, min, ampm, zone) {
  if (!date) return null;
  let hour = Number(h) % 12;
  if (ampm === "PM") hour += 12;
  const offset = ZONES[zone || ""];
  if (offset === undefined) return null;
  return Date.UTC(date.y, date.m - 1, date.d, hour, Number(min)) - offset * 3600000;
}

/** Whether a PDF is a guard company's daily activity report (its first line says so). */
function isGuardReport(pages) {
  const first = pages[0]?.[0]?.items?.map((i) => plain(i.text)).join(" ") || "";
  return /Daily Activity Report/i.test(first);
}

/**
 * A daily activity report from its PDF: { title, company, site, range, counts, date, entries,
 * summary }. Each entry: { at (ms or null), date, time, type, status, officer, headline, body,
 * fields (Location, Summary, ...), answers [{ question, answer }], checkpoint, flagged }.
 */
function parseGuardReport(pdf) {
  const text = pdfText(pdf);
  const firstLook = pdfLines(text);
  if (!isGuardReport(firstLook)) return null;
  const out = { title: null, company: null, site: null, range: null, counts: {}, date: null, entries: [] };

  // The columns, from the table's header row ("!  Time  Details  Photo", "Activity/" above).
  let colB = 100;
  let colC = 185;
  let colD = 410;
  for (const page of firstLook) {
    for (const l of page) {
      const time = l.items.find((i) => plain(i.text) === "Time");
      const details = l.items.find((i) => plain(i.text) === "Details");
      if (time && details) {
        colC = details.x - 6;
        const photo = l.items.find((i) => plain(i.text) === "Photo");
        if (photo) colD = photo.x - 6;
      }
      const activity = l.items.find((i) => plain(i.text) === "Activity/");
      if (activity) colB = activity.x - 6;
    }
    if (colC !== 185) break;
  }
  // Read again, keeping the columns apart however close their text comes.
  const pages = pdfLines(text, { columns: [colB, colC, colD] });
  const isHeaderRow = (l) => {
    const t = l.items.map((i) => plain(i.text));
    return (t.includes("Time") && t.includes("Details")) || (t.length === 1 && /^(Activity\/|Officer)$/.test(t[0]));
  };

  // The summary on the first page, above the table.
  // (Read before the columns split it: its labels run across them.)
  const firstPage = firstLook[0] || [];
  const tableAt = firstPage.findIndex(isHeaderRow);
  const preamble = firstPage.slice(0, tableAt < 0 ? firstPage.length : tableAt);
  out.title = plain(preamble[0]?.items.map((i) => i.text).join(" ")) || null;
  out.company = plain(preamble[1]?.items.map((i) => i.text).join(" ")) || null;
  for (const [i, l] of preamble.entries()) {
    const t = l.items.map((x) => plain(x.text));
    if (/^Site name:?$/i.test(t[0])) out.site = t.slice(1).join(" ") || null;
    if (/^Date\/Time Range:?$/i.test(t[0])) out.range = t.slice(1).join(" ") || null;
    // A row of numbers over a row of labels: the counts, by order.
    const next = preamble[i + 1];
    if (next && t.length > 1 && t.every((x) => /^\d+$/.test(x)) && next.items.length === t.length) {
      next.items.forEach((label, k) => { out.counts[plain(label.text)] = Number(t[k]); });
    }
  }

  // The table: an entry starts at a time in the first column, under the last date heading.
  let date = null;
  let entry = null;
  let lastField = null;
  const finish = () => {
    if (!entry) return;
    entry.status = entry.extras.length >= 2 ? entry.extras[0] : null;
    entry.officer = entry.extras.length ? entry.extras[entry.extras.length - 1] : null;
    delete entry.extras;
    entry.body = entry.body ? clean(entry.body) : null;
    out.entries.push(entry);
    entry = null;
  };
  // On the first page the table starts below its header row.
  const tableTop = tableAt < 0 ? -Infinity : firstPage[tableAt].y;
  for (const [p, page] of pages.entries()) {
    for (const l of page) {
      if (p === 0 && l.y >= tableTop - 0.5) continue;
      if (isHeaderRow(l)) continue;
      // The page number at the foot.
      if (l.y < 30 && l.items.length === 1 && /^\d+$/.test(plain(l.items[0].text))) continue;
      const a = l.items.filter((i) => i.x < colB).map((i) => plain(i.text)).join(" ").trim();
      const b = l.items.filter((i) => i.x >= colB && i.x < colC).map((i) => plain(i.text));
      const c = l.items.filter((i) => i.x >= colC && i.x < colD);
      let m;
      if ((m = DATE_CELL.exec(a))) {
        finish();
        date = { y: Number(m[3]), m: MONTHS.indexOf(m[1]) + 1, d: Number(m[2]) };
        if (!out.date) out.date = `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
        continue;
      }
      if ((m = TIME_CELL.exec(a))) {
        finish();
        entry = {
          at: guardTime(date, m[2], m[3], m[4], m[5]),
          date: date ? `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}` : null,
          time: `${m[2]}:${m[3]} ${m[4]}${m[5] ? ` ${m[5]}` : ""}`,
          type: b.shift() || null,
          extras: [],
          headline: null,
          body: "",
          fields: {},
          answers: [],
          checkpoint: null,
          flagged: Boolean(m[1]) || /incident/i.test(a),
          y: l.y
        };
        lastField = null;
      }
      if (!entry) continue;
      entry.extras.push(...b.filter(Boolean));
      for (const item of c) {
        const t = plain(item.text);
        if (!t) continue;
        const sameRow = Math.abs(l.y - entry.y) < 0.5;
        // Questions answered at a checkpoint sit indented under the details.
        if (item.x > colC + 20 && /:\s*\S+$/.test(t) && !LABELED.test(t)) {
          const at = t.lastIndexOf(":");
          entry.answers.push({ question: clean(t.slice(0, at)), answer: clean(t.slice(at + 1)) });
          lastField = null;
          continue;
        }
        let f;
        if ((f = /^[✓✔☑]\s*(.*?)(?:\s+completed)?$/u.exec(t)) || (f = /^[✗✘×☒]\s*(.*?)(?:\s+missed)?$/u.exec(t))) {
          entry.checkpoint = { name: clean(f[1]), completed: /^[✓✔☑]/u.test(t) };
          continue;
        }
        if ((f = LABELED.exec(t))) {
          const key = f[1][0].toUpperCase() + f[1].slice(1).toLowerCase();
          entry.fields[key] = clean(f[2]);
          lastField = key;
          continue;
        }
        if (lastField) {
          entry.fields[lastField] = clean(`${entry.fields[lastField]} ${t}`);
          continue;
        }
        // An activity report's first line is its title, the rest its text; for the other
        // kinds of entry the details are one sentence wrapped over lines.
        const titled = /report|incident/i.test(entry.type || "");
        if (!entry.headline && (sameRow || !titled)) entry.headline = t;
        else if (!titled && !entry.body) entry.headline = clean(`${entry.headline} ${t}`);
        else entry.body += ` ${t}`;
      }
    }
  }
  finish();
  for (const e of out.entries) delete e.y;
  out.summary = guardSummary(out.entries);
  return out;
}

/**
 * What a report comes to: each officer's shift (clock in to clock out), each tour with its
 * checkpoints, the written reports, incidents, missed checkpoints, and questions answered No.
 */
function guardSummary(entries) {
  const shifts = [];
  const tours = [];
  let tour = null;
  for (const e of entries) {
    const type = (e.type || "").toLowerCase();
    if (type === "clock-in") shifts.push({ officer: e.officer, in: e.time, inAt: e.at, out: null, outAt: null });
    if (type === "clock-out") {
      const open = [...shifts].reverse().find((s) => s.officer === e.officer && !s.out);
      if (open) Object.assign(open, { out: e.time, outAt: e.at });
      else shifts.push({ officer: e.officer, in: null, inAt: null, out: e.time, outAt: e.at });
    }
    if (type === "tour started") {
      tour = { officer: e.officer, name: e.headline ? e.headline.replace(/\s+started$/i, "") : null, start: e.time, end: null, scanned: 0, missed: 0, summary: null };
      tours.push(tour);
    }
    if (type === "checkpoint" && tour) {
      if (e.checkpoint?.completed === false) tour.missed += 1;
      else tour.scanned += 1;
    }
    if (type === "tour ended") {
      if (!tour) { tour = { officer: e.officer, name: e.headline ? e.headline.replace(/\s+ended$/i, "") : null, start: null, scanned: 0, missed: 0 }; tours.push(tour); }
      tour.end = e.time;
      tour.summary = e.fields.Summary || null;
      tour = null;
    }
  }
  const index = (e) => entries.indexOf(e);
  return {
    officers: [...new Set(entries.map((e) => e.officer).filter(Boolean))],
    shifts,
    tours,
    reports: entries.filter((e) => /activity report/i.test(e.type || "")).map(index),
    incidents: entries.filter((e) => e.flagged || /incident/i.test(e.type || "")).map(index),
    missed: entries.filter((e) => e.checkpoint?.completed === false || /missed/i.test(e.status || "")).map(index),
    answeredNo: entries.flatMap((e) => e.answers.filter((x) => /^(n|no)$/i.test(x.answer)).map((x) => ({ entry: index(e), question: x.question })))
  };
}

// --- which is which --------------------------------------------------------------------------------

/**
 * What a message is: { kind: "alarm", alarm } or { kind: "guard", report, pdf (the attachment),
 * pdfName }, or null for anything else (with `reason`, for the log of what came in).
 */
function classify(message) {
  const lines = message.html ? htmlLines(message.html) : String(message.text || "").split(/\r?\n/);
  if (isAlarm(lines)) {
    const alarm = parseAlarm(message);
    if (alarm) return { kind: "alarm", alarm };
  }
  const pdfs = (message.attachments || []).filter((a) => /pdf/i.test(a.type || "") || /\.pdf$/i.test(a.name || "") || a.data?.subarray(0, 5).toString("latin1") === "%PDF-");
  for (const a of pdfs) {
    let report = null;
    try {
      report = parseGuardReport(a.data);
    } catch {
      report = null;
    }
    if (report) return { kind: "guard", report, pdf: a.data, pdfName: a.name || "report.pdf" };
  }
  return { kind: null, reason: pdfs.length ? "Its PDF isn't a daily activity report." : "It isn't an alarm notice or a daily activity report." };
}

module.exports = { classify, parseAlarm, parseGuardReport, alarmSummary, guardSummary, htmlLines };

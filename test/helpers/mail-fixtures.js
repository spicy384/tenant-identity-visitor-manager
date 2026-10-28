/**
 * Made-up emails for the Security mail tests, in the shapes the real ones come in, with no
 * real names, numbers or places: the monitoring center's alarm notice (fixed-width HTML), the
 * guard company's daily activity report (a PDF laid out as Chrome prints one: a composite
 * font with a ToUnicode map, the page flipped by the graphics matrix, headings set one letter
 * at a time), and the files they might be dropped in as: an Outlook .msg (a compound file,
 * small streams in the mini stream and large ones in sectors of their own) or an .eml.
 */
const zlib = require("zlib");

// --- the alarm notice -----------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n, " ");

/** One log line in the notice's columns: date+time 16, action 29, phone 22, person. */
const logLine = ([when, action, phone = "", who = ""]) => `${pad(when, 16)}${pad(action, 29)}${pad(phone, 22)}${who}`;

/**
 * The alarm notice's HTML. log: newest first, [when, action, phone, who, { comment, disposition }].
 */
function alarmHtml({ account = "Z9990001", name = "Example Co - Wing A", event = "BURGLARY ALARM", zone = "120", zoneName = "Lobby Door", area = "1", when = "Jan 3, 2027 09:15", log } = {}) {
  const lines = [
    "Example Monitoring 800-555-0100",
    "",
    `Account: ${account}`,
    name,
    "1 Example Way ",
    "Springfield, ST  00000",
    "",
    "",
    "Reference #1000001",
    `${event}   `,
    `Zone ${zone}   ${zoneName}   `,
    `Area ${area} `,
    when,
    "",
    `${pad("Date...", 16)}${pad("Event/Operator Action...", 29)}${pad("Phone...", 22)}Point/User...`
  ];
  for (const [when2, action, phone, who, extra = {}] of log) {
    lines.push(logLine([when2, action, phone, who]));
    if (extra.disposition !== undefined) lines.push(`${" ".repeat(16)}Disposition: ${extra.disposition}`);
    if (extra.comment !== undefined) lines.push(`${" ".repeat(16)}Comment: ${extra.comment}`);
  }
  lines.push("", "", "For more detail, please log in to ExampleWeb at https://monitoring.example/");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/ /g, "&nbsp;");
  return `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body style="font-family:Courier New, Courier, monospace;">${lines.map(esc).join("<br>")}<br></body></html>`;
}

/** A typical alarm: the panel signals, calls, a disarm, a verified call, no dispatch, cleared. */
const SAMPLE_LOG = [
  ["01/03 09:15:40", "EmailSent - Email Sent", "", "", { comment: "Sam Sample - FSO[security@example.com]" }],
  ["01/03 09:15:40", "Full Clear - Contact Notifi", "", "", { comment: "" }],
  ["01/03 09:15:30", "Action Plan Decision", "", "", { comment: "Did the contact request dispatch?/No dispatch requested" }],
  ["01/03 09:15:20", "Valid User Passcode", "", "Pat Example", { comment: "VRFD PAT. STS ALL OK" }],
  ["01/03 09:15:20", "Call", "5550000003", "Pat Example", { disposition: "", comment: "" }],
  ["01/03 09:14:50", "DMPS49 - CANCEL ABORT/DISAR", "", "LEE EXAMPLE", { comment: "User# 42 Encrypted 128 bit" }],
  ["01/03 09:14:49", "DMPOP - OPENING", "", "LEE EXAMPLE", { comment: "LEE EXAMPLE LOBBY Encrypted 128 bit" }],
  ["01/03 09:14:00", "Call", "5550000002", "Lee Example", { disposition: "Answering Machine/Voicemail - Message Left", comment: "" }],
  ["01/03 09:13:00", "Invalid Passcode", "", "", { comment: "SPOKE TO ALEX, UNSURE" }],
  ["01/03 09:13:00", "Call", "5550000001", "", { disposition: "", comment: "" }],
  ["01/03 09:12:10", "DMPBR - RESTORAL- BURGLARY", "", "120 Lobby Door", { comment: "Encrypted 128 bit" }],
  ["01/03 09:12:10", "DMPBA - BURGLARY ALARM", "", "120 Lobby Door", { comment: "LOBBY Encrypted 128 bit" }]
];

// --- the guard report PDF --------------------------------------------------------------------------

/**
 * A PDF of text runs, laid out as Chrome's Skia does: one composite (Type0, Identity-H) font
 * with a ToUnicode map and widths, each page flipped by `1 0 0 -1 0 792 cm`, so a run's
 * y here counts down from the top. pages: [[{ x, y, text, bold }]]; a bold run is set one
 * glyph at a time, as headings are.
 */
function makePdf(pages) {
  const chars = [...new Set(pages.flat().flatMap((r) => [...r.text]))];
  const cid = new Map(chars.map((c, i) => [c, i + 1]));
  const width = (c) => (c === " " ? 280 : /[il.,:'!|]/.test(c) ? 260 : /[mwMW]/.test(c) ? 830 : /[A-Z]/.test(c) ? 660 : 540);
  const hex = (s) => [...s].map((c) => cid.get(c).toString(16).padStart(4, "0")).join("");
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const stream = (dict, data, compress = true) => {
    const bytes = compress ? zlib.deflateSync(Buffer.from(data, "latin1")) : Buffer.from(data, "latin1");
    return { dict: `${dict}${compress ? " /Filter /FlateDecode" : ""} /Length ${bytes.length}`, bytes };
  };
  const toUnicode = add(stream("<<", [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap", "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange",
    `${chars.length} beginbfchar`, ...chars.map((c) => `<${cid.get(c).toString(16).padStart(4, "0")}> <${Buffer.from(c, "utf16le").swap16().toString("hex")}>`), "endbfchar",
    "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"
  ].join("\n")));
  const widths = `[1 [${chars.map(width).join(" ")}]]`;
  const descendant = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Example /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /W ${widths} >>`);
  const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Example /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  const pagesId = objects.length + pages.length * 2 + 1;
  const kids = [];
  for (const runs of pages) {
    const ops = ["1 0 0 -1 0 792 cm"];
    for (const r of runs) {
      const size = r.size || 9;
      if (r.bold) {
        // One glyph at a time, each placed where the last ended.
        let x = r.x;
        for (const c of r.text) {
          ops.push(`BT /F1 ${size} Tf 1 0 0 -1 ${x.toFixed(2)} ${r.y} Tm <${hex(c)}> Tj ET`);
          x += (width(c) / 1000) * size;
        }
      } else {
        ops.push(`BT /F1 ${size} Tf 1 0 0 -1 ${r.x} ${r.y} Tm <${hex(r.text)}> Tj ET`);
      }
    }
    const content = add(stream("<<", ops.join("\n")));
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  const pagesObj = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  if (pagesObj !== pagesId) throw new Error("page tree numbering");
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(pos);
    const chunk = typeof o === "string"
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict} >>\nstream\n`, "latin1"), o.bytes, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/**
 * A daily activity report as the guard company's software lays it out (columns at the x the
 * real one uses: time 61, kind 117, details 191, questions 221), over as many pages as
 * `perPage` entries allow; an entry's last line may fall on the next page.
 */
function guardPdf({ site = "Example Site", company = "Example Guard Co", range = "Mon Jan 4 7:00 AM - Tue Jan 5 6:59 AM EST", counts = [3, 2, 1, 1, 0], days }) {
  const pages = [[]];
  let page = pages[0];
  let y = 60;
  const put = (x, text, extra = {}) => page.push({ x, y, text, ...extra });
  const line = (gap = 11) => {
    y += gap;
    if (y > 740) {
      page.push({ x: 558, y: 774, text: String(pages.length) });
      page = [];
      pages.push(page);
      y = 60;
      put(117, "Activity/");
      y += 7;
      put(49, "!"); put(61, "Time"); put(191, "Details"); put(415, "Photo");
      y += 6;
      put(117, "Ofﬁcer");
      y += 14;
    }
  };
  put(46, "Daily Activity Report", { bold: true, size: 16 }); line(30);
  put(46, company, { size: 12 }); line(40);
  put(48, "Site name:", { bold: true }); put(155, site); line(16);
  put(48, "Date/Time Range:", { bold: true }); put(155, range); line(30);
  [88, 195, 298, 401, 504].forEach((x, i) => put(x, String(counts[i]), { size: 14 })); line(20);
  ["Activity Reports", "Tours Completed", "Total Incidents", "High Severity Incidents", "Medium Severity Incidents"].forEach((t, i) => put([67, 167, 275, 364, 461][i], t, { size: 7 })); line(30);
  put(117, "Activity/"); line(7);
  put(49, "!"); put(61, "Time"); put(191, "Details"); put(415, "Photo"); line(6);
  put(117, "Ofﬁcer"); line(17);
  for (const day of days) {
    put(49, day.date, { bold: true }); line(15);
    for (const e of day.entries) {
      put(61, `${e.flag ? "! " : ""}${e.time}`); put(117, e.type); if (e.title) put(191, e.title); line(10);
      if (e.status) { put(117, e.status); }
      if (e.checkpoint) { put(191, `✓ ${e.checkpoint} completed`); }
      for (const [i, t] of (e.lines || []).entries()) { if (i) line(10); put(191, t); }
      if (e.status || e.checkpoint || e.lines?.length) line(10);
      for (const q of e.answers || []) { put(221, q); line(10); }
      put(117, e.officer); line(16);
    }
  }
  page.push({ x: 558, y: 774, text: String(pages.length) });
  return makePdf(pages);
}

/** A night: one officer's shift, a report, a patrol of three checkpoints (one answered N), an incident. */
const SAMPLE_DAYS = [{
  date: "Jan 4th, 2027",
  entries: [
    { time: "5:00 PM EST", type: "Clock-in", title: "Jo Guard clocked in at the Example Site - Evening", lines: ["post"], officer: "Jo Guard" },
    { time: "5:05 PM EST", type: "Activity Report", title: "Report for Duty", status: "Filed", lines: ["On duty as patrol officer from 1700hrs to midnight. Spoke", "with the building manager about the loading dock.", "Location: Suite 100"], officer: "Jo Guard" },
    { time: "5:10 PM EST", type: "Tour Started", title: "Example Patrol started", officer: "Jo Guard" },
    { time: "5:12 PM EST", type: "Checkpoint", status: "Scanned", checkpoint: "Vault - Entrance", answers: ["Is this SCIF Armed? Yes/No: Y"], officer: "Jo Guard" },
    { time: "5:13 PM EST", type: "Checkpoint", status: "Scanned", checkpoint: "Stairwell A", officer: "Jo Guard" },
    { time: "5:14 PM EST", type: "Checkpoint", status: "Scanned", checkpoint: "Lab - Entrance", answers: ["Is this SCIF Armed? Yes/No: N"], officer: "Jo Guard" },
    { time: "5:20 PM EST", type: "Tour Ended", title: "Example Patrol ended", lines: ["Summary: All secure, lab left open by", "a late worker."], officer: "Jo Guard" },
    { time: "9:40 PM EST", type: "Incident Report", title: "Door propped open", status: "Filed", flag: true, lines: ["Found the dock door propped with a chair. Closed it.", "Location: Loading dock"], officer: "Jo Guard" },
    { time: "11:58 PM EST", type: "Clock-out", officer: "Jo Guard" }
  ]
}];

// --- files the mail might be dropped in as ---------------------------------------------------------

/** UTF-16LE with no terminator, as .msg string properties are. */
const utf16 = (s) => Buffer.from(String(s), "utf16le");

/**
 * An Outlook .msg: a compound file with the message's properties, its delivery time in the
 * fixed-size property stream, and its attachments as storages of their own.
 */
function msgFile({ subject = "", html = "", from = "", messageId = null, receivedAt = null, attachments = [] }) {
  const props = (fixed, headerSize) => {
    const head = Buffer.alloc(headerSize);
    const rows = fixed.map(([type, id, value]) => {
      const b = Buffer.alloc(16);
      b.writeUInt16LE(type, 0);
      b.writeUInt16LE(id, 2);
      b.writeUInt32LE(6, 4);
      b.writeBigUInt64LE(value, 8);
      return b;
    });
    return Buffer.concat([head, ...rows]);
  };
  const filetime = (ms) => (BigInt(ms) + 11644473600000n) * 10000n;
  const root = { name: "Root Entry", type: 5, children: [] };
  const stream = (parent, name, data) => parent.children.push({ name, type: 2, data });
  stream(root, "__substg1.0_0037001F", utf16(subject));
  if (html) stream(root, "__substg1.0_10130102", Buffer.from(html, "utf8"));
  if (from) stream(root, "__substg1.0_5D01001F", utf16(from));
  if (messageId) stream(root, "__substg1.0_1035001F", utf16(messageId));
  stream(root, "__properties_version1.0", props(receivedAt ? [[0x0040, 0x0e06, filetime(receivedAt)]] : [], 32));
  attachments.forEach((a, i) => {
    const s = { name: `__attach_version1.0_#${String(i).padStart(8, "0")}`, type: 1, children: [] };
    stream(s, "__substg1.0_3707001F", utf16(a.name));
    stream(s, "__substg1.0_370E001F", utf16(a.type || "application/octet-stream"));
    stream(s, "__substg1.0_37010102", a.data);
    stream(s, "__properties_version1.0", props([], 8));
    root.children.push(s);
  });
  return compoundFile(root);
}

/** Writes a compound file (512-byte sectors; streams under 4096 bytes in the mini stream). */
function compoundFile(root) {
  const SECTOR = 512;
  const MINI = 64;
  const CUTOFF = 4096;
  const END = 0xfffffffe;
  const FREE = 0xffffffff;
  const entries = [];
  const walk = (node) => { node.id = entries.length; entries.push(node); (node.children || []).forEach(walk); };
  walk(root);
  // The mini stream: every small stream, in 64-byte sectors.
  const mini = [];
  const miniFat = [];
  for (const e of entries.filter((x) => x.type === 2 && x.data.length < CUTOFF)) {
    const n = Math.max(1, Math.ceil(e.data.length / MINI));
    e.start = mini.length;
    for (let i = 0; i < n; i += 1) {
      mini.push(Buffer.concat([e.data.subarray(i * MINI, (i + 1) * MINI)], MINI));
      miniFat.push(i === n - 1 ? END : e.start + i + 1);
    }
  }
  // Sectors: the big streams, the mini stream, the mini FAT, the directory, then the FAT.
  const sectors = [];
  const fat = [];
  const place = (data) => {
    const n = Math.max(1, Math.ceil(data.length / SECTOR));
    const start = sectors.length;
    for (let i = 0; i < n; i += 1) {
      sectors.push(Buffer.concat([data.subarray(i * SECTOR, (i + 1) * SECTOR)], SECTOR));
      fat.push(i === n - 1 ? END : start + i + 1);
    }
    return start;
  };
  for (const e of entries.filter((x) => x.type === 2 && x.data.length >= CUTOFF)) e.start = place(e.data);
  const miniData = Buffer.concat(mini);
  root.start = mini.length ? place(miniData) : END;
  root.size = miniData.length;
  const miniFatBuf = Buffer.alloc(Math.ceil((miniFat.length * 4) / SECTOR) * SECTOR, 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, i * 4));
  const miniFatStart = miniFat.length ? place(miniFatBuf) : END;
  const dir = Buffer.alloc(Math.ceil(entries.length / 4) * 4 * 128);
  entries.forEach((e, i) => {
    const off = i * 128;
    const name = Buffer.from(`${e.name}\0`, "utf16le");
    name.copy(dir, off, 0, 64);
    dir.writeUInt16LE(name.length, off + 0x40);
    dir[off + 0x42] = e.type;
    dir[off + 0x43] = 1;
    // Children hang from the first child, linked by their right-hand pointers.
    dir.writeUInt32LE(FREE, off + 0x44);
    const siblings = (entries.find((p) => (p.children || []).includes(e))?.children) || [];
    const next = siblings[siblings.indexOf(e) + 1];
    dir.writeUInt32LE(next ? next.id : FREE, off + 0x48);
    dir.writeUInt32LE(e.children?.length ? e.children[0].id : FREE, off + 0x4c);
    dir.writeUInt32LE(e.type === 2 || e.type === 5 ? e.start ?? END : 0, off + 0x74);
    dir.writeUInt32LE(e.type === 2 ? e.data.length : e.type === 5 ? e.size : 0, off + 0x78);
  });
  for (let i = entries.length; i < dir.length / 128; i += 1) {
    dir.writeUInt32LE(FREE, i * 128 + 0x44);
    dir.writeUInt32LE(FREE, i * 128 + 0x48);
    dir.writeUInt32LE(FREE, i * 128 + 0x4c);
  }
  const dirStart = place(dir);
  // The FAT itself: enough sectors to cover every sector, its own included.
  let fatCount = 1;
  while ((sectors.length + fatCount) * 4 > fatCount * SECTOR) fatCount += 1;
  const fatStart = sectors.length;
  for (let i = 0; i < fatCount; i += 1) fat.push(0xfffffffd);
  const fatBuf = Buffer.alloc(fatCount * SECTOR, 0xff);
  fat.forEach((v, i) => fatBuf.writeUInt32LE(v, i * 4));
  for (let i = 0; i < fatCount; i += 1) sectors.push(fatBuf.subarray(i * SECTOR, (i + 1) * SECTOR));
  const header = Buffer.alloc(SECTOR, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(fatCount, 0x2c);
  header.writeUInt32LE(dirStart, 0x30);
  header.writeUInt32LE(CUTOFF, 0x38);
  header.writeUInt32LE(miniFatStart, 0x3c);
  header.writeUInt32LE(miniFat.length ? miniFatBuf.length / SECTOR : 0, 0x40);
  header.writeUInt32LE(END, 0x44);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i < fatCount ? fatStart + i : FREE, 0x4c + i * 4);
  return Buffer.concat([header, ...sectors]);
}

/** An .eml: multipart, the HTML quoted-printable, an attachment in base64, the subject encoded. */
function emlFile({ subject = "", html = "", from = "", messageId = null, date = "Mon, 04 Jan 2027 12:00:00 +0000", attachments = [] }) {
  const qp = (s) => Buffer.from(s, "utf8").toString("latin1").replace(/[=\x80-\xff]/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  const parts = [
    `--b1\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp(html)}`,
    ...attachments.map((a) => `--b1\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${a.data.toString("base64").replace(/(.{76})/g, "$1\r\n")}`)
  ];
  return Buffer.from([
    `From: ${from}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    `Date: ${date}`,
    messageId ? `Message-ID: ${messageId}` : null,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed;",
    "  boundary=\"b1\"",
    "",
    // Each part, then the CRLF that belongs to the boundary after it.
    parts.join("\r\n"),
    "--b1--",
    ""
  ].filter((l) => l !== null).join("\r\n"), "latin1");
}

module.exports = { alarmHtml, SAMPLE_LOG, guardPdf, SAMPLE_DAYS, makePdf, msgFile, emlFile };

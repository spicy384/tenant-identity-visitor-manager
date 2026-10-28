/**
 * Reads an email saved as a file, for Security to drop in by hand what the mailbox would
 * have brought (security-mail.js): an Outlook .msg (dragged out of Outlook) or an .eml (saved
 * from Outlook on the web and most other mail programs).
 *
 * Both come out the same: { messageId, subject, from, receivedAt (ms or null), html, text,
 * attachments: [{ name, type, data (Buffer) }] }.
 *
 * Only node itself is used. A .msg is a compound file (the format of old Office documents):
 * a little file system of sectors, with a directory of streams. The message's properties
 * are streams named __substg1.0_<id><type>; its attachments are storages of their own. An
 * .eml is MIME: headers, then a body that may be in parts, each with its own encoding.
 */

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// --- compound files (.msg) -----------------------------------------------------------------------

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe;
const FREE = 0xffffffff;
const NONE = 0xffffffff;

/** The streams of a compound file: a tree of { name, type, children, data() }. */
function readCompound(buf) {
  if (buf.length < 512 || !buf.subarray(0, 8).equals(CFB_MAGIC)) throw fail(400, "That isn't an Outlook message (.msg) file.");
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  const firstDir = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const firstDifat = buf.readUInt32LE(0x44);
  const sectorAt = (sid) => {
    const start = (sid + 1) * sectorSize;
    if (start + sectorSize > buf.length + sectorSize) throw fail(400, "That .msg file is cut short.");
    return buf.subarray(start, Math.min(start + sectorSize, buf.length));
  };
  // The FAT's own sectors: 109 in the header, then the DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = buf.readUInt32LE(0x4c + i * 4);
    if (sid !== FREE && sid !== END) fatSectors.push(sid);
  }
  for (let sid = firstDifat, guard = 0; sid !== END && sid !== FREE && guard < 100000; guard += 1) {
    const s = sectorAt(sid);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i += 1) {
      const v = s.readUInt32LE(i * 4);
      if (v !== FREE && v !== END) fatSectors.push(v);
    }
    sid = s.readUInt32LE(per * 4);
  }
  const fat = [];
  for (const sid of fatSectors) {
    const s = sectorAt(sid);
    for (let i = 0; i + 4 <= s.length; i += 4) fat.push(s.readUInt32LE(i));
  }
  const chain = (start, table) => {
    const out = [];
    const seen = new Set();
    for (let sid = start; sid !== END && sid !== FREE && sid < table.length && !seen.has(sid); sid = table[sid]) {
      seen.add(sid);
      out.push(sid);
    }
    return out;
  };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sectorAt));
  const dirData = readChain(firstDir);
  const entries = [];
  for (let off = 0; off + 128 <= dirData.length; off += 128) {
    const nameLen = dirData.readUInt16LE(off + 0x40);
    entries.push({
      name: dirData.toString("utf16le", off, off + Math.max(0, nameLen - 2)),
      type: dirData[off + 0x42],
      left: dirData.readUInt32LE(off + 0x44),
      right: dirData.readUInt32LE(off + 0x48),
      child: dirData.readUInt32LE(off + 0x4c),
      start: dirData.readUInt32LE(off + 0x74),
      size: dirData.readUInt32LE(off + 0x78)
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw fail(400, "That .msg file has no root.");
  const miniStream = readChain(root.start);
  const miniFat = [];
  if (firstMiniFat !== END && firstMiniFat !== FREE) {
    const data = readChain(firstMiniFat);
    for (let i = 0; i + 4 <= data.length; i += 4) miniFat.push(data.readUInt32LE(i));
  }
  const dataOf = (e) => {
    if (e.size < cutoff) {
      return Buffer.concat(chain(e.start, miniFat).map((sid) => miniStream.subarray(sid * miniSize, sid * miniSize + miniSize))).subarray(0, e.size);
    }
    return readChain(e.start).subarray(0, e.size);
  };
  // A storage's children are a red-black tree hung from its child pointer.
  const childrenOf = (e) => {
    const out = [];
    const stack = [e.child];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === NONE || id >= entries.length || seen.has(id)) continue;
      seen.add(id);
      const c = entries[id];
      out.push(c);
      stack.push(c.left, c.right);
    }
    return out;
  };
  const node = (e) => ({ name: e.name, type: e.type, children: () => childrenOf(e).map(node), data: () => dataOf(e) });
  return node(root);
}

const FILETIME_EPOCH = 11644473600000n;

/** The properties of a .msg storage (the message, or an attachment): id (number) -> value. */
function msgProps(storage, headerSize) {
  const props = new Map();
  for (const c of storage.children()) {
    const m = /^__substg1\.0_([0-9A-F]{4})([0-9A-F]{4})$/i.exec(c.name);
    if (m && c.type === 2) {
      const id = parseInt(m[1], 16);
      const type = parseInt(m[2], 16);
      const data = c.data();
      if (type === 0x001f) props.set(id, data.toString("utf16le").replace(/\0+$/, ""));
      else if (type === 0x001e) props.set(id, data.toString("latin1").replace(/\0+$/, ""));
      else if (type === 0x0102) props.set(id, data);
    }
    // Fixed-size values (times) are in one stream after a header.
    if (c.name === "__properties_version1.0" && c.type === 2) {
      const data = c.data();
      for (let off = headerSize; off + 16 <= data.length; off += 16) {
        const type = data.readUInt16LE(off);
        const id = data.readUInt16LE(off + 2);
        if (type === 0x0040) {
          const ft = data.readBigUInt64LE(off + 8);
          if (ft) props.set(id, Number(ft / 10000n - FILETIME_EPOCH));
        }
      }
    }
  }
  return props;
}

/** An Outlook .msg file as a message. */
function readMsg(buf) {
  const root = readCompound(buf);
  const p = msgProps(root, 32);
  const headers = typeof p.get(0x007d) === "string" ? parseHeaders(p.get(0x007d)) : new Map();
  const htmlProp = p.get(0x1013);
  const html = Buffer.isBuffer(htmlProp) ? decodeHtmlBytes(htmlProp) : typeof htmlProp === "string" ? htmlProp : "";
  const attachments = [];
  for (const c of root.children()) {
    if (c.type !== 1 || !c.name.startsWith("__attach_version1.0_")) continue;
    const a = msgProps(c, 8);
    const data = a.get(0x3701);
    if (!Buffer.isBuffer(data)) continue;
    attachments.push({ name: a.get(0x3707) || a.get(0x3704) || "attachment", type: a.get(0x370e) || "", data });
  }
  const dateHeader = headers.get("date");
  return {
    messageId: p.get(0x1035) || headers.get("message-id") || null,
    subject: p.get(0x0037) || "",
    from: p.get(0x5d01) || p.get(0x0c1f) || p.get(0x0065) || "",
    receivedAt: p.get(0x0e06) || p.get(0x0039) || (dateHeader && !Number.isNaN(Date.parse(dateHeader)) ? Date.parse(dateHeader) : null),
    html,
    text: p.get(0x1000) || "",
    attachments
  };
}

/** HTML bytes in the charset its own meta tag names (UTF-8 when it names none). */
function decodeHtmlBytes(buf) {
  const head = buf.toString("latin1", 0, 2048);
  const charset = /charset=["']?([\w-]+)/i.exec(head)?.[1] || "utf-8";
  return decodeCharset(buf, charset);
}

function decodeCharset(buf, charset) {
  try {
    return new TextDecoder(String(charset).toLowerCase()).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

// --- MIME (.eml) ---------------------------------------------------------------------------------

/** Headers (unfolded, names in lower case; the first of each kind). */
function parseHeaders(text) {
  const out = new Map();
  for (const line of String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(at + 1).trim());
  }
  return out;
}

/** =?charset?B|Q?...?= words in a header. */
function decodeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (m, charset, enc, data) => {
    const bytes = enc.toLowerCase() === "b" ? Buffer.from(data, "base64") : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return decodeCharset(bytes, charset);
  });
}

/** A header's parameter (boundary, charset, name, filename), RFC 2231 forms included. */
function param(header, key) {
  const h = String(header || "");
  const star = new RegExp(`;\\s*${key}\\*=([^']*)'[^']*'([^;]+)`, "i").exec(h);
  if (star) return decodeCharset(Buffer.from(decodeURIComponent(star[2].trim()).split("").map((c) => c.charCodeAt(0) & 0xff)), star[1] || "utf-8");
  const parts = [...h.matchAll(new RegExp(`;\\s*${key}\\*(\\d+)\\*?=("?)([^";]*)\\2`, "gi"))];
  if (parts.length) return parts.sort((a, b) => a[1] - b[1]).map((p) => p[3]).join("");
  const plain = new RegExp(`;\\s*${key}=("([^"]*)"|[^;\\s]+)`, "i").exec(h);
  return plain ? decodeWords(plain[2] ?? plain[1]) : null;
}

function decodeBody(raw, encoding) {
  const enc = String(encoding || "").toLowerCase();
  if (enc === "base64") return Buffer.from(raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") {
    const s = raw.toString("latin1").replace(/=\r?\n/g, "");
    return Buffer.from(s.replace(/=([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  }
  return raw;
}

/** Walks a MIME entity, collecting the HTML and text bodies and the attachments. */
function walkMime(buf, out, depth = 0) {
  if (depth > 12) return;
  let split = buf.indexOf("\r\n\r\n");
  let sepLen = 4;
  const lf = buf.indexOf("\n\n");
  if (split < 0 || (lf >= 0 && lf < split)) { split = lf; sepLen = 2; }
  const head = parseHeaders(buf.toString("latin1", 0, split < 0 ? buf.length : split));
  const body = split < 0 ? Buffer.alloc(0) : buf.subarray(split + sepLen);
  const type = (head.get("content-type") || "text/plain").split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = param(head.get("content-type"), "boundary");
    if (!boundary) return;
    const marker = Buffer.from(`--${boundary}`, "latin1");
    let pos = body.indexOf(marker);
    while (pos >= 0) {
      let start = pos + marker.length;
      if (body.toString("latin1", start, start + 2) === "--") break;
      if (body[start] === 0x0d) start += 1;
      if (body[start] === 0x0a) start += 1;
      const next = body.indexOf(marker, start);
      let end = next < 0 ? body.length : next;
      if (body[end - 1] === 0x0a) end -= 1;
      if (body[end - 1] === 0x0d) end -= 1;
      walkMime(body.subarray(start, end), out, depth + 1);
      pos = next;
    }
    return;
  }
  const data = decodeBody(body, head.get("content-transfer-encoding"));
  const disposition = head.get("content-disposition") || "";
  const name = param(disposition, "filename") || param(head.get("content-type"), "name");
  if (type === "message/rfc822" && !name) return walkMime(data, out, depth + 1);
  if (!name && !/^attachment/i.test(disposition) && (type === "text/html" || type === "text/plain")) {
    const text = decodeCharset(data, param(head.get("content-type"), "charset") || "utf-8");
    if (type === "text/html" && !out.html) out.html = text;
    if (type === "text/plain" && !out.text) out.text = text;
    return;
  }
  out.attachments.push({ name: name || "attachment", type, data });
}

/** An .eml file as a message. */
function readEml(buf) {
  const headEnd = buf.indexOf("\n\n") >= 0 || buf.indexOf("\r\n\r\n") >= 0;
  const head = parseHeaders(buf.toString("latin1", 0, Math.min(buf.length, 65536)).split(/\r?\n\r?\n/)[0]);
  if (!headEnd || (!head.has("from") && !head.has("subject") && !head.has("content-type"))) throw fail(400, "That isn't an email (.eml) file.");
  const out = { html: "", text: "", attachments: [] };
  walkMime(buf, out);
  const date = head.get("date");
  return {
    messageId: head.get("message-id") || null,
    subject: decodeWords(head.get("subject") || ""),
    from: decodeWords(head.get("from") || ""),
    receivedAt: date && !Number.isNaN(Date.parse(date)) ? Date.parse(date) : null,
    ...out
  };
}

/** A .msg or .eml file, told apart by what is in it. */
function readMailFile(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw fail(400, "The file is empty.");
  return buf.subarray(0, 8).equals(CFB_MAGIC) ? readMsg(buf) : readEml(buf);
}

module.exports = { readMailFile, readMsg, readEml, parseHeaders, CFB_MAGIC };

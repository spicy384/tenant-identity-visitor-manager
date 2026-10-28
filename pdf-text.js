/**
 * The text of a PDF, with where each piece sits on its page: enough to read a report laid
 * out in columns (security-mail.js reads the guard company's daily activity report with it).
 *
 * Only node's own zlib is used. It reads the PDF's objects (and object streams), walks the
 * page tree in order, and runs each page's content (and the forms it draws) far enough to
 * know where text is shown: the graphics state's matrix, the text matrix, and the font. Text is
 * turned into characters through each font's ToUnicode map, or for a simple font without one
 * as Latin-1. Glyph widths aren't read: text shown without moving on is joined to the piece
 * before it, and a TJ gap wider than a third of the font size is taken as a space.
 *
 * It isn't a full PDF reader: encrypted PDFs, and filters other than Flate and ASCIIHex,
 * aren't read (their text comes out empty), which says so rather than guessing.
 */
const zlib = require("zlib");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// --- objects ---------------------------------------------------------------------------------

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen; }
}
class Name {
  constructor(name) { this.name = name; }
}
class Op {
  constructor(op) { this.op = op; }
}

/** Reads PDF tokens and objects from `buf` (a Buffer) starting at `pos`. */
class Lexer {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }

  skip() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos += 1;
      else if (c === 0x25) { while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos += 1; }
      else break;
    }
  }

  /** The next token: a number, string (Buffer), Name, "[", "]", "<<", ">>", "{", "}", or an Op (a bare word). */
  token() {
    this.skip();
    const b = this.buf;
    if (this.pos >= b.length) return null;
    const c = b[this.pos];
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { this.pos += 2; return "<<"; }
      return this.hex();
    }
    if (c === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; return ">>"; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { this.pos += 1; return String.fromCharCode(c); }
    if (c === 0x2f) {
      this.pos += 1;
      let s = "";
      while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) {
        if (b[this.pos] === 0x23 && /^[0-9a-f]{2}$/i.test(b.toString("latin1", this.pos + 1, this.pos + 3))) {
          s += String.fromCharCode(parseInt(b.toString("latin1", this.pos + 1, this.pos + 3), 16));
          this.pos += 3;
        } else {
          s += String.fromCharCode(b[this.pos]);
          this.pos += 1;
        }
      }
      return new Name(s);
    }
    const start = this.pos;
    while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos += 1;
    if (this.pos === start) { this.pos += 1; return new Op(String.fromCharCode(c)); }
    const word = b.toString("latin1", start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    return new Op(word);
  }

  literal() {
    const b = this.buf;
    this.pos += 1;
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos];
      this.pos += 1;
      if (c === 0x5c) {
        const n = b[this.pos];
        this.pos += 1;
        const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (map[n] !== undefined) out.push(map[n]);
        else if (n >= 0x30 && n <= 0x37) {
          let oct = n - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k += 1) { oct = oct * 8 + (b[this.pos] - 0x30); this.pos += 1; }
          out.push(oct & 0xff);
        } else if (n === 0x0d) { if (b[this.pos] === 0x0a) this.pos += 1; }
        else if (n !== 0x0a) out.push(n);
      } else if (c === 0x28) { depth += 1; out.push(c); }
      else if (c === 0x29) { depth -= 1; if (!depth) break; out.push(c); }
      else out.push(c);
    }
    return Buffer.from(out);
  }

  hex() {
    const b = this.buf;
    const end = b.indexOf(0x3e, this.pos);
    const text = b.toString("latin1", this.pos + 1, end < 0 ? b.length : end).replace(/[^0-9a-f]/gi, "");
    this.pos = end < 0 ? b.length : end + 1;
    return Buffer.from(text.length % 2 ? `${text}0` : text, "hex");
  }

  /** The next object; numbers followed by "n R" become a Ref. */
  object(tok = this.token()) {
    if (tok === "<<") {
      const dict = {};
      for (;;) {
        const k = this.token();
        if (k === ">>" || k === null) return dict;
        if (k instanceof Name) dict[k.name] = this.object();
      }
    }
    if (tok === "[") {
      const arr = [];
      for (;;) {
        const t = this.token();
        if (t === "]" || t === null) return arr;
        arr.push(this.object(t));
      }
    }
    if (typeof tok === "number" && Number.isInteger(tok)) {
      const save = this.pos;
      const gen = this.token();
      if (typeof gen === "number" && Number.isInteger(gen)) {
        const r = this.token();
        if (r instanceof Op && r.op === "R") return new Ref(tok, gen);
      }
      this.pos = save;
    }
    if (tok instanceof Op) {
      if (tok.op === "true") return true;
      if (tok.op === "false") return false;
      if (tok.op === "null") return null;
    }
    return tok;
  }
}

/** Every object in the file by number: { value, stream (raw bytes, still encoded) }. */
function readObjects(buf) {
  const objects = new Map();
  const head = /(\d+)\s+(\d+)\s+obj\b/g;
  const text = buf.toString("latin1");
  let m;
  while ((m = head.exec(text))) {
    const lex = new Lexer(buf, m.index + m[0].length);
    let value;
    try {
      value = lex.object();
    } catch {
      continue;
    }
    let stream = null;
    lex.skip();
    if (value && typeof value === "object" && !Array.isArray(value) && text.startsWith("stream", lex.pos)) {
      let start = lex.pos + 6;
      if (buf[start] === 0x0d) start += 1;
      if (buf[start] === 0x0a) start += 1;
      const len = typeof value.Length === "number" ? value.Length : -1;
      const end = len >= 0 && text.startsWith("endstream", skipWs(buf, start + len)) ? start + len : text.indexOf("endstream", start);
      stream = buf.subarray(start, end < 0 ? buf.length : end);
      head.lastIndex = end < 0 ? buf.length : end;
    }
    // A later object of the same number (an incremental update) wins.
    objects.set(Number(m[1]), { value, stream });
  }
  return objects;
}

function skipWs(buf, pos) {
  while (pos < buf.length && WS.has(buf[pos])) pos += 1;
  return pos;
}

function decode(dict, data) {
  let filters = dict.Filter;
  if (!filters) return data;
  if (!Array.isArray(filters)) filters = [filters];
  let out = data;
  for (const f of filters) {
    const name = f instanceof Name ? f.name : "";
    if (name === "FlateDecode" || name === "Fl") {
      try {
        out = zlib.inflateSync(out);
      } catch {
        try { out = zlib.inflateSync(out, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
      }
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      out = Buffer.from(out.toString("latin1").replace(/>.*$/s, "").replace(/[^0-9a-f]/gi, ""), "hex");
    } else {
      return null;
    }
  }
  return out;
}

/** A PDF's objects, with references followed. */
function openPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.toString("latin1", 0, 1024).indexOf("%PDF-") < 0) throw fail(400, "That file isn't a PDF.");
  const objects = readObjects(buf);
  // Objects kept inside object streams.
  for (const [, o] of [...objects]) {
    if (!o.stream || !(o.value.Type instanceof Name) || o.value.Type.name !== "ObjStm") continue;
    const data = decode(o.value, o.stream);
    if (!data) continue;
    const lex = new Lexer(data);
    const pairs = [];
    for (let i = 0; i < o.value.N; i += 1) pairs.push([lex.token(), lex.token()]);
    for (const [num, off] of pairs) {
      if (objects.has(num)) continue;
      try { objects.set(num, { value: new Lexer(data, o.value.First + off).object(), stream: null }); } catch { /* skip */ }
    }
  }
  const get = (v) => {
    for (let i = 0; v instanceof Ref && i < 32; i += 1) v = objects.get(v.num)?.value ?? null;
    return v;
  };
  const streamOf = (v) => {
    const o = v instanceof Ref ? objects.get(v.num) : null;
    return o?.stream ? decode(o.value, o.stream) : null;
  };
  const trailerAt = buf.lastIndexOf("trailer");
  let root = null;
  if (trailerAt >= 0) {
    const t = new Lexer(buf, trailerAt + 7).object();
    if (t?.Encrypt) throw fail(400, "That PDF is encrypted, so its text can't be read.");
    root = get(t?.Root);
  }
  if (!root) root = [...objects.values()].map((o) => o.value).find((v) => v && v.Type instanceof Name && v.Type.name === "Catalog");
  if (!root) {
    const xref = [...objects.values()].map((o) => o.value).find((v) => v && v.Type instanceof Name && v.Type.name === "XRef");
    if (xref?.Encrypt) throw fail(400, "That PDF is encrypted, so its text can't be read.");
    root = get(xref?.Root);
  }
  if (!root) throw fail(400, "That PDF has no pages that can be read.");
  return { get, streamOf, root };
}

// --- fonts -----------------------------------------------------------------------------------

/** A ToUnicode CMap: { bytes (code length), map (code -> text) }. */
function parseCMap(data) {
  const text = data.toString("latin1");
  const map = new Map();
  let bytes = 1;
  const range = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (range) {
    const first = /<([0-9a-f]+)>/i.exec(range[1]);
    if (first) bytes = Math.max(1, first[1].length / 2);
  }
  const utf16 = (hex) => {
    const b = Buffer.from(hex.length % 4 ? hex.padStart(Math.ceil(hex.length / 4) * 4, "0") : hex, "hex");
    for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
    return b.toString("utf16le");
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(m[1], 16), utf16(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f]*>|\[[^\]]*\])/gi)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3].startsWith("[")) {
        const list = [...m[3].matchAll(/<([0-9a-f]*)>/gi)].map((x) => x[1]);
        for (let c = lo; c <= hi && c - lo < list.length; c += 1) map.set(c, utf16(list[c - lo]));
      } else {
        const start = m[3].slice(1, -1);
        const base = Buffer.from(start.length % 4 ? start.padStart(Math.ceil(start.length / 4) * 4, "0") : start, "hex");
        for (let c = lo; c <= hi; c += 1) {
          const b = Buffer.from(base);
          // The last UTF-16 unit counts up through the range.
          const last = b.readUInt16BE(b.length - 2) + (c - lo);
          b.writeUInt16BE(last & 0xffff, b.length - 2);
          map.set(c, utf16(b.toString("hex")));
        }
      }
    }
  }
  return { bytes, map };
}

/**
 * How to turn a font's string bytes into text, and how far each code moves the pen:
 * { glyphs(buf) -> [{ text, width (in thousandths of the font size), space }] }.
 */
function fontDecoder(pdf, fontRef, cache) {
  const key = fontRef instanceof Ref ? fontRef.num : null;
  if (key !== null && cache.has(key)) return cache.get(key);
  const font = pdf.get(fontRef) || {};
  const sub = font.Subtype instanceof Name ? font.Subtype.name : "";
  const twoByte = sub === "Type0";
  const cmapData = font.ToUnicode ? pdf.streamOf(font.ToUnicode) : null;
  const cmap = cmapData ? parseCMap(cmapData) : null;
  const bytes = cmap ? cmap.bytes : twoByte ? 2 : 1;
  // Widths: a composite font's from its descendant (W, DW), by CID (Identity: the code); a
  // simple font's from Widths and FirstChar; a Type3 font's scaled by its FontMatrix.
  const widths = new Map();
  let fallback = 500;
  if (twoByte) {
    const desc = pdf.get((pdf.get(font.DescendantFonts) || [])[0]) || {};
    fallback = typeof desc.DW === "number" ? desc.DW : 1000;
    const w = pdf.get(desc.W) || [];
    for (let i = 0; i < w.length;) {
      const first = w[i];
      const next = pdf.get(w[i + 1]);
      if (Array.isArray(next)) {
        next.forEach((v, k) => widths.set(first + k, Number(pdf.get(v)) || 0));
        i += 2;
      } else {
        const width = Number(pdf.get(w[i + 2])) || 0;
        for (let c = first; c <= next && c - first < 65536; c += 1) widths.set(c, width);
        i += 3;
      }
    }
  } else {
    const list = pdf.get(font.Widths) || [];
    const firstChar = Number(font.FirstChar) || 0;
    const scale = sub === "Type3" && Array.isArray(font.FontMatrix) ? Number(font.FontMatrix[0]) * 1000 : 1;
    list.forEach((v, k) => widths.set(firstChar + k, (Number(pdf.get(v)) || 0) * scale));
    if (sub === "Type3") fallback = 0;
  }
  const glyphs = (buf) => {
    const out = [];
    for (let i = 0; i + bytes <= buf.length; i += bytes) {
      const code = bytes === 2 ? buf.readUInt16BE(i) : bytes === 1 ? buf[i] : parseInt(buf.toString("hex", i, i + bytes), 16);
      const text = cmap ? cmap.map.get(code) ?? "" : twoByte ? "" : String.fromCharCode(code);
      out.push({ text, width: widths.get(code) ?? fallback, space: bytes === 1 && code === 32 });
    }
    return out;
  };
  const decoder = { glyphs };
  if (key !== null) cache.set(key, decoder);
  return decoder;
}

// --- content ---------------------------------------------------------------------------------

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]
];
const ID = [1, 0, 0, 1, 0, 0];

/** Runs a content stream, adding { x, end, y, size, text } for each run of text to `items`. */
function runContent(pdf, data, resources, ctm, items, fonts, depth = 0) {
  if (!data || depth > 8) return;
  const res = pdf.get(resources) || {};
  const fontDict = pdf.get(res.Font) || {};
  const xobjects = pdf.get(res.XObject) || {};
  const lex = new Lexer(data);
  const stack = [];
  let gs = { ctm };
  const saved = [];
  let tm = ID;
  let tlm = ID;
  let font = null;
  let size = 0;
  let leading = 0;
  let charSpace = 0;
  let wordSpace = 0;
  let hScale = 1;
  // Shows a string: one item, its start and end on the page; the pen moves on past it.
  const show = (buf) => {
    if (!font || !Buffer.isBuffer(buf)) return;
    const start = mul(tm, gs.ctm);
    let text = "";
    let advance = 0;
    for (const g of font.glyphs(buf)) {
      text += g.text;
      advance += ((g.width / 1000) * size + charSpace + (g.space ? wordSpace : 0)) * hScale;
    }
    tm = mul([1, 0, 0, 1, advance, 0], tm);
    const end = mul(tm, gs.ctm);
    if (text) items.push({ x: start[4], end: end[4], y: start[5], size: Math.abs(size * Math.hypot(start[2], start[3])) || size, text });
  };
  const moveTo = (tx, ty) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const num = (k) => Number(stack[stack.length - k]) || 0;
  for (;;) {
    const tok = lex.token();
    if (tok === null) break;
    if (!(tok instanceof Op)) {
      stack.push(tok === "[" || tok === "<<" ? lex.object(tok) : tok);
      continue;
    }
    const last = stack[stack.length - 1];
    switch (tok.op) {
      case "q": saved.push(gs); gs = { ...gs }; break;
      case "Q": gs = saved.pop() || gs; break;
      case "cm": if (stack.length >= 6) gs.ctm = mul(stack.slice(-6).map(Number), gs.ctm); break;
      case "BT": tm = ID; tlm = ID; break;
      case "Tf": if (stack.length >= 2) { font = fontDecoder(pdf, fontDict[stack[stack.length - 2]?.name], fonts); size = num(1); } break;
      case "TL": leading = num(1); break;
      case "Tc": charSpace = num(1); break;
      case "Tw": wordSpace = num(1); break;
      case "Tz": hScale = num(1) / 100; break;
      case "Td": moveTo(num(2), num(1)); break;
      case "TD": leading = -num(1); moveTo(num(2), num(1)); break;
      case "Tm": if (stack.length >= 6) { tlm = stack.slice(-6).map(Number); tm = tlm; } break;
      case "T*": moveTo(0, -leading); break;
      case "Tj": show(last); break;
      case "'": moveTo(0, -leading); show(last); break;
      case "\"": wordSpace = num(3); charSpace = num(2); moveTo(0, -leading); show(last); break;
      case "TJ":
        if (Array.isArray(last)) {
          for (const part of last) {
            if (Buffer.isBuffer(part)) show(part);
            else if (typeof part === "number") tm = mul([1, 0, 0, 1, (-part / 1000) * size * hScale, 0], tm);
          }
        }
        break;
      case "Do": {
        const xo = xobjects[last?.name];
        const x = pdf.get(xo);
        if (x && x.Subtype instanceof Name && x.Subtype.name === "Form") {
          const matrix = Array.isArray(x.Matrix) ? x.Matrix.map(Number) : ID;
          runContent(pdf, pdf.streamOf(xo), x.Resources || resources, mul(matrix, gs.ctm), items, fonts, depth + 1);
        }
        break;
      }
      case "BI": {
        // Inline image data: skip to EI.
        const end = data.indexOf("EI", lex.pos);
        lex.pos = end < 0 ? data.length : end + 2;
        break;
      }
      default: break;
    }
    stack.length = 0;
  }
}

/** The pages of the page tree, in order, each with its inherited resources. */
function pagesOf(pdf) {
  const out = [];
  const walk = (ref, inherited, depth) => {
    const node = pdf.get(ref);
    if (!node || depth > 32) return;
    const resources = node.Resources || inherited.resources;
    const box = node.MediaBox || inherited.box;
    if (Array.isArray(node.Kids)) for (const kid of node.Kids) walk(kid, { resources, box }, depth + 1);
    else out.push({ node, resources, box });
  };
  walk(pdf.root.Pages, { resources: null, box: [0, 0, 612, 792] }, 0);
  return out;
}

/**
 * The text of a PDF: [{ width, height, items: [{ x, y, size, text }] }] per page, y measured
 * up from the bottom of the page as in PDF.
 */
function pdfText(buf) {
  const pdf = openPdf(buf);
  const fonts = new Map();
  return pagesOf(pdf).map(({ node, resources, box }) => {
    const items = [];
    const contents = Array.isArray(pdf.get(node.Contents)) ? pdf.get(node.Contents) : [node.Contents];
    const data = Buffer.concat(contents.map((c) => pdf.streamOf(c)).filter(Boolean).flatMap((d) => [d, Buffer.from("\n")]));
    runContent(pdf, data, resources, ID, items, fonts);
    const [x0, y0, x1, y1] = (pdf.get(box) || [0, 0, 612, 792]).map(Number);
    return { width: x1 - x0, height: y1 - y0, items: items.filter((i) => i.text.trim()).map((i) => ({ ...i, x: i.x - x0, y: i.y - y0 })) };
  });
}

/**
 * The pages as lines: runs whose baselines are within `tolerance` of each other, top to bottom.
 * On a line, runs that touch are joined (a heading set one letter at a time), with a space
 * where the gap is a word's; a wider gap starts a new piece (another column). [[{ y, items }]]
 * per page, each line's pieces left to right. columns: x positions where a column starts;
 * runs on either side of one are never joined, however close.
 */
function pdfLines(pages, { tolerance = 2, columns = [] } = {}) {
  return pages.map((page) => {
    const sorted = [...page.items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const line = lines.find((l) => Math.abs(l.y - it.y) <= tolerance);
      if (line) line.runs.push(it);
      else lines.push({ y: it.y, runs: [it] });
    }
    for (const l of lines) {
      l.runs.sort((a, b) => a.x - b.x);
      l.items = [];
      for (const r of l.runs) {
        const prev = l.items[l.items.length - 1];
        const gap = prev ? r.x - prev.end : Infinity;
        const em = Math.max(prev?.size || 0, r.size) || 10;
        if (prev && columns.some((c) => prev.x < c && r.x >= c)) l.items.push({ ...r });
        else if (prev && gap < em * 0.15) Object.assign(prev, { text: prev.text + r.text, end: Math.max(prev.end, r.end) });
        else if (prev && gap < em * 0.9) Object.assign(prev, { text: `${prev.text.replace(/ +$/, "")} ${r.text.replace(/^ +/, "")}`, end: Math.max(prev.end, r.end) });
        else l.items.push({ ...r });
      }
      delete l.runs;
    }
    return lines.sort((a, b) => b.y - a.y);
  });
}

module.exports = { pdfText, pdfLines, parseCMap };

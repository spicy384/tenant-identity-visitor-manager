/**
 * Certificates for signing in to Microsoft Entra ID without a client secret: the app proves
 * who it is with a short token signed by a certificate's private key (a "client assertion"),
 * and Entra checks it against the certificate uploaded to the app registration.
 *
 * Everything here uses node's own crypto. Node can make keys and sign, but not write an X.509
 * certificate or read a PKCS#12 (.pfx) file, so this has a small DER writer and reader for
 * those two. PFX files are read in their modern form (PBES2: PBKDF2 with AES or 3DES) and in
 * the older one (PKCS#12 PBE with 3DES or RC2). RC2, still used for the certificate part of
 * PFX files made by older OpenSSL and Windows versions, is no longer in node's OpenSSL, so it
 * is implemented here (decryption only; it protects nothing secret in a PFX, only the
 * certificate). The file's MAC is checked first, so a wrong password says so.
 */
const crypto = require("crypto");

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// --- DER -------------------------------------------------------------------------------------------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts.flat());
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const explicit = (n, ...parts) => der(0xa0 + n, ...parts);
const nullValue = () => Buffer.from([0x05, 0x00]);
const octets = (buf) => der(0x04, buf);
const utf8 = (s) => der(0x0c, Buffer.from(String(s), "utf8"));
const bool = (v) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]);

function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const bytes = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) bytes.unshift(0x80 | (v & 0x7f));
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
}

function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  // UTCTime until 2049, GeneralizedTime after (RFC 5280).
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${iso.slice(2)}Z`)) : der(0x18, Buffer.from(`${iso}Z`));
}

/** Reads one DER element at `offset`: { tag, start (of its content), end, content, constructed }. */
function readDer(buf, offset = 0) {
  if (offset + 2 > buf.length) throw fail(400, "The file is not valid DER.");
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    // Indefinite lengths (BER) aren't used by the files read here.
    if (count === 0 || count > 4) throw fail(400, "The file uses an encoding this app can't read.");
    len = 0;
    for (let i = 0; i < count; i += 1) len = len * 256 + buf[start + i];
    start += count;
  }
  const end = start + len;
  if (end > buf.length) throw fail(400, "The file is cut short.");
  return { tag, start, end, content: buf.subarray(start, end), constructed: Boolean(tag & 0x20), raw: buf.subarray(offset, end) };
}

/** The elements inside a constructed element. */
function children(node) {
  const out = [];
  let i = 0;
  while (i < node.content.length) {
    const child = readDer(node.content, i);
    out.push(child);
    i = child.end;
  }
  return out;
}

function readOid(node) {
  if (node.tag !== 0x06) throw fail(400, "The file is not in the expected form.");
  const b = node.content;
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i += 1) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join(".");
}

const readInt = (node) => node.content.reduce((n, byte) => n * 256 + byte, 0);

/** An OCTET STRING's bytes, joining the pieces of a constructed one. */
function readOctets(node) {
  if (node.tag === 0x04 || node.tag === 0x80) return node.content;
  if (node.tag === 0x24 || node.tag === 0xa0) return Buffer.concat(children(node).map(readOctets));
  throw fail(400, "The file is not in the expected form.");
}

// --- making a certificate -------------------------------------------------------------------------

/**
 * A new RSA key and a self-signed certificate for it, valid from now for `days`:
 * { certPem, keyPem }. The certificate is for client authentication only.
 */
function generateCertificate({ commonName = "Identity and Visitor Manager", days = 730, now = new Date() } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const name = seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const sha256WithRsa = seq(oid("1.2.840.113549.1.1.11"), nullValue());
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  // The public key's own bits, for the key identifier.
  const spkiParts = children(readDer(spki));
  const keyId = crypto.createHash("sha1").update(spkiParts[1].content.subarray(1)).digest();
  const extensions = seq(
    seq(oid("2.5.29.19"), bool(true), octets(seq())), // basic constraints: not a CA
    seq(oid("2.5.29.15"), bool(true), octets(der(0x03, Buffer.from([0x07, 0x80])))), // key usage: digital signature
    seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.2")))), // extended key usage: client authentication
    seq(oid("2.5.29.14"), octets(octets(keyId))) // subject key identifier
  );
  const tbs = seq(explicit(0, integer(Buffer.from([2]))), integer(serial), sha256WithRsa, name, seq(time(notBefore), time(notAfter)), name, spki, explicit(3, extensions));
  const signature = crypto.sign("sha256", tbs, privateKey);
  const cert = seq(tbs, sha256WithRsa, der(0x03, Buffer.from([0]), signature));
  return { certPem: toPem(cert, "CERTIFICATE"), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

function toPem(derBuf, label) {
  return `-----BEGIN ${label}-----\n${derBuf.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
}

// --- reading what an administrator uploads --------------------------------------------------------

/**
 * Checks a certificate and its key belong together and are usable for Entra (RSA, 2048 bits
 * or more) and gives them as PEM: { certPem, keyPem }. From a list of certificates (a chain),
 * the one matching the key is taken.
 */
function pairUp(certs, key) {
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") throw fail(400, "Entra needs an RSA certificate; this key is not RSA.");
  if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw fail(400, "The key is shorter than 2048 bits; Entra won't accept it.");
  const cert = certs.find((c) => c.checkPrivateKey(key));
  if (!cert) throw fail(400, "The certificate and the private key don't belong together.");
  return { certPem: cert.toString(), keyPem: key.export({ type: "pkcs8", format: "pem" }) };
}

function pemBlocks(text, label) {
  return String(text || "").match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----`, "g")) || [];
}

/** A certificate (PEM, possibly with its chain) and its private key (PEM, possibly encrypted). */
function readPem(certText, keyText, passphrase = "") {
  const blocks = pemBlocks(certText, "CERTIFICATE");
  if (!blocks.length) throw fail(400, "No certificate found: paste or choose a PEM file that starts with -----BEGIN CERTIFICATE-----.");
  let certs;
  try {
    certs = blocks.map((b) => new crypto.X509Certificate(b));
  } catch {
    throw fail(400, "The certificate can't be read.");
  }
  let key;
  try {
    key = crypto.createPrivateKey({ key: String(keyText || ""), format: "pem", ...(passphrase ? { passphrase } : {}) });
  } catch (error) {
    if (/ENCRYPTED/.test(String(keyText)) && !passphrase) throw fail(400, "The private key is protected by a passphrase: enter it too.");
    throw fail(400, /bad decrypt|decrypt/i.test(error.message) ? "The passphrase is wrong for that private key." : "The private key can't be read: give the PEM key that starts with -----BEGIN PRIVATE KEY----- (or RSA PRIVATE KEY).");
  }
  return pairUp(certs, key);
}

// PKCS#12 ------------------------------------------------------------------------------------------

const OID = {
  data: "1.2.840.113549.1.7.1",
  encryptedData: "1.2.840.113549.1.7.6",
  keyBag: "1.2.840.113549.1.12.10.1.1",
  shroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12"
};
const HASHES = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.4": "sha224",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512"
};
const PRFS = {
  "1.2.840.113549.2.7": "sha1",
  "1.2.840.113549.2.8": "sha224",
  "1.2.840.113549.2.9": "sha256",
  "1.2.840.113549.2.10": "sha384",
  "1.2.840.113549.2.11": "sha512"
};
const PBES2_CIPHERS = {
  "2.16.840.1.101.3.4.1.2": { name: "aes-128-cbc", key: 16 },
  "2.16.840.1.101.3.4.1.22": { name: "aes-192-cbc", key: 24 },
  "2.16.840.1.101.3.4.1.42": { name: "aes-256-cbc", key: 32 },
  "1.2.840.113549.3.7": { name: "des-ede3-cbc", key: 24 }
};
// PKCS#12 password-based encryption: the cipher, its key length and, for RC2, its key bits.
const PKCS12_PBE = {
  "1.2.840.113549.1.12.1.3": { name: "des-ede3-cbc", key: 24 },
  "1.2.840.113549.1.12.1.4": { name: "des-ede-cbc", key: 16 },
  "1.2.840.113549.1.12.1.5": { rc2: 128, key: 16 },
  "1.2.840.113549.1.12.1.6": { rc2: 40, key: 5 }
};

/** The password as PKCS#12 wants it: UTF-16 big-endian with two zero bytes at the end. */
function bmpPassword(password) {
  const s = String(password ?? "");
  const out = Buffer.alloc(s.length * 2 + 2);
  for (let i = 0; i < s.length; i += 1) out.writeUInt16BE(s.charCodeAt(i), i * 2);
  return out;
}

/** The PKCS#12 key derivation (RFC 7292 appendix B): id 1 key, 2 IV, 3 MAC key. */
function pkcs12Kdf(password, salt, iterations, id, size, hash) {
  const u = crypto.createHash(hash).digest().length;
  const v = ["sha384", "sha512"].includes(hash) ? 128 : 64;
  const fill = (src) => {
    if (!src.length) return Buffer.alloc(0);
    const out = Buffer.alloc(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i += 1) out[i] = src[i % src.length];
    return out;
  };
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([fill(salt), fill(password)]);
  const out = [];
  for (let produced = 0; produced < size; produced += u) {
    let A = crypto.createHash(hash).update(D).update(I).digest();
    for (let n = 1; n < iterations; n += 1) A = crypto.createHash(hash).update(A).digest();
    out.push(A);
    const B = fill(A).subarray(0, v);
    // Each v-byte block of I becomes (block + B + 1) mod 2^(8v).
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k -= 1) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, size);
}

// RC2 (RFC 2268), decryption only.
const PITABLE = Buffer.from(
  "d978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32" +
  "bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626" +
  "6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a" +
  "961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731" +
  "2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2e" +
  "c5f3db47e5a59c770aa62068fe7fc1ad", "hex");

function rc2Keys(key, bits) {
  const L = Buffer.alloc(128);
  key.copy(L);
  const T = key.length;
  for (let i = T; i < 128; i += 1) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  const T8 = Math.ceil(bits / 8);
  const TM = 0xff >> (8 * T8 - bits);
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i -= 1) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = L[2 * i] | (L[2 * i + 1] << 8);
  return K;
}

function rc2DecryptCbc(data, key, bits, iv) {
  if (data.length % 8) throw fail(400, "The file's encrypted part is damaged.");
  const K = rc2Keys(key, bits);
  const out = Buffer.alloc(data.length);
  let prev = iv;
  const S = [1, 2, 3, 5];
  for (let off = 0; off < data.length; off += 8) {
    const R = [0, 1, 2, 3].map((i) => data.readUInt16LE(off + 2 * i));
    let j = 63;
    const unmix = () => {
      for (let i = 3; i >= 0; i -= 1) {
        R[i] = ((R[i] >>> S[i]) | (R[i] << (16 - S[i]))) & 0xffff;
        R[i] = (R[i] - K[j] - (R[(i + 3) & 3] & R[(i + 2) & 3]) - (~R[(i + 3) & 3] & R[(i + 1) & 3])) & 0xffff;
        j -= 1;
      }
    };
    const unmash = () => {
      for (let i = 3; i >= 0; i -= 1) R[i] = (R[i] - K[R[(i + 3) & 3] & 63]) & 0xffff;
    };
    for (let n = 0; n < 5; n += 1) unmix();
    unmash();
    for (let n = 0; n < 6; n += 1) unmix();
    unmash();
    for (let n = 0; n < 5; n += 1) unmix();
    for (let i = 0; i < 4; i += 1) out.writeUInt16LE(R[i] ^ prev.readUInt16LE(2 * i), off + 2 * i);
    prev = data.subarray(off, off + 8);
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 8 || out.subarray(out.length - pad).some((b) => b !== pad)) throw fail(400, "The PFX password is wrong, or the file is damaged.");
  return out.subarray(0, out.length - pad);
}

/** Decrypts with an AlgorithmIdentifier from the file (PBES2 or PKCS#12 PBE). */
function decrypt(algNode, data, password) {
  const [algOid, params] = children(algNode);
  const alg = readOid(algOid);
  try {
    if (alg === OID.pbes2) {
      const [kdf, scheme] = children(params);
      const [kdfOid, kdfParams] = children(kdf);
      if (readOid(kdfOid) !== OID.pbkdf2) throw fail(400, "The PFX uses a key derivation this app can't read.");
      const kp = children(kdfParams);
      const salt = readOctets(kp[0]);
      const iterations = readInt(kp[1]);
      let prf = "sha1";
      for (const extra of kp.slice(2)) if (extra.tag === 0x30) prf = PRFS[readOid(children(extra)[0])] || null;
      const [cipherOid, ivNode] = children(scheme);
      const cipher = PBES2_CIPHERS[readOid(cipherOid)];
      if (!cipher || !prf) throw fail(400, "The PFX is encrypted with a cipher this app can't read.");
      const key = crypto.pbkdf2Sync(Buffer.from(String(password ?? ""), "utf8"), salt, iterations, cipher.key, prf);
      const d = crypto.createDecipheriv(cipher.name, key, readOctets(ivNode));
      return Buffer.concat([d.update(data), d.final()]);
    }
    const pbe = PKCS12_PBE[alg];
    if (!pbe) throw fail(400, "The PFX is encrypted with a cipher this app can't read.");
    const [saltNode, iterNode] = children(params);
    const salt = readOctets(saltNode);
    const iterations = readInt(iterNode);
    const pw = bmpPassword(password);
    const key = pkcs12Kdf(pw, salt, iterations, 1, pbe.key, "sha1");
    const iv = pkcs12Kdf(pw, salt, iterations, 2, 8, "sha1");
    if (pbe.rc2) return rc2DecryptCbc(data, key, pbe.rc2, iv);
    const d = crypto.createDecipheriv(pbe.name, key, iv);
    return Buffer.concat([d.update(data), d.final()]);
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, "The PFX password is wrong, or the file is damaged.");
  }
}

/** Checks the file's MAC, which proves the password before anything is decrypted. */
function checkMac(macData, authSafe, password) {
  const [digestInfo, saltNode, iterNode] = children(macData);
  const [algId, digestNode] = children(digestInfo);
  const hash = HASHES[readOid(children(algId)[0])];
  if (!hash) throw fail(400, "The PFX uses an integrity check this app can't read.");
  const salt = readOctets(saltNode);
  const iterations = iterNode ? readInt(iterNode) : 1;
  const expected = readOctets(digestNode);
  const size = crypto.createHash(hash).digest().length;
  // An empty password is written either as nothing or as two zero bytes, depending on the tool.
  const tries = password ? [bmpPassword(password)] : [bmpPassword(""), Buffer.alloc(0)];
  for (const pw of tries) {
    const key = pkcs12Kdf(pw, salt, iterations, 3, size, hash);
    const mac = crypto.createHmac(hash, key).update(authSafe).digest();
    if (mac.length === expected.length && crypto.timingSafeEqual(mac, expected)) return;
  }
  throw fail(400, "The PFX password is wrong.");
}

/** A .pfx / .p12 file (bytes) and its password: { certPem, keyPem }. */
function readPfx(buf, password = "") {
  const pfx = readDer(Buffer.from(buf));
  if (pfx.tag !== 0x30) throw fail(400, "That isn't a PFX file.");
  const [version, authSafeInfo, macData] = children(pfx);
  if (!version || readInt(version) !== 3 || !authSafeInfo) throw fail(400, "That isn't a PFX file.");
  const [authType, authContent] = children(authSafeInfo);
  if (readOid(authType) !== OID.data) throw fail(400, "The PFX is signed with a certificate rather than a password; export it again with a password.");
  const authSafe = readOctets(children(authContent)[0]);
  if (macData) checkMac(macData, authSafe, password);

  const certs = [];
  const keys = [];
  const readBags = (safeContents) => {
    for (const bag of children(readDer(safeContents))) {
      const [bagId, bagValue] = children(bag);
      const id = readOid(bagId);
      const value = children(bagValue)[0];
      if (id === OID.certBag) {
        const [certType, certValue] = children(value);
        if (readOid(certType) === OID.x509Certificate) certs.push(new crypto.X509Certificate(readOctets(children(certValue)[0])));
      } else if (id === OID.keyBag) {
        keys.push(crypto.createPrivateKey({ key: value.raw, format: "der", type: "pkcs8" }));
      } else if (id === OID.shroudedKeyBag) {
        const [alg, encrypted] = children(value);
        keys.push(crypto.createPrivateKey({ key: decrypt(alg, readOctets(encrypted), password), format: "der", type: "pkcs8" }));
      }
    }
  };
  for (const info of children(readDer(authSafe))) {
    const [type, content] = children(info);
    const kind = readOid(type);
    if (kind === OID.data) {
      readBags(readOctets(children(content)[0]));
    } else if (kind === OID.encryptedData) {
      const encryptedData = children(content)[0];
      const [, encryptedContentInfo] = children(encryptedData);
      const [, alg, encrypted] = children(encryptedContentInfo);
      readBags(decrypt(alg, readOctets(encrypted), password));
    }
  }
  if (!keys.length) throw fail(400, "The PFX has no private key: export it again with the private key included.");
  if (!certs.length) throw fail(400, "The PFX has no certificate.");
  for (const key of keys) {
    try {
      return pairUp(certs, key);
    } catch (error) {
      if (key === keys[keys.length - 1]) throw error;
    }
  }
  throw fail(400, "The PFX's certificate and key don't belong together.");
}

// --- using a certificate --------------------------------------------------------------------------

/** What to show about a certificate: thumbprints, subject, validity. */
function certificateInfo(certPem) {
  const cert = new crypto.X509Certificate(certPem);
  return {
    // As the Entra admin center shows it: SHA-1, upper-case hex without colons.
    thumbprint: cert.fingerprint.replace(/:/g, "").toUpperCase(),
    thumbprintSha256: cert.fingerprint256.replace(/:/g, "").toUpperCase(),
    subject: cert.subject.replace(/\n/g, ", "),
    notBefore: new Date(cert.validFrom).getTime(),
    notAfter: new Date(cert.validTo).getTime()
  };
}

/** The certificate as DER (what a .cer file holds). */
const certificateDer = (certPem) => new crypto.X509Certificate(certPem).raw;

/**
 * A client assertion for Entra's token endpoint: a JWT signed with the certificate's key
 * (PS256), naming the certificate by its SHA-256 thumbprint, valid for ten minutes.
 */
function clientAssertion({ certPem, keyPem, clientId, audience, now = Date.now() }) {
  const header = { alg: "PS256", typ: "JWT", "x5t#S256": b64url(crypto.createHash("sha256").update(certificateDer(certPem)).digest()) };
  const iat = Math.floor(now / 1000);
  const payload = { aud: audience, iss: clientId, sub: clientId, jti: crypto.randomUUID(), nbf: iat, iat, exp: iat + 600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(input), {
    key: crypto.createPrivateKey(keyPem),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  });
  return `${input}.${b64url(signature)}`;
}

module.exports = { generateCertificate, readPem, readPfx, certificateInfo, certificateDer, clientAssertion, pkcs12Kdf, rc2DecryptCbc };

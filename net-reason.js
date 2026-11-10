/**
 * Why an outbound request got no answer.
 *
 * Node's fetch says only "fetch failed". The reason (a name that didn't resolve, a refused
 * or dropped connection, a certificate that wasn't accepted) is a code on the error's cause,
 * or on each address it tried. Only those codes and the host are used here: never a URL's
 * path or query, a header or a body, so nothing a request carried can reach a log or a page.
 */

// Checked in this order: when both an address family that isn't routed and a real failure
// are reported, the first group that matches names the failure.
const GROUPS = [
  { test: /^(ENOTFOUND|EAI_[A-Z]+|ESERVFAIL)$/, why: "its name couldn't be looked up in DNS", retry: true },
  { test: /CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|EPROTO/, why: "its certificate wasn't accepted, which usually means a proxy or firewall is inspecting the connection", retry: false },
  { test: /^(ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/, why: "no connection could be made", retry: true },
  { test: /^(ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/, why: "the connection was dropped", retry: true }
];
const CODE = /^[A-Z][A-Z0-9_]{2,39}$/;
const MAX_CODES = 4;

/** The system's codes for a failed request, from the error, its causes and each address tried. */
function networkCodes(error) {
  const codes = [];
  const seen = new Set();
  const walk = (e, depth) => {
    if (!e || typeof e !== "object" || seen.has(e) || depth > 4) return;
    seen.add(e);
    if (typeof e.code === "string" && CODE.test(e.code) && !codes.includes(e.code)) codes.push(e.code);
    if (Array.isArray(e.errors)) for (const inner of e.errors.slice(0, 16)) walk(inner, depth + 1);
    walk(e.cause, depth + 1);
  };
  walk(error, 0);
  return codes;
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
}

/**
 * { message, codes, retry } when `error` is a request that never got an answer, else null (a
 * refusal the caller made itself, a bug). `retry` says whether trying again could help: not
 * after a time-out, which has already waited, nor for a certificate that wasn't accepted.
 */
function unreachable(error, url, { who = "Microsoft", timeoutMs = 0 } = {}) {
  if (!error || error.status) return null;
  const at = hostOf(url);
  const where = at ? `${who} at ${at}` : who;
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    const waited = timeoutMs ? ` in ${Math.round(timeoutMs / 1000)} seconds` : " in time";
    return { message: `The server couldn't reach ${where}: it didn't answer${waited}.`, codes: ["TIMEOUT"], retry: false };
  }
  const codes = networkCodes(error);
  const fetchFailed = error instanceof TypeError && /fetch failed/i.test(String(error.message));
  if (!codes.length && !fetchFailed) return null;
  const group = GROUPS.find((g) => codes.some((c) => g.test.test(c)));
  if (!group && !fetchFailed) return null;
  const shown = codes.length ? ` (${codes.slice(0, MAX_CODES).join(", ")})` : "";
  return {
    message: `The server couldn't reach ${where}: ${group ? group.why : "the request failed before any answer"}${shown}.`,
    codes,
    retry: group ? group.retry : true
  };
}

module.exports = { unreachable, networkCodes };

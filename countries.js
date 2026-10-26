/**
 * Countries for a visitor's citizenship, by ISO 3166-1 alpha-2 code (US for a U.S. citizen),
 * named in English by node's own locale data. Uninhabited territories are left out; Kosovo
 * (XK, not yet in ISO 3166) is in.
 */
const CODES = (
  "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS " +
  "MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS " +
  "RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

const names = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRIES = CODES
  .map((code) => ({ code, name: code === "XK" ? "Kosovo" : names.of(code) }))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));
const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

const US = "US";

/** The code for a country given by code or English name (any case), or null. */
function countryCode(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (BY_CODE.has(v.toUpperCase())) return v.toUpperCase();
  const lower = v.toLowerCase();
  if (["usa", "u.s.", "u.s.a.", "united states of america", "america"].includes(lower)) return US;
  return COUNTRIES.find((c) => c.name.toLowerCase() === lower)?.code ?? null;
}

const countryName = (code) => BY_CODE.get(code)?.name ?? null;

module.exports = { COUNTRIES, US, countryCode, countryName };

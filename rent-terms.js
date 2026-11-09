/**
 * A lease's yearly increase: its rent goes up by escalation_pct, compounding, on each anniversary
 * of its commencement (its start, unless it commences on another day). Each office's rent is
 * rounded to the cent every year, the way finance's escalation tracker does it, so the two agree
 * to the cent. These take rows of the leases table, so anything that works out rent counts the
 * increases the same way.
 */

/** When a lease commences: its commencement date, else its start. */
const commencementOf = (lease) => lease.commencement_date || lease.start_date;

/** Whole years from `start` to `date` (the anniversaries passed). */
function yearsBetween(start, date) {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  let years = y - sy;
  if (m < sm || (m === sm && d < sd)) years -= 1;
  return Math.max(0, years);
}

/** The `n`th anniversary of a date (of 29 February, in another year: 1 March). */
function anniversary(start, n) {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y + n, m - 1, d)).toISOString().slice(0, 10);
}

/** How many yearly increases a lease has had by `date` (none before it commences). */
const increasesOn = (lease, date) => (lease.escalation_pct ? yearsBetween(commencementOf(lease), date) : 0);

/** What a rate per square foot is multiplied by after `n` increases (a rate isn't rounded each year). */
const factorAfter = (lease, n) => (1 + (lease.escalation_pct || 0) / 100) ** n;

/**
 * A monthly amount after `n` increases, rounded to the cent each year. In whole cents, so that half
 * a cent always rounds up, as it does in a spreadsheet ($34.00 at 3.25% is $35.11).
 */
function escalate(amount, lease, n) {
  const points = Math.round((lease.escalation_pct || 0) * 100);
  let cents = Math.round(amount * 100);
  for (let i = 0; i < n; i += 1) cents = Math.floor((cents * (10000 + points) + 5000) / 10000);
  return cents / 100;
}

/**
 * An amount to the cent, half a cent going up as it does in a spreadsheet. 101 sq ft at $2.675 is
 * $270.175, which a computer holds as 270.17499999999995: taken to fifteen figures first (what a
 * spreadsheet works to), it is $270.18 and not $270.17. null stays null.
 */
function roundMoney(n) {
  if (n === null || n === undefined) return null;
  const cents = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
  return (n < 0 ? -cents : cents) / 100 || 0;
}

module.exports = { commencementOf, yearsBetween, anniversary, increasesOn, factorAfter, escalate, roundMoney };

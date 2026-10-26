// 18-badge-alerts.js: the bright banner across staff pages for visitors whose check-in the desk
// hasn't finished: most checked themselves in at a kiosk and wait for the desk to check their
// ID, then for a badge. Shown to staff who give badges out and see that site (and, with a site
// chosen in the picker, only for that site), with a button that opens the check-in at the
// right step. Each goes once given a badge, marked as needing none, or checked out.

const BADGE_ALERT_POLL_MS = 15 * 1000;
const BADGE_ALERTS_SHOWN = 3;
const badgeAlerts = { list: [], expanded: false };

const canGiveBadges = () => canEditBadges() && canReadVisitors();

function agoText(ms) {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return `at ${fmtDateTime(ms)}`;
}

async function loadBadgeAlerts() {
  if (!state.me || !canGiveBadges()) {
    badgeAlerts.list = [];
    renderBadgeAlerts();
    return;
  }
  try {
    badgeAlerts.list = (await api(`/api/visits/badge-needed?${new URLSearchParams(siteQuery())}`)).visits;
    renderBadgeAlerts();
  } catch {
    // A convenience: the next poll tries again.
  }
}

/** What the desk does next for a visit waiting on it. */
const checkinNext = (a) => (a.stage === "id" ? "Check ID" : "Give badge");

function renderBadgeAlerts() {
  const box = $("badge-alerts");
  const list = badgeAlerts.list;
  box.hidden = !list.length;
  if (!list.length) {
    box.replaceChildren();
    return;
  }
  const shown = badgeAlerts.expanded ? list : list.slice(0, BADGE_ALERTS_SHOWN);
  box.replaceChildren(
    h("div", { class: "badge-alerts-head" }, h("strong", { text: list.length === 1 ? "1 visitor needs their check-in finished" : `${list.length} visitors need their check-in finished` })),
    ...shown.map((a) => h("div", { class: `badge-alert stage-${a.stage}` },
      h("div", { class: "badge-alert-text" },
        h("strong", { text: a.name }), a.organisation ? h("span", { class: "muted", text: ` (${a.organisation})` }) : null,
        a.visitorType === "Service Technician" ? h("span", { class: "badge", text: "Service Technician" }) : null,
        ` checked in ${a.kioskName ? `at ${a.kioskName}` : "at the desk"}${multiSite() ? `, ${a.siteName},` : ""} ${agoText(a.checkedInAt)}. `,
        h("strong", { text: a.stage === "id" ? "Check their ID, then give them a badge." : "Their ID is checked; give them a badge." }),
        a.companyName ? h("div", { class: "muted small-text", text: `Visiting ${a.companyName}${a.hostName ? `, contact ${a.hostName}` : ""}${a.purpose ? ` · ${a.purpose}` : ""}` }) : null),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "primary", text: checkinNext(a), onclick: () => continueCheckIn(a.visitId) })))),
    list.length > BADGE_ALERTS_SHOWN
      ? h("button", { type: "button", class: "link-btn small-text", text: badgeAlerts.expanded ? "Show fewer" : `${list.length - BADGE_ALERTS_SHOWN} more waiting`,
        onclick: () => { badgeAlerts.expanded = !badgeAlerts.expanded; renderBadgeAlerts(); } })
      : "");
}

setInterval(() => { if (!document.hidden) loadBadgeAlerts(); }, BADGE_ALERT_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadBadgeAlerts(); });

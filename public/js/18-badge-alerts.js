// 18-badge-alerts.js: the banner across staff pages when a visitor who checked themselves in
// at a kiosk still needs a badge. Shown to staff who give badges out and see that site (and,
// with a site chosen in the picker, only for that site), with a button to give one and one to
// say none is needed. It goes once they have a badge, check out, or are marked as needing none.

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
    ...shown.map((a) => h("div", { class: "badge-alert" },
      h("div", { class: "badge-alert-text" },
        h("strong", { text: a.name }), a.organisation ? h("span", { class: "muted", text: ` (${a.organisation})` }) : null,
        ` checked in at ${a.kioskName || "the kiosk"}${multiSite() ? `, ${a.siteName},` : ""} ${agoText(a.checkedInAt)} and needs a badge.`,
        a.companyName ? h("div", { class: "muted small-text", text: `Visiting ${a.companyName}${a.hostName ? `, host ${a.hostName}` : ""}` }) : null),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "primary small", text: "Assign badge", onclick: () => giveKioskBadge(a) }),
        h("button", { type: "button", class: "secondary small", text: "No badge needed", onclick: () => noBadgeNeeded(a) })))),
    list.length > BADGE_ALERTS_SHOWN
      ? h("button", { type: "button", class: "link-btn small-text", text: badgeAlerts.expanded ? "Show fewer" : `${list.length - BADGE_ALERTS_SHOWN} more waiting for a badge`,
        onclick: () => { badgeAlerts.expanded = !badgeAlerts.expanded; renderBadgeAlerts(); } })
      : "");
}

/** Gives the visitor a badge for this visit: the image of the one to give, and the badges valid at that site. */
async function giveKioskBadge(a) {
  let data;
  try {
    data = await api(`/api/badge-holders/visitor/${a.visitorId}?site=${a.siteId}`);
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  if (!data.available.length) {
    toast(`No visitor badge is free${multiSite() ? ` at ${a.siteName}` : ""} that ${a.name} may hold.`, "error");
    return;
  }
  const picker = badgePicker(data.available, { suggested: data.suggested, label: "Visitor badge" });
  const given = await formDialog({
    title: `Give ${a.name} a badge`,
    wide: true,
    intro: h("p", { class: "muted", text: `Checked in at ${a.kioskName || "the kiosk"}${multiSite() ? ` (${a.siteName})` : ""} ${agoText(a.checkedInAt)}${a.companyName ? `, visiting ${a.companyName}` : ""}. The badge stays with them until someone takes it back.` }),
    fields: [{ node: h("div", { class: "badge-give full-row" }, suggestedBadge(data.suggested), picker.node) }],
    submitLabel: "Give badge",
    onSubmit: async () => {
      const badge = picker.chosen();
      if (!badge) throw new Error("Choose a badge.");
      await api(`/api/badges/${badge.id}/assign`, { method: "POST", body: { kind: "visitor", holderId: a.visitorId, visitId: a.visitId } });
      return badge;
    }
  });
  if (!given) return;
  toast(`Badge ${given.number} given to ${a.name}.`);
  loadBadgeAlerts();
  refreshCounts();
  refreshCurrentView();
}

async function noBadgeNeeded(a) {
  if (!(await confirmDialog(`${a.name} doesn't need a badge for this visit?`, { title: "No badge needed", confirmLabel: "No badge needed" }))) return;
  try {
    await api(`/api/visits/${a.visitId}/badge-not-needed`, { method: "POST" });
    loadBadgeAlerts();
  } catch (error) {
    toast(error.message, "error");
  }
}

setInterval(() => { if (!document.hidden) loadBadgeAlerts(); }, BADGE_ALERT_POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadBadgeAlerts(); });

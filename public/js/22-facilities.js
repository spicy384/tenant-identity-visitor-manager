// 22-facilities.js: Facilities. Floor plans with the offices drawn on them (coloured by
// whether each is available, occupied, assigned from a later date or unavailable), the
// offices as a table with their totals, rates, and each company's offices on its page.
// Seeing any of it takes a role's facilities access; drawing, assigning and setting rates
// takes edit (Administrator and Manager by default; any role under Settings > Roles).
//
//   #floors  #floors/3  #offices  #rates

// tool: rect, outline or scale; selected: the office being reshaped, vertex: its chosen point;
// placing: an office not yet on the plan, being drawn; keys: the drawing tools' key handler.
const facilitiesView = { floorId: null, drawing: false, tool: "rect", placing: null, selected: null, vertex: null, keys: null, floor: null, offices: [] };

const OFFICE_STATUS = {
  available: { label: "Available", badge: "ok" },
  occupied: { label: "Occupied", badge: "" },
  upcoming: { label: "Upcoming", badge: "warn", hint: "Free now; assigned from a later date" },
  unavailable: { label: "Unavailable", badge: "muted" }
};
const RATE_SOURCES = { company: "the company's rate", office: "the office's rate", site: "the site's default" };

const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmtMoney = (n) => (n === null || n === undefined ? "—" : moneyFormat.format(n));
const fmtRate = (n) => (n === null || n === undefined ? "—" : `${moneyFormat.format(n)}/sq ft`);
const fmtSqft = (n) => (n === null || n === undefined ? "—" : `${Number(n).toLocaleString("en-US")} sq ft`);
const facilitySite = () => new URLSearchParams(siteQuery());

/** Today in this browser, as YYYY-MM-DD (what date inputs hold). */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Mar 4, 2026" from YYYY-MM-DD, without the time zone moving it a day. */
function fmtDay(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const statusBadge = (status) => h("span", { class: `badge ${OFFICE_STATUS[status].badge}`, text: OFFICE_STATUS[status].label, title: OFFICE_STATUS[status].hint || null });

/** Who has an office, in a few words: "Acme since Jan 1, 2026", "Globex from Mar 1, 2026". */
function officeHolder(o) {
  if (o.current) return `${o.current.companyName} since ${fmtDay(o.current.startDate)}${o.current.endDate ? `, to ${fmtDay(o.current.endDate)}` : ""}`;
  if (o.next) return `${o.next.companyName} from ${fmtDay(o.next.startDate)}`;
  return null;
}

const officeWhere = (o) => (multiSite() && !state.site ? `${o.siteName}, ${o.floorName}` : o.floorName);

// --- floor plans ----------------------------------------------------------------------------------

const PLAN_TOOLS = {
  rect: { label: "Rectangle", hint: "Drag on an empty part of the plan to draw a rectangular office." },
  outline: { label: "Outline", hint: "Click each corner of the office in turn; click the first point (or double-click, or press Enter) to finish. Backspace takes back the last point; Escape starts again." },
  scale: { label: "Set scale", hint: "Click the two ends of something whose real length you know, such as a wall or a dimension line, then give its length. The longer the line, the truer the scale." }
};

function showFloors(sub) {
  if (sub) facilitiesView.floorId = Number(sub);
  Object.assign(facilitiesView, { drawing: false, placing: null, selected: null, vertex: null });
  loadFloors();
}

/** Turns drawing on or off, with a tool. */
function setDrawing(on, tool = facilitiesView.tool) {
  Object.assign(facilitiesView, { drawing: on, tool, vertex: null, ...(on ? {} : { placing: null, selected: null }) });
  loadFloors();
}

async function loadFloors() {
  const body = $("floors-body");
  let floors;
  try {
    ({ floors } = await api(`/api/floors?${facilitySite()}`));
  } catch (error) {
    body.replaceChildren(h("p", { class: "message error", text: error.message }));
    return;
  }
  const editor = canEditFacilities();
  if (!floors.length) {
    facilitiesView.floor = null;
    body.replaceChildren(h("div", { class: "placeholder" },
      h("p", { text: "No floors yet. Add a floor, upload its plan, then draw its offices on it." }),
      editor ? h("button", { type: "button", class: "primary", text: "Add floor", onclick: () => addFloor() }) : null));
    return;
  }
  if (!floors.some((f) => f.id === facilitiesView.floorId)) facilitiesView.floorId = floors[0].id;
  let data;
  try {
    data = await api(`/api/floors/${facilitiesView.floorId}`);
  } catch (error) {
    body.replaceChildren(h("p", { class: "message error", text: error.message }));
    return;
  }
  const floor = data.floor;
  if (facilitiesView.floor?.id !== floor.id) Object.assign(facilitiesView, { selected: null, vertex: null, placing: null });
  facilitiesView.floor = floor;
  facilitiesView.offices = data.offices;
  if (!floor.planRef) facilitiesView.drawing = false;

  const picker = h("select", { "aria-label": "Floor", onchange: () => { location.hash = `#floors/${picker.value}`; } },
    floors.map((f) => h("option", { value: String(f.id), text: multiSite() && !state.site ? `${f.siteName}: ${f.name}` : f.name })));
  picker.value = String(floor.id);
  const draw = h("button", { type: "button", class: facilitiesView.drawing ? "primary" : "secondary", text: facilitiesView.drawing ? "Done drawing" : "Draw offices",
    disabled: !floor.planRef, title: floor.planRef ? null : "Upload a floor plan first", onclick: () => setDrawing(!facilitiesView.drawing) });
  const toolbar = h("div", { class: "toolbar" },
    h("label", { class: "inline-label" }, h("span", { text: "Floor" }), picker),
    h("span", { class: "spacer" }),
    editor ? [
      draw,
      h("button", { type: "button", class: "secondary", text: floor.planRef ? "Replace plan" : "Upload plan", onclick: () => uploadPlan(floor) }),
      h("button", { type: "button", class: "secondary", text: "Edit floor", onclick: () => editFloor(floor) }),
      h("button", { type: "button", class: "secondary", text: "Add floor", onclick: () => addFloor(floor.siteId) })
    ] : null);
  body.replaceChildren(toolbar, facilitiesView.drawing ? planTools() : "", h("div", { class: "floor-layout" }, planPane(floor, data.offices), floorSide(floor, data.offices)));
}

/** In drawing mode: the tools, and what to do with the chosen one. */
function planTools() {
  const view = facilitiesView;
  const tool = view.placing && view.tool === "scale" ? "rect" : view.tool;
  return h("div", { class: "plan-tools" },
    h("div", { class: "segmented", role: "group", "aria-label": "Drawing tool" }, Object.entries(PLAN_TOOLS).map(([id, t]) => h("button", {
      type: "button", class: id === tool ? "is-current" : null, "aria-pressed": String(id === tool), text: t.label,
      disabled: Boolean(view.placing) && id === "scale", onclick: () => setDrawing(true, id)
    }))),
    h("p", { class: "small-text" },
      view.placing ? h("strong", { text: `Drawing ${view.placing.name}: ` }) : null,
      PLAN_TOOLS[tool].hint,
      tool === "scale" ? null : " Click an office to reshape it: drag a point to move it, drag a + to add one, right-click a point (or click it and press Delete) to remove it. Double-click an office to open it."));
}

// Geometry, in fractions of the plan: x across, y down. A step down is `aspect` (height / width)
// as long as a step across, which matters for distances and areas but not for drawing.
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  return el;
}
const pointsAttr = (pts) => pts.map(([x, y]) => `${x},${y}`).join(" ");
const planAspect = (floor) => (floor.planWidth && floor.planHeight ? floor.planHeight / floor.planWidth : 1);

function outlineArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function insideOutline(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Where an office's name goes: the point inside its outline farthest from the edges (a coarse search). */
function labelPoint(pts, aspect) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const N = 14;
  let best = null;
  let bestDistance = -1;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const x = x0 + ((i + 0.5) / N) * (x1 - x0);
      const y = y0 + ((j + 0.5) / N) * (y1 - y0);
      if (!insideOutline(pts, x, y)) continue;
      let d = Infinity;
      for (let k = 0; k < pts.length; k += 1) {
        const [ax, ay] = pts[k];
        const [bx, by] = pts[(k + 1) % pts.length];
        d = Math.min(d, segmentDistance(x, y * aspect, ax, ay * aspect, bx, by * aspect));
      }
      if (d > bestDistance) { bestDistance = d; best = [x, y]; }
    }
  }
  return best || [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** An outline's area in square feet, when the floor has a scale; else null. */
function measuredSqft(pts, floor) {
  if (!floor.scale || !pts) return null;
  return Math.round(outlineArea(pts) * floor.scale.feet * floor.scale.feet * planAspect(floor));
}

/** The plan with its offices outlined on it; in drawing mode, they can be drawn and reshaped. */
function planPane(floor, offices) {
  if (!floor.planRef) {
    return h("div", { class: "placeholder plan-missing" },
      h("p", { text: "No floor plan yet." }),
      canEditFacilities() ? h("p", { class: "small-text", text: "Upload a PNG or JPEG of the floor (export a PDF plan as an image first), then draw the offices on it." }) : null,
      canEditFacilities() ? h("button", { type: "button", class: "primary", text: "Upload plan", onclick: () => uploadPlan(floor) }) : null);
  }
  const view = facilitiesView;
  const shapes = svgEl("svg", { class: "plan-svg", viewBox: "0 0 1 1", preserveAspectRatio: "none" });
  const labels = h("div", { class: "plan-labels" });
  const handles = h("div", { class: "plan-handles" });
  const layer = h("div", { class: `plan-layer${view.drawing ? ` is-drawing tool-${view.tool}` : ""}` }, shapes, labels, handles);
  const plan = { floor, layer, shapes, labels, handles, aspect: planAspect(floor), items: new Map() };
  for (const o of offices.filter((x) => x.points)) drawOffice(plan, o);
  if (view.drawing && view.tool === "scale" && floor.scale?.line) drawScaleLine(plan, floor.scale.line);
  if (view.drawing) {
    renderHandles(plan);
    enableDrawing(plan);
  }
  return h("div", { class: "plan-pane" }, h("div", { class: "plan-wrap" }, h("img", { src: `/api/floor-plans/${floor.planRef}`, alt: `Plan of ${floor.name}`, draggable: false }), layer));
}

function drawOffice(plan, o) {
  const who = o.current?.companyName || o.next?.companyName || null;
  const shape = svgEl("polygon", { class: `plan-shape status-${o.status}${facilitiesView.selected === o.id ? " is-selected" : ""}`, points: pointsAttr(o.points), "data-id": String(o.id) });
  const title = svgEl("title");
  title.textContent = [o.name, OFFICE_STATUS[o.status].label, officeHolder(o), o.sqft ? fmtSqft(o.sqft) : null].filter(Boolean).join("\n");
  shape.append(title);
  if (!facilitiesView.drawing) {
    shape.setAttribute("tabindex", "0");
    shape.setAttribute("role", "button");
    shape.setAttribute("aria-label", `Office ${o.name}, ${OFFICE_STATUS[o.status].label}${who ? `, ${who}` : ""}`);
    shape.addEventListener("click", () => openOffice(o.id, loadFloors));
    shape.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOffice(o.id, loadFloors); } });
  }
  const label = h("div", { class: "plan-label", "aria-hidden": "true" }, h("span", { class: "plan-label-name", text: o.name }), who ? h("span", { class: "plan-label-who", text: who }) : null);
  plan.shapes.append(shape);
  plan.labels.append(label);
  const item = { office: o, points: o.points, shape, label };
  plan.items.set(o.id, item);
  placeLabel(plan, item);
}

function placeLabel(plan, item) {
  const [x, y] = labelPoint(item.points, plan.aspect);
  const xs = item.points.map((p) => p[0]);
  item.label.style.left = `${x * 100}%`;
  item.label.style.top = `${y * 100}%`;
  item.label.style.maxWidth = `${(Math.max(...xs) - Math.min(...xs)) * 100}%`;
}

/** Shows an office with new points while it is being reshaped. */
function reshape(plan, item, points) {
  item.points = points;
  item.shape.setAttribute("points", pointsAttr(points));
  placeLabel(plan, item);
  renderHandles(plan);
}

function planDot(x, y, attrs) {
  const el = h("div", attrs);
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  return el;
}

/** The selected office's points, and a + halfway along each side to add one. */
function renderHandles(plan) {
  const item = plan.items.get(facilitiesView.selected);
  for (const it of plan.items.values()) it.shape.classList.toggle("is-selected", it === item);
  if (!item) return plan.handles.replaceChildren();
  const pts = item.points;
  plan.handles.replaceChildren(
    ...pts.map(([x, y], i) => {
      const [x2, y2] = pts[(i + 1) % pts.length];
      return planDot((x + x2) / 2, (y + y2) / 2, { class: "plan-mid", dataset: { mid: String(i) }, title: "Drag to add a point here", text: "+" });
    }),
    ...pts.map(([x, y], i) => planDot(x, y, { class: `plan-vertex${facilitiesView.vertex === i ? " is-selected" : ""}`, dataset: { vertex: String(i) }, title: "Drag to move it; right-click to remove it" })));
  return null;
}

function drawScaleLine(plan, line) {
  plan.shapes.append(svgEl("line", { class: "plan-scale", x1: line.from[0], y1: line.from[1], x2: line.to[0], y2: line.to[1] }));
  plan.labels.append(planDot((line.from[0] + line.to[0]) / 2, (line.from[1] + line.to[1]) / 2, { class: "plan-scale-label", text: `${Number(line.feet).toLocaleString("en-US")} ft` }));
}

/**
 * Drawing mode. Rectangle: drag on empty plan. Outline: click corner after corner. Set scale:
 * click two points. With any tool: click an office to select it, then drag it, its points or
 * its +s; right-click a point (or select it and press Delete) to remove it; double-click to open it.
 */
function enableDrawing(plan) {
  const { layer, floor } = plan;
  const view = facilitiesView;
  let drag = null;
  // The last click on an office, to tell a double-click (pointer capture sends dblclick to the layer).
  let lastClick = { id: null, at: 0 };
  const draft = { points: [], cursor: null, el: null };
  const box = () => layer.getBoundingClientRect();
  const at = (e) => {
    const r = box();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const pixels = (a, b) => {
    const r = box();
    return Math.hypot((a[0] - b[0]) * r.width, (a[1] - b[1]) * r.height);
  };
  const select = (id) => {
    view.selected = id;
    view.vertex = null;
    renderHandles(plan);
  };

  const drawDraft = () => {
    if (!draft.el) {
      draft.el = svgEl("polyline", { class: view.tool === "scale" ? "plan-scale" : "plan-draft" });
      plan.shapes.append(draft.el);
    }
    draft.el.setAttribute("points", pointsAttr(draft.cursor ? [...draft.points, draft.cursor] : draft.points));
    plan.handles.replaceChildren(...draft.points.map(([x, y], i) => planDot(x, y, { class: `plan-vertex is-draft${i === 0 && view.tool === "outline" ? " is-first" : ""}` })));
  };
  const resetDraft = () => {
    draft.points = [];
    draft.cursor = null;
    draft.el?.remove();
    draft.el = null;
    renderHandles(plan);
  };

  /** A new outline: the office being placed takes it, else a new office is added with it. */
  const useOutline = async (points) => {
    if (view.placing) {
      const placing = view.placing;
      view.placing = null;
      await saveShape(placing.id, points);
    } else {
      await editOffice(null, { floor, points });
      loadFloors();
    }
  };
  const finishOutline = async () => {
    if (draft.points.length < 3) return;
    const points = draft.points.slice();
    draft.cursor = null;
    draft.el.setAttribute("points", pointsAttr([...points, points[0]]));
    await useOutline(points);
    resetDraft();
  };
  const addPoint = async (p) => {
    const n = draft.points.length;
    if (view.tool === "scale") {
      if (n && pixels(p, draft.points[0]) < 4) return;
      draft.points.push(p);
      drawDraft();
      if (draft.points.length === 2) {
        const [from, to] = draft.points;
        draft.cursor = null;
        drawDraft();
        await setScaleFromLine(floor, from, to);
        resetDraft();
        loadFloors();
      }
      return;
    }
    // Back on the first point, or a double-click on the last: done.
    if (n >= 3 && (pixels(p, draft.points[0]) < 10 || pixels(p, draft.points[n - 1]) < 4)) return finishOutline();
    if (n && pixels(p, draft.points[n - 1]) < 4) return null;
    draft.points.push(p);
    drawDraft();
    return null;
  };
  const removePoint = (item, index) => {
    if (item.points.length <= 3) {
      toast("An outline needs at least 3 points.", "error");
      return;
    }
    view.vertex = null;
    const points = item.points.filter((_, i) => i !== index);
    reshape(plan, item, points);
    saveShape(item.office.id, points);
  };

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = at(e);
    const item = plan.items.get(view.selected);
    const vertex = e.target.closest(".plan-vertex:not(.is-draft)");
    const mid = e.target.closest(".plan-mid");
    const shape = e.target.closest(".plan-shape");
    if (vertex && item) {
      view.vertex = Number(vertex.dataset.vertex);
      drag = { mode: "point", item, index: view.vertex, start: p, base: item.points, moved: false };
    } else if (mid && item) {
      const i = Number(mid.dataset.mid);
      const base = item.points.slice();
      const [a, b] = [base[i], base[(i + 1) % base.length]];
      base.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      view.vertex = i + 1;
      drag = { mode: "point", item, index: i + 1, start: p, base, moved: true };
      reshape(plan, item, base);
    } else if (shape && !draft.points.length) {
      const target = plan.items.get(Number(shape.dataset.id));
      if (view.selected !== target.office.id) select(target.office.id);
      drag = { mode: "move", item: target, start: p, base: target.points, moved: false };
    } else if (view.tool === "rect" || (view.tool === "scale" && view.placing)) {
      if (view.selected !== null) select(null);
      const ghost = svgEl("polygon", { class: "plan-draft" });
      plan.shapes.append(ghost);
      drag = { mode: "rect", ghost, start: p, points: null, moved: false };
    } else {
      if (view.selected !== null && !draft.points.length) select(null);
      addPoint(p);
      return;
    }
    layer.setPointerCapture(e.pointerId);
  });

  layer.addEventListener("pointermove", (e) => {
    const p = at(e);
    if (!drag) {
      if (draft.points.length) {
        draft.cursor = p;
        drawDraft();
      }
      return;
    }
    if (pixels(p, drag.start) > 3) drag.moved = true;
    if (drag.mode === "rect") {
      const [x0, y0] = drag.start;
      const [xa, xb, ya, yb] = [Math.min(x0, p[0]), Math.max(x0, p[0]), Math.min(y0, p[1]), Math.max(y0, p[1])];
      drag.points = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]];
      drag.ghost.setAttribute("points", pointsAttr(drag.points));
    } else if (drag.mode === "move") {
      // The whole office, kept on the plan.
      const xs = drag.base.map((q) => q[0]);
      const ys = drag.base.map((q) => q[1]);
      const dx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), p[0] - drag.start[0]));
      const dy = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), p[1] - drag.start[1]));
      reshape(plan, drag.item, drag.base.map(([x, y]) => [x + dx, y + dy]));
    } else if (drag.mode === "point") {
      const points = drag.base.slice();
      points[drag.index] = p;
      reshape(plan, drag.item, points);
    }
  });

  const finish = async (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (layer.hasPointerCapture(e.pointerId)) layer.releasePointerCapture(e.pointerId);
    if (d.mode === "rect") {
      const big = d.points && pixels(d.points[0], d.points[2]) > 12;
      if (!d.moved || !big) {
        d.ghost.remove();
        return;
      }
      await useOutline(d.points);
      return;
    }
    // A click without dragging selects the office (or its point); a second one soon after opens it.
    if (!d.moved) {
      renderHandles(plan);
      if (d.mode === "move") {
        const id = d.item.office.id;
        if (lastClick.id === id && Date.now() - lastClick.at < 450) {
          lastClick = { id: null, at: 0 };
          openOffice(id, loadFloors);
        } else {
          lastClick = { id, at: Date.now() };
        }
      }
      return;
    }
    await saveShape(d.item.office.id, d.item.points);
  };
  layer.addEventListener("pointerup", finish);
  layer.addEventListener("pointercancel", (e) => {
    drag?.ghost?.remove();
    drag = null;
    if (layer.hasPointerCapture(e.pointerId)) layer.releasePointerCapture(e.pointerId);
    loadFloors();
  });
  layer.addEventListener("contextmenu", (e) => {
    const vertex = e.target.closest(".plan-vertex:not(.is-draft)");
    const item = plan.items.get(view.selected);
    if (draft.points.length) {
      e.preventDefault();
      draft.points.pop();
      drawDraft();
    } else if (vertex && item) {
      e.preventDefault();
      removePoint(item, Number(vertex.dataset.vertex));
    }
  });

  view.keys = (e) => {
    const item = plan.items.get(view.selected);
    if (e.key === "Escape") {
      e.preventDefault();
      if (draft.points.length) resetDraft();
      else if (view.placing) { view.placing = null; loadFloors(); } else select(null);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (draft.points.length) {
        e.preventDefault();
        draft.points.pop();
        drawDraft();
      } else if (item && view.vertex !== null) {
        e.preventDefault();
        removePoint(item, view.vertex);
      }
    } else if (e.key === "Enter" && view.tool === "outline" && draft.points.length >= 3) {
      e.preventDefault();
      finishOutline();
    }
  };
}

// Keys while drawing (Escape, Backspace, Delete, Enter), unless a dialog or a field has them.
document.addEventListener("keydown", (e) => {
  if (state.view !== "floors" || !facilitiesView.drawing || !facilitiesView.keys) return;
  if (document.querySelector("dialog[open]") || e.target.closest?.("input, textarea, select")) return;
  facilitiesView.keys(e);
});

async function saveShape(officeId, points) {
  try {
    await api(`/api/offices/${officeId}`, { method: "PUT", body: { points } });
  } catch (error) {
    toast(error.message, "error");
  }
  loadFloors();
}

/** Asks how long the line drawn from `from` to `to` really is, and sets the floor's scale from it. */
async function setScaleFromLine(floor, from, to) {
  const saved = await formDialog({
    title: "Set the scale",
    intro: h("p", { class: "muted small-text", text: "How long is the line you drew, in real life? With a scale, each office's area is measured from its outline, as a suggestion: the size you enter for an office is the one kept." }),
    fields: [{ name: "feet", label: "Length (feet)", type: "number", step: "any", min: "0", required: true, autofocus: true, hint: "Inches as a decimal: 12 ft 6 in is 12.5." }],
    submitLabel: "Set scale",
    onSubmit: async (v) => (await api(`/api/floors/${floor.id}/scale`, { method: "PUT", body: { from, to, feet: Number(v.feet) } })).floor
  });
  if (saved) toast(`Scale set: the plan is about ${Math.round(saved.scale.feet).toLocaleString("en-US")} ft across.`);
  return saved;
}

async function clearScale(floor) {
  if (!(await confirmDialog(`Clear the scale of ${floor.name}? Sizes already entered stay as they are.`, { confirmLabel: "Clear scale" }))) return;
  try {
    await api(`/api/floors/${floor.id}/scale`, { method: "PUT", body: { feet: null } });
    toast("Scale cleared.");
  } catch (error) {
    toast(error.message, "error");
  }
  loadFloors();
}

/** Fills in, from the plan, the size of each office that has none (sizes entered are left alone). */
async function fillSizes(offices) {
  const list = offices.filter((o) => o.sqft === null && o.measuredSqft);
  const names = list.map((o) => `${o.name}: ${fmtSqft(o.measuredSqft)}`);
  if (!(await confirmDialog(`Fill in the size of ${list.length} ${list.length === 1 ? "office" : "offices"} from the plan (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""})? Offices that already have a size keep it, and any size can be changed afterwards.`, { confirmLabel: "Fill in" }))) return;
  let done = 0;
  for (const o of list) {
    try {
      await api(`/api/offices/${o.id}`, { method: "PUT", body: { sqft: o.measuredSqft } });
      done += 1;
    } catch (error) {
      toast(`${o.name}: ${error.message}`, "error");
    }
  }
  toast(`Filled in ${done} ${done === 1 ? "size" : "sizes"}.`);
  loadFloors();
}

/** Beside the plan: the key with counts, the floor's totals, and its offices (with those not yet drawn). */
function floorSide(floor, offices) {
  const counts = Object.fromEntries(Object.keys(OFFICE_STATUS).map((s) => [s, offices.filter((o) => o.status === s).length]));
  const sum = (list, key) => list.reduce((n, o) => n + (o[key] || 0), 0);
  const occupied = offices.filter((o) => o.status === "occupied");
  const free = offices.filter((o) => o.status === "available" || o.status === "upcoming");
  const editor = canEditFacilities();
  const row = (o) => h("div", { class: "floor-office-row", role: "button", tabindex: "0", onclick: () => openOffice(o.id, loadFloors), onkeydown: (e) => { if (e.key === "Enter") openOffice(o.id, loadFloors); } },
    h("span", { class: `plan-swatch status-${o.status}`, "aria-hidden": "true" }),
    h("span", { class: "floor-office-main" }, h("strong", { text: o.name }), h("span", { class: "muted small-text", text: officeHolder(o) || OFFICE_STATUS[o.status].label })),
    !o.points && facilitiesView.drawing && editor
      ? h("button", { type: "button", class: "link-btn small-text", text: "Place", onclick: (e) => { e.stopPropagation(); Object.assign(facilitiesView, { placing: o, selected: null, tool: facilitiesView.tool === "scale" ? "rect" : facilitiesView.tool }); loadFloors(); } })
      : h("span", { class: "muted small-text", text: o.sqft ? fmtSqft(o.sqft) : "" }));
  const undrawn = offices.filter((o) => !o.points);
  const unsized = offices.filter((o) => o.sqft === null && o.measuredSqft);
  return h("aside", { class: "floor-side" },
    h("div", { class: "panel" },
      h("h3", { text: floor.name }),
      multiSite() ? h("p", { class: "muted small-text", text: floor.siteName }) : null,
      h("ul", { class: "plan-legend" }, Object.entries(OFFICE_STATUS).map(([s, d]) => h("li", { title: d.hint || null },
        h("span", { class: `plan-swatch status-${s}`, "aria-hidden": "true" }), h("span", { text: d.label }), h("strong", { text: String(counts[s]) })))),
      h("dl", { class: "facts small-facts" },
        h("dt", { text: "Space" }), h("dd", { text: fmtSqft(sum(offices, "sqft")) }),
        h("dt", { text: "Let" }), h("dd", { text: fmtSqft(sum(occupied, "sqft")) }),
        h("dt", { text: "Free" }), h("dd", { text: fmtSqft(sum(free, "sqft")) }),
        h("dt", { text: "Rent" }), h("dd", { text: `${fmtMoney(sum(occupied, "monthly"))} a month` }),
        floor.planRef ? [h("dt", { text: "Scale" }), h("dd", {},
          floor.scale ? `The plan is ${Math.round(floor.scale.feet).toLocaleString("en-US")} ft across` : "Not set",
          editor ? h("button", { type: "button", class: "link-btn small-text", text: floor.scale ? " Change" : " Set it", onclick: () => setDrawing(true, "scale") }) : null,
          editor && floor.scale ? h("button", { type: "button", class: "link-btn small-text danger-text", text: " Clear", onclick: () => clearScale(floor) }) : null)] : null),
      editor && unsized.length ? h("button", { type: "button", class: "secondary small fill-sizes", text: `Fill in ${unsized.length} missing ${unsized.length === 1 ? "size" : "sizes"} from the plan`, onclick: () => fillSizes(offices) }) : null),
    h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: `Offices (${offices.length})` }),
        editor ? h("button", { type: "button", class: "link-btn small-text", text: "Add without drawing", onclick: async () => { if (await editOffice(null, { floor })) loadFloors(); } }) : null),
      offices.length ? h("div", { class: "floor-office-list" }, offices.map(row)) : h("p", { class: "muted small-text", text: facilitiesView.drawing || !editor ? "None yet." : "None yet. Choose Draw offices to draw them on the plan." }),
      undrawn.length && floor.planRef ? h("p", { class: "muted small-text", text: `${undrawn.length} not on the plan yet${editor ? ": choose Draw offices, then Place" : ""}.` }) : null));
}

// --- floors ----------------------------------------------------------------------------------------

async function addFloor(siteId = null) {
  const sites = activeSites();
  const saved = await formDialog({
    title: "Add floor",
    fields: [
      multiSite() ? { name: "siteId", label: "Site", type: "select", value: String(siteId || state.site || sites[0]?.id || ""), options: sites.map((s) => ({ value: String(s.id), label: s.name })) } : null,
      { name: "name", label: "Name", required: true, placeholder: "Level 1", autofocus: true }
    ].filter(Boolean),
    submitLabel: "Add floor",
    onSubmit: async (v) => (await api("/api/floors", { method: "POST", body: { siteId: Number(v.siteId || sites[0]?.id), name: v.name } })).floor
  });
  if (!saved) return;
  toast(`Added ${saved.name}. Upload its plan next.`);
  location.hash = `#floors/${saved.id}`;
  if (state.view === "floors") showFloors(String(saved.id));
}

async function editFloor(floor) {
  const result = await formDialog({
    title: `Edit ${floor.name}`,
    fields: [
      { name: "name", label: "Name", value: floor.name, required: true },
      { name: "position", label: "Order", type: "number", value: String(floor.position), step: "1", half: true, hint: "Floors are listed lowest first." }
    ],
    extraActions: [
      floor.planRef ? { label: "Remove plan", kind: "secondary", value: "plan" } : null,
      { label: "Delete floor", kind: "danger", value: "delete" }
    ].filter(Boolean),
    onSubmit: async (v) => (await api(`/api/floors/${floor.id}`, { method: "PUT", body: { name: v.name, position: Number(v.position) } })).floor
  });
  if (result === "plan") {
    if (!(await confirmDialog(`Remove the plan of ${floor.name}? Its offices stay, with their places, ready for a new plan.`, { confirmLabel: "Remove plan" }))) return;
    try {
      await api(`/api/floors/${floor.id}/plan`, { method: "DELETE" });
      toast("Plan removed.");
    } catch (error) {
      toast(error.message, "error");
    }
  } else if (result === "delete") {
    if (!(await confirmDialog(`Delete ${floor.name}, its plan and its ${floor.offices} ${floor.offices === 1 ? "office" : "offices"} with their history? An office that is assigned now or later has to be ended first.`, { danger: true, confirmLabel: "Delete floor" }))) return;
    try {
      await api(`/api/floors/${floor.id}`, { method: "DELETE" });
      facilitiesView.floorId = null;
      toast(`Deleted ${floor.name}.`);
      location.hash = "#floors";
    } catch (error) {
      toast(error.message, "error");
    }
  } else if (result) {
    toast("Saved.");
  }
  loadFloors();
}

/** A plan image as a data: URL the server takes: PNG, or JPEG when that is too big, at most 3000 px a side. */
function planToDataUrl(file) {
  const LIMIT = 3600000; // characters of base64, a little under the server's 2.75 MB
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const encode = (max, type, quality) => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const canvas = h("canvas", { width: Math.max(1, Math.round(img.naturalWidth * scale)), height: Math.max(1, Math.round(img.naturalHeight * scale)) });
        const ctx = canvas.getContext("2d");
        // JPEG has no transparency: put the plan on white.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL(type, quality);
      };
      for (const [max, type, q] of [[3000, "image/png"], [3000, "image/jpeg", 0.88], [2200, "image/jpeg", 0.85], [1600, "image/jpeg", 0.8]]) {
        const data = encode(max, type, q);
        if (data.length <= LIMIT) return resolve(data);
      }
      reject(new Error("That plan is too detailed to store; try a smaller image."));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image this browser can read. Export a PDF plan as a PNG or JPEG first.")); };
    img.src = url;
  });
}

function uploadPlan(floor) {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", hidden: true });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const dataUrl = await planToDataUrl(file);
      await api(`/api/floors/${floor.id}/plan`, { method: "PUT", body: { dataUrl } });
      toast(floor.planRef ? "Plan replaced. The offices keep their places." : "Plan uploaded. Choose Draw offices to draw them on it.");
      loadFloors();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  document.body.append(input);
  input.click();
}

// --- an office ---------------------------------------------------------------------------------------

/**
 * Adds an office (on `floor`, outlined by `points` when given; else choosing the floor) or
 * changes one. The size is whatever is entered; with a scale, a new outline's measured area
 * is offered to start with.
 */
async function editOffice(office, { floor = null, points = null } = {}) {
  const measured = office ? office.measuredSqft : floor && points ? measuredSqft(points, floor) : null;
  let floors = null;
  if (!office && !floor) {
    ({ floors } = await api(`/api/floors?${facilitySite()}`));
    if (!floors.length) {
      toast("Add a floor first, under Floor plans.", "error");
      return null;
    }
  }
  const saved = await formDialog({
    title: office ? `Edit ${office.name}` : "Add office",
    fields: [
      floors ? { name: "floorId", label: "Floor", type: "select", options: floors.map((f) => ({ value: String(f.id), label: multiSite() ? `${f.siteName}: ${f.name}` : f.name })) } : null,
      { name: "name", label: "Name or number", value: office?.name, required: true, autofocus: true, placeholder: "Suite 210" },
      { name: "sqft", label: "Size (sq ft)", type: "number", value: office ? office.sqft ?? "" : measured ?? "", step: "any", min: "0", half: true,
        hint: measured ? `About ${measured.toLocaleString("en-US")} sq ft measured on the plan${office ? "" : ": change it to the real size if you know it"}.` : null },
      { name: "rate", label: "Rate ($ per sq ft a month)", type: "number", value: office?.rate ?? "", step: "0.01", min: "0", half: true,
        hint: "Empty to use the site's default. A company's own rate wins over both." },
      { name: "unavailable", label: "Unavailable (can't be assigned, e.g. under renovation)", type: "checkbox", value: Boolean(office?.unavailable) },
      { name: "notes", label: "Notes", type: "textarea", value: office?.notes ?? "", rows: 2 }
    ].filter(Boolean),
    submitLabel: office ? "Save" : "Add office",
    onSubmit: async (v) => {
      const body = { name: v.name, sqft: v.sqft === "" ? null : Number(v.sqft), rate: v.rate === "" ? null : Number(v.rate), unavailable: v.unavailable, notes: v.notes };
      if (office) return (await api(`/api/offices/${office.id}`, { method: "PUT", body })).office;
      return (await api("/api/offices", { method: "POST", body: { ...body, floorId: floor ? floor.id : Number(v.floorId), ...(points ? { points } : {}) } })).office;
    }
  });
  if (saved) toast(office ? "Saved." : `Added ${saved.name}.`);
  return saved;
}

/**
 * An office: where it is, who has it, what it costs, and its history, with buttons to assign
 * it, end or change an assignment, and edit or delete it. Calls onChange after a change.
 */
async function openOffice(id, onChange = () => {}) {
  let office;
  try {
    ({ office } = await api(`/api/offices/${id}`));
  } catch (error) {
    toast(error.message, "error");
    return;
  }
  const editor = canEditFacilities();
  const today = todayISO();
  let dialog = null;
  const pick = (value) => dialog?.finish(value);
  const history = office.assignments.length
    ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Company", "From", "To", "Notes", ""].map((t) => h("th", { text: t })))),
      h("tbody", {}, office.assignments.map((a) => {
        const upcoming = a.startDate > today;
        const ended = a.endDate && a.endDate < today;
        return h("tr", {},
          h("td", {}, a.companyId ? h("a", { href: `#company/${a.companyId}`, text: a.companyName, onclick: () => pick(null) }) : a.companyName,
            upcoming ? h("span", { class: "badge warn", text: "Upcoming" }) : ended ? null : h("span", { class: "badge", text: "Now" })),
          h("td", { text: fmtDay(a.startDate) }),
          h("td", { text: a.endDate ? fmtDay(a.endDate) : "No end date" }),
          h("td", { class: "small-text pre", text: a.notes || "" }),
          h("td", {}, editor ? h("div", { class: "btn-row" },
            !ended && !upcoming ? h("button", { type: "button", class: "link-btn", text: "End", onclick: () => pick({ do: "end", a }) }) : null,
            h("button", { type: "button", class: "link-btn", text: "Change", onclick: () => pick({ do: "change", a }) }),
            h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: () => pick({ do: "remove", a }) })) : null));
      }))))
    : h("p", { class: "muted small-text", text: "Never assigned." });
  const rateText = office.effectiveRate === null ? "No rate set" : `${fmtRate(office.effectiveRate)} a month, ${RATE_SOURCES[office.rateSource]}`;
  const body = h("div", { class: "stack" },
    h("dl", { class: "facts" },
      h("dt", { text: "Status" }), h("dd", {}, statusBadge(office.status), office.status === "unavailable" ? null : h("span", { text: ` ${officeHolder(office) || ""}` })),
      h("dt", { text: "Where" }), h("dd", {}, h("a", { href: `#floors/${office.floorId}`, text: multiSite() ? `${office.siteName}, ${office.floorName}` : office.floorName, onclick: () => pick(null) }),
        office.points ? null : h("span", { class: "muted small-text", text: " (not drawn on the plan)" })),
      h("dt", { text: "Size" }), h("dd", {}, fmtSqft(office.sqft),
        office.measuredSqft && office.measuredSqft !== office.sqft ? h("span", { class: "muted small-text", text: ` (about ${fmtSqft(office.measuredSqft)} measured on the plan)` }) : null),
      h("dt", { text: "Rate" }), h("dd", { text: rateText }),
      office.rate !== null && office.rateSource !== "office" ? [h("dt", { text: "Office's own rate" }), h("dd", { text: `${fmtRate(office.rate)} a month` })] : null,
      h("dt", { text: office.status === "occupied" ? "Monthly" : "Asking" }), h("dd", {}, h("strong", { text: office.monthly === null ? "—" : `${fmtMoney(office.monthly)} a month` })),
      office.notes ? [h("dt", { text: "Notes" }), h("dd", { class: "pre", text: office.notes })] : null),
    h("h4", { class: "form-heading", text: "Assignments" }),
    history);
  const choice = await openDialog({
    title: `Office ${office.name}`,
    body,
    wide: true,
    onOpen: (dlg) => { dialog = dlg; },
    actions: [
      ...(editor ? [
        { label: "Delete", kind: "danger", value: "delete" },
        { label: "Edit", kind: "secondary", value: "edit" },
        office.unavailable ? null : { label: "Assign to a company", kind: "secondary", value: "assign" }
      ].filter(Boolean) : []),
      { label: "Close", kind: "primary", value: null }
    ]
  });
  if (!choice) return;
  let changed = null;
  if (choice === "assign") changed = await assignOffice(office);
  else if (choice === "edit") changed = await editOffice(office);
  else if (choice === "delete") {
    if (await deleteOffice(office)) onChange();
    return;
  } else if (choice.do === "end") changed = await endAssignment(choice.a);
  else if (choice.do === "change") changed = await changeAssignment(choice.a);
  else if (choice.do === "remove") changed = await removeAssignment(choice.a);
  if (changed) onChange();
  openOffice(id, onChange);
}

async function deleteOffice(office) {
  if (!(await confirmDialog(`Delete office ${office.name} and its history?`, { danger: true, confirmLabel: "Delete" }))) return false;
  try {
    await api(`/api/offices/${office.id}`, { method: "DELETE" });
    toast(`Deleted ${office.name}.`);
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

let facilityCompanies = null;
async function facilityCompanyOptions() {
  facilityCompanies = (await api("/api/facilities/companies")).companies;
  return facilityCompanies.map((c) => ({ value: String(c.id), label: c.name }));
}

async function assignOffice(office, { companyId = null } = {}) {
  const options = await facilityCompanyOptions();
  // From the day after the current company's last day, when it has one; else today.
  let start = todayISO();
  if (office.current?.endDate) {
    const [y, m, d] = office.current.endDate.split("-").map(Number);
    const next = new Date(y, m - 1, d + 1);
    start = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  }
  const saved = await formDialog({
    title: `Assign office ${office.name}`,
    intro: office.current || office.next ? h("p", { class: "muted small-text", text: `${officeHolder(office)}. An office has one company at a time, so the dates can't overlap.` }) : null,
    fields: [
      { name: "companyId", label: "Company", type: "select", value: companyId ? String(companyId) : "", options: [{ value: "", label: "Choose a company" }, ...options], required: true },
      { name: "startDate", label: "From", type: "date", value: start, required: true, half: true },
      { name: "endDate", label: "To (the last day)", type: "date", half: true, hint: "Empty for no end date." },
      { name: "notes", label: "Notes", type: "textarea", rows: 2, placeholder: "Lease reference, terms…" }
    ],
    submitLabel: "Assign",
    onSubmit: async (v) => api(`/api/offices/${office.id}/assignments`, { method: "POST", body: { companyId: Number(v.companyId), startDate: v.startDate, endDate: v.endDate || null, notes: v.notes } })
  });
  if (saved) toast(`${office.name} assigned to ${saved.assignment.companyName}.`);
  return saved;
}

async function endAssignment(a) {
  const saved = await formDialog({
    title: `End ${a.companyName}'s assignment`,
    intro: h("p", { class: "muted small-text", text: "It stays in the office's history. The office is free from the day after." }),
    fields: [{ name: "endDate", label: "Last day", type: "date", value: todayISO(), required: true }],
    submitLabel: "End it",
    onSubmit: async (v) => api(`/api/office-assignments/${a.id}`, { method: "PUT", body: { endDate: v.endDate } })
  });
  if (saved) toast("Ended.");
  return saved;
}

async function changeAssignment(a) {
  const saved = await formDialog({
    title: `${a.companyName}'s assignment`,
    fields: [
      { name: "startDate", label: "From", type: "date", value: a.startDate, required: true, half: true },
      { name: "endDate", label: "To (the last day)", type: "date", value: a.endDate || "", half: true, hint: "Empty for no end date." },
      { name: "notes", label: "Notes", type: "textarea", value: a.notes || "", rows: 2 }
    ],
    onSubmit: async (v) => api(`/api/office-assignments/${a.id}`, { method: "PUT", body: { startDate: v.startDate, endDate: v.endDate || null, notes: v.notes } })
  });
  if (saved) toast("Saved.");
  return saved;
}

async function removeAssignment(a) {
  if (!(await confirmDialog(`Remove ${a.companyName}'s assignment (${fmtDay(a.startDate)} to ${a.endDate ? fmtDay(a.endDate) : "no end date"})? Do this only for one made by mistake: ending an assignment keeps it as history.`, { danger: true, confirmLabel: "Remove" }))) return false;
  try {
    await api(`/api/office-assignments/${a.id}`, { method: "DELETE" });
    toast("Removed.");
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

// --- the offices table -----------------------------------------------------------------------------

function showOffices() {
  loadOffices();
}

async function loadOffices() {
  const params = facilitySite();
  if ($("offices-status").value) params.set("status", $("offices-status").value);
  let offices;
  try {
    ({ offices } = await api(`/api/offices?${params}`));
  } catch (error) {
    $("offices-table").tBodies[0].replaceChildren(emptyRow(8, error.message));
    return;
  }
  const q = $("offices-search").value.trim().toLowerCase();
  if (q) offices = offices.filter((o) => [o.name, o.floorName, o.siteName, o.current?.companyName, o.next?.companyName].some((s) => String(s || "").toLowerCase().includes(q)));
  $("offices-add").hidden = !canEditFacilities();
  const table = $("offices-table");
  table.tHead.replaceChildren(h("tr", {}, ["Office", "Floor", "Size", "Status", "Company", "Rate", "Monthly"].map((t) => h("th", { text: t }))));
  table.tBodies[0].replaceChildren(...(offices.length ? offices.map((o) => {
    const row = h("tr", { class: "clickable" },
      h("td", {}, h("strong", { text: o.name })),
      h("td", { text: officeWhere(o) }),
      h("td", { class: "num", text: o.sqft === null ? "—" : Number(o.sqft).toLocaleString("en-US") }),
      h("td", {}, statusBadge(o.status)),
      h("td", { text: officeHolder(o) || "" }),
      h("td", { class: "num", title: o.rateSource ? `From ${RATE_SOURCES[o.rateSource]}` : null, text: o.effectiveRate === null ? "—" : fmtRate(o.effectiveRate) }),
      h("td", { class: `num${o.status === "occupied" ? "" : " muted"}`, title: o.status === "occupied" ? null : "Asking", text: fmtMoney(o.monthly) }));
    row.addEventListener("click", () => openOffice(o.id, loadOffices));
    return row;
  }) : [emptyRow(7, q || $("offices-status").value ? "No offices match." : "No offices yet. Add floors and draw their offices under Floor plans.")]));
  const occupied = offices.filter((o) => o.status === "occupied");
  const sqft = (list) => list.reduce((n, o) => n + (o.sqft || 0), 0);
  table.tFoot.replaceChildren(offices.length ? h("tr", {},
    h("td", { colspan: 2, text: `${offices.length} ${offices.length === 1 ? "office" : "offices"}` }),
    h("td", { class: "num", text: Number(sqft(offices)).toLocaleString("en-US") }),
    h("td", { colspan: 3, class: "muted small-text", text: `${occupied.length} occupied, ${Number(sqft(occupied)).toLocaleString("en-US")} sq ft let` }),
    h("td", { class: "num" }, h("strong", { text: fmtMoney(occupied.reduce((n, o) => n + (o.monthly || 0), 0)) }))) : "");
}

$("offices-search").addEventListener("input", debounce(loadOffices));
$("offices-status").addEventListener("change", loadOffices);
$("offices-add").addEventListener("click", async () => { if (await editOffice(null)) loadOffices(); });

// --- rates -------------------------------------------------------------------------------------------

async function showRates() {
  const body = $("rates-body");
  let data;
  try {
    data = await api("/api/facilities/rates");
  } catch (error) {
    body.replaceChildren(h("p", { class: "message error", text: error.message }));
    return;
  }
  const editor = canEditFacilities();
  const sites = state.site ? data.sites.filter((s) => String(s.siteId) === String(state.site)) : data.sites;
  body.replaceChildren(
    h("p", { class: "muted", text: "Rates are dollars per square foot a month. An office uses its company's rate when the company has one, else its own rate, else its site's default. Its monthly cost is its size times that rate." }),
    h("div", { class: "panel" },
      h("h3", { text: "Site defaults" }),
      h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Site", "Default rate", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, sites.map((s) => h("tr", {},
          h("td", { text: s.name }),
          h("td", { text: s.rate === null ? "None" : `${fmtRate(s.rate)} a month` }),
          h("td", {}, editor ? h("button", { type: "button", class: "link-btn", text: "Set", onclick: () => setRate({ url: `/api/facilities/site-rates/${s.siteId}`, title: `${s.name}'s default rate`, rate: s.rate }).then((ok) => ok && showRates()) }) : null))))))),
    h("div", { class: "panel" },
      h("div", { class: "panel-head" }, h("h3", { text: "Company rates" }),
        editor ? h("button", { type: "button", class: "primary small", text: "Set a company's rate", onclick: async () => { if (await setCompanyRate(null)) showRates(); } }) : null),
      data.companies.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Company", "Rate", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, data.companies.map((c) => h("tr", {},
          h("td", {}, h("a", { href: `#company/${c.companyId}`, text: c.name })),
          h("td", { text: `${fmtRate(c.rate)} a month` }),
          h("td", {}, editor ? h("div", { class: "btn-row" },
            h("button", { type: "button", class: "link-btn", text: "Change", onclick: async () => { if (await setCompanyRate(c)) showRates(); } }),
            h("button", { type: "button", class: "link-btn danger-text", text: "Remove", onclick: async () => {
              try {
                await api(`/api/facilities/company-rates/${c.companyId}`, { method: "PUT", body: { rate: null } });
                toast(`${c.name} now pays each office's rate.`);
                showRates();
              } catch (error) {
                toast(error.message, "error");
              }
            } })) : null))))))
        : h("p", { class: "muted small-text", text: "No company has its own rate: each pays its offices' rates." })));
}

/** Asks for a rate and saves it at `url` (empty clears it). */
async function setRate({ url, title, rate, intro = null }) {
  const saved = await formDialog({
    title,
    intro,
    fields: [{ name: "rate", label: "Rate ($ per sq ft a month)", type: "number", value: rate ?? "", step: "0.01", min: "0", autofocus: true, hint: "Empty to clear it." }],
    onSubmit: async (v) => api(url, { method: "PUT", body: { rate: v.rate === "" ? null : Number(v.rate) } })
  });
  if (saved) toast("Rate saved.");
  return saved;
}

/** Sets a company's rate: `company` ({ companyId, name, rate }), or one chosen here. */
async function setCompanyRate(company) {
  if (company) return setRate({ url: `/api/facilities/company-rates/${company.companyId}`, title: `${company.name}'s rate`, rate: company.rate, intro: h("p", { class: "muted small-text", text: "It applies to every office the company has, over the office's and the site's rates." }) });
  const options = await facilityCompanyOptions();
  const saved = await formDialog({
    title: "Set a company's rate",
    fields: [
      { name: "companyId", label: "Company", type: "select", options: [{ value: "", label: "Choose a company" }, ...options], required: true },
      { name: "rate", label: "Rate ($ per sq ft a month)", type: "number", step: "0.01", min: "0", required: true, hint: "It applies to every office the company has, over the office's and the site's rates." }
    ],
    onSubmit: async (v) => api(`/api/facilities/company-rates/${v.companyId}`, { method: "PUT", body: { rate: Number(v.rate) } })
  });
  if (saved) toast("Rate saved.");
  return saved;
}

// --- on a company's page -----------------------------------------------------------------------------

/** A company's offices (now, later and before), its rate and what it pays a month, for its page. */
function companyOfficesPanel(company) {
  const panel = h("div", { class: "panel" }, h("h3", { text: "Offices" }), h("p", { class: "muted small-text", text: "Loading…" }));
  const refresh = () => panel.replaceWith(companyOfficesPanel(company));
  api(`/api/companies/${company.id}/facilities`).then((data) => {
    const editor = canEditFacilities();
    const WHEN = { current: ["Now", ""], upcoming: ["Upcoming", "warn"], ended: ["Ended", "muted"] };
    const rows = data.offices.map((o) => {
      const row = h("tr", { class: `clickable${o.when === "ended" ? " inactive" : ""}` },
        h("td", {}, h("strong", { text: o.officeName }), h("span", { class: `badge ${WHEN[o.when][1]}`, text: WHEN[o.when][0] })),
        h("td", { text: multiSite() ? `${o.siteName}, ${o.floorName}` : o.floorName }),
        h("td", { text: `${fmtDay(o.assignment.startDate)} – ${o.assignment.endDate ? fmtDay(o.assignment.endDate) : "no end date"}` }),
        h("td", { class: "num", text: o.sqft === null ? "—" : Number(o.sqft).toLocaleString("en-US") }),
        h("td", { class: "num", text: o.when === "ended" ? "" : fmtRate(o.rate) }),
        h("td", { class: "num", text: o.when === "ended" ? "" : fmtMoney(o.monthly) }));
      row.addEventListener("click", () => openOffice(o.officeId, refresh));
      return row;
    });
    const t = data.totals;
    panel.replaceChildren(
      h("div", { class: "panel-head" },
        h("h3", { text: "Offices" }),
        h("div", { class: "btn-row" },
          h("span", { class: "small-text muted", text: data.rate === null ? "Pays each office's rate" : `Company rate ${fmtRate(data.rate)} a month` }),
          editor ? h("button", { type: "button", class: "secondary small", text: data.rate === null ? "Set a rate" : "Change rate", onclick: async () => { if (await setCompanyRate({ companyId: company.id, name: company.name, rate: data.rate })) refresh(); } }) : null)),
      rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "table compact" },
        h("thead", {}, h("tr", {}, ["Office", "Floor", "Dates", "Sq ft", "Rate", "Monthly"].map((x) => h("th", { text: x })))),
        h("tbody", {}, rows),
        t.offices ? h("tfoot", {}, h("tr", {},
          h("td", { colspan: 3, text: `Now: ${t.offices} ${t.offices === 1 ? "office" : "offices"}` }),
          h("td", { class: "num", text: Number(t.sqft).toLocaleString("en-US") }),
          h("td", {}),
          h("td", { class: "num" }, h("strong", { text: fmtMoney(t.monthly) })))) : null))
        : h("p", { class: "muted small-text", text: editor ? "No offices. Assign one from Facilities > Floor plans or Offices." : "No offices." }));
  }).catch((error) => panel.replaceChildren(h("h3", { text: "Offices" }), h("p", { class: "message error", text: error.message })));
  return panel;
}

// 00-motion.js: how things move. Springs (a damping ratio and a response, as Apple describes
// them) for anything a person can grab, so a motion can be caught and turned around midway and
// carries the finger's speed; momentum projected from a flick; soft edges that resist rather
// than stop. Also the scroll edge under the header, press feedback on touch screens, and a
// soft cross-fade when the theme changes. Everything respects "reduce motion".

/** Whether the person asked for less motion (checked each time: it can change while open). */
function reducedMotion() {
  return Boolean(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Animates a number with a spring, from where it is now and at the speed it has now (px/s),
 * calling onUpdate(value) each frame and onDone() once it settles. damping 1 settles without
 * overshoot; below 1 it overshoots a little (only after a flick). response is roughly how long
 * it takes, in seconds. Returns { stop(), value(), velocity() }: stop() leaves it where it is,
 * so a new spring (or a finger) can carry on from that value.
 */
function springTo({ from, to, velocity = 0, damping = 1, response = 0.35, onUpdate, onDone = () => {} }) {
  let x = from;
  let v = velocity;
  let frame = 0;
  let last = performance.now();
  const k = (2 * Math.PI / response) ** 2;
  const c = 4 * Math.PI * damping / response;
  const settle = () => {
    frame = 0;
    x = to;
    v = 0;
    onUpdate(to);
    onDone();
  };
  if (reducedMotion()) {
    settle();
    return { stop() {}, value: () => x, velocity: () => 0 };
  }
  const step = (now) => {
    // Small fixed steps keep it stable however long a frame took.
    let dt = Math.min((now - last) / 1000, 0.064);
    last = now;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      v += (-k * (x - to) - c * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(x - to) < 0.3 && Math.abs(v) < 8) return settle();
    onUpdate(x);
    frame = requestAnimationFrame(step);
    return null;
  };
  frame = requestAnimationFrame(step);
  return {
    stop() { cancelAnimationFrame(frame); frame = 0; },
    value: () => x,
    velocity: () => v
  };
}

/**
 * How far a flick carries on (px) at a given speed (px/s), as a scroll view slows down: the
 * resting point to aim for, rather than where the finger let go. rate 0.998 is a normal scroll.
 */
function projectMomentum(velocity, rate = 0.998) {
  return (velocity / 1000) * rate / (1 - rate);
}

/** Past an edge, things follow less and less: overshoot (px) in a space `dimension` px long. */
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Remembers a pointer's last moments, for its speed when let go: { add(x, y), velocity() } in px/s. */
function trackVelocity() {
  let samples = [];
  return {
    add(x, y) {
      const t = performance.now();
      samples.push({ x, y, t });
      samples = samples.filter((s) => t - s.t < 100);
    },
    velocity() {
      if (samples.length < 2) return { x: 0, y: 0 };
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000 || 1;
      // A pause before letting go means no flick.
      if (performance.now() - b.t > 80) return { x: 0, y: 0 };
      return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
    }
  };
}

/** The CSS spring (styles.css --spring), for animations started from here. */
function springEasing() {
  return getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "ease-out";
}

/**
 * New content arriving from the side it's heading: dir 1 from the right (onward), -1 from the
 * left (back), 0 just fades in. With less motion asked for, it only fades.
 */
function slideIn(el, dir = 0) {
  if (typeof el.animate !== "function") return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  if (dir && !reducedMotion()) el.animate([{ transform: `translateX(${dir * 28}px)` }, { transform: "none" }], { duration: 470, easing: springEasing() });
}

/**
 * Things that changed places glide from where they were: this notes where each is now (by
 * key), and the function it returns, called once they've moved, animates them from there.
 */
function glideFrom(elements, keyOf) {
  const was = new Map([...elements].map((el) => [keyOf(el), el.getBoundingClientRect()]));
  return (moved) => {
    if (reducedMotion()) return;
    for (const el of moved) {
      const r = was.get(keyOf(el));
      if (!r || typeof el.animate !== "function") continue;
      const now = el.getBoundingClientRect();
      const dx = r.left - now.left;
      const dy = r.top - now.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 470, easing: springEasing() });
    }
  };
}

/** A whole-page change (light to dark) as a short cross-fade, not a flash. */
function softly(change) {
  if (typeof document.startViewTransition !== "function" || reducedMotion()) return change();
  document.startViewTransition(change);
  return null;
}

// Press feedback the moment a finger lands: Safari on iPhone and iPad shows :active only when
// the page listens for touches.
document.addEventListener("touchstart", () => {}, { passive: true });

// Things that stick under the header need its height, which changes as it wraps.
{
  const chrome = document.getElementById("chrome");
  if (chrome && typeof ResizeObserver === "function") {
    new ResizeObserver(() => document.documentElement.style.setProperty("--chrome-h", `${chrome.offsetHeight}px`)).observe(chrome);
  }
}

// The header floats over the page; once the page scrolls under it, a soft edge shows where
// they meet (and not before, so the top of the page has no line across it).
{
  let ticking = false;
  const mark = () => {
    ticking = false;
    document.documentElement.classList.toggle("is-scrolled", window.scrollY > 2);
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(mark); }
  }, { passive: true });
}

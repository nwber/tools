/**
 * World map for the AWS region latency page: renders the country outline
 * from /data/world-outline.json as inline SVG, places the user's location
 * (Cloudflare geo, city-level), draws a great-circle line from it to every
 * selected region, colors lines by measured median RTT, and supports
 * drag-pan + wheel/pinch/double-click/button zoom, auto-fitting whatever
 * regions are selected.
 *
 * The view is a window over the 3600x1800-unit world; panning is
 * confined to the world box, and a line whose arc crosses the
 * antimeridian is additionally drawn one world over so it visibly wraps
 * the edge. All math lives in aws-latency-map-calc.js (unit-tested);
 * this module only wires it to the DOM.
 *
 * The page interacts with:
 *   map.ready                  promise -> status string (outline loaded?)
 *   map.setUser(loc | null)    loc = { lat, lon, label }
 *   map.sync(regions)          selected regions; redraws markers + lines, fits
 *   map.updateRegion(code, { state, summary, maxMedian })
 *   map.highlight(code | null) row-hover sync
 *   map.zoom(factor)           about the viewport center (buttons)
 *   map.fit()                  re-fit the current selection (button)
 */

import {
  WORLD_H,
  WORLD_W,
  boundsOf,
  clampView,
  fitView,
  greatCirclePoints,
  latencyStyle,
  scaleLimits,
  screenPoint,
  topologyPaths,
  worldX,
  worldY,
  wrapShifts,
  zoomAt,
} from "./aws-latency-map-calc.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const UNMEASURED_COLOR = "#94a3b8";
const UNREACHABLE_COLOR = "#dc3545";
const USER_COLOR = "#2563eb";
const FIT_MAX_K = 6; // fits never zoom in closer than ~continent level

const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};

const coords = (points, shift) =>
  points.map((p) => `${Math.round(worldX(p.lon + shift))},${Math.round(worldY(p.lat))}`).join(" ");

/**
 * Build the map inside `container` (the #map div). `callbacks`:
 *   onHover(code | null)  a region's line or marker was hovered / left
 *   onSelect(code)        a region's line or marker was clicked
 */
export function createMap(container, callbacks = {}) {
  const svg = svgEl("svg", { width: "100%", height: "100%", role: "img" });
  const zoomG = svgEl("g");
  const worldG = svgEl("g", { class: "world", "fill-rule": "evenodd", "pointer-events": "none" });
  const linesG = svgEl("g", { class: "lines" });
  zoomG.append(worldG, linesG);
  const markersG = svgEl("g", { class: "markers" });
  svg.append(zoomG, markersG);
  container.append(svg);

  let view = null;
  let viewport = { w: 0, h: 0 };
  let limits = scaleLimits({ w: 800, h: 400 });
  let user = null;
  let userMarker = null;
  let highlighted = null;
  let rafPending = false;
  let animRaf = 0;
  const entries = new Map(); // code -> { region, x, y, state, summary, style, highlighted, markerG, dot, titleEl, lineEls, hitEls }

  const localPoint = (event) => {
    const rect = svg.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const cancelAnimation = () => cancelAnimationFrame(animRaf);

  const scheduleApply = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      applyView();
    });
  };

  function applyView() {
    if (!view) return;
    zoomG.setAttribute(
      "transform",
      `translate(${viewport.w / 2} ${viewport.h / 2}) scale(${view.k}) translate(${-view.cx} ${-view.cy})`,
    );
    if (user) positionMarker(userMarker, user.x, user.y);
    for (const entry of entries.values()) positionMarker(entry.markerG, entry.x, entry.y);
  }

  function positionMarker(marker, x, y) {
    const [sx, sy] = screenPoint(view, viewport, x, y);
    marker.setAttribute("transform", `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);
  }

  function animateView(target, duration = 350) {
    cancelAnimation();
    if (!view) {
      view = target;
      applyView();
      return;
    }
    const from = { ...view };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      view = {
        cx: from.cx + (target.cx - from.cx) * eased,
        cy: from.cy + (target.cy - from.cy) * eased,
        k: from.k + (target.k - from.k) * eased,
      };
      applyView();
      if (t < 1) animRaf = requestAnimationFrame(step);
    };
    animRaf = requestAnimationFrame(step);
  }

  /** Fit the user marker plus every selected region, with a little air. */
  function fit() {
    const points = [];
    if (user) points.push([user.x, user.y]);
    for (const entry of entries.values()) points.push([entry.x, entry.y]);
    let target;
    if (points.length === 0) {
      target = { cx: WORLD_W / 2, cy: WORLD_H / 2, k: limits.kMin };
    } else {
      const box = boundsOf(points);
      // A selection that spans most of the world (every group checked) is
      // fitted as the whole world instead, so the map's edges stay visible.
      // A lone point has no extent; give it a 25° window to sit in.
      const grow = points.length === 1 ? 250 : 0;
      const wide =
        box.maxX - box.minX + 2 * grow >= WORLD_W * 0.8 || box.maxY - box.minY + 2 * grow >= WORLD_H * 0.8;
      const padded = wide
        ? { minX: 0, maxX: WORLD_W, minY: 0, maxY: WORLD_H }
        : {
            minX: box.minX - grow,
            maxX: box.maxX + grow,
            minY: box.minY - grow,
            maxY: box.maxY + grow,
          };
      target = clampView(
        fitView(padded, viewport, { pad: 40, minK: limits.kMin, maxK: Math.min(limits.kMax, FIT_MAX_K) }),
        viewport,
      );
    }
    animateView(target);
  }

  function titleFor(entry) {
    const parts = [entry.region.name, entry.region.code];
    if (entry.summary) parts.push(`${entry.summary.median} ms median`);
    else if (entry.state === "unreachable") parts.push("unreachable");
    return parts.join(" · ");
  }

  function applyEntryStyle(entry) {
    const base = entry.style ?? { color: UNMEASURED_COLOR, width: 1.5 };
    const width = base.width + (entry.highlighted ? 1.5 : 0);
    for (const line of entry.lineEls) {
      line.setAttribute("stroke", base.color);
      line.setAttribute("stroke-width", width.toFixed(2));
      if (base.dash) line.setAttribute("stroke-dasharray", "4 4");
      else line.removeAttribute("stroke-dasharray");
    }
    entry.dot.setAttribute("fill", base.color);
    entry.dot.setAttribute("r", entry.highlighted ? 7 : 5.5);
    entry.titleEl.textContent = titleFor(entry);
    for (const hit of entry.hitEls) hit.setAttribute("stroke-width", entry.highlighted ? 16 : 12);
  }

  function highlight(code) {
    if (highlighted === code) return;
    if (highlighted !== null) {
      const prev = entries.get(highlighted);
      if (prev) {
        prev.highlighted = false;
        applyEntryStyle(prev);
      }
    }
    highlighted = code;
    const entry = code !== null ? entries.get(code) : undefined;
    if (entry) {
      entry.highlighted = true;
      applyEntryStyle(entry);
    }
  }

  /** (Re)draw the user->region line(s), including antimeridian wrap copies. */
  function drawEntryLines(entry) {
    for (const el of [...entry.lineEls, ...entry.hitEls]) el.remove();
    entry.lineEls = [];
    entry.hitEls = [];
    if (!user) return;
    const points = greatCirclePoints(user, { lat: entry.region.lat, lon: entry.region.lon });
    for (const shift of wrapShifts(points)) {
      const attr = coords(points, shift);
      const line = svgEl("polyline", {
        class: "line",
        points: attr,
        fill: "none",
        stroke: UNMEASURED_COLOR,
        "stroke-width": "1.5",
        "stroke-linecap": "round",
        "vector-effect": "non-scaling-stroke",
      });
      linesG.append(line);
      entry.lineEls.push(line);
      const hit = svgEl("polyline", {
        class: "hit",
        points: attr,
        fill: "none",
        stroke: "transparent",
        "stroke-width": "12",
        "pointer-events": "stroke",
      });
      wireRegionEvents(hit, entry.region.code);
      linesG.append(hit);
      entry.hitEls.push(hit);
    }
    applyEntryStyle(entry);
  }

  function wireRegionEvents(el, code) {
    el.addEventListener("mouseenter", () => {
      highlight(code);
      callbacks.onHover?.(code);
    });
    el.addEventListener("mouseleave", () => {
      highlight(null);
      callbacks.onHover?.(null);
    });
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      callbacks.onSelect?.(code);
    });
  }

  /** Create (or reuse) the marker + line elements for the selected set. */
  function sync(regions) {
    const keep = new Set(regions.map((region) => region.code));
    for (const [code, entry] of entries) {
      if (keep.has(code)) continue;
      entry.markerG.remove();
      for (const el of [...entry.lineEls, ...entry.hitEls]) el.remove();
      entries.delete(code);
      if (highlighted === code) highlighted = null;
    }
    for (const region of regions) {
      if (entries.has(region.code)) continue;
      const entry = {
        region,
        x: worldX(region.lon),
        y: worldY(region.lat),
        state: "queued",
        summary: null,
        style: null,
        highlighted: false,
        markerG: null,
        dot: null,
        titleEl: null,
        lineEls: [],
        hitEls: [],
      };
      entry.markerG = svgEl("g", { class: "marker" });
      entry.dot = svgEl("circle", {
        class: "dot",
        r: "5.5",
        fill: UNMEASURED_COLOR,
        stroke: "#fff",
        "stroke-width": "1.5",
      });
      entry.titleEl = svgEl("title");
      entry.titleEl.textContent = titleFor(entry);
      const halo = svgEl("circle", { class: "halo", r: "11", fill: "transparent" });
      entry.markerG.append(entry.dot, halo, entry.titleEl);
      wireRegionEvents(entry.markerG, region.code);
      markersG.append(entry.markerG);
      entries.set(region.code, entry);
      drawEntryLines(entry);
    }
    fit();
  }

  /** Restyle one region's line/marker from its row state. */
  function updateRegion(code, { state, summary, maxMedian }) {
    const entry = entries.get(code);
    if (!entry) return;
    entry.state = state;
    entry.summary = summary ?? null;
    if (summary) {
      entry.style = latencyStyle(summary.median, maxMedian);
    } else if (state === "unreachable") {
      entry.style = { color: UNREACHABLE_COLOR, width: 1.5, dash: true };
    } else if (state === "timeout" || state === "error") {
      entry.style = { color: UNMEASURED_COLOR, width: 1.5, dash: true };
    } else {
      entry.style = null;
    }
    applyEntryStyle(entry);
  }

  // --- pan / zoom -------------------------------------------------------

  const pointers = new Map(); // pointerId -> [x, y] in viewport px
  let pinch = null;

  container.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    container.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, localPoint(event));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { k: view?.k ?? limits.kMin, cx: view?.cx ?? WORLD_W / 2, cy: view?.cy ?? WORLD_H / 2, dist: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) };
    } else {
      container.classList.add("dragging");
    }
    cancelAnimation();
  });

  container.addEventListener("pointermove", (event) => {
    if (!view || !pointers.has(event.pointerId)) return;
    const point = localPoint(event);
    if (pointers.size === 1) {
      const [lastX, lastY] = pointers.get(event.pointerId);
      view = clampView(
        { cx: view.cx - (point[0] - lastX) / view.k, cy: view.cy - (point[1] - lastY) / view.k, k: view.k },
        viewport,
      );
      pointers.set(event.pointerId, point);
      scheduleApply();
    } else if (pointers.size === 2 && pinch) {
      pointers.set(event.pointerId, point);
      const [a, b] = [...pointers.values()];
      const distance = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      view = clampView(
        zoomAt({ cx: pinch.cx, cy: pinch.cy, k: pinch.k }, viewport, mid[0], mid[1], distance / pinch.dist, limits),
        viewport,
      );
      scheduleApply();
    }
  });

  const endPointer = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) container.classList.remove("dragging");
  };
  container.addEventListener("pointerup", endPointer);
  container.addEventListener("pointercancel", endPointer);

  container.addEventListener("wheel", (event) => {
    if (!view) return;
    event.preventDefault();
    cancelAnimation();
    // Normalize wheel units (pixels / lines / pages); one notch ~ x1.26.
    const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 300 : 1;
    const factor = 2 ** (-(event.deltaY * unit) / 250);
    const [px, py] = localPoint(event);
    view = clampView(zoomAt(view, viewport, px, py, factor, limits), viewport);
    scheduleApply();
  }, { passive: false });

  container.addEventListener("dblclick", (event) => {
    if (!view) return;
    cancelAnimation();
    const [px, py] = localPoint(event);
    view = clampView(zoomAt(view, viewport, px, py, 1.8, limits), viewport);
    scheduleApply();
  });

  const resizeObserver = new ResizeObserver(() => {
    const rect = svg.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    viewport = { w: rect.width, h: rect.height };
    limits = scaleLimits(viewport);
    if (view) {
      view = clampView(view, viewport);
      scheduleApply();
    }
  });
  resizeObserver.observe(container);

  // --- public API --------------------------------------------------------

  const map = {
    ready: fetch("/data/world-outline.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        for (const d of topologyPaths(data.topology)) {
          worldG.append(svgEl("path", { d, "vector-effect": "non-scaling-stroke" }));
        }
        return "ready";
      })
      .catch((error) => {
        console.error(error);
        return `world outline unavailable (${error.message}) — routes still shown`;
      }),

    /** Place (or clear) the user's location and redraw every line from it. */
    setUser(location) {
      user = location ? { ...location, x: worldX(location.lon), y: worldY(location.lat) } : null;
      if (userMarker) {
        userMarker.remove();
        userMarker = null;
      }
      if (user) {
        userMarker = svgEl("g", { class: "marker user" });
        const title = svgEl("title");
        title.textContent = `Your location · ${user.label} (city-level, via Cloudflare geo)`;
        userMarker.append(
          svgEl("circle", { r: "9", fill: "none", stroke: USER_COLOR, "stroke-width": "1.5", opacity: "0.5" }),
          svgEl("circle", { class: "dot", r: "5.5", fill: USER_COLOR, stroke: "#fff", "stroke-width": "1.5" }),
          svgEl("circle", { class: "halo", r: "13", fill: "transparent" }),
          title,
        );
        markersG.append(userMarker);
      }
      for (const entry of entries.values()) drawEntryLines(entry);
      fit();
    },

    sync,

    updateRegion,

    highlight,

    fit,

    /** Zoom by `factor` about the viewport center (map buttons). */
    zoom(factor) {
      if (!view) return;
      cancelAnimation();
      view = clampView(zoomAt(view, viewport, viewport.w / 2, viewport.h / 2, factor, limits), viewport);
      applyView();
    },
  };

  return map;
}

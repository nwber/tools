/**
 * Cost graph for the EBS pricing comparator: renders the per-type curves
 * from ebs-calc.js's calculateSeries as an inline SVG — the same
 * dependency-free approach as the EC2 tool's credit-balance chart.
 *
 * Y is always USD/month, drawn on the linear or log scale chosen by the
 * page's buttons (ebs-page.js passes the choice through the model). X is
 * the input the page's select sweeps (IOPS, throughput, or size), capped
 * at 1.5x the calculator's current value for it; each curve ends at its
 * type's own limit or the cap, whichever comes first. A type whose held
 * inputs already exceed its limits appears in the legend without a curve
 * (the table shows the same type as an ERROR row).
 *
 * The DOM wiring that calls this lives in ebs-page.js.
 */

/** X-axis title and tooltip unit per swept input. */
export const GRAPH_AXES = {
  iops: { label: "IOPS", unit: "IOPS" },
  throughput: { label: "Throughput (MiB/s)", unit: "MiB/s" },
  size: { label: "Size (GiB)", unit: "GiB" },
};

/** One stable line color per volume type, so curves keep their identity. */
const TYPE_COLORS = {
  gp2: "#64748b",
  gp3: "#2563eb",
  io1: "#dc2626",
  io2: "#f97316",
  st1: "#16a34a",
  sc1: "#7c3aed",
  standard: "#b45309",
};

/** Fallback cycle for types not in TYPE_COLORS. */
const COLOR_CYCLE = ["#0d9488", "#be185d", "#4f46e5", "#65a30d", "#0284c7", "#7c2d12", "#334155"];

const WIDTH = 860;
const HEIGHT = 340;
const PAD = { top: 18, right: 24, bottom: 48, left: 64 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

const lineColor = (type, index) => TYPE_COLORS[type] ?? COLOR_CYCLE[index % COLOR_CYCLE.length];

/** Strip trailing zeros from a decimal label ("16.0" -> "16", "2.50" -> "2.5"). */
const trim = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/** Tick labels for counts below the k threshold; toPrecision kills float dust. */
const plainCount = (v) => trim(Number(v).toPrecision(6));

/** Thousands tick labels ("50k"); 0 keeps a bare zero. */
const kCount = (v) => (v === 0 ? "0" : trim((v / 1e3).toFixed(1)) + "k");

/** Tick labels for USD below the k threshold. */
const plainUsd = (v) => (v >= 100 ? "$" + Math.round(v) : "$" + trim(v.toFixed(2)));
const kUsd = (v) => (v === 0 ? "$0" : "$" + trim((v / 1e3).toFixed(1)) + "k");

/** A 1/2/2.5/5×10^n step at least as large as raw. */
const niceStep = (raw) => {
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
};

/** 0..max ticks rounded up to a nice top (linear Y axis). max <= 0 gets [0, 1]. */
const ticks = (max, target) => {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / target);
  const top = Math.ceil(max / step - 1e-9) * step;
  const out = [];
  for (let i = 0; i <= Math.round(top / step); i++) out.push(i * step);
  return out;
};

/**
 * Ticks from 0 up to an exact cap (X axis): nice step multiples, with the
 * cap itself as the final tick so the axis ends exactly where the graph
 * says it does (e.g. IOPS 3,000 in the calculator -> last tick 4,500).
 */
const cappedTicks = (top, target) => {
  const step = niceStep(top / target);
  const out = [];
  for (let i = 0; i * step <= top + step * 1e-9; i++) out.push(i * step);
  if (out[out.length - 1] < top) out.push(top);
  return out;
};

/** Smallest 1/2/5×10^n at least as large as v (log Y-axis top). */
const niceCeil = (v) => [1, 2, 5, 10].map((m) => m * 10 ** Math.floor(Math.log10(v))).find((c) => c >= v);

/**
 * Decade ticks for the log Y axis: 1/2/5 per decade while the axis spans
 * three decades or fewer, plain decades beyond that; the top is always
 * the final tick.
 */
const logTicks = (floor, top) => {
  const subs = Math.log10(top) - Math.log10(floor) <= 3 ? [1, 2, 5] : [1];
  const out = [];
  for (let e = Math.round(Math.log10(floor)); e <= Math.floor(Math.log10(top) + 1e-9); e++) {
    for (const m of subs) {
      const v = m * 10 ** e;
      if (v >= floor && v <= top * (1 + 1e-9)) out.push(v);
    }
  }
  if (out[out.length - 1] < top) out.push(top);
  return out;
};

/**
 * Densify a vertex-only curve for log rendering: a straight chord between
 * vertices in log space would bow away from the true curve (cost is
 * linear in x, so its log is exponential). Flat segments need no help.
 */
const subdivide = (points) => {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    out.push(a);
    if (a.y === b.y || b.x === a.x) continue;
    const steps = 12;
    for (let j = 1; j < steps; j++) {
      out.push({ x: a.x + ((b.x - a.x) * j) / steps, y: a.y + (b.y - a.y) * (j / steps) });
    }
  }
  out.push(points[points.length - 1]);
  return out;
};

/**
 * Render the cost curves into a container as an SVG plus a legend row.
 *
 * @param {HTMLElement} container - the #costChart div
 * @param {{ axis: string, limit: number, scale?: "linear" | "log", series: Array<{ type: string, name: string, points: Array<{ x: number, y: number }> }> }} model
 *   the return value of ebs-calc.js's calculateSeries, plus the Y-axis
 *   scale chosen by the page's Linear/Log buttons (default linear)
 */
export function renderCostChart(container, model) {
  const scale = model.scale === "log" ? "log" : "linear";
  const plotted = model.series.filter((s) => s.points.length > 0);
  if (plotted.length === 0) {
    container.innerHTML =
      '<p class="chart-empty">' +
      (model.series.length === 0
        ? "Select one or more volume types to graph."
        : "None of the selected volume types can meet these inputs — see the ERROR rows above.") +
      "</p>";
    return;
  }

  // X domain: calculateSeries' cap (current swept value + 50%).
  const xTop = model.limit > 0 ? model.limit : Math.max(...plotted.map((s) => s.points[s.points.length - 1].x));
  const xTicks = cappedTicks(xTop, 6);
  const px = (x) => PAD.left + (x / xTop) * PLOT_W;
  const axisName = GRAPH_AXES[model.axis]?.label ?? model.axis;
  const axisUnit = GRAPH_AXES[model.axis]?.unit ?? model.axis;
  // One label style per axis: k-abbreviate only when the domain is large.
  const xfmt = xTop >= 1e4 ? kCount : plainCount;

  const yMax = Math.max(...plotted.flatMap((s) => s.points.map((p) => p.y)));
  const positives = plotted.flatMap((s) => s.points.map((p) => p.y)).filter((y) => y > 0);

  let yTicks;
  let py;
  let yfmt;
  if (scale === "log" && positives.length > 0) {
    // Floor at the decade of the cheapest point; zero-cost points clamp
    // onto it (a $0 cost has no place on a log axis, but it can hug it).
    const yFloor = 10 ** Math.floor(Math.log10(Math.min(...positives)));
    const yTop = Math.max(niceCeil(yMax), yFloor * 10);
    const span = Math.log10(yTop) - Math.log10(yFloor);
    py = (y) => PAD.top + PLOT_H - ((Math.log10(Math.max(y, yFloor)) - Math.log10(yFloor)) / span) * PLOT_H;
    yTicks = logTicks(yFloor, yTop);
    yfmt = yTop >= 1e4 ? kUsd : plainUsd;
  } else {
    yTicks = ticks(yMax, 5);
    const yTop = yTicks[yTicks.length - 1];
    py = (y) => PAD.top + PLOT_H - (y / yTop) * PLOT_H;
    yfmt = yTop >= 1e4 ? kUsd : plainUsd;
  }

  let svg =
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img"` +
    ` aria-label="monthly cost in USD by ${axisName} for the selected volume types${scale === "log" ? " (log scale)" : ""}"` +
    ` style="width:100%;height:auto;display:block">`;

  yTicks.forEach((v) => {
    const y = py(v).toFixed(1);
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + PLOT_W}" y2="${y}"` +
      ` stroke="${v === 0 ? "#b9c2cc" : "#edf1f5"}"/>`;
    svg += `<text x="${PAD.left - 8}" y="${py(v) + 4}" text-anchor="end" font-size="11" fill="#6d7f97">${yfmt(v)}</text>`;
  });
  xTicks.forEach((v) => {
    const x = px(v).toFixed(1);
    svg += `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + PLOT_H}" stroke="#edf1f5"/>`;
    svg += `<text x="${x}" y="${PAD.top + PLOT_H + 18}" text-anchor="middle" font-size="11" fill="#6d7f97">${xfmt(v)}</text>`;
  });

  svg +=
    `<text transform="rotate(-90 ${PAD.left - 46} ${PAD.top + PLOT_H / 2})"` +
    ` x="${PAD.left - 46}" y="${PAD.top + PLOT_H / 2}" text-anchor="middle" font-size="12" fill="#52606d">USD / month${scale === "log" ? " (log)" : ""}</text>`;
  svg += `<text x="${PAD.left + PLOT_W / 2}" y="${HEIGHT - 8}" text-anchor="middle" font-size="12" fill="#52606d">${axisName}</text>`;

  // One polyline per volume type; <title> gives the curve's end cost on hover.
  model.series.forEach((s, i) => {
    if (s.points.length === 0) return;
    const last = s.points[s.points.length - 1];
    const curve = scale === "log" ? subdivide(s.points) : s.points;
    const points = curve.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
    svg += `<polyline fill="none" stroke="${lineColor(s.type, i)}" stroke-width="2" points="${points}">` +
      `<title>${s.name} — $${last.y.toFixed(2)}/mo at ${xfmt(last.x)} ${axisUnit}</title></polyline>`;
  });
  svg += "</svg>";

  // The legend lists every selected type; ones without a curve are muted.
  const legend = model.series
    .map((s, i) => {
      const color = lineColor(s.type, i);
      const empty = s.points.length === 0;
      const swatch = empty
        ? `style="background:${color};opacity:.25"`
        : `style="background:${color}"`;
      const cls = empty
        ? ' class="legend-item legend-empty" title="exceeds its size/IOPS/throughput limits at these inputs"'
        : ' class="legend-item"';
      return `<span${cls}><span class="swatch" ${swatch}></span>${s.name}</span>`;
    })
    .join("");

  container.innerHTML = svg + `<div class="chart-legend">${legend}</div>`;
}

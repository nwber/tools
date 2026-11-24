/**
 * Cost graph for the EBS pricing comparator: renders the per-type curves
 * from ebs-calc.js's calculateSeries as an inline SVG — the same
 * dependency-free approach as the EC2 tool's credit-balance chart.
 *
 * Y is always USD/month. X is whichever input the page's select sweeps
 * (IOPS, throughput, or size); each curve ends at its type's own limit,
 * and a type whose held inputs already exceed its limits appears in the
 * legend without a curve (the table shows the same type as an ERROR row).
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

/** Drop a trailing ".0" from a formatted tick ("16.0k" -> "16k"). */
const trim = (s) => s.replace(/\.0+([kM]?)$/, "$1");

/** Thousands tick labels ("50k"); 0 keeps a bare zero. */
const kCount = (v) => (v === 0 ? "0" : trim((v / 1e3).toFixed(1)) + "k");
const kUsd = (v) => (v === 0 ? "$0" : "$" + trim((v / 1e3).toFixed(1)) + "k");

/** Tick labels for counts below the k threshold. */
const plainCount = (v) => String(Math.round(v));
const plainUsd = (v) => (v >= 100 ? "$" + Math.round(v) : "$" + trim(v.toFixed(2)));

/**
 * 0..max ticks at a 1/2/2.5/5×10^n step; the last tick is the domain top.
 * max <= 0 gets [0, 1] so the plot still has a sane domain.
 */
const ticks = (max, target) => {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step - 1e-9) * step;
  const out = [];
  for (let i = 0; i <= Math.round(top / step); i++) out.push(i * step);
  return out;
};

/**
 * Render the cost curves into a container as an SVG plus a legend row.
 *
 * @param {HTMLElement} container - the #costChart div
 * @param {{ axis: string, series: Array<{ type: string, name: string, points: Array<{ x: number, y: number }> }> }} model
 *   the return value of ebs-calc.js's calculateSeries
 */
export function renderCostChart(container, model) {
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

  const xMax = Math.max(...plotted.map((s) => s.points[s.points.length - 1].x));
  const yMax = Math.max(...plotted.flatMap((s) => s.points.map((p) => p.y)));
  const xTicks = ticks(xMax, 6);
  const yTicks = ticks(yMax, 5);
  const xTop = xTicks[xTicks.length - 1];
  const yTop = yTicks[yTicks.length - 1];
  const px = (x) => PAD.left + (x / xTop) * PLOT_W;
  const py = (y) => PAD.top + PLOT_H - (y / yTop) * PLOT_H;
  const axisName = GRAPH_AXES[model.axis]?.label ?? model.axis;
  const axisUnit = GRAPH_AXES[model.axis]?.unit ?? model.axis;
  // One label style per axis: k-abbreviate only when the domain is large.
  const xfmt = xTop >= 1e4 ? kCount : plainCount;
  const yfmt = yTop >= 1e4 ? kUsd : plainUsd;

  let svg =
    `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img"` +
    ` aria-label="monthly cost in USD by ${axisName} for the selected volume types"` +
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
    ` x="${PAD.left - 46}" y="${PAD.top + PLOT_H / 2}" text-anchor="middle" font-size="12" fill="#52606d">USD / month</text>`;
  svg += `<text x="${PAD.left + PLOT_W / 2}" y="${HEIGHT - 8}" text-anchor="middle" font-size="12" fill="#52606d">${axisName}</text>`;

  // One polyline per volume type; <title> gives the curve's end cost on hover.
  model.series.forEach((s, i) => {
    if (s.points.length === 0) return;
    const last = s.points[s.points.length - 1];
    const points = s.points.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
    svg += `<polyline fill="none" stroke="${lineColor(s.type, i)}" stroke-width="2" points="${points}">` +
      `<title>${s.name} — up to $${last.y.toFixed(2)}/mo at ${last.x.toLocaleString("en-US")} ${axisUnit}</title></polyline>`;
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

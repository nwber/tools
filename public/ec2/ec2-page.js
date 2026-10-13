/**
 * DOM wiring for the EC2 burst calculator.
 *
 * Loads the generated dataset (/data/ec2-burst-spec.json), wires the form to
 * the pure simulation in ec2-burst-calc.js, and renders the summary, notes,
 * credit-balance chart (inline SVG), and comparison table.
 */

import { simulateBurst, TERM_LABELS, TERMS } from "./ec2-burst-calc.js";

const spec = await fetch("/data/ec2-burst-spec.json").then((response) => response.json());

const $ = (id) => document.getElementById(id);
const money = (value) =>
  "$" + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function option(value, label, selected = false) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  if (selected) el.selected = true;
  return el;
}

function populate() {
  const instance = $("instance");
  for (const family of Object.keys(spec.families)) {
    const group = document.createElement("optgroup");
    group.label = `${family} — ${spec.families[family].processor}`;
    for (const size of spec.sizes.filter((s) => s.family === family)) {
      group.appendChild(option(size.type, `${size.type} — ${size.vcpu} vCPU, ${size.memoryGiB} GiB`));
    }
    instance.appendChild(group);
  }
  instance.value = "t4g.small";

  const region = $("region");
  for (const r of spec.regions) region.appendChild(option(r.id, `${r.name} (${r.id})`));
  region.value = "us-east-1";

  const term = $("term");
  for (const t of TERMS) term.appendChild(option(t, TERM_LABELS[t]));
}

function readInputs() {
  return {
    type: $("instance").value,
    region: $("region").value,
    avgCpu: Number($("avgCpu").value || 0),
    peakCpu: Number($("peakCpu").value || 0),
    peakMinutesPerDay: Number($("peakMinutes").value || 0),
    hoursPerDay: Number($("hoursPerDay").value || 0),
    days: Number($("days").value || 0),
    mode: $("mode").value,
    term: $("term").value,
  };
}

function renderChart(result) {
  const width = 720;
  const height = 180;
  const pad = 34;
  const maxCredits = result.size.maxCredits;
  const days = result.timeline.length;
  const x = (day) => pad + ((day - 1) / Math.max(1, days - 1)) * (width - pad * 2);
  const y = (bucket) => height - pad - (bucket / maxCredits) * (height - pad * 2);
  const points = result.timeline.map((t) => `${x(t.day).toFixed(1)},${y(t.bucket).toFixed(1)}`);
  const depletion = result.credits.timeToDepletionDay;
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="CPU credit balance per day">`;
  svg += `<line x1="${pad}" y1="${y(0)}" x2="${width - pad}" y2="${y(0)}" stroke="#c8d0da"/>`;
  svg += `<line x1="${pad}" y1="${y(maxCredits)}" x2="${width - pad}" y2="${y(maxCredits)}" stroke="#c8d0da" stroke-dasharray="4 4"/>`;
  svg += `<text x="${pad - 6}" y="${y(0) + 4}" text-anchor="end" font-size="11" fill="#6d7f97">0</text>`;
  svg += `<text x="${pad - 6}" y="${y(maxCredits) + 4}" text-anchor="end" font-size="11" fill="#6d7f97">${maxCredits}</text>`;
  svg += `<polyline fill="none" stroke="#007bff" stroke-width="2" points="${points.join(" ")}"/>`;
  if (depletion !== null) {
    svg += `<line x1="${x(depletion)}" y1="${pad - 12}" x2="${x(depletion)}" y2="${height - pad}" stroke="#dc3545" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    svg += `<text x="${x(depletion) + 4}" y="${pad - 14}" font-size="11" fill="#dc3545">credits depleted (day ${depletion})</text>`;
  }
  svg += `<text x="${pad}" y="${height - 8}" font-size="11" fill="#6d7f97">credit balance after day 1</text>`;
  svg += `<text x="${width - pad}" y="${height - 8}" text-anchor="end" font-size="11" fill="#6d7f97">after day ${days}</text>`;
  svg += `</svg>`;
  $("chart").innerHTML = svg;
}

function renderTable(result) {
  const { size, comparison, costs } = result;
  const rows = [
    ["Instance", size.type, comparison.type, comparison.exact ? "exact match" : "closest available"],
    ["vCPU", size.vcpu, comparison.vcpu, ""],
    ["Memory (GiB)", size.memoryGiB, comparison.memoryGiB, ""],
    ["Baseline", `${size.baselinePct}% (${size.creditsPerHour} cr/hr)`, "fixed performance", ""],
    ["Rate ($/hr)", costs.burstable.rate.toFixed(5), costs.candidate.rate.toFixed(5), ""],
    ["Base cost", money(costs.burstable.base), money(costs.candidate.total), ""],
    [
      "Unlimited surcharge",
      result.credits.baselinePct === undefined ? "" : money(costs.burstable.surcharge),
      "—",
      "",
    ],
    ["Total", money(costs.burstable.total), money(costs.candidate.total), ""],
  ];
  const tbody = rows
    .map(
      ([label, burstable, candidate, note]) =>
        `<tr><th scope="row">${label}</th><td>${burstable}</td><td>${candidate}</td><td class="note">${note}</td></tr>`,
    )
    .join("");
  $("comparison").innerHTML =
    `<table class="detail"><thead><tr><th></th><th>Burstable</th><th>Non-burstable</th><th></th></tr></thead><tbody>${tbody}</tbody></table>`;
}

function render() {
  const result = simulateBurst(spec, readInputs());
  const out = $("results");
  if (!result.ok) {
    out.innerHTML = `<div class="warning">${result.error}</div>`;
    return;
  }
  const { costs, credits, comparison } = result;
  const delta = costs.candidate.total - costs.burstable.total;
  const cards = [
    ["Burstable total", money(costs.burstable.total), `${result.profile.hoursPerDay}h/day × ${result.profile.days}d`],
    [
      `Non-burstable (${comparison.type})`,
      money(costs.candidate.total),
      `${comparison.vcpu} vCPU, ${comparison.memoryGiB} GiB${comparison.exact ? "" : " (closest)"}`,
    ],
    [
      "Difference",
      (delta >= 0 ? "+" : "−") + money(Math.abs(delta)),
      delta >= 0 ? "burstable is cheaper" : "non-burstable is cheaper",
    ],
  ];
  if (result.profile.days > 0 && result.profile.hoursPerDay > 0) {
    cards.push(
      [
        "Time to depletion",
        credits.timeToDepletionDay === null ? "none in this period" : `day ${credits.timeToDepletionDay}`,
        `${credits.earnedPerDay} earned vs ${credits.peakSpendPerDay + credits.idleSpendPerDay} spent per day`,
      ],
      [
        "Throttle time",
        credits.throttledMinutesPerDay > 0 ? `${credits.throttledMinutesPerDay} min/day` : "0 min",
        `${credits.totalThrottledMinutes} min total`,
      ],
      [
        "Unlimited breakeven",
        `${costs.breakevenAvgPct}% avg CPU`,
        "above this average the non-burstable is cheaper",
      ],
    );
  }
  $("cards").innerHTML = cards
    .map(
      ([label, value, sub]) =>
        `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`,
    )
    .join("");
  $("summary").textContent = result.summary;
  $("notes").innerHTML =
    result.notes.length > 0
      ? `<div class="warning">${result.notes.map((n) => "Note: " + n).join("<br>")}</div>`
      : "";
  renderChart(result);
  renderTable(result);
}

populate();
for (const id of ["instance", "region", "avgCpu", "peakCpu", "peakMinutes", "hoursPerDay", "days", "mode", "term"]) {
  $(id).addEventListener("input", render);
}
render();

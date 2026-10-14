/**
 * DOM wiring for the data transfer estimator.
 *
 * Loads the generated dataset (/data/data-transfer-pricing.json), builds the
 * region controls and traffic inputs from the model's own row definitions,
 * and renders the NAT vs. VPC-endpoints comparison via the pure model in
 * data-transfer-calc.js.
 */

import { computeDataTransferCost, TRAFFIC_ROWS } from "./data-transfer-calc.js";

const pricing = await fetch("/data/data-transfer-pricing.json").then((response) =>
  response.json(),
);

const $ = (id) => document.getElementById(id);
const money = (value) =>
  "$" + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A rate like 0.045 or 0.0105 with trailing zeros trimmed. */
const rate = (value) => "$" + String(Number(value.toFixed(6)));

const REGION_BY_CODE = Object.fromEntries(pricing.regions.map((r) => [r.code, r]));
const GROUP_LABELS = Object.fromEntries(pricing.groups.map((group) => [group.id, group.label]));

const DEFAULT_TRAFFIC = {
  s3Gb: 5000,
  dynamodbGb: 500,
  otherAwsGb: 1000,
  internetGb: 1000,
  crossAzGb: 500,
  crossRegionGb: 200,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key.startsWith("data-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

/** Grouped region <option>s, excluding `excludeCode` when given. */
function regionOptions(select, excludeCode) {
  for (const group of pricing.groups) {
    const options = pricing.regions
      .filter((r) => r.group === group.id && r.code !== excludeCode)
      .map((r) => el("option", { value: r.code, textContent: `${r.name} (${r.code})` }));
    if (options.length > 0) {
      select.append(el("optgroup", { label: GROUP_LABELS[group.id] }, ...options));
    }
  }
}

function numberInput(id, value, step = "any") {
  const input = el("input", { type: "number", id, value, min: 0, step });
  input.addEventListener("input", render);
  return input;
}

let crossRegionDest;

function buildControls() {
  const region = $("region");
  regionOptions(region);
  region.value = "us-east-1";
  region.addEventListener("input", () => {
    // Keep the cross-region destination valid when the source region changes.
    rebuildCrossRegionDest();
    render();
  });

  for (const count of [1, 2, 3]) {
    $("azCount").append(
      el("option", { value: String(count), textContent: `${count} AZ${count > 1 ? "s" : ""}` }),
    );
  }
  $("azCount").value = "2";
  $("azCount").addEventListener("input", render);

  $("endpointCount").addEventListener("input", render);

  crossRegionDest = $("crossRegionDest");
  rebuildCrossRegionDest("eu-west-1");

  const body = $("traffic-body");
  for (const row of TRAFFIC_ROWS) {
    body.append(
      el(
        "tr",
        {},
        el("th", { scope: "row", textContent: row.label }),
        el(
          "td",
          { "data-label": "GB / month" },
          numberInput(`traffic-${row.key}`, DEFAULT_TRAFFIC[row.key] ?? 0, "1"),
        ),
        el("td", { class: "hint-cell" }, el("span", { textContent: row.hint })),
      ),
    );
  }
}

function rebuildCrossRegionDest(preferred) {
  const source = $("region").value;
  const select = crossRegionDest;
  const previous = select.value;
  select.innerHTML = "";
  regionOptions(select, source);
  const keep =
    preferred && preferred !== source ? preferred : previous && previous !== source ? previous : null;
  select.value = keep ?? pricing.regions.find((r) => r.code !== source)?.code ?? "";
}

function readInputs() {
  const traffic = {};
  for (const row of TRAFFIC_ROWS) {
    traffic[row.key] = Number($(`traffic-${row.key}`).value || 0);
  }
  return {
    region: $("region").value,
    azCount: Number($("azCount").value),
    interfaceEndpointCount: Number($("endpointCount").value || 0),
    traffic,
    crossRegionDest: crossRegionDest.value,
  };
}

function render() {
  const result = computeDataTransferCost(pricing, readInputs());
  const out = $("results");
  if (!result.ok) {
    out.innerHTML = `<div class="warning">${result.error}</div>`;
    $("cards").innerHTML = "";
    $("compare-body").innerHTML = "";
    $("rates-body").innerHTML = "";
    $("notes").innerHTML = "";
    return;
  }
  out.innerHTML = "";

  const rates = result.rates;
  const breakEvenText =
    result.breakEven === null
      ? "—"
      : result.breakEven.perServiceGb === null
        ? "never"
        : `${result.breakEven.perServiceGb.toLocaleString()} GB`;
  $("cards").innerHTML = [
    ["All via NAT", money(result.scenarios.nat.total), "per month"],
    ["With VPC endpoints", money(result.scenarios.endpoints.total), "per month"],
    [
      result.savings >= 0 ? "Savings" : "Extra cost",
      money(Math.abs(result.savings)),
      `${money(Math.abs(result.savingsPerYear))} per year`,
    ],
    ["Break-even per endpoint", breakEvenText, "GB / month per service"],
  ]
    .map(
      ([label, value, sub]) =>
        `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`,
    )
    .join("");

  // Comparison table: every cost line, both scenarios, and the delta.
  const natByKey = Object.fromEntries(result.scenarios.nat.lines.map((l) => [l.key, l]));
  const endpointByKey = Object.fromEntries(result.scenarios.endpoints.lines.map((l) => [l.key, l]));
  const keys = result.scenarios.endpoints.lines.map((l) => l.key);
  const rows = keys
    .filter((key) => {
      const natLine = natByKey[key] ?? {};
      const endpointLine = endpointByKey[key] ?? {};
      return (natLine.usd ?? 0) + (endpointLine.usd ?? 0) > 0 || natLine.unpriced || endpointLine.unpriced;
    })
    .map((key) => {
      const natLine = natByKey[key] ?? { usd: 0 };
      const endpointLine = endpointByKey[key] ?? { usd: 0 };
      const unpriced = Boolean(natLine.unpriced || endpointLine.unpriced);
      const delta = natLine.usd - endpointLine.usd;
      const deltaClass = unpriced ? "" : delta > 0 ? "good" : delta < 0 ? "bad" : "";
      const deltaText = unpriced || delta === 0 ? "—" : (delta > 0 ? "+" : "−") + money(Math.abs(delta));
      const cell = (line) => (unpriced ? "—" : money(line.usd));
      return `<tr><th scope="row">${endpointLine.label}${unpriced ? " (no published rate)" : ""}</th><td class="num" data-label="All via NAT">${cell(natLine)}</td><td class="num" data-label="With endpoints">${cell(endpointLine)}</td><td class="num ${deltaClass}" data-label="Delta">${deltaText}</td></tr>`;
    });
  rows.push(
    `<tr class="total-row"><th scope="row">Total</th><td class="num" data-label="All via NAT">${money(result.scenarios.nat.total)}</td><td class="num" data-label="With endpoints">${money(result.scenarios.endpoints.total)}</td><td class="num ${result.savings >= 0 ? "good" : "bad"}" data-label="Delta">${result.savings === 0 ? "—" : (result.savings > 0 ? "+" : "−") + money(Math.abs(result.savings))}</td></tr>`,
  );
  $("compare-body").innerHTML = rows.join("");

  // Effective rates for the current selection.
  const destName = REGION_BY_CODE[$("crossRegionDest").value]?.name ?? "";
  const crossRegionLine = result.scenarios.endpoints.lines.find((l) => l.key === "cross-region");
  const pairLine =
    rates.interRegionOutPerGb !== null
      ? `<tr><th scope="row">Cross-region out to ${destName}</th><td>${rate(rates.interRegionOutPerGb)} / GB</td></tr>`
      : crossRegionLine?.unpriced
        ? `<tr><th scope="row">Cross-region out to ${destName}</th><td>no published rate for this pair</td></tr>`
        : "";
  $("rates-body").innerHTML = [
    `<tr><th scope="row">NAT gateway</th><td>${rate(rates.natHourUsd)} / hour + ${rate(rates.natGbUsd)} / GB processed</td></tr>`,
    `<tr><th scope="row">Interface endpoint (per endpoint, per AZ)</th><td>${rate(rates.endpointHourUsd)} / hour + ${rates.endpointGbTiers.map((t) => `${rate(t.perGbUsd)} / GB${t.upToGb === null ? "" : ` up to ${t.upToGb.toLocaleString()} GB`}`).join(", then ")}</td></tr>`,
    `<tr><th scope="row">Cross-AZ</th><td>${rate(rates.crossAzPerGb)} / GB each direction</td></tr>`,
    `<tr><th scope="row">Internet egress</th><td>${rates.internetOutTiers.map((t) => `${rate(t.perGbUsd)} / GB${t.upToGb === null ? "+" : ` to ${t.upToGb.toLocaleString()} GB`}`).join(", ")} (first ${pricing.internetOutFreeGb} GB free)</td></tr>`,
    pairLine,
  ].join("");

  $("notes").innerHTML =
    result.notes.length > 0
      ? result.notes.map((note) => `<div class="warning">${note}</div>`).join("")
      : "";
}

buildControls();
render();

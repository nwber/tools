/**
 * DOM wiring for the S3 cost calculator.
 *
 * Loads the generated dataset (/data/s3-pricing.json), builds the input
 * tables from the model's own row definitions, and renders the cost
 * breakdown via the pure model in s3-calc.js.
 */

import { computeS3Cost, RETRIEVAL_CLASSES, STORAGE_ROWS } from "./s3-calc.js";

const pricing = await fetch("/data/s3-pricing.json").then((response) => response.json());

const $ = (id) => document.getElementById(id);
const money = (value) =>
  "$" + value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CLASS_LABELS = Object.fromEntries(pricing.classes.map((c) => [c.id, c.name]));
const CLASS_BY_ID = Object.fromEntries(pricing.classes.map((c) => [c.id, c]));

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

function numberInput(id, value, min = 0, step = "any") {
  const input = el("input", { type: "number", id, value, min, step });
  input.addEventListener("input", render);
  return input;
}

const REQUEST_CLASSES = [
  "standard",
  "intelligent-tiering",
  "standard-ia",
  "onezone-ia",
  "glacier-ir",
  "glacier-flexible",
  "glacier-deep-archive",
];

const TRANSITION_CLASSES = REQUEST_CLASSES;

function buildTables() {
  const region = $("region");
  for (const r of pricing.regions) {
    region.append(el("option", { value: r.id, textContent: `${r.name} (${r.id})` }));
  }
  region.value = "us-east-1";

  // Storage table
  const storageBody = $("storage-body");
  for (const row of STORAGE_ROWS) {
    storageBody.append(
      el(
        "tr",
        { class: row.key.startsWith("it-") ? "subrow" : "" },
        el("td", { textContent: row.label }),
        el("td", {}, numberInput(`storage-${row.key}`, row.key === "standard" ? 1000 : 0)),
      ),
    );
  }

  // Requests + lifecycle table
  const reqBody = $("requests-body");
  for (const classId of REQUEST_CLASSES) {
    const retrieval = RETRIEVAL_CLASSES.find((entry) => entry.classId === classId);
    const cells = [
      el("td", { textContent: CLASS_LABELS[classId] }),
      el(
        "td",
        { "data-label": "PUT / COPY / POST / LIST" },
        numberInput(`put-${classId}`, classId === "standard" ? 100000 : 0, 0, "1"),
      ),
      el(
        "td",
        { "data-label": "GET / other" },
        numberInput(`get-${classId}`, classId === "standard" ? 1000000 : 0, 0, "1"),
      ),
      el(
        "td",
        { "data-label": "Transitions into class" },
        numberInput(`transition-${classId}`, 0, 0, "1"),
      ),
    ];
    if (retrieval) {
      cells.push(
        el(
          "td",
          { "data-label": "Retrieved (GB)" },
          numberInput(`retrieval-${classId}`, 0),
        ),
      );
      const select = el("select", { id: `mode-${classId}` });
      for (const mode of retrieval.modes) select.append(el("option", { value: mode, textContent: mode }));
      select.addEventListener("input", render);
      cells.push(el("td", { "data-label": "Retrieval mode" }, select));
    } else {
      cells.push(
        el("td", { "data-label": "Retrieved (GB)", textContent: "—" }),
        el("td", { "data-label": "Retrieval mode", textContent: "—" }),
      );
    }
    reqBody.append(el("tr", {}, ...cells));
  }
}

function readInputs() {
  const storageGb = {};
  for (const row of STORAGE_ROWS) storageGb[row.key] = Number($(`storage-${row.key}`).value || 0);
  const requests = {};
  for (const classId of REQUEST_CLASSES) {
    requests[classId] = {
      put: Number($(`put-${classId}`).value || 0),
      get: Number($(`get-${classId}`).value || 0),
    };
  }
  const retrieval = {};
  for (const entry of RETRIEVAL_CLASSES) {
    retrieval[entry.classId] = {
      gb: Number($(`retrieval-${entry.classId}`).value || 0),
      mode: $(`mode-${entry.classId}`).value,
    };
  }
  const transitions = {};
  for (const classId of TRANSITION_CLASSES) {
    transitions[classId] = Number($(`transition-${classId}`).value || 0);
  }
  return {
    region: $("region").value,
    storageGb,
    requests,
    retrieval,
    transitions,
    itObjectsPerMonth: Number($("itObjects").value || 0),
  };
}

function render() {
  const result = computeS3Cost(pricing, readInputs());
  const out = $("results");
  if (!result.ok) {
    out.innerHTML = `<div class="warning">${result.error}</div>`;
    return;
  }
  $("cards").innerHTML = [
    ["Total", money(result.total), "per month"],
    ["Storage", money(result.storage.total), `${result.storage.lines.length} classes`],
    ["Requests", money(result.requests.total), "PUT/GET per month"],
    ["Retrieval + transitions", money(result.retrieval.total + result.transitions.total), "restores / lifecycle"],
    ["Monitoring", money(result.monitoring.cost), "Intelligent-Tiering"],
    ["Effective rate", result.perTb === null ? "—" : money(result.perTb) + "/TiB", "all-in"],
  ]
    .map(
      ([label, value, sub]) =>
        `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`,
    )
    .join("");

  const section = (title, lines) =>
    `<h3>${title}</h3><table class="detail"><tbody>${lines.join("")}</tbody></table>`;
  const storageLines = result.storage.lines.map(
    (line) =>
      `<tr><th scope="row">${line.label}</th><td>${line.gb.toLocaleString()} GB</td><td class="num">${money(line.cost)}</td></tr>`,
  );
  const requestLines = result.requests.lines.map(
    (line) =>
      `<tr><th scope="row">${CLASS_LABELS[line.classId]}</th><td>${line.put.toLocaleString()} PUT + ${line.get.toLocaleString()} GET</td><td class="num">${money(line.cost)}</td></tr>`,
  );
  const retrievalLines = result.retrieval.lines.map(
    (line) =>
      `<tr><th scope="row">${CLASS_LABELS[line.classId]} (${line.mode})</th><td>${line.gb.toLocaleString()} GB × $${line.ratePerGb}/GB</td><td class="num">${money(line.cost)}</td></tr>`,
  );
  const transitionLines = result.transitions.lines.map(
    (line) =>
      `<tr><th scope="row">→ ${CLASS_LABELS[line.classId]}</th><td>${line.count.toLocaleString()} objects/requests × $${line.ratePer1000}/1k</td><td class="num">${money(line.cost)}</td></tr>`,
  );

  out.innerHTML =
    (result.storage.lines.length ? section("Storage", storageLines) : "") +
    (result.requests.lines.length ? section("Requests", requestLines) : "") +
    (result.retrieval.lines.length ? section("Retrieval", retrievalLines) : "") +
    (result.transitions.lines.length ? section("Lifecycle transitions", transitionLines) : "") +
    (result.monitoring.objectsPerMonth > 0
      ? section("Intelligent-Tiering monitoring", [
          `<tr><th scope="row">Objects</th><td>${result.monitoring.objectsPerMonth.toLocaleString()} objects × $${pricing.prices[result.region]["intelligent-tiering"].monitoringPer1000ObjectsPerMonth}/1k</td><td class="num">${money(result.monitoring.cost)}</td></tr>`,
        ])
      : "");
  $("notes").innerHTML =
    result.notes.length > 0 ? `<div class="warning">${result.notes.join("<br>")}</div>` : "";
}

buildTables();
$("region").addEventListener("input", render);
$("itObjects").addEventListener("input", render);
render();

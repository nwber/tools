/**
 * AWS region latency orchestration: opaque cross-origin GETs to each
 * region's public DynamoDB health endpoint, timed with performance.now().
 * Probe math lives in aws-latency-calc.js; the map (this page also draws
 * your location and a route line to every selected region) is wired in
 * through aws-latency-map.js.
 *
 * Methodology:
 *  - probes run sample-major (round 1 for every selected region, then round
 *    2, ...) with a small concurrency cap, so regions see comparable
 *    network conditions;
 *  - the first probe of each region is discarded as DNS/TCP/TLS warm-up;
 *  - a region that fails twice (6 s timeout or network error) is marked
 *    unreachable and its remaining probes are skipped;
 *  - rows are ranked by median when the run finishes (or is stopped) rather
 *    than live, so the table does not jump around while measuring.
 */

import { probeUrl, sortByMedian, summarize } from "./aws-latency-calc.js";
import { createMap } from "./aws-latency-map.js";

const PROBE_TIMEOUT_MS = 6000;
const CONCURRENCY = 6;
const MAX_FAILURES = 2;
const DEFAULT_GROUPS = ["us-canada", "europe"];

const $ = (id) => document.getElementById(id);

let dataset = null;
let running = false;
let stopRequested = false;
const controllers = new Set();
const rows = new Map(); // region code -> row state
const groupChecks = new Map(); // group id -> checkbox

const map = createMap(document.getElementById("map"), {
  onHover: (code) => highlightRow(code),
  onSelect: (code) => focusRow(code),
});

const captionState = { outline: "loading", hasUser: false };

function refreshMapCaption() {
  if (captionState.outline === "loading") {
    $("mapCaption").textContent = "Loading the map…";
    return;
  }
  if (captionState.outline !== "ready") {
    $("mapCaption").textContent = captionState.outline;
    return;
  }
  const from = captionState.hasUser
    ? "from your location (city-level, via Cloudflare geo)"
    : "— your location is unavailable here, so no routes are drawn —";
  $("mapCaption").textContent =
    `Great-circle routes ${from} to each selected region. ` +
    "Line color follows the measured median: green fast, red slow, gray not measured. " +
    "Drag to pan, scroll or pinch to zoom, ⤢ to refit.";
}

map.ready.then((status) => {
  captionState.outline = status === "ready" ? "ready" : status;
  refreshMapCaption();
});

/** Toggle the map's line + marker emphasis for one region's table row. */
function highlightRow(code) {
  for (const tr of $("rows").querySelectorAll("tr.map-hover")) tr.classList.remove("map-hover");
  if (code !== null) {
    $("rows").querySelector(`tr[data-code="${code}"]`)?.classList.add("map-hover");
  }
}

/** A map marker/line was clicked: scroll to the region's row and flash it. */
function focusRow(code) {
  const tr = $("rows").querySelector(`tr[data-code="${code}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: "smooth", block: "nearest" });
  highlightRow(code);
  setTimeout(() => highlightRow(null), 1500);
}

/** Push the current selection (and any known results) to the map. */
function syncMap() {
  const selected = selectedRows();
  map.sync(selected.map((row) => row.region));
  const maxMedian = maxMeasuredMedian();
  for (const row of selected) {
    map.updateRegion(row.region.code, { state: row.state, summary: row.summary, maxMedian });
  }
}

/** Stats over the usable samples (the warm-up first sample is dropped). */
function summaryFor(row) {
  return row.samples.length > 1 ? summarize(row.samples.slice(1)) : null;
}

function showClientInfo() {
  return fetch("/ip.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((info) => {
      $("client").textContent = `${info.ip} · ${info.city ?? "?"}, ${info.region ?? "?"} · edge ${info.colo ?? "?"} · ${info.as_organization ?? "?"}`;
      const place = [info.city, info.region].filter(Boolean).join(", ");
      if (info.latitude != null && info.longitude != null) {
        map.setUser({
          lat: info.latitude,
          lon: info.longitude,
          label: [place, info.country].filter(Boolean).join(" ") || info.ip,
        });
        captionState.hasUser = true;
      } else {
        map.setUser(null);
        captionState.hasUser = false;
      }
      refreshMapCaption();
    })
    .catch(() => {
      $("client").textContent = "client info unavailable";
      map.setUser(null);
      captionState.hasUser = false;
      refreshMapCaption();
    });
}

function buildGroups() {
  const fieldset = $("groups");
  for (const group of dataset.groups) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = DEFAULT_GROUPS.includes(group.id);
    checkbox.dataset.group = group.id;
    checkbox.addEventListener("change", syncMap);
    groupChecks.set(group.id, checkbox);
    label.append(checkbox, ` ${group.label}`);
    fieldset.append(label);
  }
}

function buildRows() {
  const tbody = $("rows");
  for (const region of dataset.regions) {
    const tr = document.createElement("tr");
    tr.dataset.state = "queued";
    tr.dataset.code = region.code;
    const regionCell = document.createElement("td");
    regionCell.className = "region";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = region.name;
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = region.code;
    regionCell.append(name, code);

    const latCell = document.createElement("td");
    const latFlex = document.createElement("div");
    latFlex.className = "lat-flex";
    const bar = document.createElement("div");
    bar.className = "bar";
    const barFill = document.createElement("div");
    barFill.className = "bar-fill";
    bar.append(barFill);
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = "—";
    latFlex.append(bar, val);
    latCell.append(latFlex);

    const minCell = document.createElement("td");
    minCell.className = "num";
    const jitterCell = document.createElement("td");
    jitterCell.className = "num";
    const nCell = document.createElement("td");
    nCell.className = "num";
    const stateCell = document.createElement("td");
    stateCell.className = "state";
    latCell.dataset.label = "Median";
    minCell.dataset.label = "Min";
    jitterCell.dataset.label = "Jitter";
    nCell.dataset.label = "Samples";
    stateCell.dataset.label = "State";

    tr.append(regionCell, latCell, minCell, jitterCell, nCell, stateCell);
    tbody.append(tr);

    const state = {
      region,
      tr,
      cells: { val, barFill, min: minCell, jitter: jitterCell, n: nCell, state: stateCell },
      samples: [],
      failures: 0,
      state: "queued",
      summary: null,
    };
    rows.set(region.code, state);
    updateRow(state);
  }
}

function maxMeasuredMedian() {
  let max = 0;
  for (const row of rows.values()) {
    if (row.summary && row.summary.median > max) max = row.summary.median;
  }
  return max;
}

function updateRow(row) {
  row.summary = summaryFor(row);
  const { cells } = row;
  if (row.summary) {
    cells.val.textContent = `${row.summary.median} ms`;
    cells.min.textContent = `${row.summary.min} ms`;
    cells.jitter.textContent = `${row.summary.jitter} ms`;
    cells.n.textContent = String(row.summary.samples);
  } else {
    cells.val.textContent = "—";
    cells.min.textContent = "—";
    cells.jitter.textContent = "—";
    cells.n.textContent = row.samples.length === 1 ? "warm-up" : "—";
  }
  cells.state.textContent = row.state;
  row.tr.dataset.state = row.state;

  const max = maxMeasuredMedian();
  const pct = row.summary && max > 0 ? Math.max(2, (row.summary.median / max) * 100) : 0;
  cells.barFill.style.width = `${pct}%`;

  map.updateRegion(row.region.code, { state: row.state, summary: row.summary, maxMedian: max });
}

function refreshSort() {
  const sorted = sortByMedian([...rows.values()]);
  $("rows").replaceChildren(...sorted.map((row) => row.tr));
}

function setControlsDisabled(disabled) {
  for (const checkbox of groupChecks.values()) checkbox.disabled = disabled;
  $("samples").disabled = disabled;
}

function selectedRows() {
  return [...rows.values()].filter((row) => groupChecks.get(row.region.group)?.checked);
}

async function probe(row) {
  const controller = new AbortController();
  controllers.add(controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  const started = performance.now();
  try {
    await fetch(probeUrl(dataset.probe.template, row.region.code), {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    row.samples.push(performance.now() - started);
    row.failures = 0;
    return true;
  } catch (error) {
    if (stopRequested) return false;
    row.failures += 1;
    if (row.failures >= MAX_FAILURES) row.state = "unreachable";
    else row.state = timedOut ? "timeout" : "error";
    return false;
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
    updateRow(row);
  }
}

function stop() {
  stopRequested = true;
  for (const controller of controllers) controller.abort();
}

function finish() {
  const stoppedEarly = stopRequested;
  running = false;
  stopRequested = false;
  setControlsDisabled(false);
  $("run").textContent = "Run test";
  for (const row of rows.values()) {
    if (row.state === "measuring") row.state = summaryFor(row) ? "done" : "stopped";
    updateRow(row);
  }
  refreshSort();

  const ranked = sortByMedian([...rows.values()].filter((row) => row.summary));
  if (ranked.length === 0) {
    $("summary").textContent = "No usable samples.";
    return;
  }
  const best = ranked[0];
  const suffix = stoppedEarly ? " · stopped early" : "";
  $("summary").textContent = `Fastest: ${best.region.name} — ${best.summary.median} ms median (${best.summary.samples} samples)${suffix}`;
}

async function run() {
  const selected = selectedRows();
  if (selected.length === 0) {
    $("summary").textContent = "Select at least one region group first.";
    return;
  }
  running = true;
  stopRequested = false;
  $("run").textContent = "Stop";
  setControlsDisabled(true);
  $("summary").textContent = "";

  for (const row of rows.values()) {
    const isSelected = selected.includes(row);
    row.samples = [];
    row.failures = 0;
    row.state = isSelected ? "queued" : "skipped";
    updateRow(row);
  }

  const perRegion = Number($("samples").value);
  const queue = [];
  for (let round = 0; round < perRegion; round += 1) {
    for (const row of selected) queue.push(row);
  }
  const total = queue.length;
  let done = 0;

  const updateProgress = () => {
    const measured = selected.filter((row) => row.summary).length;
    $("progress").textContent = `probe ${done}/${total} · ${measured}/${selected.length} regions measured`;
  };
  updateProgress();

  const worker = async () => {
    while (queue.length > 0 && !stopRequested) {
      const row = queue.shift();
      if (row.state === "unreachable") {
        done += 1;
        updateProgress();
        continue;
      }
      row.state = "measuring";
      await probe(row);
      done += 1;
      updateProgress();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stopRequested) {
    $("progress").textContent = `stopped after ${done}/${total} probes`;
  }
  finish();
}

$("run").addEventListener("click", () => {
  if (running) stop();
  else run();
});

$("zoomIn").addEventListener("click", () => map.zoom(1.5));
$("zoomOut").addEventListener("click", () => map.zoom(1 / 1.5));
$("zoomFit").addEventListener("click", () => map.fit());

// Hovering a region's row emphasizes its line and marker on the map.
$("rows").addEventListener("mouseover", (event) => {
  const tr = event.target.closest("tr[data-code]");
  map.highlight(tr ? tr.dataset.code : null);
});
$("rows").addEventListener("mouseleave", () => map.highlight(null));

async function load() {
  try {
    const response = await fetch("/data/aws-regions.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dataset = await response.json();
  } catch (error) {
    $("progress").textContent = `could not load the region dataset: ${error.message}`;
    return;
  }
  buildGroups();
  buildRows();
  syncMap();
  $("progress").textContent = `${dataset.regions.length} regions loaded — pick groups and run.`;
}

showClientInfo();
load();

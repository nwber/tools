/**
 * Speed test orchestration: latency (ping), download (parallel streams), and
 * upload (parallel chunked POSTs). All math lives in speedtest-calc.js.
 *
 * Methodology notes:
 *  - ping RTT is measured with fetch() around /speedtest/ping; the first two
 *    samples are discarded as connection warm-up;
 *  - download streams /speedtest/down?bytes=... over 6 parallel connections
 *    for a fixed window, counting bytes off the wire via the response reader;
 *  - upload POSTs 4 MiB random chunks over 4 parallel connections for the
 *    same window; the server echoes the received byte count.
 */

import { formatMbps, latencySummary, mbps } from "./speedtest-calc.js";

const $ = (id) => document.getElementById(id);
const DOWNLOAD_CHUNK = 8 * 1024 * 1024; // 8 MiB per request
const UPLOAD_CHUNK = 4 * 1024 * 1024; // 4 MiB per request
const DOWNLOAD_STREAMS = 6;
const UPLOAD_STREAMS = 4;
const WINDOW_MS = 10000;

let running = false;

function setPhase(phase, text) {
  for (const id of ["ping", "down", "up"]) {
    $(`phase-${id}`).classList.toggle("active", id === phase);
    if (id === phase) $(`phase-${id}`).classList.toggle("done", false);
  }
  $(`${phase}-status`).textContent = text;
}

function markDone(phase, text) {
  $(`phase-${phase}`).classList.add("done");
  $(`phase-${phase}`).classList.remove("active");
  $(`${phase}-status`).textContent = text;
}

async function showClientInfo() {
  try {
    const info = await fetch("/ip.json", { cache: "no-store" }).then((r) => r.json());
    $("client").textContent = `${info.ip} · ${info.city ?? "?"}, ${info.region ?? "?"} · edge ${info.colo ?? "?"} · ${info.as_organization ?? "?"}`;
  } catch {
    $("client").textContent = "client info unavailable";
  }
}

async function runPing(samples = 15) {
  setPhase("ping", "measuring…");
  const rtts = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const response = await fetch(`/speedtest/ping?i=${i}`, { cache: "no-store" });
    await response.text();
    const rtt = performance.now() - started;
    if (i >= 2) rtts.push(rtt); // discard warm-up
    $("ping-bar").style.width = `${((i + 1) / samples) * 100}%`;
  }
  const summary = latencySummary(rtts);
  $("ping-result").textContent = `${summary.min} / ${summary.median} ms · jitter ${summary.jitter} ms`;
  markDone("ping", `${summary.samples} samples`);
  return summary;
}

async function runDownload() {
  setPhase("down", "streaming…");
  const started = performance.now();
  const deadline = started + WINDOW_MS;
  const state = { bytes: 0 };
  let lastBytes = 0;
  let lastTick = started;

  const progressTimer = setInterval(() => {
    const now = performance.now();
    const rate = mbps(state.bytes - lastBytes, now - lastTick);
    lastBytes = state.bytes;
    lastTick = now;
    $("down-live").textContent = `${formatMbps(rate)} Mbps`;
    $("down-bar").style.width = `${Math.min(100, ((now - started) / WINDOW_MS) * 100)}%`;
  }, 250);

  const worker = async () => {
    while (performance.now() < deadline) {
      const response = await fetch(`/speedtest/down?bytes=${DOWNLOAD_CHUNK}&s=${Math.random()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        state.bytes += value.byteLength;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: DOWNLOAD_STREAMS }, worker));
  } finally {
    clearInterval(progressTimer);
  }
  const elapsed = performance.now() - started;
  const rate = mbps(state.bytes, elapsed);
  $("down-result").textContent = `${formatMbps(rate)} Mbps (${(state.bytes / 1e6).toFixed(0)} MB)`;
  markDone("down", `${DOWNLOAD_STREAMS} streams`);
  return rate;
}

async function runUpload() {
  setPhase("up", "uploading…");
  const started = performance.now();
  const deadline = started + WINDOW_MS;
  const state = { bytes: 0 };
  let lastBytes = 0;
  let lastTick = started;

  const chunk = new Uint8Array(UPLOAD_CHUNK);
  crypto.getRandomValues(chunk.subarray(0, 65536)); // random head; the rest repeats cheaply
  for (let i = 65536; i < chunk.length; i += 65536) chunk.set(chunk.subarray(0, 65536), i);

  const progressTimer = setInterval(() => {
    const now = performance.now();
    const rate = mbps(state.bytes - lastBytes, now - lastTick);
    lastBytes = state.bytes;
    lastTick = now;
    $("up-live").textContent = `${formatMbps(rate)} Mbps`;
    $("up-bar").style.width = `${Math.min(100, ((now - started) / WINDOW_MS) * 100)}%`;
  }, 250);

  const worker = async () => {
    while (performance.now() < deadline) {
      const response = await fetch("/speedtest/up", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: chunk,
      });
      if (!response.ok) throw new Error(`upload failed: ${response.status}`);
      const { bytes_received } = await response.json();
      state.bytes += bytes_received ?? chunk.byteLength;
    }
  };

  try {
    await Promise.all(Array.from({ length: UPLOAD_STREAMS }, worker));
  } finally {
    clearInterval(progressTimer);
  }
  const elapsed = performance.now() - started;
  const rate = mbps(state.bytes, elapsed);
  $("up-result").textContent = `${formatMbps(rate)} Mbps (${(state.bytes / 1e6).toFixed(0)} MB)`;
  markDone("up", `${UPLOAD_STREAMS} streams`);
  return rate;
}

async function runAll() {
  if (running) return;
  running = true;
  $("run").disabled = true;
  for (const id of ["ping", "down", "up"]) {
    $(`phase-${id}`).classList.remove("done", "active");
    $(`${id}-bar`).style.width = "0%";
    $(`${id}-result`).textContent = "—";
    $(`${id}-status`).textContent = "";
    $(`${id}-live`).textContent = "";
  }
  try {
    await showClientInfo();
    await runPing();
    await runDownload();
    await runUpload();
    $("summary").textContent = "Done. Run again from a different network to compare.";
  } catch (error) {
    $("summary").textContent = `Failed: ${error.message}`;
  } finally {
    running = false;
    $("run").disabled = false;
  }
}

$("run").addEventListener("click", runAll);
showClientInfo();

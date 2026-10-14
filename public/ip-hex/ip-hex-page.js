/**
 * DOM wiring for the IP <-> hex page. All conversion math lives in
 * ip-hex-calc.js; this file only turns the result into rows, handles the
 * example chips, and copies values to the clipboard.
 */

import { convert } from "./ip-hex-calc.js";

const $ = (id) => document.getElementById(id);

const input = $("input");
const errorLine = $("error");
const hint = $("hint");
const resultBox = $("result");
const detected = $("detected");
const readingBox = $("reading");
const rows = $("rows");

/** Forced reading for digit-only input ("hex"/"decimal"), null = automatic. */
let forced = null;

const EXAMPLES = [
  "192.168.1.1",
  "c0a80101",
  "0x7f000001",
  "2001:db8::8a2e:370:7334",
  "3232235777",
];

/** How to describe reads of each source/version pair. */
const DETECTIONS = {
  "ip/4": "IPv4 address",
  "ip/6": "IPv6 address",
  "hex/4": "32-bit hex",
  "hex/6": "128-bit hex",
  "decimal/4": "32-bit decimal",
  "decimal/6": "128-bit decimal",
};

/** Result rows per IP version: [label, accessor]; null values are skipped. */
const FIELDS = {
  4: [
    ["IPv4", (r) => r.ip],
    ["Hex", (r) => r.hex],
    ["Hex (0x)", (r) => r.hex0x],
    ["Hex (dotted)", (r) => r.hexDotted],
    ["Decimal", (r) => r.decimal],
    ["IPv6 (mapped)", (r) => r.mappedIpv6],
  ],
  6: [
    ["IPv6", (r) => r.ip],
    ["IPv6 (expanded)", (r) => r.expanded],
    ["Hex", (r) => r.hex],
    ["Hex (0x)", (r) => r.hex0x],
    ["Decimal", (r) => r.decimal],
    ["IPv4 (embedded)", (r) => r.mappedIpv4],
  ],
};

function fallbackCopy(text) {
  const pre = document.createElement("textarea");
  pre.value = text;
  pre.style.position = "fixed";
  pre.style.opacity = "0";
  document.body.append(pre);
  pre.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  pre.remove();
  return ok;
}

function copy(text, button) {
  const reset = () => {
    button.textContent = "copy";
  };
  const done = (ok) => {
    button.textContent = ok ? "copied" : "copy failed";
    setTimeout(reset, 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  } else {
    done(fallbackCopy(text));
  }
}

function buildRow(label, value) {
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.scope = "row";
  th.textContent = label;
  const td = document.createElement("td");
  td.className = "value";
  td.textContent = value;
  const copyCell = document.createElement("td");
  copyCell.className = "copy";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "copy";
  button.setAttribute("aria-label", `copy ${label}`);
  button.addEventListener("click", () => copy(value, button));
  copyCell.append(button);
  tr.append(th, td, copyCell);
  return tr;
}

function showEmpty() {
  errorLine.textContent = "";
  resultBox.hidden = true;
  hint.hidden = false;
}

function showError(message) {
  errorLine.textContent = message;
  resultBox.hidden = true;
  hint.hidden = true;
}

function showResult(result) {
  errorLine.textContent = "";
  hint.hidden = true;
  detected.textContent = `read as ${DETECTIONS[`${result.source}/${result.version}`]}`;
  readingBox.hidden = !result.ambiguous;
  for (const button of readingBox.querySelectorAll("button")) {
    const active = button.dataset.reading === result.readAs;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  rows.replaceChildren(
    ...FIELDS[result.version]
      .map(([label, get]) => [label, get(result)])
      .filter(([, value]) => value !== null)
      .map(([label, value]) => buildRow(label, value)),
  );
  resultBox.hidden = false;
}

function render() {
  const text = input.value.trim();
  if (text === "") {
    showEmpty();
    return;
  }
  const result = convert(text, forced === null ? undefined : { readAs: forced });
  if (result.ok) showResult(result);
  else showError(result.error);
}

for (const example of EXAMPLES) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = example;
  button.addEventListener("click", () => {
    input.value = example;
    forced = null;
    render();
    input.focus();
  });
  $("examples").append(button);
}

for (const button of readingBox.querySelectorAll("button")) {
  button.addEventListener("click", () => {
    forced = button.dataset.reading;
    render();
  });
}

input.addEventListener("input", () => {
  forced = null;
  render();
});
render();

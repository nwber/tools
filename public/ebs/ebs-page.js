/**
 * DOM wiring for the EBS pricing comparator page.
 *
 * Faithful port of the original tool's page script (recovered from
 * ebs-pricing-comparator.nwber.workers.dev): same ids, same behaviors, same
 * rendered output. The pricing data now loads from the shared JSON asset
 * (/data/ebs-pricing.json) instead of being inlined, and the math lives in
 * ebs-calc.js where it is unit-tested.
 *
 * Inline handlers in index.html (onchange="calculate()", onclick="sortTable(0)")
 * keep working because calculate/sortTable are also assigned onto window.
 */

import { calculateRows } from "./ebs-calc.js";

const pricing = await fetch("/data/ebs-pricing.json").then((response) => response.json());

const selected = new Set(["gp3", "io2"]);

function initVolumeTypes() {
  const input = document.getElementById("volumeTypesInput");
  const dropdown = document.getElementById("volumeTypesDropdown");
  Object.entries(pricing.volumeTypes).forEach(([type, volume]) => {
    const entry = document.createElement("div");
    entry.style.padding = "8px";
    entry.style.cursor = "pointer";
    entry.style.borderBottom = "1px solid #eee";
    entry.textContent = volume.name;
    if (selected.has(type)) entry.style.background = "#f0f8ff";
    entry.addEventListener("click", function (event) {
      event.stopPropagation();
      if (selected.has(type)) {
        selected.delete(type);
        entry.style.background = "white";
      } else {
        selected.add(type);
        entry.style.background = "#f0f8ff";
      }
      updateInput();
      calculate();
    });
    dropdown.appendChild(entry);
  });
  input.addEventListener("click", function () {
    dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", function (event) {
    if (
      !event.target.closest("#volumeTypesInput") &&
      !event.target.closest("#volumeTypesDropdown")
    ) {
      dropdown.style.display = "none";
    }
  });
  function updateInput() {
    if (selected.size === 0) {
      input.value = "Select volume types";
    } else {
      input.value = Array.from(selected).join(", ");
    }
  }
  updateInput();
}

function calculate() {
  const region = document.getElementById("region").value;
  const size = parseFloat(document.getElementById("size").value);
  const unit = document.getElementById("sizeUnit").value;
  const iops = parseInt(document.getElementById("iops").value) || 0;
  const throughput = parseInt(document.getElementById("throughput").value) || 0;
  const tbody = document.querySelector("#results tbody");
  const warn = document.getElementById("warning");
  tbody.innerHTML = "";
  warn.style.display = "none";

  const { rows, warnings } = calculateRows(pricing, {
    region,
    size,
    unit,
    iops,
    throughput,
    selectedTypes: Array.from(selected),
  });

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    if (!row.meets) {
      tr.style.opacity = "0.5";
      tr.style.background = "#f8f9fa";
    } else {
      tr.style.background = "white";
    }
    const cell = (value, label) =>
      value === null
        ? `<td class="error" data-label="${label}">ERROR</td>`
        : `<td data-label="${label}">$${value.toFixed(2)}</td>`;
    const totalCell =
      row.total === null
        ? '<td class="error" data-label="Total">ERROR</td>'
        : `<td data-label="Total"><strong>$${row.total.toFixed(2)}</strong></td>`;
    tr.innerHTML =
      `<td>${row.type}</td>` +
      `<td data-label="Durability">${row.durability}</td>` +
      cell(row.storage, "Storage") +
      cell(row.iopsCost, "IOPS") +
      cell(row.throughputCost, "Throughput") +
      totalCell;
    tbody.appendChild(tr);
  });

  if (warnings.length > 0) {
    warn.textContent =
      "Warning: " + warnings.slice(0, 3).join("; ") + (warnings.length > 3 ? "..." : "");
    warn.style.display = "block";
  }
}

function sortTable(n) {
  const table = document.getElementById("results");
  let rows;
  let switching;
  let i;
  let x;
  let y;
  let shouldSort;
  let dir;
  let switchcount = 0;
  dir = "asc";
  switching = true;
  while (switching) {
    switching = false;
    rows = table.rows;
    for (i = 1; i < rows.length - 1; i++) {
      shouldSort = false;
      x = rows[i].getElementsByTagName("TD")[n];
      y = rows[i + 1].getElementsByTagName("TD")[n];
      if (dir == "asc") {
        if (x.innerHTML.toLowerCase() > y.innerHTML.toLowerCase()) {
          shouldSort = true;
          break;
        }
      } else if (dir == "desc") {
        if (x.innerHTML.toLowerCase() < y.innerHTML.toLowerCase()) {
          shouldSort = true;
          break;
        }
      }
    }
    if (shouldSort) {
      rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
      switching = true;
      switchcount++;
    } else {
      if (switchcount == 0 && dir == "asc") {
        dir = "desc";
        switching = true;
      }
    }
  }
}

window.calculate = calculate;
window.sortTable = sortTable;
initVolumeTypes();
calculate();

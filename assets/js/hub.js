/* ChesHub hub page: registry cards and pairing controls. */

const REGISTRY = window.CHESHUB_DEVICES || [];

function showToast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

// A registry filter may specify any subset of vendorId / productId /
// usagePage / usage. Anything unspecified is a wildcard.
function registryMatch(device) {
  return window.ChesHubRegistry ? window.ChesHubRegistry.match(device) : undefined;
}

const LIMIT = 2;
let devicesExpanded = false;
let liveTelemetry = {};

function connectionLabel(entry, device) {
  if (entry.id === "tozo-ht3") return "Bluetooth";
  if (entry.id === "tecknet-tk-gm012") return device && device.vendorId === 0x249A ? "2.4 GHz" : "USB";
  if (entry.id === "ajazz-aj139") return device && device.vendorId === 0xA8A5 ? "2.4 GHz" : "USB";
  if (entry.id === "ilovbee-b75") {
    if (device && device.vendorId === 0x046D) return "Bluetooth";
    return device && device.productId === 0x01BB ? "2.4 GHz" : "USB";
  }
  return "USB";
}

function batteryText(entry) {
  const stored = window.ChesHubRegistry ? window.ChesHubRegistry.loadTelemetry() : {};
  const reading = liveTelemetry[entry.id] || stored[entry.id] || null;
  const level = reading ? Number(reading.battery) : NaN;
  if (!Number.isFinite(level)) return "—%";
  return `${Math.round(level)}%${reading.charging ? " ⚡" : ""}`;
}

function renderDevices(pairedIds, deviceMap) {
  const grid = document.getElementById("devices-grid");
  const moreHost = document.getElementById("hub-more");
  const paired = REGISTRY.filter((r) => pairedIds.has(r.id));

  if (!paired.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 6v4"/></svg>
        <div class="empty-title">No paired devices</div>
        <p class="empty-text">Use <strong>Pair Device</strong> to connect a supported mouse, keyboard or headset.</p>
      </div>`;
    if (moreHost) moreHost.innerHTML = "";
    return;
  }

  const visible = devicesExpanded ? paired : paired.slice(0, LIMIT);
  const remaining = paired.length - visible.length;
  const icons = (window.ChesHubRegistry && window.ChesHubRegistry.icons) || {};

  grid.innerHTML = visible.map((r) => {
    const device = deviceMap.get(r.id);
    const art = r.image
      ? `<img src="${r.image}" alt="" loading="lazy" decoding="async">`
      : `<svg class="device-glyph" viewBox="0 0 24 24" aria-hidden="true">${icons[r.kind] || icons.mouse || ""}</svg>`;
    const battery = batteryText(r);
    const level = parseInt(battery, 10);
    const low = Number.isFinite(level) && level <= 20;

    return `
    <article class="device-card" data-path="${r.path}" role="link" tabindex="0" aria-label="${r.name}" title="Open ${r.name}">
      <div class="device-art">
        ${art}
        <div class="device-indicators">
          <span class="indicator${low ? " battery-low" : ""}" data-battery-for="${r.id}">${battery}</span>
          <span class="indicator">${connectionLabel(r, device)}</span>
        </div>
      </div>
      <div class="card-name">${r.name}</div>
    </article>`;
  }).join("");

  if (moreHost) {
    moreHost.innerHTML = remaining > 0
      ? `<button class="btn-ghost" id="btn-more-devices" type="button">Show ${remaining} more</button>`
      : "";
  }

  grid.querySelectorAll(".device-card").forEach((card) => {
    const open = () => { location.href = card.dataset.path; };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    /* Warm the studio document so opening a card feels instant. */
    const prefetch = () => {
      const url = card.dataset.path;
      if (document.querySelector(`link[rel="prefetch"][href="${url}"]`)) return;
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = url;
      link.as = "document";
      document.head.appendChild(link);
    };
    card.addEventListener("pointerenter", prefetch, { once: true });
    card.addEventListener("focus", prefetch, { once: true });
  });

  const more = document.getElementById("btn-more-devices");
  if (more) {
    more.addEventListener("click", () => {
      devicesExpanded = true;
      renderDevices(pairedIds, deviceMap);
    });
  }

  visible.forEach((entry) => {
    const device = deviceMap.get(entry.id);
    if (!device) return;
    readBattery(entry, device).then((reading) => {
      if (!reading) return;
      liveTelemetry[entry.id] = reading;
      if (window.ChesHubRegistry) window.ChesHubRegistry.saveTelemetry(entry.id, reading);
      const level = Math.round(reading.battery);
      grid.querySelectorAll(`[data-battery-for="${entry.id}"]`).forEach((el) => {
        el.textContent = `${level}%${reading.charging ? " ⚡" : ""}`;
        el.classList.toggle("battery-low", level <= 20);
      });
    }).catch(() => { /* keep the cached value */ });
  });
}

/* Battery reads are read-only queries copied from each device driver. A failed
   or sleeping link falls back to the last value saved by the studio. */
async function withOpen(device, task) {
  const wasOpen = device.opened;
  if (!wasOpen) {
    try { await device.open(); } catch (err) { return null; }
  }
  try {
    return await task();
  } finally {
    if (!wasOpen) {
      try { await device.close(); } catch (err) { /* already closed */ }
    }
  }
}

function readTk(device) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      device.removeEventListener("inputreport", onReport);
      resolve(value);
    };
    const onReport = (event) => {
      const data = new Uint8Array(event.data.buffer);
      if (data[0] === 0x10 && data[1] === 0) {
        const level = data[13];
        finish(level <= 100 ? { battery: level, charging: !!data[12] } : null);
      }
    };
    device.addEventListener("inputreport", onReport);
    timer = setTimeout(() => finish(null), 900);

    const frame = new Uint8Array(33);
    frame[1] = 0x10;
    frame[32] = 0;
    device.sendReport(0, frame.slice(1)).catch(() => {
      device.sendReport(0, frame).catch(() => finish(null));
    });
  });
}

function readAjazz(device) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      device.removeEventListener("inputreport", onReport);
      resolve(value);
    };
    const onReport = (event) => {
      const data = new Uint8Array(event.data.buffer);
      if (data[0] === 0xAA && data[1] === 0x30) {
        const level = data[8];
        finish(level <= 100 ? { battery: level, charging: !!data[9] } : null);
      }
    };
    device.addEventListener("inputreport", onReport);
    timer = setTimeout(() => finish(null), 900);

    const packet = new Uint8Array(64);
    packet[0] = 0x55; packet[1] = 0x30; packet[2] = 0xA5; packet[3] = 0x0B;
    packet[4] = 0x2E; packet[5] = 0x01; packet[6] = 0x01; packet[7] = 0x01;
    device.sendReport(0, packet).catch(() => finish(null));
  });
}

/* iLovbee B75: GetPower (0x87) over the 0x208-byte feature report.
   Byte 0 of the reply data is read as the level (inferred, see PROTOCOL.md). */
async function readB75(device) {
  if (device.vendorId === 0x046D) return null;   // Bluetooth: format not known yet
  if (device.productId === 0x01BB) return readB75Wireless(device);
  const col = (device.collections || []).find((c) => c.usagePage >= 0xFF00 && (c.featureReports || []).length);
  if (!col) return null;
  const rid = col.featureReports[0].reportId;
  const frame = new Uint8Array(0x207);
  frame[0] = 0x87; frame[3] = 1; frame[5] = 2;
  try {
    await device.sendFeatureReport(rid, frame);
    await new Promise((r) => setTimeout(r, 25));
    const view = await device.receiveFeatureReport(rid);
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const off = data[0] === 0x87 ? 0 : (data[1] === 0x87 ? 1 : -1);
    if (off < 0) return null;
    const level = data[off + 7];
    return level <= 100 ? { battery: level, charging: !!data[off + 8] } : null;
  } catch (err) {
    return null;
  }
}

/* B75 behind its 2.4 GHz receiver: 20-byte report 0x13, battery cmd 0x4A. */
function readB75Wireless(device) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      clearTimeout(timer);
      device.removeEventListener("inputreport", onReport);
      resolve(value);
    };
    const onReport = (event) => {
      if (event.reportId !== 0x13) return;
      const d = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
      if ((d[0] & 0x7F) !== 0x4A) return;
      const level = d[4];
      finish(level <= 100 ? { battery: level, charging: !!d[5] } : null);
    };
    device.addEventListener("inputreport", onReport);
    timer = setTimeout(() => finish(null), 1500);
    const b = new Uint8Array(20);
    b[0] = 0x13; b[1] = 0x4A; b[2] = 1;
    let sum = 0;
    for (let i = 0; i < 19; i++) sum += b[i];
    b[19] = sum & 0xFF;
    device.sendReport(0x13, b.subarray(1)).catch(() => finish(null));
  });
}

function readBattery(entry, device) {
  if (entry.id === "ilovbee-b75") return withOpen(device, () => readB75(device));
  if (entry.id === "tecknet-tk-gm012") return withOpen(device, () => readTk(device));
  if (entry.id === "ajazz-aj139") return withOpen(device, () => readAjazz(device));
  return Promise.resolve(null);
}

async function checkPairedDevices() {
  const pairedIds = new Set();
  const deviceMap = new Map();

  if (navigator.hid) {
    try {
      const paired = await navigator.hid.getDevices();
      paired.forEach((device) => {
        const match = registryMatch(device);
        if (match) {
          pairedIds.add(match.id);
          deviceMap.set(match.id, device);
        }
      });
    } catch (err) { /* permission denied */ }
  }

  if (navigator.serial) {
    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) pairedIds.add("tozo-ht3");
    } catch (err) { /* permission denied */ }
  }

  renderDevices(pairedIds, deviceMap);
}

function showProtocolSelection() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Select connection type">
        <div class="modal-title">Select connection type</div>
        <button class="btn-primary" id="btn-hid" type="button">WebHID</button>
        <button class="btn-ghost" id="btn-serial" type="button">Serial (RFCOMM)</button>
      </div>`;
    document.body.appendChild(overlay);

    const finish = (value) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (event) => { if (event.key === "Escape") finish(null); };

    overlay.querySelector("#btn-hid").onclick = () => finish("hid");
    overlay.querySelector("#btn-serial").onclick = () => finish("serial");
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKey);
  });
}

async function pairViaHID() {
  try {
    // Build HID filters from the registry, dropping serial-only entries.
    const allFilters = [];
    REGISTRY.forEach((r) => {
      (r.filters || []).forEach((f) => {
        const filter = {};
        if (f.vendorId !== undefined) filter.vendorId = f.vendorId;
        if (f.productId !== undefined) filter.productId = f.productId;
        if (f.usagePage !== undefined) filter.usagePage = f.usagePage;
        if (f.usage !== undefined) filter.usage = f.usage;
        if (Object.keys(filter).length > 0) allFilters.push(filter);
      });
    });

    const devices = await navigator.hid.requestDevice({ filters: allFilters });
    if (devices && devices.length) {
      if (!devices[0].opened) await devices[0].open();
      await checkPairedDevices();
    }
  } catch (err) {
    showToast("HID pairing failed or was cancelled");
  }
}

async function pairViaSerial() {
  if (!navigator.serial) {
    showToast("Serial API is not available in this browser");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    await checkPairedDevices();
  } catch (err) {
    showToast("Serial pairing failed or was cancelled");
  }
}

document.getElementById("btn-scan").addEventListener("click", async () => {
  const choice = await showProtocolSelection();
  if (choice === "hid") await pairViaHID();
  else if (choice === "serial") await pairViaSerial();
});

// Fallback for devices the registry filters do not match: list every
// vendor-defined HID collection and report what was picked.
document.getElementById("btn-scan-vendor").addEventListener("click", async () => {
  if (!navigator.hid) return showToast("WebHID is not available — use Chrome or Edge");
  const filters = [];
  for (let page = 0xFF00; page <= 0xFFFF; page++) filters.push({ usagePage: page });
  try {
    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices.length) return;
    const device = devices[0];
    const match = registryMatch(device);
    if (match) {
      await checkPairedDevices();
      location.href = match.path;
      return;
    }
    const size = (r) => Math.round((r.items || []).reduce((sum, it) => sum + it.reportSize * it.reportCount, 0) / 8);
    const reports = (label, arr) => (arr || []).map((r) => `${label} 0x${r.reportId.toString(16).toUpperCase()} ${size(r)}B`);
    const pages = (device.collections || []).map((c) => {
      const detail = [...reports("in", c.inputReports), ...reports("out", c.outputReports), ...reports("feature", c.featureReports)];
      return `  usagePage 0x${c.usagePage.toString(16).toUpperCase()} / usage 0x${c.usage.toString(16).toUpperCase()}`
        + (detail.length ? `\n    ${detail.join(", ")}` : "");
    });
    const out = document.getElementById("scan-result");
    out.hidden = false;
    out.textContent = [
      "Unregistered device — please report this:",
      `product    ${device.productName || "(unnamed)"}`,
      `vendorId   0x${device.vendorId.toString(16).toUpperCase()}`,
      `productId  0x${device.productId.toString(16).toUpperCase()}`,
      "collections:",
      ...pages
    ].join("\n");
  } catch (err) {
    showToast("Scan cancelled");
  }
});

window.addEventListener("DOMContentLoaded", checkPairedDevices);
if (navigator.hid) {
  navigator.hid.onconnect = checkPairedDevices;
  navigator.hid.ondisconnect = checkPairedDevices;
}
if (navigator.serial) {
  navigator.serial.onconnect = checkPairedDevices;
  navigator.serial.ondisconnect = checkPairedDevices;
}

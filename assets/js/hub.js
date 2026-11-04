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
  return REGISTRY.find((r) => (r.filters || []).some((f) => {
    if (f.namePrefix !== undefined) return false;
    if (f.vendorId !== undefined && f.vendorId !== device.vendorId) return false;
    if (f.productId !== undefined && f.productId !== device.productId) return false;
    if (f.usagePage === undefined) return true;
    return (device.collections || []).some((c) =>
      c.usagePage === f.usagePage && (f.usage === undefined || c.usage === f.usage));
  }));
}

function renderDevices(onlineIds) {
  const grid = document.getElementById("devices-grid");
  grid.innerHTML = REGISTRY.map((r) => `
    <article class="device-card${onlineIds.has(r.id) ? " online" : ""}"
             data-path="${r.path}" role="link" tabindex="0">
      <div class="card-status">${onlineIds.has(r.id) ? "Online" : "Not paired"}</div>
      <div class="card-name">${r.name}</div>
      <div class="card-desc">${r.type}</div>
      <button class="btn-primary small" type="button">Open Studio</button>
    </article>`).join("");

  grid.querySelectorAll(".device-card").forEach((card) => {
    const open = () => { location.href = card.dataset.path; };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

async function checkPairedDevices() {
  const onlineIds = new Set();

  if (navigator.hid) {
    try {
      const paired = await navigator.hid.getDevices();
      paired.forEach((device) => {
        const match = registryMatch(device);
        if (match) onlineIds.add(match.id);
      });
    } catch (err) { /* permission denied */ }
  }

  if (navigator.serial) {
    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) onlineIds.add("tozo-ht3");
    } catch (err) { /* permission denied */ }
  }

  renderDevices(onlineIds);
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
    const pages = (device.collections || []).map((c) =>
      `  usagePage 0x${c.usagePage.toString(16).toUpperCase()} / usage 0x${c.usage.toString(16).toUpperCase()}`);
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

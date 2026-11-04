/* TECKNET TK-GM012 — ChesHub driver
 *
 * Feature set and defaults come from the vendor's device descriptor,
 * device/mouse_tk-gm012.xml, and the action labels from language/1033.lan.
 * Wire protocol: see PROTOCOL.md.
 *
 * Frame (verified):
 *   [0] report id 0x00   [1] command   [2] 0x00   [3] 0x01
 *   [4] length/type      [5..31] payload
 *   [32] checksum = sum(5..31) & 0xFF
 *
 * The vendor tool ignores the usage page when it enumerates:
 * DriverComm::EnumerateDevice opens every interface and keeps the ones that
 * answer the 0x10 read. On this receiver that is interface 2,
 * usage_page 0xFF01 / usage 0x0010 (measured with hidapi). Everything else —
 * the mouse and keyboard collections, and the consumer-control collection —
 * either has no output report or never answers.
 *
 * (DriverComm::FindDevice @ 0x4C3A0 does ask for 0xFFEF/0x00, but it is not the
 * path this receiver is opened through; filtering on it showed an empty picker.)
 */

const WIRED = { vendorId: 0x248A, productId: 0x5D2E };
const WIRELESS = { vendorId: 0x249A, productId: 0x5C2F };

/* Measured with hidapi on the actual receiver:
 *
 *   if=2  usage_page=0xFF01 usage=0x0010   <- vendor collection (answers 0x10)
 *   if=0  usage_page=0x0001 usage=0x0002   <- mouse   (protected, hidden)
 *   if=1  usage_page=0x000C usage=0x0001   <- consumer control
 *   if=1  usage_page=0x0001 usage=0x0006   <- keyboard (protected, hidden)
 *
 * DriverComm::FindDevice @ 0x4C3A0 asks for 0xFFEF/0x00, but that is not the
 * path this receiver is opened through: DriverComm::EnumerateDevice opens every
 * interface and keeps the ones that answer the 0x10 read. 0xFF01/0x0010 is the
 * one that answers here. */
const VENDOR_PAGE = 0xFF01;
const VENDOR_USAGE = 0x0010;

/* Primary: only the collection that actually answers. This is precise enough
   to show a single row instead of several identical-looking interfaces. */
const FILTERS = [
  { ...WIRED, usagePage: VENDOR_PAGE, usage: VENDOR_USAGE },
  { ...WIRELESS, usagePage: VENDOR_PAGE, usage: VENDOR_USAGE }
];

/* Every interface of the brand, for picking a different row. */
const FILTERS_ALL = [{ vendorId: WIRED.vendorId }, { vendorId: WIRELESS.vendorId }];

const CMD = {
  INFO: 0x10,
  RATE: 0x02,
  DPI: 0x03,
  DPI_COLOR: 0x04,
  POWER: 0x07,
  KEY_ONE: 0x08,
  KEY_ALL: 0x09,
  LIGHT_RESET: 0x0E,
  FACTORY: 0x0F
};

const RATE_CODES = { 1000: 1, 500: 2, 250: 4, 125: 8 };

/* DPI is not sent as a raw value. GetMouseDPIValue @ 0x1D740 compresses it:
 *
 *   dpi <= 10000         -> dpi / 50
 *   10000 < dpi < 13000  -> 200 + (dpi - 10000) / 100
 *   dpi >= 13000         -> 221 + (dpi - 13000) / 1000
 *
 * 1100 -> 22 (0x16), 24000 -> 232 (0xE8); both confirmed against captures
 * from the vendor tool. */
function encodeDpi(dpi) {
  const v = Math.max(50, Math.min(24000, Math.round(dpi)));
  if (v <= 10000) return Math.floor(v / 50);
  if (v < 13000) return 200 + Math.floor((v - 10000) / 100);
  return 221 + Math.floor((v - 13000) / 1000);
}

function decodeDpi(code) {
  if (code <= 200) return code * 50;
  if (code <= 220) return 10000 + (code - 200) * 100;
  return 13000 + (code - 221) * 1000;
}

/* <mouse_key> from the device XML. `value` is key_value, i.e. the index the
   firmware expects — note 204/205 are swapped relative to visual order. */
const KEYS = [
  { name: 201, value: 0, side: "left" },
  { name: 202, value: 1, side: "right" },
  { name: 203, value: 2, side: "right" },
  { name: 204, value: 4, side: "left" },
  { name: 205, value: 3, side: "left" },
  { name: 206, value: 5, side: "right", dashed: true }
];

/* Button actions, in the vendor's own order (language/1033.lan ids 106-142,
   160). Only the six used as defaults in the XML have a confirmed
   func_type/func_value pair. */
const KEY_ACTIONS = [
  "Left-Click", "Right-Click", "Middle-Click", "Double-Click",
  "Forward", "Backward",
  "Scroll Up", "Scroll Down", "Scroll Left", "Scroll Right",
  "Volume +", "Volume -", "Mute",
  "Play/Pause", "Previous", "Next", "Stop",
  "Macro", "System Shortcut",
  "Screen Brightness +", "Screen Brightness -",
  "Calculator", "My Computer", "Website", "Mail",
  "Refresh (F5)", "Switch Application",
  "Sensitivity", "DPI Loop", "Disable Key", "Keyboard"
];

/* Wire records for command 0x09, three bytes each, verified against captures:
   mouse buttons are HID button bits, media actions use the consumer usage.
   Record index is key_value, not visual order. */
const KEY_RECORDS = {
  "Left-Click":  [0x10, 0x01, 0x00],
  "Right-Click": [0x10, 0x02, 0x00],
  "Middle-Click": [0x10, 0x04, 0x00],
  "Backward":    [0x10, 0x08, 0x00],
  "Forward":     [0x10, 0x10, 0x00],
  "Volume +":    [0x80, 0xE9, 0x00],
  "Volume -":    [0x80, 0xEA, 0x00],
  "Mute":        [0x80, 0xE2, 0x00],
  "Play/Pause":  [0x80, 0xCD, 0x00],
  "Next":        [0x80, 0xB5, 0x00],
  "Previous":    [0x80, 0xB6, 0x00],
  "Stop":        [0x80, 0xB7, 0x00],
  "DPI Loop":    [0x40, 0x01, 0x00],
  "Disable Key": [0x60, 0x00, 0x00]
};

const DEFAULTS = {
  dpiCount: 6,
  dpi: [
    { value: 800,   color: "#FF0000" },
    { value: 1600,  color: "#00FF00" },
    { value: 2400,  color: "#0000FF" },
    { value: 3200,  color: "#FFFF00" },
    { value: 6400,  color: "#FE1966" },
    { value: 12000, color: "#FF4400" }
  ],
  rate: 1000,         // report_rate default_value="1" == 1000 Hz (code 1)
  sleep: 180,         // sleep_light value="180"
  moveWake: false,    // move_wakeup value="0"
  keys: ["Left-Click", "Right-Click", "Middle-Click", "Forward", "Backward", "DPI Loop"]
};

/* default_dpi="2" is 1-based, so the second stage is active out of the box. */
const DEFAULT_STAGE = 1;

let state = structuredClone(DEFAULTS);
let hidDevice = null;
let deviceInfo = null;
let pending = null;
let lastWriteError = "";
let lastResult = "—";
let selectedStage = DEFAULT_STAGE;
let outputReportId = 0;
let sendLayout = null;   // null = unknown, 0 = 32-byte payload, 1 = 33 bytes as-is
let probing = false;
let macroSteps = [];
let recording = false;

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- transport */

function checksum(bytes) {
  let sum = 0;
  for (let i = 5; i <= 31; i++) sum += bytes[i];
  return sum & 0xFF;
}

/* Reports are small. Measured with hidapi on the receiver: a 65-byte buffer
   reaches the wire as 33 bytes and the reply is 32 bytes. Byte 0 is the report
   id / leading zero, byte 1 the command, byte 4 the payload length and byte 32
   the checksum over 5..31. Sending 64 bytes in WebHID is instantly refused with
   "Failed to write the report.", which is what hidapi never does because it
   truncates/pads to the real report size. */
const FRAME_SIZE = 33;

function buildFrame(cmd, payload, lenByte, isWrite) {
  const frame = new Uint8Array(FRAME_SIZE);
  frame[0] = 0x00;
  frame[1] = cmd;
  frame[2] = 0x00;
  frame[3] = isWrite === false ? 0x00 : 0x01;
  frame[4] = lenByte === undefined ? payload.length : lenByte;
  for (let i = 0; i < payload.length && i < 27; i++) frame[5 + i] = payload[i] & 0xFF;
  frame[32] = checksum(frame);
  return frame;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function hexOf(bytes, limit) {
  return Array.from(bytes.slice(0, limit))
    .map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/* Last few packets, so a failed session can be reported verbatim. */
const wireLog = [];

function logWire(dir, bytes) {
  wireLog.push(`${dir} ${hexOf(bytes, 16)}`);
  if (wireLog.length > 12) wireLog.shift();
  const el = document.getElementById("diag-wire");
  if (el) el.textContent = wireLog.length ? wireLog.join("\n") : "—";
}

/* One write, then wait for an input report. */
function exchange(bytes, timeoutMs) {
  return new Promise(async (resolve) => {
    let timer = null;
    const settle = (reply) => {
      clearTimeout(timer);
      if (pending === settle) pending = null;
      resolve(reply);
    };
    pending = settle;
    timer = setTimeout(() => settle(null), timeoutMs);

    logWire("TX", bytes);
    try {
      await hidDevice.sendReport(outputReportId, bytes);
    } catch (err) {
      lastWriteError = err && err.message ? err.message : String(err);
      settle(null);
    }
  });
}

/* DriverComm::SetDeviceData writes, then reads up to 50 times at 30 ms and
   only accepts a reply whose second byte is 0. So the wait has to be
   generous: a 2.4G dongle can be slow, and the probe showed a write's
   acknowledgement arriving only on the next transaction. */
const FIRST_WAIT = 600;
const RETRY_WAIT = 1500;

/* Two plausible framings, tried in order on the first exchange: a 32-byte
   payload with the report id passed separately, or the full 33 bytes verbatim.
   Exactly one is accepted — the other throws "Failed to write the report." — so
   the first send that resolves tells us the layout for the rest of the session. */
function candidatePayloads(frame) {
  if (sendLayout === 0) return [frame.slice(1)];
  if (sendLayout === 1) return [frame];
  return [frame.slice(1), frame];
}

function describeReply(cmd, reply) {
  // byte 1 is the status byte: 0 = accepted, 1 = rejected
  const status = reply.length > 1 ? reply[1] : 0xFF;
  lastResult = `0x${cmd.toString(16)} <- ${reply.length} B [${hexOf(reply, 12)}] status=${status}`;
  return { ok: true, reply, status, silent: false };
}

async function sendCommand(cmd, payload, lenByte, opts = {}) {
  if (!hidDevice || !hidDevice.opened) {
    lastResult = "not connected";
    return { ok: false, error: "not connected" };
  }
  const frame = buildFrame(cmd, payload, lenByte, opts.isWrite !== false);
  let lastErr = "";

  for (const bytes of candidatePayloads(frame)) {
    lastWriteError = "";
    const first = await exchange(bytes, FIRST_WAIT);
    if (lastWriteError) {
      lastErr = lastWriteError;
      continue;                       // wrong report length, try the other form
    }
    if (sendLayout === null) sendLayout = bytes.length === 32 ? 0 : 1;
    if (first && first.length) return describeReply(cmd, first);

    // Accepted by the OS but quiet so far — give the link a longer window.
    const second = await exchange(bytes, RETRY_WAIT);
    if (lastWriteError) {
      lastErr = lastWriteError;
      continue;
    }
    if (second && second.length) return describeReply(cmd, second);
    break;                            // correct length, device just did not answer
  }

  if (lastErr) {
    lastResult = `0x${cmd.toString(16)} -> write error`;
    return { ok: false, error: lastErr };
  }
  lastResult = `0x${cmd.toString(16)} -> no ack`;
  return { ok: true, silent: true };
}

/* DriverComm::GetDeviceInfo @ 0x4B200 and the open path in EnumerateDevice:
   every connection starts with a read of command 0x10. Doing the same both
   wakes the dongle and proves the link before any write is attempted. */
async function readDeviceInfo() {
  return sendCommand(CMD.INFO, [], 0, { isWrite: false });
}

/* -------------------------------------------------------------------- apply */

async function applyRate() {
  return sendCommand(CMD.RATE, [RATE_CODES[state.rate] || 1], 1);
}

async function applyDpi() {
  const payload = new Array(25).fill(0);
  for (let i = 0; i < 6; i++) {
    const code = encodeDpi(state.dpi[i].value);
    const base = 1 + i * 4;                    // payload[0] stays zero
    payload[base] = code & 0xFF;
    payload[base + 1] = (code >> 8) & 0xFF;
    payload[base + 2] = code & 0xFF;           // Y axis carries the same code
    payload[base + 3] = (code >> 8) & 0xFF;
  }
  return sendCommand(CMD.DPI, payload, 0x25);
}

async function applyDpiColors() {
  const payload = [];
  for (let i = 0; i < 6; i++) {
    const hex = state.dpi[i].color;
    payload.push(parseInt(hex.slice(1, 3), 16),
                 parseInt(hex.slice(3, 5), 16),
                 parseInt(hex.slice(5, 7), 16));
  }
  return sendCommand(CMD.DPI_COLOR, payload, 0x12);
}

/* move_closelight has no UI on this model (custom show_* = 0), so it is
   always written at the vendor default of 0. */
async function applyPower() {
  return sendCommand(CMD.POWER,
                     [state.sleep, 0, state.moveWake ? 1 : 0, 0], 4);
}

/* Command 0x09 carries all six bindings as 3-byte records, ordered by
   key_value. Verified against captures: key 204 (key_value 4) lands in record
   4, key 205 (key_value 3) in record 3. The vendor sends a length byte of 0x0f
   even though six records follow, so that constant is copied verbatim. */
async function applyKeys() {
  const records = new Array(6);
  for (let i = 0; i < KEYS.length; i++) {
    const record = KEY_RECORDS[state.keys[i]];
    if (!record) return { ok: false, error: `"${state.keys[i]}" is not encodable` };
    records[KEYS[i].value] = record;
  }
  const payload = [];
  for (const record of records) payload.push(...record);
  return sendCommand(CMD.KEY_ALL, payload, 0x0F);
}

async function resetIndicator() {
  return sendCommand(CMD.LIGHT_RESET, [0x01], 1);
}

async function restoreFactory() {
  return sendCommand(CMD.FACTORY, [0x01, 0xFF], 1);
}

async function applyAll() {
  if (!hidDevice || !hidDevice.opened) return showToast("Connect the mouse first");
  setBusy(true);
  await readDeviceInfo();          // wake the link the way the vendor does
  const results = [];
  results.push(await applyRate()); await delay(40);
  results.push(await applyDpi()); await delay(40);
  results.push(await applyDpiColors()); await delay(40);
  results.push(await applyPower());
  setBusy(false);
  updateDiagnostics();
  saveState();

  const errors = results.filter((r) => !r.ok);
  if (errors.length) showToast(errors[0].error || "Write failed");
  else if (results.some((r) => r.silent)) showToast("Sent — device did not acknowledge");
  else showToast("Configuration written");
}

function setBusy(busy) {
  document.body.classList.toggle("busy", busy);
}

/* ------------------------------------------------------------------ connect */

async function requestPairWith(filters, label) {
  if (!navigator.hid) return showToast("WebHID unavailable — use Chrome or Edge");
  try {
    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices.length) return;
    if (hidDevice && hidDevice !== devices[0]) {
      try { await hidDevice.close(); } catch (err) { /* already gone */ }
    }
    await attach(devices[0], true);
  } catch (err) {
    showToast(`Pairing cancelled${label ? " (" + label + ")" : ""}`);
  }
}

/* Send the open-time read to one specific interface without disturbing the
   attached one. Returns the reply bytes, or null. */
async function probeDeviceOnce(device) {
  if (!device.opened) {
    try {
      await device.open();
    } catch (err) {
      return null;
    }
  }
  const prevDevice = hidDevice;
  const prevReportId = outputReportId;
  hidDevice = device;
  outputReportId = pickReportId(device);
  device.oninputreport = (event) => {
    const bytes = new Uint8Array(event.data.buffer);
    logWire("RX", bytes);
    if (pending) pending(bytes);
  };
  const res = await sendCommand(CMD.INFO, [], 0, { isWrite: false });
  hidDevice = prevDevice;
  outputReportId = prevReportId;
  return res.reply || null;
}

/* Chrome grants one interface per pairing and they all share a product name in
   the picker, so a silent interface is common. If other interfaces of the same
   device were granted earlier, the one that answers 0x10 is the vendor
   collection — switch to it automatically. */
async function autoSwitchToAnswering(device) {
  if (probing) return false;
  let granted = [];
  try {
    granted = await navigator.hid.getDevices();
  } catch (err) {
    return false;
  }
  const others = granted.filter((d) => d !== device && isOurs(d));
  if (!others.length) return false;

  probing = true;
  showToast(`Silent interface — trying ${others.length} other granted one(s)`);
  for (const dev of others) {
    const reply = await probeDeviceOnce(dev);
    if (reply) {
      probing = false;
      await attach(dev, true, false);
      return true;
    }
  }
  probing = false;
  showToast("None of the granted interfaces answered");
  return false;
}

async function attach(device, announce, allowSwitch) {
  hidDevice = device;
  lastWriteError = "";
  if (!hidDevice.opened) {
    try {
      await hidDevice.open();
    } catch (err) {
      lastWriteError = err && err.message ? err.message : String(err);
      showToast("Could not open the interface");
      updateDiagnostics();
      return;
    }
  }
  hidDevice.oninputreport = (event) => {
    const bytes = new Uint8Array(event.data.buffer);
    logWire("RX", bytes);
    if (pending) pending(bytes);
  };
  outputReportId = pickReportId(device);

  // A collection with no output report cannot carry the protocol; skip the
  // pointless write attempts and move straight to finding a usable interface.
  const canWrite = hasOutputReport(device);
  const probe = canWrite
    ? await readDeviceInfo()
    : { ok: false, error: "this interface has no output report" };
  deviceInfo = probe.reply || null;

  updateHud();
  updateDiagnostics();

  // No reply, or the write was refused ("Failed to write the report" means the
  // collection has no such output report): look for a better granted one.
  const unusable = !probe.reply;
  if (unusable && allowSwitch !== false && await autoSwitchToAnswering(device)) return;

  if (announce) {
    if (!isVendorCollection(device)) {
      showToast(`${pageKind(device)} — pick the vendor row`);
    } else if (probe.reply) {
      showToast(`Connected — device answered (${probe.reply.length} B)`);
    } else if (probe.error) {
      showToast(`Connected — ${probe.error}`);
    } else {
      showToast("No reply — try another row in the picker");
    }
  }
}

/* Last resort: every vendor-defined usage page, for a unit whose vendor id is
   not in the list above. */
const FILTERS_VENDOR = (() => {
  const out = [];
  for (let page = 0xFF00; page <= 0xFFFF; page++) out.push({ usagePage: page });
  return out;
})();
function isVendorCollection(device) {
  return (device.collections || []).some(
    (c) => c.usagePage === VENDOR_PAGE && c.usage === VENDOR_USAGE) ||
    (device.collections || []).some((c) => c.usagePage >= 0xFF00);
}

function pageSummary(device) {
  const seen = [];
  for (const c of device.collections || []) {
    const tag = `0x${c.usagePage.toString(16).toUpperCase()}/${c.usage.toString(16).toUpperCase()}`;
    if (!seen.includes(tag)) seen.push(tag);
  }
  return seen.join(", ") || "none";
}

/* Name the interface so the picker choice is obvious in the toast. */
function pageKind(device) {
  const pages = (device.collections || []).map((c) => c.usagePage);
  if (pages.some((p) => p >= 0xFF00)) return "vendor interface";
  if (pages.includes(0x0001)) return "mouse/keyboard interface";
  if (pages.includes(0x000C)) return "consumer-control interface";
  return "non-vendor interface";
}

/* Collection with no output report cannot carry the protocol at all — the
   consumer-control interface is exactly this case. inputReports/outputReports
   are arrays in WebHID, not Sets. */
function hasOutputReport(device) {
  return (device.collections || []).some((c) => (c.outputReports || []).length > 0);
}

/* The vendor always writes report id 0. If a unit's descriptor does not
   declare it, fall back to whatever output report it does expose. */
function pickReportId(device) {
  const ids = [];
  for (const c of device.collections || []) {
    for (const r of c.outputReports || []) ids.push(r.reportId);
  }
  const unique = [...new Set(ids)];
  // Prefer 0, which is what the vendor writes; otherwise the smallest declared.
  if (unique.includes(0)) return 0;
  return unique.length ? Math.min(...unique) : 0;
}

async function autoConnect() {
  if (!navigator.hid) return;
  try {
    const paired = await navigator.hid.getDevices();
    const ours = paired.filter(isOurs);
    if (!ours.length) return;
    // Prefer the collection with a vendor-defined usage page; fall back to any
    // granted interface so DIAGNOSTICS can show what the picker actually gave us.
    const good = ours.find(isVendorCollection) || ours[0];
    await attach(good, false);
  } catch (err) {
    /* ignore */
  }
}

/* A unit whose vendor/product id differs from the descriptor can be paired by
   id; remember it so auto-connect keeps working across reloads. */
function loadCustom() {
  try {
    return JSON.parse(localStorage.getItem("tk-gm012.custom") || "null");
  } catch (err) {
    return null;
  }
}

function isOurs(device) {
  const custom = loadCustom();
  if (custom && device.vendorId === custom.vid &&
      (custom.pid === null || custom.pid === undefined || device.productId === custom.pid)) {
    return true;
  }
  return [WIRED, WIRELESS].some(
    (f) => f.vendorId === device.vendorId && f.productId === device.productId);
}

/* -------------------------------------------------------------- diagnostics */

function updateHud() {
  const online = !!(hidDevice && hidDevice.opened);
  const dot = $("hud-dot");
  const status = $("hud-status");
  const mode = $("hud-mode");
  if (dot) dot.classList.toggle("online", online);
  if (status) status.textContent = online ? "ONLINE" : "STANDBY";
  if (mode) {
    if (!online || !hidDevice) mode.textContent = "NONE";
    else mode.textContent = hidDevice.vendorId === WIRELESS.vendorId ? "2.4G WIRELESS" : "USB WIRED";
  }
  const bat = $("hud-battery-text");
  if (bat) bat.textContent = online ? "N/A" : "--%";
}

function updateDiagnostics() {
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove("ok", "bad");
    if (cls) el.classList.add(cls);
  };

  if (!hidDevice) {
    set("diag-product", "not connected");
    set("diag-ids", "—");
    set("diag-interface", "—");
    set("diag-info", "—");
    set("diag-last", lastResult);
    set("diag-error", lastWriteError || "—");
    const list = $("diag-collections");
    if (list) list.innerHTML = `<div class="macro-empty">No device open</div>`;
    return;
  }

  const vendor = isVendorCollection(hidDevice);
  set("diag-product", hidDevice.productName || "(unnamed)");
  set("diag-ids", `0x${hidDevice.vendorId.toString(16).toUpperCase()} : 0x${hidDevice.productId.toString(16).toUpperCase()}`);
  set("diag-interface",
      vendor ? `vendor collection · ${pageSummary(hidDevice)} · report id ${outputReportId}`
             : `${pageKind(hidDevice)} · ${pageSummary(hidDevice)}`,
      vendor ? "ok" : "bad");
  set("diag-info", deviceInfo ? `${deviceInfo.length} B [${hexOf(deviceInfo, 16)}]` : "no reply",
      deviceInfo ? "ok" : "bad");
  set("diag-last", lastResult);
  set("diag-error", lastWriteError || "—", lastWriteError ? "bad" : "");

  const list = $("diag-collections");
  if (list) {
    const rows = (hidDevice.collections || []).map((c) => `
      <div class="diag-row">
        <span>usage page</span>
        <code>0x${c.usagePage.toString(16).toUpperCase()}</code>
        <span>usage</span>
        <code>0x${c.usage.toString(16).toUpperCase()}</code>
        <span class="diag-flag ${c.usagePage >= 0xFF00 ? "ok" : ""}">
          ${(c.inputReports || []).length} in / ${(c.outputReports || []).length} out / ${(c.featureReports || []).length} feat
        </span>
      </div>`);
    list.innerHTML = rows.length ? rows.join("")
      : `<div class="macro-empty">This interface exposes no collections</div>`;
  }
}

/* ---------------------------------------------------------------------- UI */

function showToast(message) {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const target = $(tabId);
  if (target) target.classList.add("active");
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  const nav = $("nav-" + tabId);
  if (nav) nav.classList.add("active");
  saveState();
}

function buildKeySelects() {
  for (let i = 0; i < KEYS.length; i++) {
    const select = $("btn-select-" + i);
    if (!select) continue;
    select.innerHTML = KEY_ACTIONS
      .map((a) => `<option${a === state.keys[i] ? " selected" : ""}>${a}</option>`)
      .join("");
    select.onchange = () => {
      state.keys[i] = select.value;
      const label = $("anchor-label-" + i);
      if (label) label.textContent = `${i + 1}. ${select.value}`;
      saveState();
    };
    const label = $("anchor-label-" + i);
    if (label) label.textContent = `${i + 1}. ${state.keys[i]}`;
  }
}

function buildDpiCards() {
  const grid = $("dpi-grid");
  if (!grid) return;
  grid.innerHTML = state.dpi.map((stage, i) => `
    <button class="dpi-card${i === selectedStage ? " active" : ""}" data-stage="${i}" type="button">
      <span class="dpi-card-head" style="background:${stage.color}">DPI ${i + 1}</span>
      <span class="dpi-card-value" style="color:${stage.color}">${stage.value}</span>
    </button>`).join("");

  grid.querySelectorAll(".dpi-card").forEach((card) => {
    card.onclick = () => {
      selectedStage = Number(card.dataset.stage);
      buildDpiCards();
      syncDpiControls();
      updateStageLed();
    };
  });
}

/* The only LED on this model: the DPI indicator under the wheel, tinted with
   the colour of the stage it shows. */
function updateStageLed() {
  const led = $("live-led");
  if (!led) return;
  const color = state.dpi[selectedStage].color;
  led.style.backgroundColor = color;
  led.style.boxShadow = `0 0 4px #fff, 0 0 10px ${color}, 0 0 22px ${color}`;
}

function syncDpiControls() {
  const range = $("rng-dpi");
  if (range) range.value = state.dpi[selectedStage].value;
  const badge = $("lbl-dpi");
  if (badge) badge.textContent = state.dpi[selectedStage].value;
  const color = $("inp-dpi-color");
  if (color) color.value = state.dpi[selectedStage].color;
  const count = $("sel-dpi-count");
  if (count) count.value = state.dpiCount;
}

function buildMacroList() {
  const list = $("macro-steps");
  if (!list) return;
  list.innerHTML = macroSteps.length
    ? macroSteps.map((step, i) => `
        <div class="macro-step">
          <span class="macro-index">${i + 1}</span>
          <span class="macro-body">${step.kind === "delay"
            ? `Delay ${step.ms} ms`
            : `${step.type === "down" ? "Press" : "Release"} ${step.key}`}</span>
          <button class="macro-del" data-i="${i}" type="button">×</button>
        </div>`).join("")
    : `<div class="macro-empty">No steps recorded</div>`;

  list.querySelectorAll(".macro-del").forEach((btn) => {
    btn.onclick = () => {
      macroSteps.splice(Number(btn.dataset.i), 1);
      buildMacroList();
    };
  });
}

function buildProfiles() {
  const list = $("profile-list");
  if (!list) return;
  const profiles = loadProfiles();
  list.innerHTML = Object.keys(profiles).length
    ? Object.entries(profiles).map(([name, saved]) => `
        <div class="profile-row">
          <span class="profile-name">${name}</span>
          <span class="profile-meta">${saved.savedAt || ""}</span>
          <button class="btn-ghost small" data-load="${name}" type="button">LOAD</button>
          <button class="btn-ghost small" data-del="${name}" type="button">DELETE</button>
        </div>`).join("")
    : `<div class="macro-empty">No saved profiles</div>`;

  list.querySelectorAll("[data-load]").forEach((btn) => {
    btn.onclick = () => {
      const profilesNow = loadProfiles();
      state = Object.assign(structuredClone(DEFAULTS), profilesNow[btn.dataset.load].state);
      refreshUI();
      showToast("Profile loaded");
    };
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => {
      const profilesNow = loadProfiles();
      delete profilesNow[btn.dataset.del];
      localStorage.setItem("tk-gm012.profiles", JSON.stringify(profilesNow));
      buildProfiles();
    };
  });
}

function refreshUI() {
  buildKeySelects();
  buildDpiCards();
  syncDpiControls();
  updateStageLed();
  buildMacroList();
  buildProfiles();

  document.querySelectorAll("#rate-control .seg-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.rate) === state.rate);
  });

  const sleep = $("sel-sleep");
  if (sleep) sleep.value = String(state.sleep);
  const wake = $("chk-wake");
  if (wake) wake.checked = state.moveWake;
}

/* ---------------------------------------------------------------- persistence */

function saveState() {
  try {
    localStorage.setItem("tk-gm012.state", JSON.stringify(state));
  } catch (err) { /* storage disabled */ }
}

function restoreState() {
  try {
    const raw = localStorage.getItem("tk-gm012.state");
    if (raw) state = Object.assign(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (err) { /* ignore */ }
}

function loadProfiles() {
  try {
    return JSON.parse(localStorage.getItem("tk-gm012.profiles") || "{}");
  } catch (err) {
    return {};
  }
}

function saveProfile() {
  const input = $("inp-profile-name");
  const name = (input && input.value.trim()) || "Profile";
  const profiles = loadProfiles();
  profiles[name] = {
    state: structuredClone(state),
    savedAt: new Date().toISOString().slice(0, 10)
  };
  localStorage.setItem("tk-gm012.profiles", JSON.stringify(profiles));
  buildProfiles();
  showToast(`Saved "${name}"`);
}

/* ---------------------------------------------------------------- macros */

function isTypingTarget(el) {
  return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function startRecording() {
  if (recording) return;
  recording = true;
  macroSteps = [];
  buildMacroList();
  const btn = $("btn-record");
  if (btn) btn.classList.add("recording");
  showToast("Recording — Esc to stop");
}

function stopRecording() {
  recording = false;
  const btn = $("btn-record");
  if (btn) btn.classList.remove("recording");
  buildMacroList();
}

function macroKeyHook(event) {
  if (!recording || isTypingTarget(event.target)) return;
  if (event.code === "Escape") {
    stopRecording();
    return;
  }
  event.preventDefault();
  macroSteps.push({
    kind: "key",
    type: event.type === "keydown" ? "down" : "up",
    key: event.code || "KeyA"
  });
  buildMacroList();
}

/* ------------------------------------------------------------------- wiring */

document.addEventListener("DOMContentLoaded", () => {
  restoreState();
  refreshUI();
  updateHud();
  updateDiagnostics();
  autoConnect();

  navigator.hid?.addEventListener("connect", autoConnect);
  navigator.hid?.addEventListener("disconnect", () => {
    hidDevice = null;
    updateHud();
    updateDiagnostics();
    showToast("Device disconnected");
  });

  $("btn-connect")?.addEventListener("click", () => {
    if (hidDevice && hidDevice.opened) applyAll();
    else requestPairWith(FILTERS);
  });
  $("btn-pair-any")?.addEventListener("click", () => requestPairWith(FILTERS_ALL, "all interfaces"));
  $("btn-pair-scan")?.addEventListener("click", () => requestPairWith(FILTERS_VENDOR, "vendor scan"));

  $("btn-pair-custom")?.addEventListener("click", () => {
    const hex = (s) => {
      const cleaned = (s || "").trim().replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "");
      return cleaned ? parseInt(cleaned, 16) : NaN;
    };
    const vid = hex($("inp-custom-vid")?.value);
    if (!Number.isInteger(vid) || vid > 0xFFFF) return showToast("Enter a vendor id in hex");
    const filter = { vendorId: vid };
    const pidRaw = ($("inp-custom-pid")?.value || "").trim();
    let pid = null;
    if (pidRaw) {
      pid = hex(pidRaw);
      if (!Number.isInteger(pid) || pid > 0xFFFF) return showToast("Enter a product id in hex");
      filter.productId = pid;
    }
    try {
      localStorage.setItem("tk-gm012.custom", JSON.stringify({ vid, pid }));
    } catch (err) { /* storage disabled */ }
    requestPairWith([filter], "custom");
  });

  $("btn-sync")?.addEventListener("click", () => {
    refreshUI();
    updateDiagnostics();
    showToast("Loaded saved profile");
  });

  $("btn-reset-keys")?.addEventListener("click", () => {
    state.keys = structuredClone(DEFAULTS.keys);
    buildKeySelects();
    saveState();
    showToast("Keys reset to vendor defaults");
  });

  $("btn-reset-led")?.addEventListener("click", async () => {
    const res = await resetIndicator();
    updateDiagnostics();
    showToast(res.ok ? "Indicator reset" : (res.error || "No response"));
  });

  $("btn-factory")?.addEventListener("click", async () => {
    if (!confirm("Restore the mouse to factory defaults?")) return;
    const res = await restoreFactory();
    state = structuredClone(DEFAULTS);
    selectedStage = DEFAULT_STAGE;
    refreshUI();
    saveState();
    updateDiagnostics();
    showToast(res.ok ? "Factory defaults restored" : (res.error || "No response"));
  });

  $("btn-test")?.addEventListener("click", async () => {
    if (!hidDevice || !hidDevice.opened) return showToast("Connect the mouse first");
    const res = await readDeviceInfo();
    deviceInfo = res.reply || deviceInfo;
    updateDiagnostics();
    showToast(res.reply
      ? `Device answered: ${res.reply.length} B`
      : res.error ? res.error : "No reply");
  });

  $("btn-copy-diag")?.addEventListener("click", async () => {
    const text = (id) => ($(id)?.textContent || "").trim();
    const rows = Array.from(document.querySelectorAll("#diag-collections .diag-row"))
      .map((r) => "  " + r.textContent.replace(/\s+/g, " ").trim());
    const report = [
      `product    ${text("diag-product")}`,
      `vid:pid    ${text("diag-ids")}`,
      `interface  ${text("diag-interface")}`,
      `info reply ${text("diag-info")}`,
      `last cmd   ${text("diag-last")}`,
      `last error ${text("diag-error")}`,
      "collections:",
      ...rows,
      "wire log:",
      text("diag-wire")
    ].join("\n");
    try {
      await navigator.clipboard.writeText(report);
      showToast("Diagnostics copied");
    } catch (err) {
      showToast("Clipboard blocked — select the text manually");
    }
  });

  document.querySelectorAll("#rate-control .seg-btn").forEach((btn) => {
    btn.onclick = async () => {
      state.rate = Number(btn.dataset.rate);
      refreshUI();
      saveState();
      const res = await applyRate();
      updateDiagnostics();
      showToast(res.ok && !res.silent ? `${state.rate} Hz applied`
        : res.ok ? `${state.rate} Hz sent (no ack)` : (res.error || "Write failed"));
    };
  });

  $("rng-dpi")?.addEventListener("input", (e) => {
    state.dpi[selectedStage].value = Number(e.target.value);
    $("lbl-dpi").textContent = e.target.value;
    buildDpiCards();
  });
  $("rng-dpi")?.addEventListener("change", async () => {
    saveState();
    await applyDpi();
    updateDiagnostics();
  });

  $("inp-dpi-color")?.addEventListener("input", (e) => {
    state.dpi[selectedStage].color = e.target.value;
    buildDpiCards();
    updateStageLed();
  });
  $("inp-dpi-color")?.addEventListener("change", async () => {
    saveState();
    await applyDpiColors();
    updateDiagnostics();
  });

  $("sel-dpi-count")?.addEventListener("change", (e) => {
    state.dpiCount = Number(e.target.value);
    saveState();
  });

  $("sel-sleep")?.addEventListener("change", async (e) => {
    state.sleep = Number(e.target.value);
    saveState();
    await applyPower();
    updateDiagnostics();
  });

  $("chk-wake")?.addEventListener("change", async (e) => {
    state.moveWake = e.target.checked;
    saveState();
    await applyPower();
    updateDiagnostics();
  });

  $("btn-record")?.addEventListener("click", () => {
    if (recording) stopRecording(); else startRecording();
  });

  $("btn-add-delay")?.addEventListener("click", () => {
    const ms = Number($("inp-delay")?.value || 100);
    macroSteps.push({ kind: "delay", ms });
    buildMacroList();
  });

  $("btn-clear-macro")?.addEventListener("click", () => {
    macroSteps = [];
    buildMacroList();
  });

  $("btn-save-profile")?.addEventListener("click", saveProfile);

  $("btn-apply-keys")?.addEventListener("click", async () => {
    const res = await applyKeys();
    updateDiagnostics();
    if (!res.ok) return showToast(res.error || "Key write failed");
    showToast(res.silent ? "Keys sent (no ack)" : "Keys written");
  });

  window.addEventListener("keydown", macroKeyHook);
  window.addEventListener("keyup", macroKeyHook);
});

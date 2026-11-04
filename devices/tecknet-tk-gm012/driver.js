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
 * The vendor binds to one specific HID collection: DriverComm::FindDevice at
 * 0x4C3A0 rejects every interface whose usage_page is not 0xFFEF or whose
 * usage is not 0. Pairing a boot mouse/keyboard collection instead produces
 * writes the firmware silently drops, so the filter below is narrow.
 */

const VENDOR_USAGE_PAGE = 0xFFEF;
const VENDOR_USAGE = 0x00;

const WIRED = { vendorId: 0x248A, productId: 0x5D2E };
const WIRELESS = { vendorId: 0x249A, productId: 0x5C2F };

const FILTERS = [
  { ...WIRED, usagePage: VENDOR_USAGE_PAGE, usage: VENDOR_USAGE },
  { ...WIRELESS, usagePage: VENDOR_USAGE_PAGE, usage: VENDOR_USAGE }
];
const FILTERS_ANY = [WIRED, WIRELESS];

const CMD = {
  INFO: 0x10,
  RATE: 0x02,
  DPI: 0x03,
  DPI_COLOR: 0x04,
  POWER: 0x07,
  KEY_ONE: 0x08,
  LIGHT_RESET: 0x0E,
  FACTORY: 0x0F
};

const RATE_CODES = { 125: 1, 250: 2, 500: 3, 1000: 4 };

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

/* Keyboard records are the only key record type decoded so far. */
const ACTION_KEYCODE = {
  "Enter": 0x1C, "Space": 0x39, "Copy": 0x2E, "Paste": 0x2F,
  "Cut": 0x2D, "Undo": 0x2C
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
  rate: 125,          // report_rate default_value="1"
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
let macroSteps = [];
let recording = false;

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- transport */

function checksum(bytes) {
  let sum = 0;
  for (let i = 5; i <= 31; i++) sum += bytes[i];
  return sum & 0xFF;
}

/* Build a 64-byte report with the report id stripped. The vendor writes
   `00 <cmd> 00 <rw> <len> ...` and lets hidapi keep the leading 0x00 as the
   report id; WebHID wants the id passed separately, so [0] is dropped here.
   Byte 3 is 0x01 for writes and 0x00 for reads. */
function buildReport(cmd, payload, lenByte, isWrite) {
  const frame = new Uint8Array(65);
  frame[0] = 0x00;
  frame[1] = cmd;
  frame[2] = 0x00;
  frame[3] = isWrite === false ? 0x00 : 0x01;
  frame[4] = lenByte === undefined ? payload.length : lenByte;
  for (let i = 0; i < payload.length && i < 27; i++) frame[5 + i] = payload[i] & 0xFF;
  frame[32] = checksum(frame);
  return frame.slice(1);
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

/* One write, then wait for an input report. `wide` sends the full 65-byte
   frame instead of the 64-byte payload, which covers units whose descriptor
   carries no report id. */
function exchange(report, wide, timeoutMs) {
  return new Promise(async (resolve) => {
    let timer = null;
    const settle = (reply) => {
      clearTimeout(timer);
      if (pending === settle) pending = null;
      resolve(reply);
    };
    pending = settle;
    timer = setTimeout(() => settle(null), timeoutMs);

    let data = report;
    if (wide) {
      data = new Uint8Array(65);
      data[0] = 0x00;
      data.set(report, 1);
    }
    logWire("TX", data);
    try {
      await hidDevice.sendReport(outputReportId, data);
    } catch (err) {
      lastWriteError = err && err.message ? err.message : String(err);
      settle(null);
    }
  });
}

/* DriverComm::SetDeviceData writes, then reads up to 50 times at 30 ms and
   only accepts a reply whose second byte is 0 (hidapi keeps the report id at
   [0], WebHID strips it). So the wait has to be long: a 2.4G dongle can take
   a while. Each variant is tried once before moving on. */
const ATTEMPTS = [
  { wide: false, timeout: 400 },
  { wide: true, timeout: 400 },
  { wide: false, timeout: 1200 }
];

async function sendCommand(cmd, payload, lenByte, opts = {}) {
  if (!hidDevice || !hidDevice.opened) {
    lastResult = "not connected";
    return { ok: false, error: "not connected" };
  }
  const report = buildReport(cmd, payload, lenByte, opts.isWrite !== false);
  let lastErr = "";

  for (const attempt of ATTEMPTS) {
    lastWriteError = "";
    const reply = await exchange(report, attempt.wide, attempt.timeout);
    if (reply && reply.length) {
      // vendor check: reply[1] == 0 in hidapi terms, reply[0] after WebHID strips the id
      const ack = reply[0] === 0 || (reply.length > 1 && reply[1] === 0);
      lastResult = `0x${cmd.toString(16)} <- ${reply.length} B [${hexOf(reply, 16)}]${ack ? "" : " (odd ack)"}`;
      return { ok: true, reply, ack };
    }
    if (lastWriteError) lastErr = lastWriteError;
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
    const stage = state.dpi[i];
    const base = 1 + i * 4;                    // payload[0] stays zero
    payload[base] = stage.value & 0xFF;
    payload[base + 1] = (stage.value >> 8) & 0xFF;
    const rgb565 = ((parseInt(stage.color.slice(1, 3), 16) >> 3) << 11) |
                   ((parseInt(stage.color.slice(3, 5), 16) >> 2) << 5) |
                   (parseInt(stage.color.slice(5, 7), 16) >> 3);
    payload[base + 2] = rgb565 & 0xFF;
    payload[base + 3] = (rgb565 >> 8) & 0xFF;
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

async function applyKey(index) {
  const keyCode = ACTION_KEYCODE[state.keys[index]];
  if (keyCode === undefined) return { ok: false, error: "not encodable" };
  return sendCommand(CMD.KEY_ONE,
                     [KEYS[index].value, 0x30, 0x01, 0x00, keyCode], 6);
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

async function requestPair(anyInterface) {
  if (!navigator.hid) return showToast("WebHID unavailable — use Chrome or Edge");
  try {
    const devices = await navigator.hid.requestDevice({
      filters: anyInterface ? FILTERS_ANY : FILTERS
    });
    if (!devices.length) return;
    if (hidDevice && hidDevice !== devices[0]) {
      try { await hidDevice.close(); } catch (err) { /* already gone */ }
    }
    await attach(devices[0], true);
  } catch (err) {
    showToast("Pairing cancelled");
  }
}

async function attach(device, announce) {
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

  // Same open sequence as DriverComm::EnumerateDevice: read command 0x10.
  const probe = await readDeviceInfo();
  deviceInfo = probe.reply || null;

  updateHud();
  updateDiagnostics();
  if (announce) {
    if (!isVendorCollection(device)) showToast("Wrong interface — see DIAGNOSTICS");
    else if (probe.reply) showToast(`Connected — device answered (${probe.reply.length} B)`);
    else if (probe.error) showToast(`Connected — ${probe.error}`);
    else showToast("Connected — no reply, check DIAGNOSTICS");
  }
}

function isVendorCollection(device) {
  return (device.collections || []).some(
    (c) => c.usagePage === VENDOR_USAGE_PAGE && c.usage === VENDOR_USAGE);
}

/* The vendor always writes report id 0. If a unit's descriptor does not
   declare it, fall back to whatever output report it does expose. */
function pickReportId(device) {
  const ids = [];
  for (const c of device.collections || []) {
    for (const r of c.outputReports || []) ids.push(r.reportId);
  }
  const unique = [...new Set(ids)];
  if (unique.includes(0)) return 0;
  return unique.length ? unique[0] : 0;
}

async function autoConnect() {
  if (!navigator.hid) return;
  try {
    const paired = await navigator.hid.getDevices();
    const ours = paired.filter((d) =>
      [WIRED, WIRELESS].some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
    const good = ours.find(isVendorCollection);
    if (good) {
      await attach(good, false);
    } else if (ours.length) {
      // A previous grant bound the boot mouse/keyboard collection, where every
      // write is silently dropped. Ask for a fresh pairing instead.
      showToast("Re-pair the mouse — the saved permission bound the wrong interface");
    }
  } catch (err) {
    /* ignore */
  }
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
      vendor ? `0x${VENDOR_USAGE_PAGE.toString(16).toUpperCase()} / 0x00 vendor collection · report id ${outputReportId}`
             : "wrong collection — re-pair",
      vendor ? "ok" : "bad");
  set("diag-info", deviceInfo ? `${deviceInfo.length} B [${hexOf(deviceInfo, 16)}]` : "no reply",
      deviceInfo ? "ok" : "bad");
  set("diag-last", lastResult);
  set("diag-error", lastWriteError || "—", lastWriteError ? "bad" : "");

  const list = $("diag-collections");
  if (list) {
    const rows = (hidDevice.collections || []).flatMap((c) =>
      (c.inputReports.size || c.outputReports.size || c.featureReports.size)
        ? [`<div class="diag-row">
             <span>usage page</span>
             <code>0x${c.usagePage.toString(16).toUpperCase()}</code>
             <span>usage</span>
             <code>0x${c.usage.toString(16).toUpperCase()}</code>
             <span class="diag-flag ${c.usagePage === VENDOR_USAGE_PAGE && c.usage === VENDOR_USAGE ? "ok" : ""}">
               ${c.outputReports.size} out</span>
           </div>`]
        : []);
    list.innerHTML = rows.length ? rows.join("")
      : `<div class="macro-empty">No report collections exposed</div>`;
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
    else requestPair(false);
  });
  $("btn-pair-any")?.addEventListener("click", () => requestPair(true));

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
    if (!confirm("Button remap encoding is only partially recovered. Write anyway?")) return;
    let sent = 0;
    for (let i = 0; i < KEYS.length; i++) {
      const res = await applyKey(i);
      if (res.ok) sent++;
      await delay(40);
    }
    updateDiagnostics();
    showToast(`${sent} of ${KEYS.length} keys written (experimental)`);
  });

  window.addEventListener("keydown", macroKeyHook);
  window.addEventListener("keyup", macroKeyHook);
});

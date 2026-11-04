/* TECKNET TK-GM012 — ChesHub driver
 *
 * Protocol recovered from the vendor tool; see PROTOCOL.md for the evidence
 * behind every byte. Frame layout (verified):
 *
 *   [0] report id 0x00   [1] command   [2] 0x00   [3] 0x01
 *   [4] length/type      [5..31] payload
 *   [32] checksum = sum(5..31) & 0xFF
 */

const FILTERS = [
  { vendorId: 0x248A, productId: 0x5D2E },  // USB wired
  { vendorId: 0x249A, productId: 0x5C2F }   // 2.4 GHz dongle
];

const CMD = {
  RATE: 0x02,
  DPI: 0x03,
  DPI_COLOR: 0x04,
  LIGHT: 0x05,
  SENSOR: 0x06,
  POWER: 0x07,
  KEY_ONE: 0x08,
  LIGHT_RESET: 0x0E,
  FACTORY: 0x0F
};

const RATE_CODES = { 125: 1, 250: 2, 500: 3, 1000: 4 };

const KEY_ACTIONS = [
  "Left Click", "Right Click", "Middle Click",
  "Backward", "Forward", "DPI Loop", "DPI +", "DPI -",
  "Scroll Up", "Scroll Down", "Volume +", "Volume -", "Mute",
  "Play / Pause", "Next Track", "Prev Track",
  "Copy", "Paste", "Cut", "Undo", "Enter", "Space", "Disabled"
];

/* Mode index -> payload shape. Indices and shapes come straight from the
   branch table in SetLightModeData @ 0x34B80:
     0 -> 2 bytes, 1 -> 3 bytes, 2 -> 0x18 bytes, 3 -> 5 bytes,
     4 -> 2 bytes, 5 -> 2 bytes */
const LIGHT_MODES = [
  { id: "flow",    label: "Flow",         desc: "Cascading colour sweep",     shape: 2,    mode: 0 },
  { id: "breath",  label: "Breathing",    desc: "Slow pulse",                 shape: 3,    mode: 1 },
  { id: "steady",  label: "Steady",       desc: "Per-zone constant colour",   shape: 0x18, mode: 2 },
  { id: "neon",    label: "Neon",         desc: "Hard colour cycling",        shape: 5,    mode: 3 },
  { id: "wave",    label: "Rainbow Wave", desc: "Full spectrum sweep",        shape: 2,    mode: 4 },
  { id: "off",     label: "Off",          desc: "LEDs disabled",              shape: 2,    mode: 5 }
];

const SLEEP_OPTIONS = [1, 5, 10, 15, 30, 60, 180];

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
  rate: 1000,
  sleep: 30,
  moveWake: true,
  closeLight: false,
  lod: 1,
  sensorA: true,
  sensorB: false,
  lightMode: "breath",
  brightness: 8,
  speed: 5,
  lightColor: "#2ee6c5",
  keys: ["Left Click", "Right Click", "Middle Click", "Volume +", "Volume -", "DPI Loop"]
};

let state = structuredClone(DEFAULTS);
let hidDevice = null;
let pending = null;
let selectedStage = 0;
let macroSteps = [];
let recording = false;

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- transport */

function checksum(bytes) {
  let sum = 0;
  for (let i = 5; i <= 31; i++) sum += bytes[i];
  return sum & 0xFF;
}

function buildReport(cmd, payload, lenByte) {
  const frame = new Uint8Array(65);
  frame[0] = 0x00;
  frame[1] = cmd;
  frame[2] = 0x00;
  frame[3] = 0x01;
  frame[4] = lenByte === undefined ? payload.length : lenByte;
  for (let i = 0; i < payload.length && i < 27; i++) frame[5 + i] = payload[i] & 0xFF;
  frame[32] = checksum(frame);
  return frame.slice(1);           // 64-byte report, id 0
}

/* Writes a report and resolves with the first input report seen, or null. */
function sendCommand(cmd, payload, lenByte, timeoutMs = 400) {
  return new Promise(async (resolve) => {
    if (!hidDevice || !hidDevice.opened) return resolve(null);
    const done = (data) => {
      clearTimeout(timer);
      pending = null;
      resolve(data);
    };
    pending = done;
    const timer = setTimeout(() => { if (pending) done(null); }, timeoutMs);
    try {
      await hidDevice.sendReport(0, buildReport(cmd, payload, lenByte));
    } catch (err) {
      done(null);
    }
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* -------------------------------------------------------------------- apply */

async function applyRate() {
  return sendCommand(CMD.RATE, [RATE_CODES[state.rate] || 4], 1);
}

async function applyDpi() {
  const payload = new Array(25).fill(0);
  for (let i = 0; i < 6; i++) {
    const stage = state.dpi[i];
    const base = 1 + i * 4;                    // payload[0] is left zero
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

async function applyLighting() {
  const preset = LIGHT_MODES.find((m) => m.id === state.lightMode) || LIGHT_MODES[0];
  const packed = ((state.brightness & 0x0F) << 4) | (state.speed & 0x0F);
  const payload = [preset.mode, packed];

  if (preset.shape === 3) {
    payload.push(state.speed & 0x0F);
  } else if (preset.shape === 5) {
    const hex = state.lightColor;
    payload.push(parseInt(hex.slice(1, 3), 16),
                 parseInt(hex.slice(3, 5), 16),
                 parseInt(hex.slice(5, 7), 16));
  } else if (preset.shape === 0x18) {
    // [mode][packed][count=7] then seven RGB triples (the vendor fills all
    // seven from the configured colours; a 6-mode mouse simply repeats one).
    const hex = state.lightColor;
    const rgb = [parseInt(hex.slice(1, 3), 16),
                 parseInt(hex.slice(3, 5), 16),
                 parseInt(hex.slice(5, 7), 16)];
    payload.push(7);
    for (let i = 0; i < 7; i++) payload.push(rgb[0], rgb[1], rgb[2]);
  }
  return sendCommand(CMD.LIGHT, payload, preset.shape);
}

async function applySensor() {
  const flags = (state.sensorA ? 8 : 0) | (state.sensorB ? 4 : 0);
  return sendCommand(CMD.SENSOR, [state.lod, (flags & 8) ? 1 : 0, (flags & 4) ? 1 : 0], 5);
}

async function applyPower() {
  return sendCommand(CMD.POWER, [
    state.sleep,
    0,
    state.moveWake ? 1 : 0,
    state.closeLight ? 1 : 0
  ], 4);
}

/* Button remap: 0x08 carries [key] followed by 4-byte records. The record
   encoding for keyboard keys is confirmed ([0x30][0x01][0x00][code]); mouse
   actions were not decoded, so this is gated behind the experimental toggle. */
async function applyKey(index) {
  const action = state.keys[index];
  const keyCode = ACTION_KEYCODE[action];
  if (keyCode === undefined) return null;
  return sendCommand(CMD.KEY_ONE, [index, 0x30, 0x01, 0x00, keyCode], 6);
}

/* Only the keys whose scancode is known are encodable. */
const ACTION_KEYCODE = {
  "Enter": 0x1C, "Space": 0x39, "Copy": 0x2E, "Paste": 0x2F,
  "Cut": 0x2D, "Undo": 0x2C
};

async function resetLighting() {
  return sendCommand(CMD.LIGHT_RESET, [0x01], 1);
}

async function restoreFactory() {
  return sendCommand(CMD.FACTORY, [0x01, 0xFF], 1);
}

async function applyAll() {
  if (!hidDevice || !hidDevice.opened) return showToast("Connect the mouse first");
  setBusy(true);
  const send = await applyRate();
  await delay(40);
  await applyDpi();
  await delay(40);
  await applyDpiColors();
  await delay(40);
  await applyLighting();
  await delay(40);
  await applySensor();
  await delay(40);
  await applyPower();
  setBusy(false);
  saveState();
  showToast(send ? "Configuration written" : "Device did not answer");
}

function setBusy(busy) {
  document.body.classList.toggle("busy", busy);
}

/* ------------------------------------------------------------------ connect */

async function connect() {
  if (!navigator.hid) return showToast("WebHID unavailable — use Chrome or Edge");
  try {
    const devices = await navigator.hid.requestDevice({ filters: FILTERS });
    if (!devices.length) return;
    await attach(devices[0], true);
  } catch (err) {
    showToast("Pairing cancelled");
  }
}

async function attach(device, announce) {
  hidDevice = device;
  if (!hidDevice.opened) await hidDevice.open();
  hidDevice.oninputreport = (event) => {
    const data = new Uint8Array(event.data.buffer);
    if (pending) pending(data);
  };
  updateHud();
  if (announce) showToast("Connected to TK-GM012");
}

async function autoConnect() {
  if (!navigator.hid) return;
  try {
    const paired = await navigator.hid.getDevices();
    const match = paired.find((d) =>
      FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
    if (match) await attach(match, false);
  } catch (err) {
    /* ignore */
  }
}

function updateHud() {
  const online = !!(hidDevice && hidDevice.opened);
  const dot = $("hud-dot");
  const status = $("hud-status");
  const mode = $("hud-mode");
  if (dot) dot.classList.toggle("online", online);
  if (status) status.textContent = online ? "ONLINE" : "STANDBY";
  if (mode) {
    if (!online || !hidDevice) mode.textContent = "NONE";
    else mode.textContent = hidDevice.vendorId === 0x249A ? "2.4G WIRELESS" : "USB WIRED";
  }
  const bat = $("hud-battery-text");
  if (bat) bat.textContent = online ? "N/A" : "--%";
}

/* ---------------------------------------------------------------------- UI */

function showToast(message) {
  const container = $("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
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
  for (let i = 0; i < 6; i++) {
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
    };
  });
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

function buildLightCards() {
  const grid = $("lighting-grid");
  if (!grid) return;
  grid.innerHTML = LIGHT_MODES.map((mode) => `
    <button class="light-card${mode.id === state.lightMode ? " active" : ""}"
            data-mode="${mode.id}" type="button">
      <span class="light-preview ${mode.id}"></span>
      <span class="light-name">${mode.label}</span>
      <span class="light-desc">${mode.desc}</span>
    </button>`).join("");

  grid.querySelectorAll(".light-card").forEach((card) => {
    card.onclick = () => {
      state.lightMode = card.dataset.mode;
      buildLightCards();
      previewLighting();
      saveState();
    };
  });
}

function previewLighting() {
  const led = $("live-led");
  if (!led) return;
  const preset = LIGHT_MODES.find((m) => m.id === state.lightMode) || LIGHT_MODES[0];
  led.className = "dpi-slit-led " + preset.id;
  if (preset.shape === 2 || preset.shape === 3) {
    led.style.backgroundColor = state.lightMode === "off" ? "transparent" : state.lightColor;
  } else {
    led.style.backgroundColor = state.lightColor;
  }
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
  buildLightCards();
  previewLighting();
  buildMacroList();
  buildProfiles();

  const rate = document.querySelector(`#rate-control .seg-btn[data-rate="${state.rate}"]`);
  document.querySelectorAll("#rate-control .seg-btn").forEach((b) => b.classList.remove("active"));
  if (rate) rate.classList.add("active");

  const sleep = $("sel-sleep");
  if (sleep) sleep.value = String(state.sleep);
  const wake = $("chk-wake");
  if (wake) wake.checked = state.moveWake;
  const close = $("chk-closelight");
  if (close) close.checked = state.closeLight;
  const bright = $("rng-brightness");
  if (bright) { bright.value = state.brightness; $("lbl-brightness").textContent = state.brightness; }
  const speed = $("rng-speed");
  if (speed) { speed.value = state.speed; $("lbl-speed").textContent = state.speed; }
  const color = $("inp-light-color");
  if (color) color.value = state.lightColor;
  const lod = document.querySelector(`#lod-control .seg-btn[data-lod="${state.lod}"]`);
  if (lod) {
    document.querySelectorAll("#lod-control .seg-btn").forEach((b) => b.classList.remove("active"));
    lod.classList.add("active");
  }
  const sensorA = $("chk-sensor-a");
  if (sensorA) sensorA.checked = state.sensorA;
  const sensorB = $("chk-sensor-b");
  if (sensorB) sensorB.checked = state.sensorB;
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
  showToast("Recording — press keys, click STOP to finish");
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
  autoConnect();

  navigator.hid?.addEventListener("connect", autoConnect);
  navigator.hid?.addEventListener("disconnect", () => {
    hidDevice = null;
    updateHud();
    showToast("Device disconnected");
  });

  $("btn-connect")?.addEventListener("click", () => {
    if (hidDevice && hidDevice.opened) applyAll();
    else connect();
  });

  $("btn-sync")?.addEventListener("click", () => {
    refreshUI();
    showToast("Loaded saved profile");
  });

  $("btn-reset-keys")?.addEventListener("click", () => {
    state.keys = structuredClone(DEFAULTS.keys);
    buildKeySelects();
    saveState();
    showToast("Keys reset to defaults");
  });

  $("btn-reset-light")?.addEventListener("click", async () => {
    const res = await resetLighting();
    showToast(res ? "Lighting reset" : "No response");
  });

  $("btn-factory")?.addEventListener("click", async () => {
    if (!confirm("Restore the mouse to factory defaults?")) return;
    const res = await restoreFactory();
    state = structuredClone(DEFAULTS);
    refreshUI();
    saveState();
    showToast(res ? "Factory defaults restored" : "No response");
  });

  document.querySelectorAll("#rate-control .seg-btn").forEach((btn) => {
    btn.onclick = async () => {
      state.rate = Number(btn.dataset.rate);
      document.querySelectorAll("#rate-control .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      saveState();
      const res = await applyRate();
      showToast(res ? `${state.rate} Hz applied` : "Saved (device not answering)");
    };
  });

  document.querySelectorAll("#lod-control .seg-btn").forEach((btn) => {
    btn.onclick = async () => {
      state.lod = Number(btn.dataset.lod);
      document.querySelectorAll("#lod-control .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      saveState();
      await applySensor();
    };
  });

  $("rng-dpi")?.addEventListener("input", (e) => {
    state.dpi[selectedStage].value = Number(e.target.value);
    $("lbl-dpi").textContent = e.target.value;
    buildDpiCards();
  });
  $("rng-dpi")?.addEventListener("change", () => { saveState(); applyDpi(); });

  $("inp-dpi-color")?.addEventListener("input", (e) => {
    state.dpi[selectedStage].color = e.target.value;
    buildDpiCards();
  });

  $("sel-dpi-count")?.addEventListener("change", (e) => {
    state.dpiCount = Number(e.target.value);
    saveState();
  });

  $("rng-brightness")?.addEventListener("input", (e) => {
    state.brightness = Number(e.target.value);
    $("lbl-brightness").textContent = e.target.value;
  });
  $("rng-brightness")?.addEventListener("change", () => { saveState(); applyLighting(); });

  $("rng-speed")?.addEventListener("input", (e) => {
    state.speed = Number(e.target.value);
    $("lbl-speed").textContent = e.target.value;
  });
  $("rng-speed")?.addEventListener("change", () => { saveState(); applyLighting(); });

  $("inp-light-color")?.addEventListener("input", (e) => {
    state.lightColor = e.target.value;
    previewLighting();
  });
  $("inp-light-color")?.addEventListener("change", () => { saveState(); applyLighting(); });

  $("sel-sleep")?.addEventListener("change", (e) => {
    state.sleep = Number(e.target.value);
    saveState();
    applyPower();
  });

  $("chk-wake")?.addEventListener("change", (e) => {
    state.moveWake = e.target.checked;
    saveState();
    applyPower();
  });

  $("chk-closelight")?.addEventListener("change", (e) => {
    state.closeLight = e.target.checked;
    saveState();
    applyPower();
  });

  $("chk-sensor-a")?.addEventListener("change", (e) => {
    state.sensorA = e.target.checked;
    saveState();
    applySensor();
  });

  $("chk-sensor-b")?.addEventListener("change", (e) => {
    state.sensorB = e.target.checked;
    saveState();
    applySensor();
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
    for (let i = 0; i < 6; i++) {
      await applyKey(i);
      await delay(40);
    }
    showToast("Key writes sent (experimental)");
  });

  window.addEventListener("keydown", macroKeyHook);
  window.addEventListener("keyup", macroKeyHook);
});

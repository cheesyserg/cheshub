// ============================================
// TOZO HT3 Control Panel - Driver Logic
// ============================================

// --- Constants & Commands ---
const FREQ_LABELS = ["20Hz", "50Hz", "100Hz", "200Hz", "400Hz", "800Hz", "1.6k", "3.2k", "6.4k", "12.8k"];
const FREQ_CONSTS = [0x05, 0x06, 0x07, 0x08, 0x0A, 0x0C, 0x0E, 0x10, 0x12, 0x14];

const ANC_MODES = [
  { name: "Normal Mode",       live: "1004010000", persist: "1012010000" },
  { name: "Noise Cancelling",  live: "1004010101", persist: "1012010101" },
  { name: "Transparency",      live: "1005010101", persist: "1012010202" },
  { name: "Reduce Wind Noise", live: "1007010101", persist: "1012010303" },
  { name: "Leisure Mode",      live: "1008010101", persist: "1012010404" },
  { name: "Adaptive Mode",     live: "1011010101", persist: "1012010606" }
];

const BUILTIN_PRESETS = [
  { name: "Custom / Flat",  vals: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass Boost",     vals: [30, 25, 15, 5, 0, 0, 0, 5, 10, 15] },
  { name: "Dance",          vals: [25, 20, 10, 0, 5, 15, 20, 20, 15, 10] },
  { name: "Rock / Pop",     vals: [20, 15, 0, -10, -5, 10, 20, 25, 20, 15] },
  { name: "Vocal Clarity",  vals: [-10, -5, 0, 10, 20, 20, 10, 0, -5, -10] }
];

// --- State Variables ---
let port = null, reader = null, writer = null;
let readLoopPromise = null;
let isDisconnecting = false;
let customPresets = JSON.parse(localStorage.getItem('tozo_custom_presets') || '{}');
let activeCustomPreset = "";
let sliders = [], gainLabels = [];

// --- Toast & HUD Helpers ---
const toast = (msg) => {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.innerText = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 2200);
};

const setHud = (status, battery, mode) => {
  const dot = document.getElementById("hud-dot");
  const lbl = document.getElementById("hud-status");
  const bat = document.getElementById("hud-battery-text");
  const bar = document.getElementById("hud-battery-bar");
  const md = document.getElementById("hud-mode");

  if (status) {
    const online = status === "ONLINE";
    if (online) { dot.className = "status-dot active"; lbl.innerText = "ONLINE"; lbl.style.color = "#00ff55"; }
    else { dot.className = "status-dot"; lbl.innerText = status; lbl.style.color = ""; }
  }
  if (battery !== undefined && battery !== null) { bat.innerText = `${battery}%`; bar.style.width = `${battery}%`; }
  if (mode) { md.innerText = mode; }
};

const setStatus = (msg) => {
  const el = document.getElementById("statusLbl");
  if (el) el.textContent = msg;
};

// --- Connection Management ---
async function connectOrApply() {
  if (port) {
    await disconnect();
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    isDisconnecting = false;

    setHud("ONLINE", 100, "BLUETOOTH SERIAL");
    setStatus("Status: Connected.");
    const btn = document.getElementById("btn-connect");
    if (btn) btn.textContent = "DISCONNECT";

    setControlsEnabled(true);
    toast("Connected to TOZO HT3");
    readLoopPromise = readLoop();
    setTimeout(() => requestMasterState(), 500);
  } catch (err) {
    setHud("ERROR", 0, "BLUETOOTH SERIAL");
    setStatus("Status: Connection Failed.");
    toast("Connection failed: " + err.message);
  }
}

async function disconnect() {
  if (isDisconnecting) return;
  isDisconnecting = true;

  if (reader) {
    try {
      await reader.cancel();
    } catch (e) {}
  }

  if (readLoopPromise) {
    try {
      await readLoopPromise;
    } catch (e) {}
    readLoopPromise = null;
  }

  if (writer) {
    try {
      writer.releaseLock();
    } catch (e) {}
    writer = null;
  }

  if (port) {
    try {
      await port.close();
    } catch (e) {}
    port = null;
  }

  isDisconnecting = false;

  setHud("STANDBY", 0, "BLUETOOTH LE");
  setStatus("Status: Disconnected.");

  const batteryLbl = document.getElementById("batteryLbl");
  if (batteryLbl) batteryLbl.textContent = "Battery: --%";

  const btn = document.getElementById("btn-connect");
  if (btn) btn.textContent = "CONNECT VIA BLUETOOTH";

  setControlsEnabled(false);
  toast("Disconnected");
}

async function sendHex(hexStr) {
  if (!writer) return;
  const bytes = new Uint8Array(hexStr.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  await writer.write(bytes);
}

async function readLoop() {
  while (port && port.readable && !isDisconnecting) {
    reader = port.readable.getReader();
    let accumulated = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += Array.from(value).map(b => b.toString(16).padStart(2, '0')).join('');
        accumulated = handleIncomingHex(accumulated);
      }
    } catch (e) {
      break;
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {}
      reader = null;
    }
  }
}

function handleIncomingHex(hex) {
  // 1. Battery: 000201[bat][chk]
  const bIdx = hex.lastIndexOf("000201");
  if (bIdx !== -1 && hex.length >= bIdx + 8) {
    const bat = parseInt(hex.substr(bIdx + 6, 2), 16);
    if (!isNaN(bat)) {
      setHud(null, bat);
      const batteryLbl = document.getElementById("batteryLbl");
      if (batteryLbl) batteryLbl.textContent = `Battery: ${bat}%`;
    }
  }

  // 2. ANC Mode: Match persistent query (001201), live query (003001), or push button changes
  const map = { "00": 0, "01": 1, "02": 2, "03": 3, "04": 4, "06": 5 };
  const memIdx = hex.lastIndexOf("001201");
  const liveIdx = hex.lastIndexOf("003001");
  const latestAncIdx = Math.max(memIdx, liveIdx);

  let detectedMode = -1;
  if (latestAncIdx !== -1 && hex.length >= latestAncIdx + 8) {
    const mode = hex.substr(latestAncIdx + 6, 2);
    if (map[mode] !== undefined) {
      detectedMode = map[mode];
    }
  }

  const buttonEvents = [
    { code: "00040100", val: 0 },
    { code: "00040101", val: 1 },
    { code: "00050101", val: 2 },
    { code: "00070101", val: 3 },
    { code: "00080101", val: 4 },
    { code: "00110101", val: 5 }
  ];

  let maxButtonIdx = -1;
  let buttonMode = -1;
  for (const be of buttonEvents) {
    const idx = hex.lastIndexOf(be.code);
    if (idx !== -1 && idx > maxButtonIdx && hex.length >= idx + 8) {
      maxButtonIdx = idx;
      buttonMode = be.val;
    }
  }

  if (maxButtonIdx > latestAncIdx) {
    detectedMode = buttonMode;
  }

  if (detectedMode !== -1) {
    const ancSelect = document.getElementById("ancSelect");
    if (ancSelect) ancSelect.value = detectedMode;
  }

  // 3. Low Latency: 000601[val][chk]
  const lIdx = hex.lastIndexOf("000601");
  if (lIdx !== -1 && hex.length >= lIdx + 8) {
    const latencyChk = document.getElementById("latencyChk");
    if (latencyChk) latencyChk.checked = hex.substr(lIdx + 6, 2) === "01";
  }

  // 4. Spatial Audio: 001301[val][chk]
  const sIdx = hex.lastIndexOf("001301");
  if (sIdx !== -1 && hex.length >= sIdx + 8) {
    const spatial = hex.substr(sIdx + 6, 2) === "01";
    const spatialChk = document.getElementById("spatialChk");
    if (spatialChk) spatialChk.checked = spatial;
    toggleEqUiLock(spatial);
  }

  // 5. EQ Telemetry: 000b14 + 10 gains
  const eqIdx = hex.lastIndexOf("000b14");
  if (eqIdx !== -1 && hex.length >= eqIdx + 26) {
    const gains = [];
    for (let i = 0; i < 10; i++) {
      let b = parseInt(hex.substr(eqIdx + 6 + i * 2, 2), 16);
      gains.push(b > 127 ? b - 256 : b);
    }
    setEqValues(gains, false);
    checkExactMatchPreset();
  }

  return hex.length > 256 ? hex.slice(-128) : hex;
}

async function requestMasterState() {
  const cmds = ["00020000", "000b0000", "00060000", "00120000", "00300000", "00130000"];
  for (const cmd of cmds) {
    await sendHex(cmd);
    await new Promise(res => setTimeout(res, 80));
  }
}

// --- EQ & Payload Construction ---
function generatePayload() {
  const bytes = [0x10, 0x0B, 0x15];
  let sum = 0;

  for (let s of sliders) {
    let v = parseInt(s.value);
    let b = v < 0 ? 256 + v : v;
    bytes.push(b);
    sum += b;
  }

  for (let i = 0; i < 10; i++) {
    bytes.push(FREQ_CONSTS[i]);
    sum += FREQ_CONSTS[i];
  }

  bytes.push(0x01);
  sum += 0x01;
  bytes.push(sum & 0xFF);

  return new Uint8Array(bytes);
}

function pushEqRam() {
  if (writer) writer.write(generatePayload());
}

function setEqValues(vals, syncHw = false) {
  for (let i = 0; i < 10 && i < vals.length; i++) {
    if (sliders[i]) {
      sliders[i].value = vals[i];
      if (gainLabels[i]) gainLabels[i].textContent = (vals[i] / 10).toFixed(1) + " dB";
    }
  }
  if (syncHw) pushEqRam();
}

// --- Preset Management ---
function refreshPresetDropdown(selectKey = "") {
  const dropdown = document.getElementById("presetSelect");
  if (!dropdown) return;
  dropdown.innerHTML = "";

  BUILTIN_PRESETS.forEach((p, idx) => {
    const opt = new Option(p.name, `builtin:${idx}`);
    dropdown.add(opt);
  });

  Object.keys(customPresets).forEach(name => {
    const opt = new Option(`${name} (Custom)`, `custom:${name}`);
    dropdown.add(opt);
  });

  if (selectKey) dropdown.value = selectKey;
  onPresetChanged();
}

function onPresetChanged() {
  const dropdown = document.getElementById("presetSelect");
  if (!dropdown) return;
  const val = dropdown.value;

  if (val.startsWith("builtin:")) {
    const idx = parseInt(val.split(":")[1]);
    activeCustomPreset = "";
    setEqValues(BUILTIN_PRESETS[idx].vals, true);
    updatePresetButtons(false);
  } else if (val.startsWith("custom:")) {
    const name = val.split(":")[1];
    activeCustomPreset = name;
    setEqValues(customPresets[name], true);
    updatePresetButtons(true);
  }
}

function checkExactMatchPreset() {
  if (sliders.length === 0) return;
  const cur = sliders.map(s => parseInt(s.value));
  const dropdown = document.getElementById("presetSelect");
  if (!dropdown) return;

  for (let i = 0; i < BUILTIN_PRESETS.length; i++) {
    if (JSON.stringify(BUILTIN_PRESETS[i].vals) === JSON.stringify(cur)) {
      dropdown.value = `builtin:${i}`;
      activeCustomPreset = "";
      updatePresetButtons(false);
      return;
    }
  }

  for (let name in customPresets) {
    if (JSON.stringify(customPresets[name]) === JSON.stringify(cur)) {
      dropdown.value = `custom:${name}`;
      activeCustomPreset = name;
      updatePresetButtons(true);
      return;
    }
  }
  updatePresetButtons(Boolean(activeCustomPreset));
}

function updatePresetButtons(isCustom) {
  const saveBtn = document.getElementById("btnSavePreset");
  const delBtn = document.getElementById("btnDelPreset");
  if (saveBtn) saveBtn.disabled = !isCustom;
  if (delBtn) delBtn.disabled = !isCustom;
}

function setControlsEnabled(enabled) {
  const modesCard = document.getElementById("modesCard");
  const eqCard = document.getElementById("eqCard");

  if (modesCard) {
    modesCard.style.pointerEvents = enabled ? "auto" : "none";
    modesCard.style.opacity = enabled ? "1" : "0.5";
  }
  if (eqCard) {
    eqCard.style.pointerEvents = enabled ? "auto" : "none";
    eqCard.style.opacity = enabled ? "1" : "0.5";
  }
}

function toggleEqUiLock(isSpatial) {
  const eqCard = document.getElementById("eqCard");
  if (eqCard) {
    eqCard.style.pointerEvents = !isSpatial && port ? "auto" : "none";
    eqCard.style.opacity = !isSpatial && port ? "1" : "0.5";
  }
}

// --- UI Initialization ---
function initSliders() {
  const slidersContainer = document.getElementById("slidersContainer");
  if (!slidersContainer) return;

  slidersContainer.innerHTML = "";
  sliders = [];
  gainLabels = [];

  for (let i = 0; i < 10; i++) {
    const col = document.createElement("div");
    col.className = "slider-col";

    const lbl = document.createElement("span");
    lbl.className = "slider-freq";
    lbl.textContent = FREQ_LABELS[i];

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = -50;
    slider.max = 50;
    slider.value = 0;

    const valLbl = document.createElement("span");
    valLbl.className = "slider-val";
    valLbl.textContent = "0.0 dB";

    slider.addEventListener("input", () => {
      valLbl.textContent = (slider.value / 10).toFixed(1) + " dB";
      pushEqRam();
      checkExactMatchPreset();
    });

    col.appendChild(lbl);
    col.appendChild(slider);
    col.appendChild(valLbl);
    slidersContainer.appendChild(col);

    sliders.push(slider);
    gainLabels.push(valLbl);
  }
}

// --- Event Handlers ---
async function setAncMode(mode) {
  const idx = { "OFF": 0, "ANC": 1, "TRANSPARENT": 2, "WIND": 3, "LEISURE": 4, "ADAPTIVE": 5 }[mode];
  if (idx === undefined) return;

  const ancSelect = document.getElementById("ancSelect");
  if (ancSelect) ancSelect.value = idx;

  const cmds = ANC_MODES[idx];
  if (cmds) {
    await sendHex(cmds.live);
    const rememberChk = document.getElementById("rememberChk");
    if (rememberChk && rememberChk.checked) {
      await new Promise(r => setTimeout(r, 50));
      await sendHex(cmds.persist);
    }
  }

  toast(`ANC: ${ANC_MODES[idx].name}`);
}

function syncHardwareState() {
  if (!port) { toast("Not connected"); return; }
  requestMasterState();
  toast("Telemetry synchronized");
}

// --- DOM Ready ---
window.addEventListener("DOMContentLoaded", async () => {
  initSliders();
  refreshPresetDropdown();
  setControlsEnabled(false);

  // Auto-connect if device is available
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length > 0) {
      port = ports[0];
      await port.open({ baudRate: 115200 });
      writer = port.writable.getWriter();
      isDisconnecting = false;

      setHud("ONLINE", 100, "BLUETOOTH SERIAL");
      setStatus("Status: Connected.");
      const btn = document.getElementById("btn-connect");
      if (btn) btn.textContent = "DISCONNECT";

      setControlsEnabled(true);
      toast("Auto-connected to TOZO HT3");
      readLoopPromise = readLoop();
      requestMasterState();
    }
  } catch (err) {
    console.log("No device to auto-connect:", err);
  }

  // Connect/Disconnect button
  const connectBtn = document.getElementById("btn-connect");
  if (connectBtn) connectBtn.onclick = connectOrApply;

  // Sync button
  const syncBtn = document.getElementById("btn-sync");
  if (syncBtn) syncBtn.onclick = syncHardwareState;

  // ANC selector
  const ancSelect = document.getElementById("ancSelect");
  if (ancSelect) {
    ancSelect.onchange = async (e) => {
      const mode = ANC_MODES[e.target.value];
      if (mode) {
        await sendHex(mode.live);
        const rememberChk = document.getElementById("rememberChk");
        if (rememberChk && rememberChk.checked) {
          await new Promise(r => setTimeout(r, 50));
          await sendHex(mode.persist);
        }
      }
    };
  }

  // Spatial Audio
  const spatialChk = document.getElementById("spatialChk");
  if (spatialChk) {
    spatialChk.onchange = (e) => {
      sendHex(e.target.checked ? "1013010101" : "1013010000");
      toggleEqUiLock(e.target.checked);
      if (!e.target.checked) setTimeout(() => sendHex("000b0000"), 200);
    };
  }

  // Low Latency
  const latencyChk = document.getElementById("latencyChk");
  if (latencyChk) {
    latencyChk.onchange = (e) => {
      sendHex(e.target.checked ? "1006010101" : "1006010000");
    };
  }

  // Preset selector
  const presetSelect = document.getElementById("presetSelect");
  if (presetSelect) presetSelect.onchange = onPresetChanged;

  // Reset Flat
  const btnReset = document.getElementById("btnReset");
  if (btnReset) {
    btnReset.onclick = () => {
      setEqValues(BUILTIN_PRESETS[0].vals, true);
      checkExactMatchPreset();
      toast("EQ reset to flat");
    };
  }

  // Commit
  const btnCommit = document.getElementById("btnCommit");
  if (btnCommit) {
    btnCommit.onclick = () => {
      pushEqRam();
      const ancSelect = document.getElementById("ancSelect");
      if (ancSelect) ancSelect.dispatchEvent(new Event("change"));
      toast("Settings committed to device");
    };
  }

  // Add Preset
  const btnAddPreset = document.getElementById("btnAddPreset");
  if (btnAddPreset) {
    btnAddPreset.onclick = () => {
      const name = prompt("Enter Preset Name:");
      if (name && name.trim()) {
        customPresets[name.trim()] = sliders.map(s => parseInt(s.value));
        localStorage.setItem('tozo_custom_presets', JSON.stringify(customPresets));
        refreshPresetDropdown(`custom:${name.trim()}`);
        toast(`Preset '${name.trim()}' added`);
      }
    };
  }

  // Save Preset
  const btnSavePreset = document.getElementById("btnSavePreset");
  if (btnSavePreset) {
    btnSavePreset.onclick = () => {
      if (activeCustomPreset) {
        customPresets[activeCustomPreset] = sliders.map(s => parseInt(s.value));
        localStorage.setItem('tozo_custom_presets', JSON.stringify(customPresets));
        toast(`Preset '${activeCustomPreset}' updated`);
      }
    };
  }

  // Delete Preset
  const btnDelPreset = document.getElementById("btnDelPreset");
  if (btnDelPreset) {
    btnDelPreset.onclick = () => {
      if (activeCustomPreset && confirm(`Delete preset '${activeCustomPreset}'?`)) {
        delete customPresets[activeCustomPreset];
        localStorage.setItem('tozo_custom_presets', JSON.stringify(customPresets));
        activeCustomPreset = "";
        refreshPresetDropdown("builtin:0");
        toast("Preset deleted");
      }
    };
  }
});

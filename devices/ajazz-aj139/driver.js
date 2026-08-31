const TARGET_FILTERS = [
  { vendorId: 0xA8A4, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 },
  { vendorId: 0xA8A5, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 }
];

const KEY_BINDINGS = {
  "Left Click": [32, 1, 0, 0], "Right Click": [32, 2, 0, 0], "Middle Click": [32, 4, 0, 0],
  "Backward": [32, 8, 0, 0], "Forward": [32, 16, 0, 0], "DPI Loop": [33, 85, 0, 0],
  "Scroll Up": [33, 56, 1, 0], "Scroll Down": [33, 56, 255, 0], "Volume Up": [48, 233, 0, 0],
  "Volume Down": [48, 234, 0, 0], "Mute": [48, 226, 0, 0], "Play / Pause": [48, 205, 0, 0],
  "Next Track": [48, 181, 0, 0], "Prev Track": [48, 182, 0, 0], "Copy (Ctrl+C)": [16, 1, 6, 0],
  "Paste (Ctrl+V)": [16, 1, 25, 0], "Cut (Ctrl+X)": [16, 1, 27, 0], "Undo (Ctrl+Z)": [16, 1, 29, 0],
  "Enter": [16, 0, 40, 0], "Space": [16, 0, 44, 0], "Disabled": [32, 0, 0, 0]
};

const DPI_STAGE_COLORS = [
  { name: "Vivid Red", hex: "#ff0033" }, { name: "Neon Green", hex: "#00ff55" },
  { name: "Electric Blue", hex: "#0055ff" }, { name: "Pure Cyan", hex: "#00f0ff" },
  { name: "Vivid Amber", hex: "#ff7700" }, { name: "Neon Magenta", hex: "#ee00ff" }
];

const STREAMER_MODES = [
  { label: "WAVE STREAMER", desc: "Reverse rainbow wave", val: 0, class: "glow-wave", preview: "linear-gradient(90deg, #ff0044, #cc00ff, #0055ff, #00ff55, #ffaa00)" },
  { label: "NEON SPECTRUM", desc: "Synchronized cycle", val: 1, class: "glow-neon", preview: "linear-gradient(90deg, #ff0033, #ffee00, #00ff55, #0088ff, #ee00ff)" },
  { label: "TOURING CHASER", desc: "Fast Christmas chaser", val: 2, class: "glow-chaser", preview: "repeating-linear-gradient(90deg, #ff0044 0px, #ff0044 14px, transparent 14px, transparent 24px, #00ff55 24px, #00ff55 38px)" },
  { label: "YO-YO SWIPE", desc: "Rapid color wipe cycle", val: 3, class: "glow-yoyo", preview: "linear-gradient(90deg, #00f0ff, transparent)" },
  { label: "DIRECTIONAL FLOW", desc: "4-LED sequential cascade", val: 4, class: "glow-flow", preview: "linear-gradient(90deg, #ff0044, #00f0ff, #ffee00)" },
  { label: "COLOR BREATHING", desc: "Relaxed 28s breath cycle", val: 5, class: "glow-breathing", preview: "linear-gradient(90deg, #ff0044, #00f0ff)" },
  { label: "TURN OFF STRIP", desc: "Disable side lighting", val: 6, class: "glow-off", preview: "#1f2731" }
];

let hidDevice = null;
let activeStreamerMode = 6;
let currentDpis = [800, 1600, 2400, 3200, 5000, 12000];
let activeDpiIndex = 1;
let activePolling = 1000;
let activeLOD = 1;

let pendingRequest = null;
let isBusBusy = false;
let autoSyncInterval = null;

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerText = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2200);
}

function setShellColor(fileName) {
  const img = document.getElementById("mouse-img");
  if (img) img.src = fileName;
  const swatchBlack = document.getElementById("swatch-black");
  const swatchWhite = document.getElementById("swatch-white");
  if (swatchBlack) swatchBlack.classList.toggle("active", fileName.includes("black"));
  if (swatchWhite) swatchWhite.classList.toggle("active", fileName.includes("white"));
  localStorage.setItem("cheshub_mouse_shell", fileName);
}

function updateDpiLedGlow(stageIndex) {
  activeDpiIndex = stageIndex;
  const col = DPI_STAGE_COLORS[stageIndex]?.hex || "#00ff55";
  document.documentElement.style.setProperty('--dpi-glow', col);
  document.querySelectorAll(".stage-radio").forEach((r, idx) => r.checked = (idx === stageIndex));
}

function handleLightingModeChange(modeVal) {
  activeStreamerMode = parseInt(modeVal);
  const item = STREAMER_MODES.find(m => m.val === activeStreamerMode) || STREAMER_MODES[6];
  const left = document.getElementById("glow-left");
  const right = document.getElementById("glow-right");
  if (left) left.className = `side-diffuser left ${item.class}`;
  if (right) right.className = `side-diffuser right ${item.class}`;
  
  document.querySelectorAll(".rgb-card").forEach((card, idx) => {
    card.classList.toggle("active", STREAMER_MODES[idx].val === activeStreamerMode);
  });
}

function setPolling(rate) {
  activePolling = rate;
  document.querySelectorAll("#poll-control .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.innerText.includes(rate.toString()));
  });
}

function setLOD(lod) {
  activeLOD = lod;
  document.querySelectorAll("#lod-control .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.innerText.startsWith(lod.toString()));
  });
}

function updateTelemetryHUD(connected, batteryPct = null, charging = false, mode = "NONE") {
  const dot = document.getElementById("hud-dot");
  const statusText = document.getElementById("hud-status");
  const batText = document.getElementById("hud-battery-text");
  const batBar = document.getElementById("hud-battery-bar");
  const modeText = document.getElementById("hud-mode");

  if (!dot) return;

  if (connected) {
    dot.className = "status-dot active";
    statusText.innerText = "ONLINE";
    statusText.style.color = "#00ff55";
    modeText.innerText = mode.toUpperCase();
    modeText.style.color = "#fff";

    if (batteryPct !== null) {
      batText.innerText = `${batteryPct}% ${charging ? "⚡" : ""}`;
      batBar.style.width = `${Math.min(100, Math.max(0, batteryPct))}%`;
      batBar.style.background = batteryPct > 20 ? "#00ff55" : "#ff4655";
    }
  } else {
    dot.className = "status-dot";
    statusText.innerText = "STANDBY";
    statusText.style.color = "var(--riot-gray)";
    batText.innerText = "--%";
    batBar.style.width = "0%";
    modeText.innerText = "NONE";
    modeText.style.color = "var(--riot-gray)";
  }
}

function initUI() {
  setShellColor(localStorage.getItem("cheshub_mouse_shell") || "black.png");

  const grid = document.getElementById("lighting-grid");
  if (grid) {
    grid.innerHTML = "";
    STREAMER_MODES.forEach(m => {
      grid.innerHTML += `
        <div class="rgb-card ${m.val === activeStreamerMode ? "active" : ""}" onclick="testStreamerMode(${m.val})">
          <div class="rgb-preview" style="background: ${m.preview};"></div>
          <div>
            <div class="rgb-name">${m.label}</div>
            <div class="rgb-desc">${m.desc}</div>
          </div>
        </div>
      `;
    });
  }

  const dpiContainer = document.getElementById("dpi-stage-rows");
  if (dpiContainer) {
    dpiContainer.innerHTML = "";
    for (let i = 0; i < 6; i++) {
      const col = DPI_STAGE_COLORS[i];
      dpiContainer.innerHTML += `
        <div class="form-row">
          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; width:130px;">
            <input type="radio" name="dpi_active" class="stage-radio" ${i === activeDpiIndex ? "checked" : ""} onchange="activeDpiIndex = ${i}; updateDpiLedGlow(${i}); writeFullConfig();">
            <span style="display:inline-block; width:14px; height:14px; border-radius:50%; background:${col.hex}; box-shadow:0 0 8px ${col.hex};"></span>
            <span style="font-size:14px; font-weight:700;">Stage ${i + 1}</span>
          </label>
          <div class="slider-wrap">
            <input type="range" id="dpi-rng-${i}" min="50" max="12000" step="50" value="${currentDpis[i]}"
                   oninput="currentDpis[${i}] = parseInt(this.value); document.getElementById('dpi-lbl-${i}').innerText = this.value + ' DPI'; debouncedWrite();">
            <span class="val-badge" id="dpi-lbl-${i}">${currentDpis[i]} DPI</span>
          </div>
        </div>
      `;
    }
  }

  const optionsHtml = Object.keys(KEY_BINDINGS).map(k => `<option value="${k}">${k}</option>`).join("");
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById(`btn-select-${i}`);
    if (el) el.innerHTML = optionsHtml;
  }
  
  if(document.getElementById("btn-select-0")) document.getElementById("btn-select-0").value = "Left Click";
  if(document.getElementById("btn-select-1")) document.getElementById("btn-select-1").value = "Right Click";
  if(document.getElementById("btn-select-2")) document.getElementById("btn-select-2").value = "Middle Click";
  if(document.getElementById("btn-select-3")) document.getElementById("btn-select-3").value = "Backward";
  if(document.getElementById("btn-select-4")) document.getElementById("btn-select-4").value = "Forward";
  if(document.getElementById("btn-select-5")) document.getElementById("btn-select-5").value = "DPI Loop";

  updateDpiLedGlow(activeDpiIndex);
  handleLightingModeChange(activeStreamerMode);
}

function transact(sendPkt, matchFn, timeoutMs = 250) {
  return new Promise(async (resolve) => {
    if (!hidDevice || !hidDevice.opened) return resolve(null);
    let timer = null;
    
    const complete = (data) => {
      clearTimeout(timer);
      pendingRequest = null;
      resolve(data);
    };

    pendingRequest = { matchFn, resolve: complete };

    timer = setTimeout(() => {
      if (pendingRequest) complete(null);
    }, timeoutMs);

    try { await hidDevice.sendReport(0, new Uint8Array(sendPkt.slice(1))); } 
    catch (e) { complete(null); }
  });
}

async function pollHardwareLightState() {
  if (!hidDevice || !hidDevice.opened || isBusBusy) return;
  isBusBusy = true;
  try {
    const cfgPacket = new Array(65).fill(0);
    cfgPacket[1] = 0x55; cfgPacket[2] = 0x0E; cfgPacket[3] = 0xA5; cfgPacket[4] = 0x0B; cfgPacket[5] = 0x30;
    cfgPacket[6] = 0x01; cfgPacket[7] = 0x01; cfgPacket[8] = 0x01;
    const cfgRes = await transact(cfgPacket, d => d[0] === 0xAA && d[1] === 0x0E, 200);
    if (cfgRes && cfgRes.length >= 55) {
      const hwMode = (cfgRes[9] >= 0 && cfgRes[9] <= 6) ? cfgRes[9] : 6;
      if (hwMode !== activeStreamerMode) {
        handleLightingModeChange(hwMode);
      }
    }
  } finally {
    isBusBusy = false;
  }
}

function setupHardwareListener() {
  if (!hidDevice) return;
  hidDevice.oninputreport = (event) => {
    const data = new Uint8Array(event.data.buffer);
    
    if (pendingRequest && pendingRequest.matchFn(data)) {
      pendingRequest.resolve(data);
      return;
    }

    if (data.length < 20) return;

    if (data[0] === 0xAA) {
      if (data[1] === 0xFA && data[8] === 0x10) {
        const newDpiStage = data[9] - 1;
        const rateMap = { 0: 125, 1: 250, 2: 500, 3: 1000 };
        updateDpiLedGlow(newDpiStage);
        setPolling(rateMap[data[10] - 1] || 1000);
      }
      else if (data[1] === 0x30) {
        const isWireless = hidDevice.vendorId === 0xA8A5;
        updateTelemetryHUD(true, data[8], !!data[9], isWireless ? "2.4G Wireless" : "USB Wired");
      }
      else {
        pollHardwareLightState();
      }
    }
  };
}

// Auto-connect on startup if previously paired
async function tryAutoConnect() {
  if (!navigator.hid) return;
  try {
    const pairedDevices = await navigator.hid.getDevices();
    
    // Match VID, PID, AND the custom vendor usage/usagePage
    const match = pairedDevices.find(dev => 
      TARGET_FILTERS.some(f => 
        f.vendorId === dev.vendorId && 
        f.productId === dev.productId &&
        dev.collections.some(c => c.usagePage === f.usagePage && c.usage === f.usage)
      )
    );

    if (match) {
      hidDevice = match;
      if (!hidDevice.opened) await hidDevice.open();

      const isWireless = hidDevice.vendorId === 0xA8A5;
      updateTelemetryHUD(true, null, false, isWireless ? "2.4G Wireless" : "USB Wired");
      setupHardwareListener();
      await syncHardwareState();
      
      clearInterval(autoSyncInterval);
      autoSyncInterval = setInterval(pollHardwareLightState, 1200);

      showToast("Auto-connected to AJ139");
    }
  } catch (e) {
    console.warn("Auto-connect failed:", e);
  }
}

async function connectOrApply() {
  if (!hidDevice || !hidDevice.opened) {
    try {
      const devices = await navigator.hid.requestDevice({ filters: TARGET_FILTERS });
      if (devices.length === 0) return;
      hidDevice = devices[0];
      if (!hidDevice.opened) await hidDevice.open();

      const isWireless = hidDevice.vendorId === 0xA8A5;
      updateTelemetryHUD(true, null, false, isWireless ? "2.4G Wireless" : "USB Wired");
      setupHardwareListener();
      await syncHardwareState();
      
      clearInterval(autoSyncInterval);
      autoSyncInterval = setInterval(pollHardwareLightState, 1200);

      showToast("Connected to ChesHub Ecosystem");
    } catch (err) {
      showToast("Connection failed.");
    }
  } else {
    writeFullConfig();
  }
}

async function syncHardwareState() {
  if (!hidDevice || !hidDevice.opened || isBusBusy) return;
  isBusBusy = true;

  try {
    const cfgPacket = new Array(65).fill(0);
    cfgPacket[1] = 0x55; cfgPacket[2] = 0x0E; cfgPacket[3] = 0xA5; cfgPacket[4] = 0x0B; cfgPacket[5] = 0x30;
    cfgPacket[6] = 0x01; cfgPacket[7] = 0x01; cfgPacket[8] = 0x01;
    const cfgRes = await transact(cfgPacket, d => d[0] === 0xAA && d[1] === 0x0E);

    const keyPacket = new Array(65).fill(0);
    keyPacket[1] = 0x55; keyPacket[2] = 0x08; keyPacket[3] = 0xA5; keyPacket[4] = 0x0B; keyPacket[5] = 0x20;
    const keyRes = await transact(keyPacket, d => d[0] === 0xAA && d[1] === 0x08);

    const batPacket = new Array(65).fill(0);
    batPacket[1] = 0x55; batPacket[2] = 0x30; batPacket[3] = 0xA5; batPacket[4] = 0x0B; batPacket[5] = 0x2E;
    batPacket[6] = 0x01; batPacket[7] = 0x01; batPacket[8] = 0x01;
    const batRes = await transact(batPacket, d => d[0] === 0xAA && d[1] === 0x30);

    const fwPacket = new Array(65).fill(0);
    fwPacket[1] = 0x55; fwPacket[2] = 0x03;
    const fwRes = await transact(fwPacket, d => d.length >= 26);

    const fwTag = document.getElementById("header-fw");
    console.log(fwRes)
    if (fwRes && fwTag) fwTag.innerText = `FW: ${String.fromCharCode(fwRes[23])}.${String.fromCharCode(fwRes[24])}.${String.fromCharCode(fwRes[25])}`;
    
    const isWireless = hidDevice.vendorId === 0xA8A5;
    if (batRes) {
      updateTelemetryHUD(true, batRes[8], !!batRes[9], isWireless ? "2.4G Wireless" : "USB Wired");
    }

    if (cfgRes) {
      handleLightingModeChange((cfgRes[9] >= 0 && cfgRes[9] <= 6) ? cfgRes[9] : 6);
      setPolling({ 0: 125, 1: 250, 2: 500, 3: 1000 }[cfgRes[10] - 1] || 1000);
      updateDpiLedGlow(Math.max(0, cfgRes[12] - 1));

      for (let i = 0; i < 6; i++) {
        const dpi = cfgRes[13 + i * 2] | (cfgRes[14 + i * 2] << 8);
        if (dpi > 0) {
          currentDpis[i] = dpi;
          const rng = document.getElementById(`dpi-rng-${i}`);
          const lbl = document.getElementById(`dpi-lbl-${i}`);
          if (rng) rng.value = dpi;
          if (lbl) lbl.innerText = `${dpi} DPI`;
        }
      }

      const sensorFlag = cfgRes[50];
      const motionSync = document.getElementById("chk-motion-sync");
      const ripple = document.getElementById("chk-ripple");
      const linesnap = document.getElementById("chk-linesnap");
      const esports = document.getElementById("chk-esports");
      const debounce = document.getElementById("rng-debounce");
      const debounceLbl = document.getElementById("lbl-debounce");
      const sleep = document.getElementById("rng-sleep");
      const sleepLbl = document.getElementById("lbl-sleep");
      const invert = document.getElementById("chk-invert-scroll");
      const moveWake = document.getElementById("chk-move-wake");

      if (motionSync) motionSync.checked = !!(sensorFlag & 0x20);
      if (ripple) ripple.checked = !!(sensorFlag & 0x10);
      if (linesnap) linesnap.checked = !!(sensorFlag & 0x01);
      if (esports) esports.checked = !!(cfgRes[53] & 0x01);
      setLOD(cfgRes[49] === 2 ? 2 : 1);
      if (debounce) debounce.value = cfgRes[51];
      if (debounceLbl) debounceLbl.innerText = cfgRes[51] + " ms";
      if (sleep) sleep.value = cfgRes[52];
      if (sleepLbl) sleepLbl.innerText = cfgRes[52] === 0 ? "Never" : cfgRes[52] + " min";
      if (invert) invert.checked = !!cfgRes[48];
      if (moveWake) moveWake.checked = !!(cfgRes[54] & 0x01);
    }

    if (keyRes) {
      const kData = keyRes.slice(8);
      for (let i = 0; i < 6; i++) {
        const t = kData[4 * i], c1 = kData[4 * i + 1], c2 = kData[4 * i + 2], c3 = kData[4 * i + 3];
        const select = document.getElementById(`btn-select-${i}`);
        if (!select) continue;
        for (const [name, bytes] of Object.entries(KEY_BINDINGS)) {
          if (bytes[0] === t && bytes[1] === c1 && bytes[2] === c2 && bytes[3] === c3) { select.value = name; break; }
        }
      }
    }
    showToast("Device registers synchronized");
  } finally { isBusBusy = false; }
}

async function testStreamerMode(modeVal) {
  handleLightingModeChange(modeVal);
  if (!hidDevice || !hidDevice.opened || isBusBusy) return;
  try {
    const livePacket = new Array(65).fill(0);
    livePacket[1] = 0x55; livePacket[2] = 0x21; livePacket[5] = 0x03; livePacket[11] = activeStreamerMode;
    await hidDevice.sendReport(0, new Uint8Array(livePacket.slice(1)));
  } catch (e) {}
}

async function writeFullConfig() {
  if (!hidDevice || !hidDevice.opened) return connectOrApply();
  
  // Wait for busy bus rather than aborting the write
  if (isBusBusy) {
    setTimeout(writeFullConfig, 50);
    return;
  }
  isBusBusy = true;

  try {
    const pollingMap = { 125: 1, 250: 2, 500: 3, 1000: 4 };
    let sensorFlag = 0;
    if (document.getElementById("chk-linesnap")?.checked) sensorFlag |= 0x01;
    if (document.getElementById("chk-ripple")?.checked) sensorFlag |= 0x10;
    if (document.getElementById("chk-motion-sync")?.checked) sensorFlag |= 0x20;

    const pkt = new Array(65).fill(0);
    pkt[1] = 0x55; pkt[2] = 0x0F; pkt[3] = 0xAE; pkt[4] = 0x0A; pkt[5] = 0x30;
    pkt[6] = 0x01; pkt[7] = 0x01; pkt[8] = 0x01; pkt[9] = 0x00;
    pkt[10] = activeStreamerMode;
    pkt[11] = pollingMap[activePolling] || 4;
    pkt[12] = 6;
    pkt[13] = activeDpiIndex + 1;

    for (let i = 0; i < 6; i++) {
      pkt[14 + i * 2] = currentDpis[i] & 0xFF;
      pkt[15 + i * 2] = (currentDpis[i] >> 8) & 0xFF;
    }

    pkt[49] = document.getElementById("chk-invert-scroll")?.checked ? 1 : 0;
    pkt[50] = activeLOD;
    pkt[51] = sensorFlag;
    pkt[52] = parseInt(document.getElementById("rng-debounce")?.value || 8);
    pkt[53] = parseInt(document.getElementById("rng-sleep")?.value || 10);
    pkt[54] = document.getElementById("chk-esports")?.checked ? 1 : 0;
    pkt[55] = document.getElementById("chk-move-wake")?.checked ? 1 : 0;

    await hidDevice.sendReport(0, new Uint8Array(pkt.slice(1)));
    
    const btnPkt = new Array(65).fill(0);
    btnPkt[1] = 0x55; btnPkt[2] = 0x09; btnPkt[3] = 0xA5; btnPkt[4] = 0x22; btnPkt[5] = 0x20;
    for (let i = 0; i < 6; i++) {
      const selected = document.getElementById(`btn-select-${i}`)?.value || "Left Click";
      const bytes = KEY_BINDINGS[selected] || [32, 0, 0, 0];
      btnPkt[9 + i * 4] = bytes[0]; btnPkt[10 + i * 4] = bytes[1];
      btnPkt[11 + i * 4] = bytes[2]; btnPkt[12 + i * 4] = bytes[3];
    }
    await hidDevice.sendReport(0, new Uint8Array(btnPkt.slice(1)));
    
    showToast("Settings applied to mouse memory");
  } catch (err) { showToast("Write failed: " + err.message); } 
  finally { isBusBusy = false; }
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

const debouncedWrite = debounce(() => {
  if (hidDevice && hidDevice.opened) {
    writeFullConfig();
  }
}, 400);

window.addEventListener("DOMContentLoaded", async () => {
  initUI();
  await tryAutoConnect();

  document.querySelectorAll("select, .toggle input").forEach(el => {
    el.addEventListener("change", () => {
      if (hidDevice && hidDevice.opened) {
        writeFullConfig();
      }
    });
  });

  document.querySelectorAll("input[type='range']").forEach(rng => {
    rng.addEventListener("input", () => {
      debouncedWrite();
    });
  });

  document.querySelectorAll(".segmented .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      setTimeout(() => {
        if (hidDevice && hidDevice.opened) {
          writeFullConfig();
        }
      }, 50);
    });
  });
});
const FILTERS = [
  { vendorId: 0xA8A4, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 },
  { vendorId: 0xA8A5, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 }
];

const KEY_BINDINGS = {
  "Left Click": [32, 1, 0, 0], "Right Click": [32, 2, 0, 0], "Middle Click": [32, 4, 0, 0],
  "Backward": [32, 8, 0, 0], "Forward": [32, 16, 0, 0], "DPI Loop": [33, 85, 0, 0],
  "Scroll Up": [33, 56, 1, 0], "Scroll Down": [33, 56, 255, 0], "Disabled": [32, 0, 0, 0]
};

const DPI_COLORS = [
  { name: "Red", hex: "#ff0033" }, { name: "Green", hex: "#00ff55" },
  { name: "Blue", hex: "#0055ff" }, { name: "Cyan", hex: "#00f0ff" },
  { name: "Amber", hex: "#ff7700" }, { name: "Magenta", hex: "#ee00ff" }
];

const STREAMER_MODES = [
  { label: "WAVE STREAMER", desc: "Rainbow animation", val: 0, class: "glow-wave", preview: "linear-gradient(90deg, #ff0044, #00ff55, #0055ff)" },
  { label: "OFF", desc: "Side lighting disabled", val: 6, class: "glow-off", preview: "#222" }
];

class AJ139Driver {
  constructor() {
    this.device = null;
    this.activeDpiIndex = 1;
    this.currentDpis = [800, 1600, 2400, 3200, 5000, 12000];
    this.activePolling = 1000;
    this.activeLOD = 1;
    this.activeStreamerMode = 6;
    this.pending = null;
  }

  showToast(msg) {
    const c = document.getElementById("toast-container");
    const t = document.createElement("div");
    t.className = "toast";
    t.innerText = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 2000);
  }

  async connect() {
    try {
      const devs = await navigator.hid.requestDevice({ filters: FILTERS });
      if (!devs.length) return;
      this.device = devs[0];
      if (!this.device.opened) await this.device.open();
      
      this.setupListener();
      await this.sync();
      this.showToast("Connected to AJ139");
    } catch (err) {
      this.showToast("Connection failed: " + err.message);
    }
  }

  setupListener() {
    this.device.oninputreport = (e) => {
      const d = new Uint8Array(e.data.buffer);
      if (this.pending && this.pending.match(d)) {
        this.pending.resolve(d);
        return;
      }
      if (d.length >= 20 && d[0] === 0xAA && d[1] === 0x30) {
        document.getElementById("hud-dot").className = "status-dot active";
        document.getElementById("hud-status").innerText = "ONLINE";
        document.getElementById("hud-battery-text").innerText = `${d[8]}%`;
        document.getElementById("hud-battery-bar").style.width = `${d[8]}%`;
        document.getElementById("hud-mode").innerText = this.device.vendorId === 0xA8A5 ? "2.4G WIRELESS" : "USB WIRED";
      }
    };
  }

  transact(sendPkt, matchFn) {
    return new Promise(async (resolve) => {
      let timer = setTimeout(() => { this.pending = null; resolve(null); }, 250);
      this.pending = { match: matchFn, resolve: (d) => { clearTimeout(timer); this.pending = null; resolve(d); } };
      try { await this.device.sendReport(0, new Uint8Array(sendPkt.slice(1))); }
      catch { clearTimeout(timer); this.pending = null; resolve(null); }
    });
  }

  async sync() {
    if (!this.device || !this.device.opened) return;

    const batPkt = new Array(65).fill(0);
    batPkt[1] = 0x55; batPkt[2] = 0x30; batPkt[3] = 0xA5; batPkt[4] = 0x0B; batPkt[5] = 0x2E;
    batPkt[6] = 0x01; batPkt[7] = 0x01; batPkt[8] = 0x01;
    const res = await this.transact(batPkt, d => d[0] === 0xAA && d[1] === 0x30);

    if (res) {
      document.getElementById("hud-dot").className = "status-dot active";
      document.getElementById("hud-status").innerText = "ONLINE";
      document.getElementById("hud-battery-text").innerText = `${res[8]}%`;
      document.getElementById("hud-battery-bar").style.width = `${res[8]}%`;
      document.getElementById("hud-mode").innerText = this.device.vendorId === 0xA8A5 ? "2.4G WIRELESS" : "USB WIRED";
      this.showToast("Telemetry Synchronized");
    }
  }

  async apply() {
    if (!this.device || !this.device.opened) return this.connect();
    
    const pkt = new Array(65).fill(0);
    pkt[1] = 0x55; pkt[2] = 0x0F; pkt[3] = 0xAE; pkt[4] = 0x0A; pkt[5] = 0x30;
    pkt[6] = 0x01; pkt[7] = 0x01; pkt[8] = 0x01;
    pkt[10] = this.activeStreamerMode;
    pkt[11] = { 125: 1, 250: 2, 500: 3, 1000: 4 }[this.activePolling] || 4;
    pkt[13] = this.activeDpiIndex + 1;

    for (let i = 0; i < 6; i++) {
      pkt[14 + i * 2] = this.currentDpis[i] & 0xFF;
      pkt[15 + i * 2] = (this.currentDpis[i] >> 8) & 0xFF;
    }

    pkt[50] = this.activeLOD;
    pkt[51] = document.getElementById("chk-motion-sync").checked ? 0x20 : 0x00;

    await this.device.sendReport(0, new Uint8Array(pkt.slice(1)));
    this.showToast("Settings Flashed to Mouse");
  }

  setDpiStage(i) {
    this.activeDpiIndex = i;
    document.documentElement.style.setProperty('--dpi-glow', DPI_COLORS[i].hex);
    document.querySelectorAll(".stage-radio").forEach((r, idx) => r.checked = (idx === i));
  }

  setPolling(rate) {
    this.activePolling = rate;
    document.querySelectorAll("#poll-control .seg-btn").forEach(b => b.classList.toggle("active", b.innerText.includes(rate)));
  }

  setLOD(lod) {
    this.activeLOD = lod;
    document.querySelectorAll("#lod-control .seg-btn").forEach(b => b.classList.toggle("active", b.innerText.startsWith(lod)));
  }

  setLighting(val) {
    this.activeStreamerMode = val;
    const mode = STREAMER_MODES.find(m => m.val === val);
    document.getElementById("glow-left").className = `side-diffuser left ${mode.class}`;
    document.getElementById("glow-right").className = `side-diffuser right ${mode.class}`;
    document.querySelectorAll(".rgb-card").forEach((c, idx) => c.classList.toggle("active", STREAMER_MODES[idx].val === val));
  }

  initUI() {
    const grid = document.getElementById("lighting-grid");
    STREAMER_MODES.forEach(m => {
      grid.innerHTML += `
        <div class="rgb-card ${m.val === this.activeStreamerMode ? 'active' : ''}" onclick="driver.setLighting(${m.val})">
          <div class="rgb-preview" style="background:${m.preview};"></div>
          <div class="font-impact" style="font-size:11px;">${m.label}</div>
        </div>
      `;
    });

    const dpiRows = document.getElementById("dpi-stage-rows");
    DPI_COLORS.forEach((col, i) => {
      dpiRows.innerHTML += `
        <div class="form-row">
          <label style="display:flex; align-items:center; gap:8px; width:120px; cursor:pointer;">
            <input type="radio" name="dpi_act" class="stage-radio" ${i === this.activeDpiIndex ? 'checked' : ''} onchange="driver.setDpiStage(${i})">
            <span style="width:10px; height:10px; border-radius:50%; background:${col.hex};"></span>
            <span style="font-size:12px; font-weight:bold;">Stage ${i + 1}</span>
          </label>
          <div class="slider-wrap">
            <input type="range" min="50" max="12000" step="50" value="${this.currentDpis[i]}"
                   oninput="driver.currentDpis[${i}] = parseInt(this.value); document.getElementById('dpi-lbl-${i}').innerText = this.value + ' DPI'">
            <span class="val-badge" id="dpi-lbl-${i}">${this.currentDpis[i]} DPI</span>
          </div>
        </div>
      `;
    });

    const opts = Object.keys(KEY_BINDINGS).map(k => `<option value="${k}">${k}</option>`).join('');
    for (let i = 0; i < 6; i++) {
      const el = document.getElementById(`btn-select-${i}`);
      if (el) el.innerHTML = opts;
    }
  }
}

window.driver = new AJ139Driver();
window.addEventListener("DOMContentLoaded", () => {
  window.driver.initUI();
  document.getElementById("btn-connect").onclick = () => window.driver.apply();
  document.getElementById("btn-sync").onclick = () => window.driver.sync();
});
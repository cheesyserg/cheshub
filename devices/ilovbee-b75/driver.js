/* iLovbee B75 studio — transport, protocol and UI.

   Protocol reverse-engineered from the vendor utility (DeviceDriver.exe,
   class CDevG5KB, Fw=2 branch). See docs/PROTOCOL.md for the wire format
   and which parts are verified against the binary vs. inferred. */

(function () {
  "use strict";

  /* ================================================================ constants */

  const VID = 0x258A;
  const PID = 0x01E7;
  const DONGLE_PID = 0x01BB;           // "2.4G Wireless Receiver"
  const FILTERS = [
    { vendorId: VID, productId: PID, usagePage: 0xFF00 },
    { vendorId: VID, productId: PID, usagePage: 0xFF02 },
    { vendorId: VID, productId: DONGLE_PID, usagePage: 0xFF02, usage: 0x02 },
    // Bluetooth: same vendor channel as the receiver if the firmware exposes it.
    { vendorId: VID, usagePage: 0xFF02, usage: 0x02 }
  ];

  /* Wireless link (receiver, and Bluetooth when exposed): CDev3632. 20-byte
     output/input reports with id 0x13 on usage page 0xFF02 / usage 2:
       [13, cmd, packets, index, sub<<4 | len, data x14, checksum]
     checksum = sum of the first 19 bytes. Each packet is acknowledged by an
     input report echoing the command. */
  const WL_REPORT = 0x13;
  const WL_CHUNK = 14;
  const WL_GAP_MS = 15;
  const WL_TIMEOUT_MS = 4000;
  const WL_PAGE = 0x200;               // macros go out in 512-byte pages (sub = page)
  const WL_CMD = {                     // wired command -> wireless command
    0x03: 0x01,                        // key matrix, sub = layer
    0x06: 0x02,                        // per-key colour, sub = group
    0x05: 0x03,                        // macro buffer, sub = page
    0x04: 0x04,                        // config block
    0x0A: 0x09,                        // colour table
    0x82: 0x05,                        // pairing id (6 bytes)
    0x84: 0x44,                        // config read
    0x87: 0x4A                         // battery read
  };
  const WL_ONLINE = 0x07;              // 1 byte: keyboard awake and linked

  const REPORT_BYTES = 0x208;          // HidP caps FeatureReportByteLength, incl. report id
  const PAYLOAD = REPORT_BYTES - 1;    // what WebHID sends after the report id
  const CHUNK = 0x200;                 // data bytes per packet
  const PACKET_GAP_MS = 25;            // vendor Sleep(0x19) before every packet

  const CMD = {
    SET_MATRIX: 0x03,    // sub = layer, 126 x 4-byte codes
    SET_CFG: 0x04,       // 0x80-byte config / lighting block
    SET_MACRO: 0x05,     // macro buffer
    SET_KEY_RGB: 0x06,   // sub = custom group, 3 planes x 126
    SET_RGB_TAB: 0x0A,   // 7 colours per effect, 21 bytes per effect id
    RESET: 0x11,
    GET_PSD: 0x82,
    GET_CFG: 0x84,
    GET_POWER: 0x87
  };

  const MATRIX_FORMAT = 2;             // bump when the matrix encoding changes
  const MATRIX_LEN = 0x7E;             // m_nMatrixLen = m_nLedNum = 126
  const CFG_LEN = 0x80;
  const CFG = {
    DEBOUNCE_A: 0x02,
    DEBOUNCE_B: 0x03,
    ZERO: 0x05,
    TAP: 0x08,
    SLEEP: 0x09,
    RESET_FLAG: 37,                    // ResetItem=37,1
    MODE: 0x21,
    COLOR: 0x22,
    BRIGHT: 0x23,
    SPEED: 0x24,
    MODE_TABLE: 0x53,                  // + hw*2 : brightness, + hw*2 + 1 : speed<<4 | colour
    SIG_A: 0x7E,
    SIG_B: 0x7F
  };

  /* LedOpt1..19 from KB.ini: hw id, speed, brightness, direction, colourful, colours.
     Names follow tc_eft1..19 in Dev/en/led.xml. LedMask=0x2100 hides #9 and #14. */
  const EFFECTS = [
    { n: 1,  hw: 1,  speed: 0, light: 1, random: 1, color: 1, name: "Steady" },
    { n: 2,  hw: 2,  speed: 1, light: 1, random: 1, color: 1, name: "Breathing" },
    { n: 3,  hw: 3,  speed: 1, light: 1, random: 0, color: 0, name: "Rainbow" },
    { n: 4,  hw: 4,  speed: 1, light: 1, random: 1, color: 1, name: "Flash Away" },
    { n: 5,  hw: 5,  speed: 1, light: 1, random: 1, color: 1, name: "Raindrops" },
    { n: 6,  hw: 6,  speed: 1, light: 1, random: 1, color: 1, name: "Rainbow Wheel" },
    { n: 7,  hw: 7,  speed: 1, light: 1, random: 1, color: 1, name: "Ripples Shining" },
    { n: 8,  hw: 8,  speed: 1, light: 1, random: 1, color: 1, name: "Stars Twinkle" },
    { n: 10, hw: 9,  speed: 1, light: 1, random: 1, color: 1, name: "Retro Snake" },
    { n: 11, hw: 10, speed: 1, light: 1, random: 1, color: 1, name: "Neon Stream" },
    { n: 12, hw: 11, speed: 1, light: 1, random: 1, color: 1, name: "Reaction" },
    { n: 13, hw: 12, speed: 1, light: 1, random: 1, color: 1, name: "Sine Wave" },
    { n: 15, hw: 13, speed: 1, light: 1, random: 0, color: 0, name: "Rotating Windmill" },
    { n: 16, hw: 14, speed: 1, light: 1, random: 0, color: 0, name: "Colorful Waterfall" },
    { n: 17, hw: 15, speed: 1, light: 1, random: 0, color: 0, name: "Blossoming" },
    { n: 18, hw: 19, speed: 0, light: 0, random: 0, color: 0, name: "Custom (per key)" },
    { n: 19, hw: 0,  speed: 0, light: 0, random: 0, color: 0, name: "Off" }
  ];
  const RGB_TAB_LEN = (19 + 1) * 21;   // (LedOpt count + 1) * 7 colours * 3
  const CUSTOM_HW = 19;

  const LIGHT_HW = [0, 5, 10, 15, 20]; // LightHW
  const DEF_BRIGHT = 4;                // DefBri / BriNum - 1
  const SPEED_MAX = 4;                 // SpeedParam=0x030400 -> min 0, max 4, default 3
  const DEF_SPEED = 3;
  const COLORFUL = 7;                  // colour nibble 7 = colourful / random
  const DEF_PALETTE = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#ffffff"];

  const DEBOUNCE = [                   // DebounceUI=1,2 / DebounceHW=0,4 (hex), DebounceName=1
    { hw: 0x00, name: "Office" },
    { hw: 0x04, name: "Gaming" }
  ];
  const SLEEP = [                      // UI 5/10/20/30 min -> HW 10/20/40/60 (30 s units), 0 = never
    { hw: 10, name: "5 min" },
    { hw: 20, name: "10 min" },
    { hw: 40, name: "20 min" },
    { hw: 60, name: "30 min" },
    { hw: 0,  name: "Never" }
  ];

  const STORE_KEY = "cheshub.ilovbee-b75";
  const MACRO_LIMIT = 10;              // MacroBufferNum default
  const MACRO_BUFFER = 0x1000;         // FillMatrix buffer limit
  const MACRO_MAX_DELAY = 0xFFFFF;

  /* ============================================================ key catalogue */

  const HID_NAMES = {};
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c, i) => { HID_NAMES[0x04 + i] = c; });
  "1234567890".split("").forEach((c, i) => { HID_NAMES[0x1E + i] = c; });
  Object.assign(HID_NAMES, {
    0x28: "Enter", 0x29: "Esc", 0x2A: "Backspace", 0x2B: "Tab", 0x2C: "Space", 0x2D: "-", 0x2E: "=",
    0x2F: "[", 0x30: "]", 0x31: "\\", 0x33: ";", 0x34: "'", 0x35: "`", 0x36: ",", 0x37: ".", 0x38: "/",
    0x39: "Caps Lock", 0x46: "Print Screen", 0x47: "Scroll Lock", 0x48: "Pause", 0x49: "Insert",
    0x4A: "Home", 0x4B: "Page Up", 0x4C: "Delete", 0x4D: "End", 0x4E: "Page Down", 0x4F: "Right",
    0x50: "Left", 0x51: "Down", 0x52: "Up", 0x53: "Num Lock", 0x54: "Num /", 0x55: "Num *", 0x56: "Num -",
    0x57: "Num +", 0x58: "Num Enter", 0x63: "Num .", 0x64: "ISO \\", 0x65: "Menu",
    0xE0: "Left Ctrl", 0xE1: "Left Shift", 0xE2: "Left Alt", 0xE3: "Left Win",
    0xE4: "Right Ctrl", 0xE5: "Right Shift", 0xE6: "Right Alt", 0xE7: "Right Win"
  });
  for (let i = 0; i < 12; i++) HID_NAMES[0x3A + i] = "F" + (i + 1);
  for (let i = 0; i < 12; i++) HID_NAMES[0x68 + i] = "F" + (i + 13);
  for (let i = 0; i < 9; i++) HID_NAMES[0x59 + i] = "Num " + (i + 1);
  HID_NAMES[0x62] = "Num 0";

  /* KeyboardEvent.code -> HID usage, for macro recording and the key picker. */
  const CODE_TO_HID = {};
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c, i) => { CODE_TO_HID["Key" + c] = 0x04 + i; });
  "1234567890".split("").forEach((c, i) => { CODE_TO_HID["Digit" + c] = 0x1E + i; });
  for (let i = 0; i < 12; i++) CODE_TO_HID["F" + (i + 1)] = 0x3A + i;
  Object.assign(CODE_TO_HID, {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2A, Tab: 0x2B, Space: 0x2C, Minus: 0x2D, Equal: 0x2E,
    BracketLeft: 0x2F, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
    Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
    Insert: 0x49, Home: 0x4A, PageUp: 0x4B, Delete: 0x4C, End: 0x4D, PageDown: 0x4E, ArrowRight: 0x4F,
    ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
    NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58, NumpadDecimal: 0x63, IntlBackslash: 0x64,
    ContextMenu: 0x65, ControlLeft: 0xE0, ShiftLeft: 0xE1, AltLeft: 0xE2, MetaLeft: 0xE3,
    ControlRight: 0xE4, ShiftRight: 0xE5, AltRight: 0xE6, MetaRight: 0xE7
  });
  for (let i = 0; i < 10; i++) CODE_TO_HID["Numpad" + i] = i === 0 ? 0x62 : 0x58 + i;

  const MODS = [
    { bit: 0x01, name: "Ctrl" }, { bit: 0x02, name: "Shift" }, { bit: 0x04, name: "Alt" }, { bit: 0x08, name: "Win" },
    { bit: 0x10, name: "R-Ctrl" }, { bit: 0x20, name: "R-Shift" }, { bit: 0x40, name: "R-Alt" }, { bit: 0x80, name: "R-Win" }
  ];

  /* Consumer usages the vendor tool offers (keyinfo_to_hardware_code tables). */
  const MEDIA = [
    [0x00CD, "Play / Pause"], [0x00B7, "Stop"], [0x00B6, "Previous"], [0x00B5, "Next"],
    [0x00E9, "Volume Up"], [0x00EA, "Volume Down"], [0x00E2, "Mute"],
    [0x0183, "Media Player"], [0x018A, "Email"], [0x0192, "Calculator"], [0x0194, "Explorer"],
    [0x0221, "Search"], [0x0223, "Home Page"], [0x0227, "Refresh"], [0x022A, "Favorites"],
    [0x006F, "Screen +"], [0x0070, "Screen −"]
  ];

  const MOUSE = [
    ["01010100", "Left Button"], ["01010200", "Right Button"], ["01010300", "Middle Button"],
    ["01010400", "Back"], ["01010500", "Forward"], ["01080000", "Scroll Up"], ["01090000", "Scroll Down"]
  ];

  const MACRO_MODES = [
    { hw: 1, name: "Repeat N times" },
    { hw: 2, name: "Loop while held" },
    { hw: 4, name: "Loop until pressed again" },
    { hw: 3, name: "Loop until any key" }
  ];

  /* ================================================================== state */

  const KEYS = (window.B75_KEYS || []).map(([id, label, rect, idx, code]) => ({ id, label, rect, idx, code }));
  const KEY_BY_ID = new Map(KEYS.map((key) => [key.id, key]));
  /* Knob press / turn entries: no LED under the knob, so they are never lit
     in the preview and get no per-key colour. */
  const UNLIT = new Set([82, 83, 84]);
  const lightable = (key) => !UNLIT.has(key.id);

  let device = null;
  let reportId = 0;
  let featureBytes = PAYLOAD;
  let queue = Promise.resolve();
  let cfg = null;                      // last config block read from the keyboard
  let selectedKey = null;
  let activeTab = "tab-light";
  let paintColor = "#ff2a55";
  let editingMacro = -1;
  let recording = null;
  const wire = [];
  const dirty = { cfg: false, rgbTab: false, matrix: false, keyRgb: false };

  const light = {
    hw: 9,                             // DefLedIndex=10 -> LedOpt10 (hw 9)
    effects: {}                        // hw -> { bright, speed, slot, colorful }
  };
  EFFECTS.forEach((fx) => {
    light.effects[fx.hw] = { bright: DEF_BRIGHT, speed: DEF_SPEED, slot: 0, colorful: true };
  });

  let saved = loadStore();

  function loadStore() {
    const base = { keys: {}, macros: [], palettes: {}, perKey: {}, debounce: 0, sleep: 1, layout: "knob" };
    try {
      return Object.assign(base, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
    } catch (err) {
      return base;
    }
  }

  function store() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (err) { /* storage disabled */ }
  }

  function palette(hw) {
    const p = saved.palettes[hw];
    return Array.isArray(p) && p.length === 7 ? p : DEF_PALETTE.slice();
  }

  /* ================================================================ helpers */

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function hexToBytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i += 2) out.push(parseInt(str.substr(i, 2), 16));
    return out;
  }

  function rgb(hexColor) {
    const v = parseInt(hexColor.replace("#", ""), 16);
    return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
  }

  function toast(msg) {
    const container = $("toast-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 2400);
  }

  function log(dir, bytes) {
    const line = `${new Date().toISOString().slice(11, 23)} ${dir} ${hex(bytes.slice(0, 24))}${bytes.length > 24 ? " …" : ""}`;
    wire.push(line);
    if (wire.length > 80) wire.shift();
    const el = $("diag-wire");
    if (el) el.textContent = wire.join("\n");
  }

  function setDiag(id, text, ok) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = ok === undefined ? "" : (ok ? "#2ee6c5" : "#e05561");
  }

  /* ============================================================== transport */

  function exclusive(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  /* Picks the vendor collection carrying the 0x208-byte feature report and
     returns its report id (CDevG5KB::FindHIDDevice keeps "RID" the same way). */
  function pickCollection(dev) {
    let best = null;
    (dev.collections || []).forEach((col) => {
      (col.featureReports || []).forEach((report) => {
        const bits = (report.items || []).reduce((sum, item) => sum + item.reportSize * item.reportCount, 0);
        const bytes = Math.round(bits / 8);
        const vendor = col.usagePage >= 0xFF00;
        const score = (vendor ? 2 : 0) + (bytes === PAYLOAD ? 4 : 0) + (bytes >= 64 ? 1 : 0);
        if (!best || score > best.score) best = { score, col, reportId: report.reportId, bytes };
      });
    });
    return best;
  }

  function frame(cmd, sub, packets, index, chunk) {
    const out = new Uint8Array(featureBytes);
    out[0] = cmd;
    out[1] = sub;
    out[2] = 0;
    out[3] = packets;
    out[4] = index;
    out[5] = chunk.length & 0xFF;
    out[6] = (chunk.length >> 8) & 0xFF;
    out.set(chunk.subarray(0, Math.min(chunk.length, featureBytes - 7)), 7);
    return out;
  }

  async function sendFrame(data) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        log(`>> ${reportId.toString(16).padStart(2, "0")}`, data);
        await device.sendFeatureReport(reportId, data);
        return;
      } catch (err) {
        lastErr = err;
        await sleep(50);
      }
    }
    throw lastErr;
  }

  async function receive(cmd) {
    const view = await device.receiveFeatureReport(reportId);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    log("<<", bytes);
    let off = -1;
    if (bytes[0] === cmd) off = 0;
    else if (bytes[1] === cmd) off = 1;
    if (off < 0) throw new Error(`reply cmd 0x${(bytes[0] || 0).toString(16)} != 0x${cmd.toString(16)}`);
    return bytes.subarray(off);
  }

  /* ------------------------------------------------- wireless transport */

  let link = "wired";                  // "wired" | "wireless"
  let wlWaiters = [];

  function watchReports() {
    device.removeEventListener("inputreport", onInputReport);
    device.addEventListener("inputreport", onInputReport);
  }

  function onInputReport(event) {
    onNotify(event);
    if (link !== "wireless") return;
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    const bytes = new Uint8Array(data.length + 1);
    bytes[0] = event.reportId;
    bytes.set(data, 1);
    if (event.reportId !== WL_REPORT && event.reportId !== 0xFF) return;
    log("<<", bytes);
    wlWaiters = wlWaiters.filter((w) => !w(bytes));
  }

  function wlFrame(cmd, total, index, sub, chunk) {
    const b = new Uint8Array(20);
    b[0] = WL_REPORT;
    b[1] = cmd;
    b[2] = total;
    b[3] = index;
    b[4] = ((sub & 0x0F) << 4) | (chunk.length & 0x0F);
    b.set(chunk.subarray(0, WL_CHUNK), 5);
    let sum = 0;
    for (let i = 0; i < 19; i++) sum += b[i];
    b[19] = sum & 0xFF;
    return b;
  }

  /* Resolves with the next report for `cmd`; accept() may consume several. */
  function wlWait(cmd, accept, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wlWaiters = wlWaiters.filter((w) => w !== waiter);
        reject(new Error("keyboard did not answer — is it awake?"));
      }, timeout);
      const waiter = (b) => {
        if (b[0] === 0xFF) { clearTimeout(timer); reject(new Error("receiver reported an error")); return true; }
        if ((b[1] & 0x7F) !== cmd) return false;
        const done = accept(b);
        if (done === undefined) return false;
        clearTimeout(timer);
        if (done instanceof Error) reject(done); else resolve(done);
        return true;
      };
      wlWaiters.push(waiter);
    });
  }

  async function wlSend(b) {
    log(">> 13", b.subarray(1));
    await device.sendReport(WL_REPORT, b.subarray(1));
  }

  /* CDev3632::AccessData: 14-byte packets, each acknowledged. */
  async function wlWriteBlock(cmd, sub, bytes) {
    const total = Math.max(1, Math.ceil(bytes.length / WL_CHUNK));
    for (let i = 0; i < total; i++) {
      const frameBytes = wlFrame(cmd, total, i, sub, bytes.subarray(i * WL_CHUNK, (i + 1) * WL_CHUNK));
      for (let attempt = 0; ; attempt++) {
        await sleep(WL_GAP_MS);
        const ack = wlWait(cmd, (b) => (b[2] & 0x80 ? "retry" : "ok"), WL_TIMEOUT_MS);
        await wlSend(frameBytes);
        const result = await ack;
        if (result === "ok") break;
        if (attempt >= 5) throw new Error("keyboard kept asking for a resend");
      }
    }
  }

  async function wlWrite(wiredCmd, sub, bytes) {
    const cmd = WL_CMD[wiredCmd];
    if (cmd === undefined) throw new Error("not available over wireless");
    if (cmd === 0x03) {
      // Macro buffer: one AccessData per 512-byte page, sub = page index.
      const pages = Math.max(1, Math.ceil(bytes.length / WL_PAGE));
      for (let page = 0; page < pages; page++) {
        await wlWriteBlock(cmd, page, bytes.subarray(page * WL_PAGE, (page + 1) * WL_PAGE));
        await sleep(100);
      }
      return;
    }
    await wlWriteBlock(cmd, sub, bytes);
  }

  /* Read: one request, then reply packets until index == packets - 1. */
  async function wlRead(cmd, length) {
    const out = new Uint8Array(length);
    let filled = 0;
    const seen = new Set();
    const done = wlWait(cmd, (b) => {
      if (b[1] & 0x80) return new Error("keyboard rejected the request");
      const total = b[2] & 0x7F;
      const index = b[3];
      if (!seen.has(index)) {
        seen.add(index);
        const n = Math.min(b[4] & 0x0F, WL_CHUNK, length - index * WL_CHUNK);
        if (n > 0) out.set(b.subarray(5, 5 + n), index * WL_CHUNK);
        filled += Math.max(0, n);
      }
      return index >= total - 1 ? out : undefined;
    }, 3000);
    const req = wlFrame(cmd, 1, 0, 0, new Uint8Array(0));
    await wlSend(req);
    return done;
  }

  /* CDevG5KB::AccessData (write) */
  function write(cmd, sub, data, gap = PACKET_GAP_MS) {
    if (link === "wireless") {
      return exclusive(async () => {
        if (!device || !device.opened) throw new Error("not connected");
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        await wlWrite(cmd, sub, bytes);
        setDiag("diag-last", `0x${(WL_CMD[cmd] || cmd).toString(16).padStart(2, "0")} write ${bytes.length} B (wireless)`, true);
      });
    }
    return exclusive(async () => {
      if (!device || !device.opened) throw new Error("not connected");
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const packets = Math.max(1, Math.ceil(bytes.length / CHUNK));
      for (let i = 0; i < packets; i++) {
        await sleep(gap);
        await sendFrame(frame(cmd, sub, packets, i, bytes.subarray(i * CHUNK, (i + 1) * CHUNK)));
      }
      setDiag("diag-last", `0x${cmd.toString(16).padStart(2, "0")} write ${bytes.length} B`, true);
    });
  }

  /* GetLED / GetPower / GetPassword: one request frame, then a feature read. */
  function read(cmd, sub, length) {
    if (link === "wireless") {
      return exclusive(async () => {
        if (!device || !device.opened) throw new Error("not connected");
        const wl = WL_CMD[cmd] !== undefined ? WL_CMD[cmd] : cmd;
        const out = await wlRead(wl, length);
        setDiag("diag-last", `0x${wl.toString(16).padStart(2, "0")} read ${length} B (wireless)`, true);
        return out;
      });
    }
    return exclusive(async () => {
      if (!device || !device.opened) throw new Error("not connected");
      const out = new Uint8Array(length);
      const packets = Math.max(1, Math.ceil(length / CHUNK));
      for (let i = 0, done = 0; i < packets; i++) {
        const size = Math.min(CHUNK, length - done);
        await sleep(PACKET_GAP_MS);
        const req = frame(cmd, sub, packets, i, new Uint8Array(0));
        req[5] = size & 0xFF;
        req[6] = size >> 8;
        await sendFrame(req);
        await sleep(PACKET_GAP_MS);
        const reply = await receive(cmd);
        out.set(reply.subarray(7, 7 + size), done);
        done += size;
      }
      setDiag("diag-last", `0x${cmd.toString(16).padStart(2, "0")} read ${length} B`, true);
      return out;
    });
  }

  /* ============================================================ connection */

  async function attach(dev) {
    device = dev;
    if (!device.opened) await device.open();
    setDiag("diag-product", device.productName || "—");
    setDiag("diag-ids", `${hex4(device.vendorId)} : ${hex4(device.productId)}`);
    renderCollections();

    if (isWireless(device)) {
      link = "wireless";
      watchReports();
      setDiag("diag-interface", "wireless channel, usage page 0xFF02 / 0x0002, report 0x13", true);
      updateHud(true);
      let awake = true;
      try {
        const st = await read(WL_ONLINE, 0, 1);
        awake = st[0] !== 0;
      } catch (err) { /* older receivers may not answer; carry on */ }
      if (!awake) {
        toast("Keyboard is asleep — press any key on it, then press Sync.");
        return;
      }
      // KB.ini Psd=a,0,0,0,0,12 identifies the B75 behind a receiver.
      try {
        const psd = await read(CMD.GET_PSD, 1, 6);
        setDiag("diag-psd", hex(psd), true);
        const b75 = [0x0A, 0, 0, 0, 0, 0x12];
        if (!b75.every((v, i) => psd[i] === v)) {
          toast("This receiver is paired with a different iLovbee keyboard.");
        }
      } catch (err) { setDiag("diag-psd", err.message, false); }
    } else {
      link = "wired";
      watchReports();
      const pick = pickCollection(device);
      if (!pick) throw new Error("this interface can't be configured — use Try Another Interface");
      reportId = pick.reportId;
      featureBytes = pick.bytes || PAYLOAD;
      setDiag("diag-interface",
        `usage page 0x${hex4(pick.col.usagePage)} / 0x${hex4(pick.col.usage)}, report 0x${reportId.toString(16).padStart(2, "0")}, ${featureBytes + 1} B`,
        featureBytes === PAYLOAD);
      updateHud(true);
    }

    await sync(true);
    // Layers written by older builds carried modifiers as E0-E7 usages,
    // which the firmware drops; rewrite the base layer once to repair them.
    if (saved.matrixFormat !== MATRIX_FORMAT) {
      dirty.matrix = true;
      saved.matrixFormat = MATRIX_FORMAT;
      store();
    }
    if (Object.values(dirty).some(Boolean)) scheduleApply();
    startPolling();
  }

  /* The receiver (and a Bluetooth link) carries the 0x13 report on
     0xFF02 / usage 2; the wired board uses the 0x208 feature report. */
  function wirelessCollection(dev) {
    return (dev.collections || []).find((c) => c.usagePage === 0xFF02 && c.usage === 0x02
      && (c.outputReports || []).some((r) => r.reportId === WL_REPORT));
  }

  function isWireless(dev) {
    if (dev.productId === PID) return false;
    return !!wirelessCollection(dev) || dev.productId === DONGLE_PID;
  }

  function linkLabel() {
    if (!device) return "None";
    if (link === "wired") return "USB Wired";
    return device.productId === DONGLE_PID || /receiver|dongle/i.test(device.productName || "") ? "2.4 GHz" : "Bluetooth";
  }

  function hex4(v) { return (v || 0).toString(16).toUpperCase().padStart(4, "0"); }

  async function connect(filters = FILTERS) {
    if (!navigator.hid) { toast("This browser can't connect to USB devices. Use Chrome or Edge."); return; }
    try {
      const picked = await navigator.hid.requestDevice({ filters });
      if (!picked.length) return;
      await attach(picked[0]);
      toast("Connected to iLovbee B75");
    } catch (err) {
      setDiag("diag-error", err.message, false);
      toast("Couldn't connect to the keyboard. See Diagnostics for details.");
    }
  }

  async function autoConnect() {
    if (!navigator.hid) return;
    try {
      const granted = await navigator.hid.getDevices();
      const match = granted.find((dev) => dev.vendorId === VID && dev.productId === PID && pickCollection(dev))
        || granted.find((dev) => dev.vendorId === VID && isWireless(dev));
      if (match) await attach(match);
    } catch (err) {
      setDiag("diag-error", err.message, false);
    }
  }

  function updateHud(connected, battery = null, charging = false) {
    if (window.ChesHub) window.ChesHub.setConnected(connected);
    if (window.ChesHubRegistry) {
      window.ChesHubRegistry.saveTelemetry(document.body.dataset.device, {
        battery: connected ? battery : null, charging, mode: connected ? linkLabel() : null
      });
    }
    const text = $("hud-battery-text");
    const bar = $("hud-battery-bar");
    if (text) text.textContent = !connected ? "--%" : (battery === null ? "n/a" : `${battery}%${charging ? " ⚡" : ""}`);
    if (bar) bar.style.width = connected && battery !== null ? `${Math.max(0, Math.min(100, battery))}%` : "0%";
    const mode = $("hud-mode");
    if (mode) mode.textContent = connected ? linkLabel() + (asleep ? " · asleep" : "") : "None";
  }

  navigator.hid?.addEventListener("disconnect", (event) => {
    if (event.device === device) {
      device = null;
      cfg = null;
      clearInterval(pollTimer);
      clearTimeout(refreshTimer);
      updateHud(false);
      toast("Keyboard disconnected");
    }
  });

  /* ================================================================== sync */

  async function readCfg() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const block = await read(CMD.GET_CFG, 0, CFG_LEN);
      if (block[CFG.SIG_A] === 0x5A && block[CFG.SIG_B] === 0xA5) return block;
      await sleep(100);
    }
    throw new Error("config block signature (5A A5) missing");
  }

  async function sync(quiet) {
    if (!device) return;
    try {
      cfg = await readCfg();
      setDiag("diag-cfg", hex(cfg), true);
      setDiag("diag-error", "—");
      decodeCfg(cfg);
      renderAll();
      await readPower();
      dirty.cfg = false;
      if (!quiet) toast("Settings read from keyboard");
    } catch (err) {
      setDiag("diag-error", err.message, false);
      toast("Couldn't read settings from the keyboard.");
    }
  }

  /* ------------------------------------------------- live state from the board

     The keyboard announces on-board changes (Fn lighting hotkeys, wake/sleep)
     with a notification whose second byte is 0x0A:
       wired:    [rid, 0A, type, a, b, ...]           (8-byte input report)
       wireless: [13, 0A, .., .., .., type, a, b, ...] (20-byte input report)
     type 2 = settings changed; the vendor tool re-reads the config block then
     (and over wireless, a = 0 means the keyboard went to sleep). A slow poll
     covers anything that arrives without a notification. */
  const POLL_MS = 3000;
  const POWER_EVERY = 20;              // battery on every 20th poll (~1 min)
  let refreshTimer = null;
  let pollTimer = null;
  let pollCount = 0;
  let lastWrite = 0;
  let asleep = false;

  function onNotify(event) {
    const d = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    let type;
    let a;
    if (link === "wireless") {
      if (event.reportId !== WL_REPORT || d[0] !== 0x0A) return;
      type = d[4];
      a = d[5];
    } else {
      if (d[0] !== 0x0A) return;
      type = d[1];
      a = d[2];
    }
    log("<< event", d.subarray(0, 8));
    if (type !== 2) return;
    if (link === "wireless" && a === 0) {
      asleep = true;
      updateHud(true);
      return;
    }
    asleep = false;
    scheduleRefresh(250);
  }

  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshFromDevice, delay);
  }

  /* Re-read the config block and update the UI if the keyboard changed it.
     Skipped while our own edits are pending or being written, so a poll never
     overwrites what the user just picked. */
  async function refreshFromDevice() {
    if (!device || !device.opened) return;
    if (Object.values(dirty).some(Boolean) || applying || recording || performance.now() - lastWrite < 1500) {
      scheduleRefresh(800);
      return;
    }
    try {
      const block = await readCfg();
      if (Object.values(dirty).some(Boolean) || applying) return;
      asleep = false;
      if (!cfg || block.some((v, i) => v !== cfg[i])) {
        cfg = block;
        setDiag("diag-cfg", hex(cfg), true);
        decodeCfg(cfg);
        renderLighting();
        renderSettings();
      }
      if (++pollCount % POWER_EVERY === 0) await readPower();
    } catch (err) {
      // A sleeping wireless keyboard simply stops answering.
      if (link === "wireless") { asleep = true; updateHud(true); }
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden) refreshFromDevice();
    }, POLL_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && device) scheduleRefresh(100);
  });

  async function readPower() {
    try {
      const p = await read(CMD.GET_POWER, 0, 2);
      setDiag("diag-power", hex(p), true);
      const level = p[0] <= 100 ? p[0] : null;
      updateHud(true, level, !!p[1]);
    } catch (err) {
      setDiag("diag-power", "no reply", false);
      updateHud(true);
    }
  }

  /* The vendor tool never loads its UI from this block — it only patches and
     writes it back — so values are adopted only when they look valid. A zero
     brightness byte means "never written", not "off"; trusting it would make
     every effect write brightness 0 and leave the keyboard dark. */
  /* Brightness may come back on the vendor scale (0/5/10/15/20) or, after an
     Fn hotkey, on whatever scale the firmware uses — map to the nearest of
     the five levels instead of dropping unknown values. */
  function brightIndex(v) {
    const exact = LIGHT_HW.indexOf(v);
    if (exact >= 0) return exact;
    const top = LIGHT_HW[LIGHT_HW.length - 1];
    const scale = v <= top ? top : (v <= 100 ? 100 : 255);
    return Math.max(0, Math.min(LIGHT_HW.length - 1, Math.round((v / scale) * (LIGHT_HW.length - 1))));
  }

  let prevBlock = null;

  function decodeCfg(block) {
    const notes = [];
    const fx = EFFECTS.find((e) => e.hw === block[CFG.MODE]);
    if (fx) light.hw = fx.hw;
    else notes.push(`mode 0x${block[CFG.MODE].toString(16)} unknown`);

    // A table that was never written is all zeros; then 0 means "unset", not
    // "off". Once anything is in it, 0 really is brightness off.
    const tableLive = EFFECTS.some((e) => e.hw && (block[CFG.MODE_TABLE + e.hw * 2] || block[CFG.MODE_TABLE + e.hw * 2 + 1]));
    const changed = (i) => !prevBlock || prevBlock[i] !== block[i];

    EFFECTS.forEach((e) => {
      if (!e.hw) return;
      const b = block[CFG.MODE_TABLE + e.hw * 2];
      const sc = block[CFG.MODE_TABLE + e.hw * 2 + 1];
      const state = light.effects[e.hw];
      if (b || tableLive) state.bright = brightIndex(b);
      if (b === 0 && sc === 0 && !tableLive) return;
      if ((sc >> 4) <= SPEED_MAX) state.speed = sc >> 4;
      const slot = sc & 0x0F;
      if (slot === COLORFUL) state.colorful = true;
      else if (slot < 7) { state.colorful = false; state.slot = slot; }
    });

    // The active effect also has its own brightness / speed bytes. Hotkeys may
    // update either copy; whichever changed since the last read wins.
    const cur = light.effects[light.hw];
    if (cur && light.hw) {
      const tb = CFG.MODE_TABLE + light.hw * 2;
      const activeBright = block[CFG.BRIGHT];
      // First read: trust the active byte. Later reads: the copy that moved.
      const pickActive = (activeIdx, tableIdx) => !prevBlock || (changed(activeIdx) && !changed(tableIdx));
      if ((activeBright || tableLive) && pickActive(CFG.BRIGHT, tb)) cur.bright = brightIndex(activeBright);
      const activeSpeed = block[CFG.SPEED];
      if (tableLive && activeSpeed <= SPEED_MAX && pickActive(CFG.SPEED, tb + 1)) cur.speed = activeSpeed;
    }
    prevBlock = new Uint8Array(block);

    const deb = DEBOUNCE.findIndex((d) => d.hw === block[CFG.DEBOUNCE_A]);
    if (deb >= 0) saved.debounce = deb;
    const sl = SLEEP.findIndex((s) => s.hw === block[CFG.SLEEP]);
    if (sl >= 0) saved.sleep = sl;
    const raw = light.hw ? ` (raw: active ${block[CFG.BRIGHT]}, effect ${block[CFG.MODE_TABLE + light.hw * 2]}, speed ${block[CFG.SPEED]}/${block[CFG.MODE_TABLE + light.hw * 2 + 1] >> 4})` : "";
    setDiag("diag-decode", `effect ${light.hw}, brightness ${cur ? cur.bright : "-"}, speed ${cur ? cur.speed : "-"}${raw}${notes.length ? " · " + notes.join(", ") : ""}`, !notes.length);
  }

  /* FillCfg_LowDaly (Fw=2): only the bytes the vendor tool owns are touched. */
  function encodeCfg(block, options = {}) {
    const out = new Uint8Array(block);
    EFFECTS.forEach((e) => {
      if (!e.hw) return;
      const s = light.effects[e.hw];
      const slot = s.colorful ? COLORFUL : (s.slot & 0x0F);
      out[CFG.MODE_TABLE + e.hw * 2] = LIGHT_HW[s.bright];
      out[CFG.MODE_TABLE + e.hw * 2 + 1] = ((s.speed & 0x0F) << 4) | slot;
    });
    const cur = light.effects[light.hw];
    out[CFG.MODE] = light.hw;
    if (light.hw) {
      out[CFG.COLOR] = cur.colorful ? COLORFUL : cur.slot;
      out[CFG.BRIGHT] = LIGHT_HW[cur.bright];
      out[CFG.SPEED] = cur.speed;
    }
    out[CFG.DEBOUNCE_A] = out[CFG.DEBOUNCE_B] = DEBOUNCE[saved.debounce].hw;
    out[CFG.SLEEP] = SLEEP[saved.sleep].hw;
    out[CFG.ZERO] = 0;
    if (options.reset) out[CFG.RESET_FLAG] = 1;
    out[CFG.SIG_A] = 0x5A;
    out[CFG.SIG_B] = 0xA5;
    return out;
  }

  function buildRgbTab() {
    const tab = new Uint8Array(RGB_TAB_LEN);
    EFFECTS.forEach((e) => {
      if (!e.hw) return;
      palette(e.hw).forEach((color, slot) => {
        tab.set(rgb(color), e.hw * 21 + slot * 3);
      });
    });
    return tab;
  }

  function buildKeyRgb() {
    const planes = new Uint8Array(MATRIX_LEN * 3);
    KEYS.forEach((key) => {
      const color = saved.perKey[key.idx];
      if (!color || key.idx >= MATRIX_LEN || !lightable(key)) return;
      const [r, g, b] = rgb(color);
      planes[key.idx] = r;
      planes[MATRIX_LEN + key.idx] = g;
      planes[MATRIX_LEN * 2 + key.idx] = b;
    });
    return planes;
  }

  function macroIndexMap() {
    // Macros get buffer ids in the order keys reference them (FillMatrix).
    const used = [];
    KEYS.forEach((key) => {
      const a = saved.keys[key.id];
      if (a && a.type === "macro" && saved.macros[a.macro] && !used.includes(a.macro)) used.push(a.macro);
    });
    return used;
  }

  /* Keyboard entry: [00, modifier bits, 0, usage]. A modifier key goes in as
     its bit with no usage — the firmware ignores E0-E7 in the usage byte,
     which is what dropped Ctrl / Shift / Alt / Win before. */
  function keyCode(mods, hid) {
    let m = mods & 0xFF;
    let u = hid & 0xFF;
    if (u >= 0xE0 && u <= 0xE7) {
      m |= 1 << (u - 0xE0);
      u = 0;
    }
    return [0x00, m, 0x00, u];
  }

  function factoryCode(key) {
    const c = hexToBytes(key.code);
    return c[0] === 0x00 ? keyCode(c[1], c[3]) : c;
  }

  function codeFor(key, usedMacros) {
    const a = layout().hide.includes(key.id) ? null : saved.keys[key.id];
    if (!a) return factoryCode(key);
    switch (a.type) {
      case "key": return keyCode(a.mods, a.hid);
      case "media": return [0x02, 0x00, (a.usage >> 8) & 0xFF, a.usage & 0xFF];
      case "raw": return hexToBytes(a.code);
      case "macro": {
        const slot = usedMacros.indexOf(a.macro);
        const m = saved.macros[a.macro];
        if (slot < 0 || !m) return factoryCode(key);
        const mode = MACRO_MODES.find((x) => x.hw === m.mode) || MACRO_MODES[0];
        const count = mode.hw === 1 ? Math.max(1, Math.min(255, m.count || 1)) : 0;
        return [0x03, mode.hw, count, slot];
      }
      case "off": return [0, 0, 0, 0];
      default: return factoryCode(key);
    }
  }

  function buildMatrix() {
    const used = macroIndexMap();
    const matrix = new Uint8Array(MATRIX_LEN * 4);
    KEYS.forEach((key) => {
      if (key.idx < MATRIX_LEN) matrix.set(codeFor(key, used), key.idx * 4);
    });
    return { matrix, used };
  }

  /* StMacro_To_HdMacro */
  function encodeMacro(m) {
    const name = (m.name || "Macro").slice(0, 0x28);
    const out = [name.length * 2];
    for (const ch of name) {
      const c = ch.charCodeAt(0);
      out.push(c & 0xFF, c >> 8);
    }
    (m.events || []).forEach((ev) => {
      const delay = Math.max(0, Math.min(MACRO_MAX_DELAY, ev.delay | 0));
      const type = ev.kind === "mouse" ? 2 : 1;
      let b0 = (type << 4) | ((delay >> 16) & 0x0F);
      if (ev.down) b0 |= 0x80;
      out.push(b0, (delay >> 8) & 0xFF, delay & 0xFF, ev.code & 0xFF);
    });
    return out;
  }

  function buildMacroBuffer(used) {
    const bodies = used.map((i) => encodeMacro(saved.macros[i]));
    const header = used.length * 4;
    const total = header + bodies.reduce((s, b) => s + b.length, 0);
    if (total > MACRO_BUFFER) throw new Error("macro buffer full (" + total + " B)");
    const buf = new Uint8Array(total);
    let offset = header;
    bodies.forEach((body, i) => {
      buf[i * 4] = offset & 0xFF;
      buf[i * 4 + 1] = offset >> 8;
      buf[i * 4 + 2] = body.length & 0xFF;
      buf[i * 4 + 3] = body.length >> 8;
      buf.set(body, offset);
      offset += body.length;
    });
    return buf;
  }

  /* ================================================================= apply */

  /* Writes whatever changed. Flags are taken up front so edits made while a
     write is on the wire stay pending and go out on the next pass. */
  async function apply(options = {}) {
    if (!device) return connect();
    const todo = {};
    Object.keys(dirty).forEach((part) => { todo[part] = dirty[part] || !!options.all; dirty[part] = false; });
    if (options.reset) todo.cfg = true;
    setSaveState("saving");
    try {
      if (todo.matrix) {
        const { matrix, used } = buildMatrix();
        await write(CMD.SET_MATRIX, 0, matrix);
        if (used.length) await write(CMD.SET_MACRO, 0, buildMacroBuffer(used), 200);
        todo.matrix = false;
      }
      if (todo.cfg) {
        // Every byte the studio owns is rebuilt from UI state, so the block read
        // on connect / Sync is enough to preserve the rest. Skipping the
        // read-back saves a round trip per lighting change.
        let current = cfg && cfg[CFG.SIG_A] === 0x5A && cfg[CFG.SIG_B] === 0xA5 ? cfg : null;
        if (!current) try {
          current = await readCfg();
        } catch (err) {
          // Without a fresh read, patch the last good block (or a blank one)
          // rather than dropping the change.
          setDiag("diag-error", "config read failed, writing anyway: " + err.message, false);
          current = cfg || new Uint8Array(CFG_LEN);
        }
        cfg = encodeCfg(current, options);
        await write(CMD.SET_CFG, 0, cfg);
        prevBlock = new Uint8Array(cfg);
        todo.cfg = false;
      }
      if (todo.rgbTab) {
        await write(CMD.SET_RGB_TAB, 0, buildRgbTab());
        todo.rgbTab = false;
      }
      if (todo.keyRgb) {
        await write(CMD.SET_KEY_RGB, 0, buildKeyRgb());
        todo.keyRgb = false;
      }
      store();
      lastWrite = performance.now();
      setDiag("diag-error", "—");
      setSaveState("saved");
      if (!options.quiet) toast(options.reset ? "Factory settings restored" : "Saved to keyboard");
    } catch (err) {
      Object.keys(todo).forEach((part) => { if (todo[part]) dirty[part] = true; });
      setDiag("diag-error", err.message, false);
      setSaveState("error");
      toast("Couldn't save to the keyboard. Check the cable and try again.");
    } finally {
      renderDirty();
    }
  }

  /* --------------------------------------------------------- auto-apply */

  const AUTO_DELAY_MS = 450;          // keys, macros: let a burst of edits settle
  const FAST_DELAY_MS = 80;           // lighting: feel immediate
  let autoTimer = null;
  let applying = null;

  function scheduleApply(fast) {
    clearTimeout(autoTimer);
    if (!device) return;
    autoTimer = setTimeout(runAutoApply, fast ? FAST_DELAY_MS : AUTO_DELAY_MS);
  }

  async function runAutoApply() {
    if (!device || !Object.values(dirty).some(Boolean)) return;
    if (recording || applying) { scheduleApply(true); return; }
    applying = apply({ quiet: true });
    try { await applying; } finally { applying = null; }
    if (Object.values(dirty).some(Boolean)) scheduleApply(true);
  }

  function markDirty(part) {
    dirty[part] = true;
    store();
    renderDirty();
    scheduleApply(part === "cfg" || part === "rgbTab");
  }

  let saveState = "";
  function setSaveState(state) {
    saveState = state;
    renderDirty();
  }

  /* Saves happen in the background; only failures are surfaced (as a toast). */
  function renderDirty() {}


  /* ============================================================ keyboard UI */

  const KB_W = 879;
  const KB_H = 399;
  /* Two production layouts share PID 01E7 and the same matrix:
     - "knob":    rotary knob top right, in place of End (retail B75)
     - "classic": End key top right, knob controls top left (vendor artwork) */
  const LAYOUTS = {
    knob: {
      name: "Knob",
      hide: [81],
      // Knob takes End's slot at keycap size; turn left / right sit above it.
      place: { 82: [800.6, 54.6, 847.4, 101.4], 83: [800, 16, 821, 37], 84: [827, 16, 848, 37] },
      short: { 83: "↺", 84: "↻", 82: "" }
    },
    classic: {
      // No knob on this version: its press / turn entries are not shown or
      // remapped (they keep their factory codes in the matrix).
      name: "End key",
      hide: [82, 83, 84],
      place: {},
      short: {}
    }
  };
  const SHORT = { 29: "Home", 44: "PgUp", 80: "PgDn" };

  function layout() {
    return LAYOUTS[saved.layout] || LAYOUTS.knob;
  }

  /* Real keycap geometry on a 75% unit grid (traced from the retail board):
     id -> [column in u, row, width in u]. Row 0 is the F-row; the main block
     starts a quarter unit lower. The vendor rectangles in keymap.js are only
     click targets with wide gaps, so they are not used for drawing. */
  const U = 50;
  const ORIGIN = [36, 53];
  const GAP = 3.2;
  const GRID = (() => {
    const g = {};
    const row = (r, items) => items.forEach(([id, x, w]) => { g[id] = [x, r, w || 1]; });
    const run = (r, first, x, count) => Array.from({ length: count }, (_, i) => [first + i, x + i]);
    row(0, [[1, 0], ...run(0, 2, 1.25, 4), ...run(0, 6, 5.5, 4), ...run(0, 10, 9.75, 4), [14, 14], [81, 15.25]]);
    row(1.25, [...run(1.25, 15, 0, 13), [28, 13, 2], [29, 15.25]]);
    row(2.25, [[30, 0, 1.5], ...run(2.25, 31, 1.5, 12), [43, 13.5, 1.5], [44, 15.25]]);
    row(3.25, [[45, 0, 1.75], ...run(3.25, 46, 1.75, 11), [57, 12.75, 2.25], [80, 15.25]]);
    row(4.25, [[58, 0, 2.25], ...run(4.25, 59, 2.25, 10), [69, 12.25, 1.75], [70, 14.25]]);
    row(5.25, [[71, 0, 1.25], [72, 1.25, 1.25], [73, 2.5, 1.25], [74, 3.75, 6.25], [75, 10, 1.25], [76, 11.25, 1.25],
      [77, 13.25], [78, 14.25], [79, 15.25]]);
    return g;
  })();

  function keyRect(key) {
    const placed = layout().place[key.id];
    if (placed) return { x: placed[0], y: placed[1], w: placed[2] - placed[0], h: placed[3] - placed[1] };
    const cell = GRID[key.id];
    if (cell) {
      return {
        x: ORIGIN[0] + cell[0] * U + GAP / 2,
        y: ORIGIN[1] + cell[1] * U + GAP / 2,
        w: cell[2] * U - GAP,
        h: U - GAP
      };
    }
    const r = key.rect;
    return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] };
  }

  function keyCaption(key) {
    const short = layout().short;
    if (key.id in short) return short[key.id];
    return SHORT[key.id] || key.label;
  }

  /* Line-art case traced from the retail B75: outer shell, inner bezel, key
     well and the iLovbee badge (a small rounded-corner plate, top left). */
  function caseArt() {
    return `<svg class="kb-art" viewBox="0 0 879 399" preserveAspectRatio="none" aria-hidden="true">
      <rect class="art-shell" x="2" y="2" width="875" height="395" rx="30"/>
      <rect class="art-bezel" x="10" y="9" width="859" height="381" rx="24"/>
      <rect class="art-well" x="27" y="45" width="826" height="333" rx="12"/>
      <g class="art-badge">
        <rect x="34" y="17" width="66" height="21" rx="5"/>
        <text x="67" y="31.5" text-anchor="middle">iLovbee</text>
      </g>
    </svg>`;
  }

  function assignmentLabel(key) {
    const a = saved.keys[key.id];
    if (!a) return "";
    if (a.type === "key") {
      const mods = MODS.filter((m) => a.mods & m.bit).map((m) => m.name);
      return mods.concat(HID_NAMES[a.hid] || `0x${a.hid.toString(16)}`).join("+");
    }
    if (a.type === "media") return (MEDIA.find((m) => m[0] === a.usage) || [0, "Media"])[1];
    if (a.type === "raw") return (MOUSE.find((m) => m[0] === a.code) || [0, a.code])[1];
    if (a.type === "macro") return saved.macros[a.macro] ? "M: " + saved.macros[a.macro].name : "Macro?";
    if (a.type === "off") return "Off";
    return "";
  }

  function renderKeyboard() {
    const board = $("kb-board");
    if (!board) return;
    const hidden = layout().hide;
    board.classList.toggle("layout-knob", saved.layout !== "classic");
    board.innerHTML = caseArt() + KEYS.filter((key) => !hidden.includes(key.id)).map((key) => {
      const r = keyRect(key);
      const a = assignmentLabel(key);
      const style = `left:${(r.x / KB_W) * 100}%;top:${(r.y / KB_H) * 100}%;width:${(r.w / KB_W) * 100}%;height:${(r.h / KB_H) * 100}%;`;
      const cls = ["kb-key", key.rect[2] ? "" : "knob", a ? "remapped" : "", selectedKey === key.id ? "selected" : ""].join(" ");
      return `<button type="button" class="${cls}" style="${style}" data-key="${key.id}" title="${esc(key.label)}${a ? " → " + esc(a) : ""}"><span>${esc(keyCaption(key))}</span></button>`;
    }).join("");
    preview.nodes = KEYS.filter((key) => !hidden.includes(key.id)).map((key) => {
      const r = keyRect(key);
      return {
        key,
        el: board.querySelector(`[data-key="${key.id}"]`),
        x: (r.x + r.w / 2) / KB_W,
        y: (r.y + r.h / 2) / KB_H,
        heat: 0
      };
    });
    preview.last = "";
    startPreview();
  }

  /* ------------------------------------------------------ lighting preview */

  /* An approximation of each firmware effect, driven by the selected effect,
     colour slot / colourful, brightness and speed. */
  const preview = { nodes: [], drops: [], snake: 0, raf: 0, lastFrame: 0, nextDrop: 0, last: "" };
  const SNAKE_PATH = [];

  function hsl(h, sat = 1, l = 0.5) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  function pressKey(node, now) {
    if (!node) return;
    node.heat = 1;
    preview.drops.push({ x: node.x, y: node.y, t0: now, hue: Math.random() * 360 });
    if (preview.drops.length > 12) preview.drops.shift();
  }

  function startPreview() {
    if (!preview.raf) preview.raf = requestAnimationFrame(previewFrame);
  }

  function previewFrame(now) {
    preview.raf = requestAnimationFrame(previewFrame);
    if (now - preview.lastFrame < 33) return;
    const dt = Math.min(0.1, (now - preview.lastFrame) / 1000);
    preview.lastFrame = now;

    const nodes = preview.nodes;
    if (!nodes.length) return;
    const perKeyView = activeTab === "tab-perkey" || light.hw === CUSTOM_HW;
    const fx = EFFECTS.find((e) => e.hw === light.hw) || EFFECTS[EFFECTS.length - 1];
    const st = light.effects[fx.hw] || { bright: DEF_BRIGHT, speed: DEF_SPEED, slot: 0, colorful: true };

    if (perKeyView) {
      const sig = "pk" + JSON.stringify(saved.perKey);
      if (sig === preview.last) return;
      preview.last = sig;
      nodes.forEach((n) => paintNode(n, saved.perKey[n.key.idx] ? rgb(saved.perKey[n.key.idx]) : null, 1));
      return;
    }
    preview.last = "";

    if (fx.hw === 0 || (fx.light && st.bright === 0)) {
      nodes.forEach((n) => paintNode(n, null, 0));
      return;
    }

    const level = fx.light ? LIGHT_HW[st.bright] / LIGHT_HW[LIGHT_HW.length - 1] : 1;
    const rate = fx.speed ? 0.35 + st.speed * 0.4 : 0.8;
    const t = now / 1000 * rate;
    const fixed = fx.color && !st.colorful ? rgb(palette(fx.hw)[st.slot]) : null;
    const pick = (hue) => fixed || hsl(hue);

    // Random "presses" drive the reactive and drop-style effects.
    if ([4, 5, 7, 8, 11].includes(fx.hw) && now > preview.nextDrop) {
      pressKey(nodes[Math.floor(Math.random() * nodes.length)], now);
      preview.nextDrop = now + (fx.hw === 8 ? 90 : 520) / rate;
    }
    preview.drops = preview.drops.filter((d) => now - d.t0 < 3000 / rate);

    if (fx.hw === 9) {
      preview.snake = (preview.snake + dt * 14 * rate) % SNAKE_PATH.length;
    }

    nodes.forEach((n, i) => {
      let c = null;
      let a = 1;
      const dx = n.x - 0.5;
      const dy = (n.y - 0.55) * 0.46;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      switch (fx.hw) {
        case 1: c = pick(n.x * 300); break;
        case 2: c = pick(t * 40); a = 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(t * 2.4)); break;
        case 3: c = hsl(t * 70); break;
        case 4: case 5: case 8:
          n.heat = Math.max(0, n.heat - dt * (fx.hw === 8 ? 1.4 : 0.9) * rate);
          c = pick(n.x * 300 + i * 17); a = fx.hw === 8 ? n.heat : 0.04 + n.heat * 0.96;
          break;
        case 6: c = hsl(ang + t * 120); break;
        case 7: case 11: {
          let best = 0;
          let hue = 0;
          preview.drops.forEach((d) => {
            const r = (now - d.t0) / 1000 * rate * 0.45;
            const dd = Math.hypot(n.x - d.x, (n.y - d.y) * 0.46);
            const v = Math.exp(-Math.pow((dd - r) / 0.035, 2)) * Math.max(0, 1 - r / 0.9);
            if (v > best) { best = v; hue = d.hue; }
          });
          c = fx.hw === 11 ? pick(hue) : pick(hue + n.x * 120);
          a = 0.05 + best * 0.95;
          break;
        }
        case 9: {
          const pos = SNAKE_PATH.indexOf(n.key.id);
          let lag = (preview.snake - pos + SNAKE_PATH.length) % SNAKE_PATH.length;
          c = pick(pos * 9);
          a = pos >= 0 && lag < 9 ? 1 - lag / 9 : 0.03;
          break;
        }
        case 10: c = hsl(n.x * 360 - t * 140); break;
        case 12: {
          const yWave = 0.55 + 0.32 * Math.sin(n.x * Math.PI * 3 - t * 3);
          c = pick(n.x * 360 - t * 60);
          a = Math.max(0.05, 1 - Math.abs(n.y - yWave) / 0.22);
          break;
        }
        case 13: c = hsl(ang * 2 + t * 90); a = 0.15 + 0.85 * Math.pow(0.5 + 0.5 * Math.cos((ang * Math.PI / 180 - t * 1.5) * 4), 2); break;
        case 14: c = hsl(n.y * 260 - t * 120 + n.x * 30); break;
        case 15: c = hsl(dist * 700 - t * 120); a = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(dist * 18 - t * 3)); break;
        default: c = pick(n.x * 300);
      }
      paintNode(n, c, a * level);
    });
  }

  function paintNode(n, c, a) {
    if (!n.el) return;
    if (!c || a <= 0.02 || !lightable(n.key)) {
      n.el.classList.remove("lit");
      n.el.style.removeProperty("--kc");
      return;
    }
    const alpha = Math.max(0, Math.min(1, a));
    n.el.classList.add("lit");
    n.el.style.setProperty("--kc", `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0} / ${alpha.toFixed(2)})`);
  }

  function buildSnakePath() {
    // Serpentine over the five main rows (top row left to right, next row back).
    const rows = [0, 1.25, 2.25, 3.25, 4.25, 5.25].map((r) => KEYS.filter((k) => GRID[k.id] && GRID[k.id][1] === r && k.id !== 81)
      .sort((a, b) => GRID[a.id][0] - GRID[b.id][0]));
    rows.forEach((row, i) => (i % 2 ? row.slice().reverse() : row).forEach((k) => SNAKE_PATH.push(k.id)));
  }

  function onKeyClick(id) {
    const key = KEY_BY_ID.get(id);
    if (!key) return;
    if (activeTab === "tab-perkey") {
      if (!lightable(key)) return;
      saved.perKey[key.idx] = paintColor;
      markDirty("keyRgb");
      renderKeyboard();
      return;
    }
    selectedKey = id;
    if (activeTab !== "tab-keys") window.switchTab("tab-keys");
    renderKeyboard();
    renderKeyEditor();
  }

  /* --------------------------------------------------------------- lighting */

  function renderLighting() {
    const grid = $("fx-grid");
    if (grid) {
      grid.innerHTML = EFFECTS.map((e) => `
        <button type="button" class="fx-card${e.hw === light.hw ? " active" : ""}" data-hw="${e.hw}">
          <span class="fx-name">${esc(e.name)}</span>
          <span class="fx-meta">${e.hw === 0 ? "Lights off" : e.hw === CUSTOM_HW ? "Your colours" : [e.color ? "Colour" : "Multicolour", e.speed ? "Speed" : ""].filter(Boolean).join(" · ")}</span>
        </button>`).join("");
    }
    const fx = EFFECTS.find((e) => e.hw === light.hw) || EFFECTS[0];
    const st = light.effects[fx.hw];
    const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
    show("row-bright", !!fx.light);
    show("row-speed", !!fx.speed);
    show("row-color", !!(fx.color || fx.random));
    show("row-custom-hint", fx.hw === CUSTOM_HW);

    segment("seg-bright", st.bright);
    segment("seg-speed", st.speed);

    const sw = $("swatches");
    if (sw) {
      const pal = palette(fx.hw);
      sw.innerHTML = (fx.color ? pal.map((c, i) => `
        <label class="swatch${!st.colorful && st.slot === i ? " active" : ""}" style="--sw:${c}" title="Slot ${i + 1} — click to select, double-click to edit">
          <input type="radio" name="slot" value="${i}" ${!st.colorful && st.slot === i ? "checked" : ""}>
          <input type="color" value="${c}" data-slot="${i}" tabindex="-1">
        </label>`).join("") : "")
        + (fx.random ? `<button type="button" class="swatch rainbow${st.colorful ? " active" : ""}" data-colorful="1" title="Colourful">✦</button>` : "");
    }
  }

  function segment(id, value) {
    document.querySelectorAll(`#${id} .seg-btn`).forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.v) === value);
    });
  }

  /* ------------------------------------------------------------ key editor */

  function renderKeyEditor() {
    const box = $("key-editor");
    if (!box) return;
    const key = KEY_BY_ID.get(selectedKey);
    if (!key) {
      box.innerHTML = `<p class="section-note">Click a key on the keyboard to change what it sends.</p>`;
      return;
    }
    const a = saved.keys[key.id] || { type: "default" };
    const hidOptions = Object.keys(HID_NAMES).map(Number).sort((x, y) => x - y)
      .map((u) => `<option value="${u}" ${a.type === "key" && a.hid === u ? "selected" : ""}>${esc(HID_NAMES[u])}</option>`).join("");
    const mediaOptions = MEDIA.map(([u, n]) => `<option value="${u}" ${a.type === "media" && a.usage === u ? "selected" : ""}>${esc(n)}</option>`).join("");
    const mouseOptions = MOUSE.map(([c, n]) => `<option value="${c}" ${a.type === "raw" && a.code === c ? "selected" : ""}>${esc(n)}</option>`).join("");
    const macroOptions = saved.macros.map((m, i) => `<option value="${i}" ${a.type === "macro" && a.macro === i ? "selected" : ""}>${esc(m.name)}</option>`).join("");

    box.innerHTML = `
      <div class="key-head">
        <span class="key-chip">${esc(key.label)}</span>
      </div>
      <div class="segmented key-types" id="key-type">
        ${[["default", "Default"], ["key", "Key"], ["media", "Media"], ["raw", "Mouse"], ["macro", "Macro"], ["off", "Disable"]]
          .map(([t, n]) => `<button type="button" class="seg-btn${a.type === t ? " active" : ""}" data-type="${t}">${n}</button>`).join("")}
      </div>
      <div class="key-pane" data-pane="key" ${a.type === "key" ? "" : "hidden"}>
        <div class="form-row"><div class="form-info"><div class="form-label">Key</div></div>
          <select id="sel-hid">${hidOptions}</select></div>
        <div class="mod-row">${MODS.map((m) => `<label class="mod"><input type="checkbox" data-mod="${m.bit}" ${a.type === "key" && a.mods & m.bit ? "checked" : ""}>${m.name}</label>`).join("")}</div>
        <button type="button" class="btn-ghost small" id="btn-capture">Press a key to capture…</button>
      </div>
      <div class="key-pane" data-pane="media" ${a.type === "media" ? "" : "hidden"}>
        <div class="form-row"><div class="form-info"><div class="form-label">Media function</div></div><select id="sel-media">${mediaOptions}</select></div>
      </div>
      <div class="key-pane" data-pane="raw" ${a.type === "raw" ? "" : "hidden"}>
        <div class="form-row"><div class="form-info"><div class="form-label">Mouse function</div></div><select id="sel-mouse">${mouseOptions}</select></div>
      </div>
      <div class="key-pane" data-pane="macro" ${a.type === "macro" ? "" : "hidden"}>
        ${saved.macros.length
          ? `<div class="form-row"><div class="form-info"><div class="form-label">Macro</div></div><select id="sel-macro">${macroOptions}</select></div>`
          : `<p class="section-note">No macros yet — create one in the Macros tab.</p>`}
      </div>
      <div class="section-actions">
        <button type="button" class="btn-ghost small" id="btn-key-reset-all">Reset all keys</button>
      </div>`;
  }

  function readKeyEditor(type) {
    const key = KEY_BY_ID.get(selectedKey);
    if (!key) return;
    let a = null;
    if (type === "key") {
      let mods = 0;
      document.querySelectorAll("#key-editor [data-mod]").forEach((el) => { if (el.checked) mods |= Number(el.dataset.mod); });
      a = { type, hid: Number(($("sel-hid") || {}).value || 0x04), mods };
    } else if (type === "media") {
      a = { type, usage: Number(($("sel-media") || {}).value || MEDIA[0][0]) };
    } else if (type === "raw") {
      a = { type, code: ($("sel-mouse") || {}).value || MOUSE[0][0] };
    } else if (type === "macro") {
      if (!saved.macros.length) a = { type: "macro", macro: -1 };
      else a = { type, macro: Number(($("sel-macro") || {}).value || 0) };
    } else if (type === "off") {
      a = { type };
    }
    if (a && !(a.type === "macro" && a.macro < 0)) saved.keys[key.id] = a;
    else delete saved.keys[key.id];
    markDirty("matrix");
    renderKeyboard();
  }

  /* ---------------------------------------------------------------- macros */

  function renderMacros() {
    const list = $("macro-list");
    if (list) {
      list.innerHTML = saved.macros.length
        ? saved.macros.map((m, i) => `
          <div class="macro-item${i === editingMacro ? " active" : ""}" data-macro="${i}">
            <span class="macro-name">${esc(m.name)}</span>
            <span class="macro-meta">${(m.events || []).length} events</span>
          </div>`).join("")
        : `<p class="section-note">No macros. Click <strong>New macro</strong>.</p>`;
    }
    const ed = $("macro-editor");
    if (!ed) return;
    const m = saved.macros[editingMacro];
    if (!m) { ed.hidden = true; return; }
    ed.hidden = false;
    $("inp-macro-name").value = m.name;
    $("sel-macro-mode").value = String(m.mode || 1);
    $("inp-macro-count").value = m.count || 1;
    $("inp-macro-count").disabled = (m.mode || 1) !== 1;
    const rec = $("btn-macro-record");
    if (rec) {
      rec.textContent = recording ? "Stop recording" : "Record";
      rec.classList.toggle("recording", !!recording);
    }
    $("macro-events").innerHTML = (m.events || []).map((ev, i) => `
      <div class="macro-ev" data-ev="${i}">
        <span class="ev-dir ${ev.down ? "down" : "up"}">${ev.down ? "▼" : "▲"}</span>
        <span class="ev-name">${esc(ev.kind === "mouse" ? (["", "Left", "Right", "", "Middle", "", "", "", "Back"][ev.code] || (ev.code === 16 ? "Forward" : "Mouse")) + " button" : (HID_NAMES[ev.code] || "0x" + ev.code.toString(16)))}</span>
        <input type="number" class="input-compact ev-delay" min="0" max="${MACRO_MAX_DELAY}" value="${ev.delay}" data-delay="${i}"> ms
        <button type="button" class="ev-btn" data-up="${i}" title="Move up">↑</button>
        <button type="button" class="ev-btn" data-del="${i}" title="Delete">✕</button>
      </div>`).join("") || `<p class="section-note">Empty — record, or add events below.</p>`;
  }

  function macroChanged() {
    store();
    if (Object.values(saved.keys).some((a) => a.type === "macro")) markDirty("matrix");
    renderMacros();
  }

  function startRecording() {
    const m = saved.macros[editingMacro];
    if (!m) return;
    m.events = [];
    let last = performance.now();
    const held = new Set();
    const handler = (event) => {
      const hid = CODE_TO_HID[event.code];
      if (!hid) return;
      event.preventDefault();
      const down = event.type === "keydown";
      if (down && held.has(hid)) return;
      if (down) held.add(hid); else held.delete(hid);
      const now = performance.now();
      if (m.events.length) m.events[m.events.length - 1].delay = Math.min(MACRO_MAX_DELAY, Math.round(now - last));
      last = now;
      m.events.push({ kind: "key", code: hid, down, delay: 10 });
      if (m.events.length >= 128) stopRecording();
      renderMacros();
    };
    recording = handler;
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", handler, true);
    renderMacros();
  }

  function stopRecording() {
    if (!recording) return;
    window.removeEventListener("keydown", recording, true);
    window.removeEventListener("keyup", recording, true);
    recording = null;
    macroChanged();
  }

  /* -------------------------------------------------------------- settings */

  function renderSettings() {
    const deb = $("seg-debounce");
    if (deb) {
      deb.innerHTML = DEBOUNCE.map((d, i) => `<button type="button" class="seg-btn${saved.debounce === i ? " active" : ""}" data-v="${i}">${d.name}</button>`).join("");
    }
    const sl = $("seg-sleep");
    if (sl) {
      sl.innerHTML = SLEEP.map((s, i) => `<button type="button" class="seg-btn${saved.sleep === i ? " active" : ""}" data-v="${i}">${s.name}</button>`).join("");
    }
  }

  function renderCollections() {
    const box = $("diag-collections");
    if (!box || !device) return;
    box.innerHTML = (device.collections || []).map((c) => {
      const feats = (c.featureReports || []).map((r) => `0x${r.reportId.toString(16)}:${Math.round((r.items || []).reduce((s, it) => s + it.reportSize * it.reportCount, 0) / 8)}B`).join(", ") || "none";
      return `<div class="diag-row"><code>page 0x${hex4(c.usagePage)} / 0x${hex4(c.usage)}</code><span>feature ${feats}</span></div>`;
    }).join("");
  }

  function renderLayoutPicker() {
    const seg = $("seg-layout");
    if (!seg) return;
    seg.innerHTML = Object.entries(LAYOUTS).map(([id, l]) =>
      `<button type="button" class="seg-btn${(saved.layout || "knob") === id ? " active" : ""}" data-layout="${id}">${l.name}</button>`).join("");
  }

  function renderAll() {
    renderLayoutPicker();
    renderLighting();
    renderKeyboard();
    renderKeyEditor();
    renderMacros();
    renderSettings();
    renderDirty();
  }

  /* ================================================================ events */

  function wire_() {
    $("btn-connect")?.addEventListener("click", () => apply({ all: true }));
    $("btn-lock-connect")?.addEventListener("click", () => connect());
    $("btn-sync")?.addEventListener("click", () => sync(false));

    $("seg-layout")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-layout]");
      if (!btn) return;
      saved.layout = btn.dataset.layout;
      if (layout().hide.includes(selectedKey)) selectedKey = null;
      const touchesHidden = layout().hide.some((id) => saved.keys[id]);
      store();
      if (touchesHidden) markDirty("matrix");
      renderKeyEditor();
      renderLayoutPicker();
      renderKeyboard();
    });

    $("kb-board")?.addEventListener("pointerover", (event) => {
      const btn = event.target.closest("[data-key]");
      if (!btn || ![4, 7, 11].includes(light.hw)) return;
      pressKey(preview.nodes.find((n) => n.key.id === Number(btn.dataset.key)), performance.now());
    });

    $("kb-board")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-key]");
      if (btn) onKeyClick(Number(btn.dataset.key));
    });

    $("fx-grid")?.addEventListener("click", (event) => {
      const card = event.target.closest("[data-hw]");
      if (!card) return;
      light.hw = Number(card.dataset.hw);
      markDirty("cfg");
      renderLighting();
      renderKeyboard();
    });

    $("seg-bright")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-v]");
      if (!btn) return;
      light.effects[light.hw].bright = Number(btn.dataset.v);
      markDirty("cfg");
      renderLighting();
    });

    $("seg-speed")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-v]");
      if (!btn) return;
      light.effects[light.hw].speed = Number(btn.dataset.v);
      markDirty("cfg");
      renderLighting();
    });

    const sw = $("swatches");
    sw?.addEventListener("click", (event) => {
      const st = light.effects[light.hw];
      if (event.target.closest("[data-colorful]")) {
        st.colorful = true;
      } else {
        const label = event.target.closest(".swatch");
        const radio = label && label.querySelector("input[type=radio]");
        if (!radio) return;
        if (event.target.type === "color") return;
        st.colorful = false;
        st.slot = Number(radio.value);
      }
      markDirty("cfg");
      renderLighting();
      renderKeyboard();
    });
    sw?.addEventListener("dblclick", (event) => {
      const label = event.target.closest(".swatch");
      const picker = label && label.querySelector("input[type=color]");
      if (picker) picker.click();
    });
    sw?.addEventListener("change", (event) => {
      if (event.target.type !== "color") return;
      const pal = palette(light.hw);
      pal[Number(event.target.dataset.slot)] = event.target.value;
      saved.palettes[light.hw] = pal;
      markDirty("rgbTab");
      renderLighting();
      renderKeyboard();
    });

    $("inp-paint")?.addEventListener("input", (event) => { paintColor = event.target.value; });
    $("btn-paint-all")?.addEventListener("click", () => {
      KEYS.filter(lightable).forEach((key) => { saved.perKey[key.idx] = paintColor; });
      markDirty("keyRgb");
      renderKeyboard();
    });
    $("btn-paint-clear")?.addEventListener("click", () => {
      saved.perKey = {};
      markDirty("keyRgb");
      renderKeyboard();
    });
    $("btn-paint-use")?.addEventListener("click", () => {
      light.hw = CUSTOM_HW;
      markDirty("cfg");
      markDirty("keyRgb");
      renderLighting();
      renderKeyboard();
    });

    const editor = $("key-editor");
    editor?.addEventListener("click", (event) => {
      const t = event.target.closest("[data-type]");
      if (t) {
        const type = t.dataset.type;
        if (type === "default") {
          delete saved.keys[selectedKey];
          markDirty("matrix");
          renderKeyboard();
        } else {
          readKeyEditor(type);
        }
        renderKeyEditor();
        return;
      }
      if (event.target.id === "btn-key-reset-all") {
        saved.keys = {};
        markDirty("matrix");
        renderKeyboard();
        renderKeyEditor();
      }
      if (event.target.id === "btn-capture") {
        const btn = event.target;
        btn.textContent = "Waiting for a key…";
        const once = (ev) => {
          ev.preventDefault();
          window.removeEventListener("keydown", once, true);
          const hid = CODE_TO_HID[ev.code];
          if (hid) {
            const mods = (ev.ctrlKey ? 1 : 0) | (ev.shiftKey ? 2 : 0) | (ev.altKey ? 4 : 0) | (ev.metaKey ? 8 : 0);
            saved.keys[selectedKey] = { type: "key", hid, mods: hid >= 0xE0 ? 0 : mods };
            markDirty("matrix");
            renderKeyboard();
          }
          renderKeyEditor();
        };
        window.addEventListener("keydown", once, true);
      }
    });
    editor?.addEventListener("change", () => {
      const active = editor.querySelector("#key-type .seg-btn.active");
      if (active && active.dataset.type !== "default") readKeyEditor(active.dataset.type);
    });

    $("btn-macro-new")?.addEventListener("click", () => {
      if (saved.macros.length >= MACRO_LIMIT) { toast(`You can create up to ${MACRO_LIMIT} macros`); return; }
      saved.macros.push({ name: "Macro " + (saved.macros.length + 1), mode: 1, count: 1, events: [] });
      editingMacro = saved.macros.length - 1;
      macroChanged();
    });
    $("macro-list")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-macro]");
      if (!item) return;
      stopRecording();
      editingMacro = Number(item.dataset.macro);
      renderMacros();
    });
    $("inp-macro-name")?.addEventListener("input", (event) => {
      const m = saved.macros[editingMacro];
      if (m) { m.name = event.target.value.slice(0, 40) || "Macro"; macroChanged(); }
    });
    $("sel-macro-mode")?.addEventListener("change", (event) => {
      const m = saved.macros[editingMacro];
      if (m) { m.mode = Number(event.target.value); macroChanged(); }
    });
    $("inp-macro-count")?.addEventListener("change", (event) => {
      const m = saved.macros[editingMacro];
      if (m) { m.count = Math.max(1, Math.min(255, Number(event.target.value) || 1)); macroChanged(); }
    });
    $("btn-macro-record")?.addEventListener("click", () => (recording ? stopRecording() : startRecording()));
    $("btn-macro-delete")?.addEventListener("click", () => {
      if (editingMacro < 0) return;
      stopRecording();
      saved.macros.splice(editingMacro, 1);
      Object.keys(saved.keys).forEach((id) => {
        const a = saved.keys[id];
        if (a.type !== "macro") return;
        if (a.macro === editingMacro) delete saved.keys[id];
        else if (a.macro > editingMacro) a.macro -= 1;
      });
      editingMacro = -1;
      markDirty("matrix");
      macroChanged();
      renderKeyboard();
    });
    $("btn-macro-add")?.addEventListener("click", () => {
      const m = saved.macros[editingMacro];
      if (!m) return;
      const v = $("sel-macro-add").value;
      const [kind, code] = v.split(":");
      const c = Number(code);
      m.events.push({ kind, code: c, down: true, delay: 20 }, { kind, code: c, down: false, delay: 20 });
      macroChanged();
    });
    $("macro-events")?.addEventListener("click", (event) => {
      const m = saved.macros[editingMacro];
      if (!m) return;
      const del = event.target.closest("[data-del]");
      const up = event.target.closest("[data-up]");
      if (del) m.events.splice(Number(del.dataset.del), 1);
      if (up) {
        const i = Number(up.dataset.up);
        if (i > 0) [m.events[i - 1], m.events[i]] = [m.events[i], m.events[i - 1]];
      }
      if (del || up) macroChanged();
    });
    $("macro-events")?.addEventListener("change", (event) => {
      const m = saved.macros[editingMacro];
      const i = event.target.dataset.delay;
      if (!m || i === undefined) return;
      m.events[Number(i)].delay = Math.max(0, Math.min(MACRO_MAX_DELAY, Number(event.target.value) || 0));
      macroChanged();
    });

    $("seg-debounce")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-v]");
      if (!btn) return;
      saved.debounce = Number(btn.dataset.v);
      markDirty("cfg");
      renderSettings();
    });
    $("seg-sleep")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-v]");
      if (!btn) return;
      saved.sleep = Number(btn.dataset.v);
      markDirty("cfg");
      renderSettings();
    });
    $("btn-factory")?.addEventListener("click", async () => {
      if (!device) return;
      if (!confirm("Restore factory settings? This clears lighting, key assignments and macros on the keyboard.")) return;
      saved.keys = {};
      saved.perKey = {};
      saved.palettes = {};
      EFFECTS.forEach((e) => { light.effects[e.hw] = { bright: DEF_BRIGHT, speed: DEF_SPEED, slot: 0, colorful: true }; });
      light.hw = 9;
      store();
      await apply({ all: true, reset: true });
      await sync(true);
    });
    $("btn-write-all")?.addEventListener("click", () => apply({ all: true }));

    $("btn-read-cfg")?.addEventListener("click", () => sync(false));
    $("btn-read-psd")?.addEventListener("click", async () => {
      try { setDiag("diag-psd", hex(await read(CMD.GET_PSD, 1, 6)), true); } catch (err) { setDiag("diag-psd", err.message, false); }
    });
    $("btn-read-power")?.addEventListener("click", readPower);
    $("btn-pair-any")?.addEventListener("click", () => connect([{ vendorId: VID, productId: PID }]));
    $("btn-pair-scan")?.addEventListener("click", () => connect([{ vendorId: VID }]));
    $("btn-copy-diag")?.addEventListener("click", () => {
      const text = ["diag-product", "diag-ids", "diag-interface", "diag-last", "diag-error", "diag-power", "diag-psd", "diag-decode", "diag-cfg"]
        .map((id) => `${id}: ${($(id) || {}).textContent || ""}`).join("\n") + "\n\n" + wire.join("\n");
      navigator.clipboard?.writeText(text).then(() => toast("Diagnostics copied"));
    });

    document.addEventListener("cheshub:tabchange", (event) => {
      activeTab = event.detail.tabId;
      if (activeTab !== "tab-macro") stopRecording();
      renderKeyboard();
    });
  }

  function populateStatic() {
    const add = $("sel-macro-add");
    if (add) {
      add.innerHTML = Object.keys(HID_NAMES).map(Number).sort((a, b) => a - b)
        .map((u) => `<option value="key:${u}">${esc(HID_NAMES[u])}</option>`).join("")
        + [[1, "Left"], [2, "Right"], [4, "Middle"], [8, "Back"], [16, "Forward"]]
          .map(([c, n]) => `<option value="mouse:${c}">Mouse ${n}</option>`).join("");
    }
    const mode = $("sel-macro-mode");
    if (mode) mode.innerHTML = MACRO_MODES.map((m) => `<option value="${m.hw}">${m.name}</option>`).join("");
    const bright = $("seg-bright");
    if (bright) bright.innerHTML = LIGHT_HW.map((v, i) => `<button type="button" class="seg-btn" data-v="${i}">${i === 0 ? "Off" : i * 25 + "%"}</button>`).join("");
    const speed = $("seg-speed");
    if (speed) speed.innerHTML = Array.from({ length: SPEED_MAX + 1 }, (_, i) => `<button type="button" class="seg-btn" data-v="${i}">${i + 1}</button>`).join("");
    const paint = $("inp-paint");
    if (paint) paint.value = paintColor;
  }

  window.addEventListener("DOMContentLoaded", async () => {
    buildSnakePath();
    populateStatic();
    wire_();
    renderAll();
    await autoConnect();
  });

  /* Exposed for the console and the protocol notes. */
  window.B75 = { read, write, CMD, buildMatrix, buildRgbTab, buildKeyRgb, encodeCfg, encodeMacro, get cfg() { return cfg; } };
})();

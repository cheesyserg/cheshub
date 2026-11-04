/* TECKNET TK-GM012 — ChesHub driver
 *
 * Feature set and defaults come from the vendor's device descriptor,
 * device/mouse_tk-gm012.xml, and the action labels from language/1033.lan.
 * Wire protocol: see docs/PROTOCOL.md.
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
  RATE: 0x02,
  DPI: 0x03,
  DPI_COLOR: 0x04,
  POWER: 0x07,
  KEY_MACRO: 0x08,
  KEY_ALL: 0x09,
  LIGHT_RESET: 0x0E,
  FACTORY: 0x0F,
  /* Reads are their own command numbers, write + 0x10. Captured on launch:
     0x10..0x17 then 0x20, all answered back-to-back. */
  INFO: 0x10,
  KEYS_READ: 0x11,
  RATE_READ: 0x12,
  DPI_READ: 0x13,
  DPI_COLOR_READ: 0x14,
  SENSOR_READ: 0x16,
  POWER_READ: 0x17
};

const RATE_CODES = { 1000: 1, 500: 2, 250: 4, 125: 8 };

/* Sleep timeout options from the vendor UI, in minutes. The firmware stores
   minutes * 6: 1 min -> 0x06, 30 min -> 0xB4 (180), confirmed from captures. */
const SLEEP_OPTIONS = [1, 2, 5, 6, 10, 15, 20, 30];
const SLEEP_UNIT = 6;

function nearestSleep(minutes) {
  return SLEEP_OPTIONS.reduce((best, option) =>
    Math.abs(option - minutes) < Math.abs(best - minutes) ? option : best,
    SLEEP_OPTIONS[0]);
}

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
  { name: 201, value: 0, side: "left", physical: "Left" },
  { name: 202, value: 1, side: "right", physical: "Right" },
  { name: 203, value: 2, side: "right", physical: "Middle" },
  { name: 204, value: 4, side: "left", physical: "Forward" },
  { name: 205, value: 3, side: "left", physical: "Back" },
  { name: 206, value: 5, side: "right", dashed: true, physical: "DPI" }
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
   Record index is key_value, not visual order. Double-click and scroll come
   from SetMouseKeyMacroData's func_type 1 switch and are not capture-verified. */
const KEY_RECORDS = {
  "Left-Click":  [0x10, 0x01, 0x00],
  "Right-Click": [0x10, 0x02, 0x00],
  "Middle-Click": [0x10, 0x04, 0x00],
  "Backward":    [0x10, 0x08, 0x00],
  "Forward":     [0x10, 0x10, 0x00],
  "Double-Click": [0x30, 0x32, 0x03],
  "Scroll Up":   [0x20, 0x01, 0x00],
  "Scroll Down": [0x20, 0xFF, 0x00],
  "Scroll Left": [0x10, 0x00, 0xF5],
  "Scroll Right": [0x10, 0x00, 0xF6],
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

/* Macro records (command 0x08), recovered from
   DeviceMainDlg::GetMouseMacroData @ 0x1C280. Each event is four bytes:

     [0] class   [1..2] delay after the event, LE ms   [3] parameter

   0x30 keyboard down   0xB0 keyboard up   parameter = HID keyboard usage
   0x20 modifier down   0xA0 modifier up   parameter = modifier bit
   0x10 mouse down      0x90 mouse up      parameter = HID button bit

   The delay sits in the record it follows, so the final event can carry a
   trailing pause. Delay 1 ms is the vendor's minimum. */
const MACRO_ACTIONS = {
  keyboardDown: 0x30, keyboardUp: 0xB0,
  modifierDown: 0x20, modifierUp: 0xA0,
  mouseDown: 0x10, mouseUp: 0x90
};

/* Mouse button bits for macro records (parameter byte). Same encoding the
   vendor's Insert Event menu uses for Mouse Down / Mouse Up. */
const MACRO_MOUSE_BUTTONS = {
  Left:    { bit: 0x01, label: "Left button" },
  Right:   { bit: 0x02, label: "Right button" },
  Middle:  { bit: 0x04, label: "Middle button" },
  Back:    { bit: 0x08, label: "Back button" },
  Forward: { bit: 0x10, label: "Forward button" }
};

/* Insert-menu order for manual events. Every code exists in HID_USAGE or
   MODIFIER_BITS, so buildMacroRecords can always encode it. */
const MACRO_INSERT_KEYS = (() => {
  const out = [];
  const add = (value, label) => out.push({ value, label });
  for (let i = 0; i < 26; i++) add(`Key${String.fromCharCode(65 + i)}`, String.fromCharCode(65 + i));
  for (let i = 1; i <= 9; i++) add(`Digit${i}`, String(i));
  add("Digit0", "0");
  for (let i = 1; i <= 12; i++) add(`F${i}`, `F${i}`);
  add("Escape", "Esc"); add("Tab", "Tab"); add("CapsLock", "Caps Lock");
  add("ShiftLeft", "Left Shift"); add("ShiftRight", "Right Shift");
  add("ControlLeft", "Left Ctrl"); add("ControlRight", "Right Ctrl");
  add("AltLeft", "Left Alt"); add("AltRight", "Right Alt");
  add("MetaLeft", "Left Win"); add("MetaRight", "Right Win");
  add("Space", "Space"); add("Enter", "Enter"); add("Backspace", "Backspace");
  add("Delete", "Delete"); add("Insert", "Insert"); add("Home", "Home"); add("End", "End");
  add("PageUp", "Page Up"); add("PageDown", "Page Down");
  add("ArrowUp", "Up"); add("ArrowDown", "Down");
  add("ArrowLeft", "Left"); add("ArrowRight", "Right");
  add("PrintScreen", "Print Screen"); add("ScrollLock", "Scroll Lock"); add("Pause", "Pause");
  add("ContextMenu", "Menu");
  add("Minus", "-"); add("Equal", "="); add("BracketLeft", "["); add("BracketRight", "]");
  add("Backslash", "\\"); add("Semicolon", ";"); add("Quote", "'");
  add("Backquote", "`"); add("Comma", ","); add("Period", "."); add("Slash", "/");
  add("IntlBackslash", "Intl \\");
  add("NumLock", "Num Lock"); add("NumpadDivide", "Num /"); add("NumpadMultiply", "Num *");
  add("NumpadSubtract", "Num -"); add("NumpadAdd", "Num +"); add("NumpadEnter", "Num Enter");
  add("NumpadDecimal", "Num ."); add("NumpadEqual", "Num =");
  for (let i = 1; i <= 9; i++) add(`Numpad${i}`, `Num ${i}`);
  add("Numpad0", "Num 0");
  return out;
})();

const MACRO_KEY_LABELS = Object.fromEntries(MACRO_INSERT_KEYS.map((k) => [k.value, k.label]));

function isMouseStep(step) {
  return step.source === "mouse" || (step.source === undefined && MACRO_MOUSE_BUTTONS[step.key] !== undefined);
}

function macroStepLabel(step) {
  if (isMouseStep(step)) return (MACRO_MOUSE_BUTTONS[step.key] || {}).label || step.key;
  return MACRO_KEY_LABELS[step.key] || step.key;
}

/* KeyboardEvent.code -> USB HID keyboard usage, the values
   ProtocolData::GetFlashKeyCode @ 0x4D7A0 returns for Windows VKs. */
const HID_USAGE = (() => {
  const map = {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2A, Tab: 0x2B, Space: 0x2C,
    Minus: 0x2D, Equal: 0x2E, BracketLeft: 0x2F, BracketRight: 0x30,
    Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
    Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
    PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49,
    Home: 0x4A, PageUp: 0x4B, Delete: 0x4C, End: 0x4D, PageDown: 0x4E,
    ArrowRight: 0x4F, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55,
    NumpadSubtract: 0x56, NumpadAdd: 0x57, NumpadEnter: 0x58,
    NumpadDecimal: 0x63, IntlBackslash: 0x64, ContextMenu: 0x65,
    NumpadEqual: 0x67
  };
  for (let i = 0; i < 26; i++) map[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
  for (let i = 0; i < 9; i++) map[`Digit${i + 1}`] = 0x1E + i;
  map.Digit0 = 0x27;
  for (let i = 1; i <= 12; i++) map[`F${i}`] = 0x39 + i;
  for (let i = 1; i <= 9; i++) map[`Numpad${i}`] = 0x58 + i;
  map.Numpad0 = 0x62;
  return map;
})();

/* ProtocolData::GetSysKeyCode @ 0x4DDB0 returns these bits for the modifier
   VKs. The mouse tracks eight modifier slots, so each physical modifier gets
   its own bit. */
const MODIFIER_BITS = {
  ShiftLeft: 0x20, ShiftRight: 0x01,
  ControlLeft: 0x10, ControlRight: 0x04,
  AltLeft: 0x40, AltRight: 0x80,
  MetaLeft: 0x08, MetaRight: 0x02
};

const MACRO_MAX_EVENTS = 6;   // 6 * 4 + 1 = 25 bytes, inside the 27-byte payload

const DEFAULTS = {
  dpi: [
    { value: 800,   color: "#FF0000" },
    { value: 1600,  color: "#00FF00" },
    { value: 2400,  color: "#0000FF" },
    { value: 3200,  color: "#FFFF00" },
    { value: 6400,  color: "#FE1966" },
    { value: 12000, color: "#FF4400" }
  ],
  rate: 1000,         // report_rate default_value="1" == 1000 Hz (code 1)
  dpiCount: 6,        // dpi_count: low nibble of 0x03 payload[0]
  dpiIndex: 1,        // default_dpi="2" is 1-based -> index 1
  sleep: 30,          // minutes; wire code is minutes * 6 (XML sleep_light="180")
  sleepVersion: 3,    // state migration marker for the power payload layout
  moveWake: false,    // move_wakeup value="0", payload index 1
  powerAux: 1,        // payload index 2; constant 1 in every capture, echoed back
  keys: ["Left-Click", "Right-Click", "Middle-Click", "Forward", "Backward", "DPI Loop"],
  keyRecords: null    // raw 3-byte 0x09 records, filled by readKeys()
};

/* default_dpi="2" is 1-based, so the second stage is active out of the box. */
const DEFAULT_STAGE = 1;

let state = structuredClone(DEFAULTS);
let hidDevice = null;
let deviceInfo = null;
let batteryLevel = null;
let charging = false;
let linkState = null;
let pollTimer = null;
let pending = null;
let lastWriteError = "";
let lastResult = "—";
let selectedStage = DEFAULT_STAGE;
let outputReportId = 0;
let sendLayout = null;   // null = unknown, 0 = 32-byte payload, 1 = 33 bytes as-is
let probing = false;
let macroSteps = [];
let macroTarget = 5;          // visual key index; 5 = the DPI-loop key
let macroMode = "once";      // once | repeat | toggle | hold
let macroRepeat = 1;
let lastStepAt = 0;          // timestamp of the previous recorded event, for auto delays
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

/* One write, then wait for an input report that matches the command and has
   status 0. DriverComm::SetDeviceData does the same: it retries hid_read up to
   50 times at 30 ms and only accepts `buf[1] == 0`, so a stale or rejected
   acknowledgement must not be mistaken for the answer. */
function exchange(bytes, timeoutMs, accept) {
  return new Promise(async (resolve) => {
    let timer = null;
    let last = null;
    const settle = (reply) => {
      if (reply && reply.length) last = reply;
      if (reply && accept && !accept(reply)) return;   // keep waiting
      clearTimeout(timer);
      if (pending === settle) pending = null;
      resolve(reply || null);
    };
    pending = settle;
    timer = setTimeout(() => {
      if (pending === settle) pending = null;
      resolve(last && accept && !accept(last) ? null : last);
    }, timeoutMs);

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
  return {
    ok: status === 0,
    reply,
    status,
    silent: false,
    error: status === 0 ? undefined : `device rejected command 0x${cmd.toString(16)} (status ${status})`
  };
}

async function sendCommand(cmd, payload, lenByte, opts = {}) {
  if (!hidDevice || !hidDevice.opened) {
    lastResult = "not connected";
    return { ok: false, error: "not connected" };
  }
  const frame = buildFrame(cmd, payload, lenByte, opts.isWrite !== false);
  let lastErr = "";
  const accept = (reply) => reply.length > 1 && reply[0] === cmd && reply[1] === 0;

  for (const bytes of candidatePayloads(frame)) {
    lastWriteError = "";
    const first = await exchange(bytes, FIRST_WAIT, accept);
    if (lastWriteError) {
      lastErr = lastWriteError;
      continue;                       // wrong report length, try the other form
    }
    if (sendLayout === null) sendLayout = bytes.length === 32 ? 0 : 1;
    if (first && first.length) return describeReply(cmd, first);

    // Accepted by the OS but quiet so far — give the link a longer window.
    const second = await exchange(bytes, RETRY_WAIT, accept);
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

/* Reply layout, confirmed against a live capture:
 *   [1] status  [4..7] "L93Q" device id  [10] device type  [12] charging
 *   [13] battery 0..100  [14] link state  [31] checksum
 * GetMouseData stores the same three bytes into 0x88b/0x88c/0x88a. */
function applyDeviceInfo(reply) {
  if (!reply || reply.length < 15) return;
  const level = reply[13];
  batteryLevel = level >= 1 && level <= 100 ? level : null;
  charging = reply[12] === 1;
  linkState = reply[14];
}

async function readBattery() {
  const info = await readDeviceInfo();
  if (info.reply) applyDeviceInfo(info.reply);
  updateHud();
  updateDiagnostics();
  return info;
}

/* The vendor tool reads its whole configuration on launch: 0x10..0x17, in that
   order, all answered immediately. Each reply is the write layout echoed back,
   so the same decoders used for display apply. */
async function readRate() {
  const res = await sendCommand(CMD.RATE_READ, [], 0, { isWrite: false });
  if (!res.reply || res.reply.length < 5) return false;
  const hz = Object.keys(RATE_CODES).find(
    (k) => RATE_CODES[k] === res.reply[4]);
  if (hz) state.rate = Number(hz);
  return !!hz;
}

async function readDpi() {
  const res = await sendCommand(CMD.DPI_READ, [], 0, { isWrite: false });
  if (!res.reply || res.reply.length < 29) return false;
  const packed = res.reply[4];
  const count = packed & 0x0F;
  const index = (packed >> 4) & 0x0F;
  if (count >= 1 && count <= 6) state.dpiCount = count;
  if (index >= 0 && index < 6) {
    state.dpiIndex = Math.min(index, Math.max(0, state.dpiCount - 1));
    selectedStage = state.dpiIndex;
  }
  for (let i = 0; i < 6; i++) {
    const base = 5 + i * 4;                 // [4] is the packed index/count
    const code = res.reply[base] | (res.reply[base + 1] << 8);
    state.dpi[i].value = decodeDpi(code);
  }
  return true;
}

async function readDpiColors() {
  const res = await sendCommand(CMD.DPI_COLOR_READ, [], 0, { isWrite: false });
  if (!res.reply || res.reply.length < 22) return false;
  for (let i = 0; i < 6; i++) {
    const base = 4 + i * 3;
    const hex = "#" + [0, 1, 2].map((k) =>
      res.reply[base + k].toString(16).padStart(2, "0")).join("");
    state.dpi[i].color = hex.toUpperCase();
  }
  return true;
}

/* Names for the 0x09 record classes. Unknown bindings keep a friendly class
   label and stay byte-for-byte in state.keyRecords; the raw bytes are shown in
   the diagnostics report. */
const KEY_CLASS_NAMES = {
  0x10: "Mouse Button",
  0x20: "Scroll",
  0x30: "Double-Click / Speed",
  0x40: "DPI",
  0x60: "Special",
  0x70: "Keyboard Shortcut",
  0x80: "Media",
  0x90: "Macro"
};

function describeKeyRecord(record) {
  const joined = record.join(",");
  for (const [name, rec] of Object.entries(KEY_RECORDS)) {
    if (rec.join(",") === joined) return name;
  }
  if (record[0] === 0x90) return "Macro";
  return KEY_CLASS_NAMES[record[0] & 0xF0] || "Custom Action";
}

async function readKeys() {
  const res = await sendCommand(CMD.KEYS_READ, [], 0, { isWrite: false });
  if (!res.reply || res.reply.length < 22) return false;
  const records = new Array(6);
  for (let value = 0; value < 6; value++) {
    const record = Array.from(res.reply.slice(4 + value * 3, 7 + value * 3));
    const visual = KEYS.findIndex((k) => k.value === value);
    if (visual < 0) continue;
    records[visual] = record;
    if (record[0] === 0x90) {
      // Key binding to a macro slot. [1] = key_value | loop flag, [2] = loop count.
      // Vendor mapping (SetMouseKeyMacroData @ 0x33EA0):
      //   0x10 = loop until the button is released ("Loops Until Stop Pressing")
      //   0x20 = play a fixed number of times ("Loop Times", [2] = count)
      //   0x40 = loop until any click ("Loops Until Any Click")
      state.keys[visual] = "Macro";
      const flag = record[1] & 0xF0;
      const loops = record[2] || 1;
      if (flag === 0x10) macroMode = "hold";
      else if (flag === 0x40) macroMode = "toggle";
      else if (flag === 0x20) macroMode = loops <= 1 ? "once" : "repeat";
      else macroMode = "once";
      macroRepeat = loops;
      macroTarget = visual;
      continue;
    }
    state.keys[visual] = describeKeyRecord(record);
  }
  state.keyRecords = records;
  return true;
}

/* Reply payload starts at [4]: [sleep][wake][aux][close]. Verified against the
   vendor launch traffic `17 00 01 05 1e 00 01 00 00` (sleep 5 min, wake off,
   aux 1). Reading the old index 2 picked up the constant aux byte, so the UI
   always showed move wake as enabled. */
async function readPower() {
  const res = await sendCommand(CMD.POWER_READ, [], 0, { isWrite: false });
  if (!res.reply || res.reply.length < 7) return false;
  const wire = res.reply[4];
  if (wire > 0) {
    const minutes = wire / SLEEP_UNIT;
    state.sleep = SLEEP_OPTIONS.includes(minutes) ? minutes : Math.round(minutes * 10) / 10;
  }
  state.moveWake = res.reply[5] === 1;
  state.powerAux = res.reply[6] === 0 ? 0 : 1;
  return true;
}

async function syncFromDevice() {
  if (!hidDevice || !hidDevice.opened) return false;
  await readBattery();
  await readKeys();
  await readRate();
  await readDpi();
  await readDpiColors();
  await readPower();
  refreshUI();
  updateHud();
  updateDiagnostics();
  saveState();
  return true;
}

/* -------------------------------------------------------------------- apply */

async function applyRate() {
  return sendCommand(CMD.RATE, [RATE_CODES[state.rate] || 1], 1);
}

async function applyDpi() {
  const payload = new Array(25).fill(0);
  // byte 0 packs the active stage (high nibble) and stage count (low nibble).
  // SetMouseDPIData does `(dpi_index << 4) | dpi_count`.
  const index = Math.max(0, Math.min(5, state.dpiIndex));
  const count = Math.max(1, Math.min(6, state.dpiCount));
  const active = Math.max(0, Math.min(count - 1, index));
  state.dpiIndex = active;
  payload[0] = ((active & 0x0F) << 4) | (count & 0x0F);
  for (let i = 0; i < 6; i++) {
    const code = encodeDpi(state.dpi[i].value);
    const base = 1 + i * 4;                    // six 4-byte records after byte 0
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

/* Payload is [sleep][wake][aux][close]. Captured from the vendor tool:
     wake off: 07 00 01 04 24 00 01 00
     wake on:  07 00 01 04 24 01 01 00
   so move wake-up is payload index 1. move_closelight has no UI on this model
   (custom show_* = 0); its slot is written as 0 and `aux` is echoed back from
   the device instead of being forced to a literal. */
async function applyPower() {
  const wire = Math.max(1, Math.min(255, Math.round(state.sleep * SLEEP_UNIT)));
  return sendCommand(CMD.POWER, [wire, state.moveWake ? 1 : 0, state.powerAux ? 1 : 0, 0], 4);
}

/* Command 0x09 carries all six bindings as 3-byte records, ordered by
   key_value. Verified against captures: key 204 (key_value 4) lands in record
   4, key 205 (key_value 3) in record 3. The vendor sends a length byte of 0x0f
   even though six records follow, so that constant is copied verbatim. */
async function applyKeys() {
  const records = new Array(6);
  if (!Array.isArray(state.keyRecords)) state.keyRecords = new Array(6);
  for (let i = 0; i < KEYS.length; i++) {
    const value = KEYS[i].value;
    const action = state.keys[i];
    let record = null;

    if (action === "Macro") {
      const raw = Array.isArray(state.keyRecords[i]) ? state.keyRecords[i] : null;
      if (raw && raw[0] === 0x90 && i !== macroTarget) {
        // Another macro key read from the mouse keeps its own mode/repeat.
        record = raw.slice();
      } else {
        /* 0x90 = macro slot. [1] = key_value | loop flag, [2] = loop count.
           There is no dedicated "play once" flag in the firmware: the vendor
           expresses it as "Loop Times" with a count of 1 (flag 0x20). Flag
           0x10 is "loop until the button is released", which is why binding a
           macro to 0x10 made a single click emit a long run of keystrokes. */
        const flag = macroMode === "hold" ? 0x10 : macroMode === "toggle" ? 0x40 : 0x20;
        const loops = flag === 0x20
          ? Math.max(1, Math.min(255, macroMode === "once" ? 1 : macroRepeat))
          : 0;
        record = [0x90, value | flag, loops];
      }
    } else if (KEY_RECORDS[action]) {
      record = KEY_RECORDS[action].slice();
    } else if (!KEY_ACTIONS.includes(action) && Array.isArray(state.keyRecords[i])) {
      // A binding read from the mouse that this studio cannot name. Preserve
      // its exact bytes instead of overwriting it with a default.
      record = state.keyRecords[i].slice();
    }

    if (!record) return { ok: false, error: `"${action}" is not encodable` };
    records[value] = record;
    state.keyRecords[i] = record.slice();
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
  deviceInfo = null;
  batteryLevel = null;
  charging = false;
  linkState = null;
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
  applyDeviceInfo(deviceInfo);
  if (deviceInfo) {
    startPolling();
    await syncFromDevice();      // same read sweep the vendor tool does on launch
  }

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
/* Battery is read out of the 0x10 reply, so refresh it slowly — every 30 s is
   plenty and keeps the 2.4G link from being woken constantly. */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!hidDevice || !hidDevice.opened) {
      stopPolling();
      return;
    }
    if (pending) return;      // a command is already waiting for its reply
    readBattery();
  }, 30000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

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
  const mode = $("hud-mode");
  const connectBtn = $("btn-connect");
  if (connectBtn) connectBtn.textContent = online ? "Apply" : "Connect";
  if (mode) {
    if (!online || !hidDevice) mode.textContent = "None";
    else if (hidDevice.vendorId === WIRELESS.vendorId) mode.textContent = "2.4 GHz";
    else mode.textContent = charging ? "USB · charging" : "USB wired";
  }

  const text = $("hud-battery-text");
  const bar = $("hud-battery-bar");
  const pct = online ? batteryLevel : null;
  if (text) {
    if (pct === null) text.textContent = online ? "n/a" : "--%";
    else text.textContent = `${pct}%${charging ? " ⚡" : ""}`;
    text.style.color = pct !== null && pct <= 20 ? "#e05561" : "";
  }
  if (bar) {
    bar.style.width = pct === null ? "0%" : `${pct}%`;
    bar.style.background = pct !== null && pct <= 20 ? "#e05561" : "";
  }

  if (online && window.ChesHubRegistry) {
    window.ChesHubRegistry.saveTelemetry(document.body.dataset.device, {
      battery: batteryLevel,
      charging,
      mode: hidDevice.vendorId === WIRELESS.vendorId ? "2.4 GHz" : "USB"
    });
  }

  window.ChesHub?.setConnected(online);
}

function updateDiagnostics() {
  const set = (id, text, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove("diag-ok", "diag-bad");
    if (cls) el.classList.add("diag-" + cls);
  };

  if (!hidDevice) {
    set("diag-product", "not connected");
    set("diag-ids", "—");
    set("diag-interface", "—");
    set("diag-info", "—");
    set("diag-battery", "—");
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
  set("diag-battery",
      `${batteryLevel === null ? "—" : batteryLevel + "%"}`
      + `${charging ? " charging" : ""}`
      + `${linkState === null ? "" : " · link " + linkState}`,
      batteryLevel === null ? "" : "ok");
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

function buildKeySelects() {
  for (let i = 0; i < KEYS.length; i++) {
    const select = $("btn-select-" + i);
    if (!select) continue;
    const current = state.keys[i] || "Disable Key";
    const actions = KEY_ACTIONS.filter((a) => KEY_RECORDS[a] || a === "Macro");
    const raw = state.keyRecords && Array.isArray(state.keyRecords[i]) ? state.keyRecords[i] : null;
    const rawLabel = raw ? describeKeyRecord(raw) : null;
    // Keep a binding read from the mouse even when it is not in the built-in
    // action list, so the dropdown reflects the hardware rather than the XML.
    if (rawLabel && !actions.includes(rawLabel)) actions.unshift(rawLabel);
    if (!actions.includes(current)) actions.unshift(current);
    select.innerHTML = actions
      .map((a) => `<option${a === current ? " selected" : ""}>${a}</option>`)
      .join("");
    select.onchange = () => {
      state.keys[i] = select.value;
      const label = $("anchor-label-" + i);
      if (label) label.textContent = `${i + 1}. ${select.value}`;
      if (select.value === "Macro") {
        macroTarget = i;
        const bind = $("sel-macro-key");
        if (bind) bind.value = String(i);
        switchTab("tab-macro");
        showToast("Record a sequence, then UPLOAD TO MOUSE");
      }
      saveState();
    };
    const label = $("anchor-label-" + i);
    if (label) label.textContent = `${i + 1}. ${current}`;
  }
}

function updateDpiCaption() {
  const caption = $("caption-dpi");
  if (!caption) return;
  caption.textContent = `${state.dpiCount} DPI stage${state.dpiCount === 1 ? "" : "s"}`;
}

function buildDpiCards() {
  const grid = $("dpi-grid");
  if (!grid) return;
  grid.innerHTML = state.dpi.map((stage, i) => `
    <button class="dpi-card${i === selectedStage ? " active" : ""}${i >= state.dpiCount ? " inactive" : ""}${i === state.dpiIndex ? " live" : ""}"
            data-stage="${i}" type="button">
      <span class="dpi-card-head">
        <span class="dpi-color-dot" style="background:${stage.color}"></span>
        <span>DPI ${i + 1}</span>
      </span>
      <span class="dpi-card-value">${stage.value}</span>
      <span class="dpi-card-status">${i === state.dpiIndex ? "Active" : ""}</span>
    </button>`).join("");

  grid.querySelectorAll(".dpi-card").forEach((card) => {
    card.onclick = async () => {
      const stage = Number(card.dataset.stage);
      selectedStage = stage;
      if (stage < state.dpiCount) {
        state.dpiIndex = stage;
        saveState();
        const res = await applyDpi();
        if (!res.ok) showToast(res.error || "DPI write failed");
        updateDiagnostics();
      } else {
        showToast(`DPI ${stage + 1} is inactive — raise DPI COUNT first`);
      }
      buildDpiCards();
      syncDpiControls();
      updateStageLed();
    };
  });
}

/* The only LED on this model: the DPI indicator under the wheel, tinted with
   the colour of the stage the mouse is currently on. */
function updateStageLed() {
  const led = $("live-led");
  if (!led) return;
  const index = Math.max(0, Math.min(5, state.dpiIndex));
  const color = state.dpi[index].color;
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
  if (count) count.value = String(state.dpiCount);
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
            : `${step.type === "down" ? "Press" : "Release"} ${macroStepLabel(step)}`}</span>
          <button class="macro-del" data-i="${i}" type="button">×</button>
        </div>`).join("")
    : `<div class="macro-empty">No steps recorded</div>`;

  const events = macroSteps.filter((s) => s.kind === "key").length;
  const delays = macroSteps.length - events;
  const summary = $("macro-summary");
  if (summary) {
    summary.textContent = `${events}/${MACRO_MAX_EVENTS} events`
      + (delays ? ` · ${delays} delay step${delays > 1 ? "s" : ""}` : "");
    summary.classList.toggle("over", events > MACRO_MAX_EVENTS);
  }

  list.querySelectorAll(".macro-del").forEach((btn) => {
    btn.onclick = () => {
      macroSteps.splice(Number(btn.dataset.i), 1);
      buildMacroList();
      saveMacro();
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
          <button class="btn-ghost small" data-load="${name}" type="button">Load</button>
          <button class="btn-ghost small" data-del="${name}" type="button">Delete</button>
        </div>`).join("")
    : `<div class="macro-empty">No saved profiles</div>`;

  list.querySelectorAll("[data-load]").forEach((btn) => {
    btn.onclick = () => {
      const profilesNow = loadProfiles();
      const saved = profilesNow[btn.dataset.load];
      if (!saved) return;
      state = Object.assign(structuredClone(DEFAULTS), saved.state);
      if (!saved.state || (saved.state.sleepVersion !== 2 && saved.state.sleepVersion !== 3)) {
        const legacy = Number(saved.state && saved.state.sleep);
        state.sleep = Number.isFinite(legacy) ? nearestSleep(legacy / SLEEP_UNIT) : 30;
      }
      state.sleepVersion = 3;
      if (state.powerAux !== 0 && state.powerAux !== 1) state.powerAux = 1;
      normalizeKeyRecords();
      if (saved.macro) {
        if (Array.isArray(saved.macro.steps)) macroSteps = saved.macro.steps;
        if (Number.isInteger(saved.macro.target) && KEYS[saved.macro.target]) macroTarget = saved.macro.target;
        if (["once", "repeat", "toggle", "hold"].includes(saved.macro.mode)) macroMode = saved.macro.mode;
        if (Number.isInteger(saved.macro.repeat)) macroRepeat = saved.macro.repeat;
      }
      refreshUI();
      saveState();
      saveMacro();
      showToast(saved.macro ? "Profile loaded — upload the macro to write it" : "Profile loaded");
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

  const macroKey = $("sel-macro-key");
  if (macroKey) {
    const bound = Array.isArray(state.keys) ? state.keys.indexOf("Macro") : -1;
    if (bound >= 0) macroTarget = bound;
    macroKey.innerHTML = KEYS.map((key, i) =>
      `<option value="${i}">Key ${i + 1} — ${key.physical}</option>`).join("");
    macroKey.value = String(macroTarget);
  }
  const macroModeSelect = $("sel-macro-mode");
  if (macroModeSelect) macroModeSelect.value = macroMode;
  const macroCountInput = $("inp-macro-count");
  if (macroCountInput) {
    macroCountInput.value = String(macroRepeat);
    macroCountInput.disabled = macroMode !== "repeat";
  }

  updateDpiCaption();
  document.querySelectorAll("#rate-control .seg-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.rate) === state.rate);
  });

  const sleep = $("sel-sleep");
  if (sleep) {
    sleep.innerHTML = SLEEP_OPTIONS
      .map((m) => `<option value="${m}">${m} min</option>`).join("");
    if (!SLEEP_OPTIONS.includes(state.sleep)) {
      const option = document.createElement("option");
      option.value = String(state.sleep);
      option.textContent = `${state.sleep} min`;
      sleep.appendChild(option);
    }
    sleep.value = String(state.sleep);
  }
  const wake = $("chk-wake");
  if (wake) wake.checked = state.moveWake;
}

/* ---------------------------------------------------------------- persistence */

function saveState() {
  try {
    localStorage.setItem("tk-gm012.state", JSON.stringify(state));
  } catch (err) { /* storage disabled */ }
}

function saveMacro() {
  try {
    localStorage.setItem("tk-gm012.macro", JSON.stringify({
      steps: macroSteps, target: macroTarget, mode: macroMode, repeat: macroRepeat
    }));
  } catch (err) { /* storage disabled */ }
}

function loadMacro() {
  try {
    const raw = JSON.parse(localStorage.getItem("tk-gm012.macro") || "null");
    if (!raw) return;
    if (Array.isArray(raw.steps)) {
      macroSteps = raw.steps.filter((s) => s && (s.kind === "delay" || s.kind === "key"));
    }
    if (Number.isInteger(raw.target) && KEYS[raw.target]) macroTarget = raw.target;
    if (["once", "repeat", "toggle", "hold"].includes(raw.mode)) macroMode = raw.mode;
    if (Number.isInteger(raw.repeat)) macroRepeat = raw.repeat;
  } catch (err) { /* ignore */ }
}

function normalizeKeyRecords() {
  if (!Array.isArray(state.keys) || state.keys.length !== KEYS.length) {
    state.keys = structuredClone(DEFAULTS.keys);
  }
  if (!Array.isArray(state.keyRecords) || state.keyRecords.length !== KEYS.length) {
    state.keyRecords = state.keys.map((name) => {
      const record = KEY_RECORDS[name];
      return record ? record.slice() : null;
    });
  }
}

function restoreState() {
  try {
    const raw = localStorage.getItem("tk-gm012.state");
    if (raw) {
      const saved = JSON.parse(raw);
      state = Object.assign(structuredClone(DEFAULTS), saved);
      if (saved && saved.sleepVersion !== 2 && saved.sleepVersion !== 3) {
        // Older builds stored the firmware code directly (minutes * 6).
        const legacy = Number(saved.sleep);
        state.sleep = Number.isFinite(legacy) ? nearestSleep(legacy / SLEEP_UNIT) : 30;
      }
    }
  } catch (err) { /* ignore */ }
  state.sleepVersion = 3;
  if (state.powerAux !== 0 && state.powerAux !== 1) state.powerAux = 1;
  if (!Number.isFinite(state.sleep) || state.sleep <= 0) state.sleep = 30;
  if (!Number.isInteger(state.dpiIndex) || state.dpiIndex < 0 || state.dpiIndex > 5) {
    state.dpiIndex = DEFAULT_STAGE;
  }
  if (!Number.isInteger(state.dpiCount) || state.dpiCount < 1 || state.dpiCount > 6) {
    state.dpiCount = 6;
  }
  normalizeKeyRecords();
  selectedStage = state.dpiIndex;
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
    macro: {
      steps: structuredClone(macroSteps),
      target: macroTarget,
      mode: macroMode,
      repeat: macroRepeat
    },
    savedAt: new Date().toISOString().slice(0, 10)
  };
  localStorage.setItem("tk-gm012.profiles", JSON.stringify(profiles));
  buildProfiles();
  showToast(`Saved "${name}"`);
}

/* ---------------------------------------------------------------- macros */

/* The mouse stores a macro per key as four-byte events. A delay step between
   two events is folded into the earlier event's [1..2], which is where the
   firmware reads it (GetMouseMacroData @ 0x1C280). Delays before the first
   event have no record to live in and are dropped. */
function buildMacroRecords() {
  const events = [];
  let gap = 0;
  let droppedLeadDelay = false;

  for (const step of macroSteps) {
    if (step.kind === "delay") {
      gap += Math.max(0, Math.round(Number(step.ms) || 0));
      continue;
    }

    const down = step.type === "down";
    let cls, param;

    if (isMouseStep(step)) {
      const button = MACRO_MOUSE_BUTTONS[step.key];
      if (!button) return { error: `Unknown mouse button "${step.key}"` };
      cls = down ? MACRO_ACTIONS.mouseDown : MACRO_ACTIONS.mouseUp;
      param = button.bit;
    } else {
      const modifier = MODIFIER_BITS[step.key];
      const usage = HID_USAGE[step.key];
      if (modifier === undefined && usage === undefined) {
        return { error: `"${step.key}" has no HID usage mapping` };
      }
      cls = modifier !== undefined
        ? (down ? MACRO_ACTIONS.modifierDown : MACRO_ACTIONS.modifierUp)
        : (down ? MACRO_ACTIONS.keyboardDown : MACRO_ACTIONS.keyboardUp);
      param = modifier !== undefined ? modifier : usage;
    }

    if (events.length) {
      const ms = Math.max(1, Math.min(0xFFFF, gap || 1));
      const prev = events[events.length - 1];
      prev[1] = ms & 0xFF;
      prev[2] = (ms >> 8) & 0xFF;
    } else if (gap > 0) {
      droppedLeadDelay = true;
    }
    gap = 0;

    events.push([cls, 1, 0, param]);

    if (events.length > MACRO_MAX_EVENTS) {
      return { error: `Macro is limited to ${MACRO_MAX_EVENTS} events in this studio` };
    }
  }

  if (!events.length) return { error: "Record or add at least one key event" };

  if (gap > 0) {
    const ms = Math.max(1, Math.min(0xFFFF, gap));
    const prev = events[events.length - 1];
    prev[1] = ms & 0xFF;
    prev[2] = (ms >> 8) & 0xFF;
  }

  return { records: events, droppedLeadDelay };
}

/* Manual event insertion, mirroring the vendor's Insert Event menu: keyboard
   down/up and mouse down/up, including modifiers. */
function buildMacroInsertKeys() {
  const select = $("sel-insert-key");
  if (!select) return;
  const mode = $("sel-insert-type")?.value || "keyboard-down";
  const previous = select.value;
  const options = mode.startsWith("mouse-")
    ? Object.entries(MACRO_MOUSE_BUTTONS).map(([value, button]) => ({ value, label: button.label }))
    : MACRO_INSERT_KEYS;
  select.innerHTML = options
    .map((option) => `<option value="${option.value}">${option.label}</option>`).join("");
  if (options.some((option) => option.value === previous)) select.value = previous;
}

function insertMacroStep() {
  const mode = $("sel-insert-type")?.value || "keyboard-down";
  const value = $("sel-insert-key")?.value;
  if (!value) return showToast("Choose a key or button to insert");
  macroSteps.push({
    kind: "key",
    source: mode.startsWith("mouse-") ? "mouse" : "keyboard",
    type: mode.endsWith("-down") ? "down" : "up",
    key: value
  });
  buildMacroList();
  saveMacro();
}

async function uploadMacro() {
  if (!hidDevice || !hidDevice.opened) return showToast("Connect the mouse first");

  const select = $("sel-macro-key");
  const visual = select ? Number(select.value) : macroTarget;
  if (!KEYS[visual]) return showToast("Pick a key to bind");
  if (visual <= 1) {
    const label = visual === 0 ? "left" : "right";
    if (!confirm(`Bind the macro to the ${label} button? You will need another pointing device if you want to undo this.`)) return;
  }

  const built = buildMacroRecords();
  if (built.error) return showToast(built.error);

  macroMode = $("sel-macro-mode")?.value || macroMode;
  macroRepeat = Math.max(1, Math.min(255, Math.round(Number($("inp-macro-count")?.value) || 1)));
  macroTarget = visual;
  saveMacro();

  const target = KEYS[visual].value;
  const payload = [target];
  for (const record of built.records) payload.push(...record);

  setBusy(true);
  await readDeviceInfo();          // wake the link the way the vendor does
  const written = await sendCommand(CMD.KEY_MACRO, payload, built.records.length * 4 + 1);
  if (!written.ok) {
    setBusy(false);
    updateDiagnostics();
    return showToast(written.error || "Macro write failed");
  }

  // This studio edits one macro slot at a time. Any other key still pointing
  // at a macro goes back to its vendor default so it cannot run an empty slot.
  let restored = 0;
  for (let i = 0; i < KEYS.length; i++) {
    if (i !== visual && state.keys[i] === "Macro") {
      state.keys[i] = DEFAULTS.keys[i];
      restored++;
    }
  }
  state.keys[visual] = "Macro";

  const bound = await applyKeys();
  setBusy(false);
  refreshUI();
  saveState();
  updateDiagnostics();

  if (!bound.ok) return showToast(bound.error || "Macro stored, but the key binding failed");
  if (built.droppedLeadDelay) {
    showToast(`Macro bound to key ${visual + 1}; leading delay ignored`);
  } else if (written.silent) {
    showToast(`Macro sent to key ${visual + 1} (no ack)`);
  } else {
    showToast(`Macro bound to key ${visual + 1}${restored ? "; previous macro key restored" : ""}`);
  }
}

async function unbindMacro() {
  const select = $("sel-macro-key");
  const visual = select ? Number(select.value) : macroTarget;
  if (!KEYS[visual]) return showToast("Pick a key");
  state.keys[visual] = DEFAULTS.keys[visual];
  buildKeySelects();
  saveState();
  saveMacro();
  const res = await applyKeys();
  updateDiagnostics();
  showToast(res.ok ? `Key ${visual + 1} restored to ${state.keys[visual]}`
                   : (res.error || "Binding write failed"));
}

function isTypingTarget(el) {
  return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function startRecording() {
  if (recording) return;
  recording = true;
  macroSteps = [];
  lastStepAt = performance.now();
  buildMacroList();
  saveMacro();
  const btn = $("btn-record");
  if (btn) btn.classList.add("recording");
  showToast("Recording — Esc to stop");
}

function stopRecording() {
  recording = false;
  const btn = $("btn-record");
  if (btn) btn.classList.remove("recording");
  buildMacroList();
  saveMacro();
}

function macroKeyHook(event) {
  if (!recording || isTypingTarget(event.target)) return;
  if (event.code === "Escape") {
    stopRecording();
    return;
  }
  if (event.repeat) return;
  event.preventDefault();

  /* The vendor recorder inserts a "%d ms" row for the pause before each event
     (MacroRecrodData), so a recorded press keeps its real press duration: the
     capture shows 78 ms becoming `30 4e 00 04`. Idle time before Stop is not
     recorded, because there is no following event to attach it to. */
  const now = performance.now();
  if (macroSteps.length) {
    const gap = Math.min(31000, Math.round(now - lastStepAt));
    if (gap >= 1) macroSteps.push({ kind: "delay", ms: gap });
  }

  macroSteps.push({
    kind: "key",
    source: "keyboard",
    type: event.type === "keydown" ? "down" : "up",
    key: event.code || "KeyA"
  });
  lastStepAt = now;
  buildMacroList();
  saveMacro();
}

/* ------------------------------------------------------------------- wiring */

document.addEventListener("DOMContentLoaded", () => {
  restoreState();
  loadMacro();
  refreshUI();
  buildMacroInsertKeys();
  updateHud();
  updateDiagnostics();
  autoConnect();

  document.addEventListener("cheshub:tabchange", saveState);

  navigator.hid?.addEventListener("connect", autoConnect);
  navigator.hid?.addEventListener("disconnect", () => {
    hidDevice = null;
    deviceInfo = null;
    batteryLevel = null;
    charging = false;
    linkState = null;
    stopPolling();
    updateHud();
    updateDiagnostics();
    showToast("Device disconnected");
  });

  $("btn-connect")?.addEventListener("click", () => {
    if (hidDevice && hidDevice.opened) applyAll();
    else requestPairWith(FILTERS);
  });
  $("btn-lock-connect")?.addEventListener("click", () => requestPairWith(FILTERS));
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

  $("btn-sync")?.addEventListener("click", async () => {
    const ok = await syncFromDevice();
    showToast(ok ? "Synced from device" : "Connect the mouse first");
  });

  $("btn-read-keys")?.addEventListener("click", async () => {
    if (!hidDevice || !hidDevice.opened) return showToast("Connect the mouse first");
    const ok = await readKeys();
    refreshUI();
    saveState();
    updateDiagnostics();
    showToast(ok ? "Button mapping read from mouse" : "No button reply — check DIAGNOSTICS");
  });

  $("btn-reset-keys")?.addEventListener("click", () => {
    state.keys = structuredClone(DEFAULTS.keys);
    state.keyRecords = null;
    buildKeySelects();
    saveState();
    showToast("Default mapping loaded — APPLY TO MOUSE to write");
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
    macroSteps = [];
    macroTarget = 5;
    macroMode = "once";
    macroRepeat = 1;
    refreshUI();
    saveState();
    saveMacro();
    updateDiagnostics();
    showToast(res.ok ? "Factory defaults restored" : (res.error || "No response"));
  });

  $("btn-test")?.addEventListener("click", async () => {
    if (!hidDevice || !hidDevice.opened) return showToast("Connect the mouse first");
    const res = await readDeviceInfo();
    deviceInfo = res.reply || deviceInfo;
    updateHud();
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
      "buttons:",
      ...state.keys.map((name, i) => {
        const raw = state.keyRecords && Array.isArray(state.keyRecords[i])
          ? state.keyRecords[i].map((b) => b.toString(16).padStart(2, "0")).join(" ")
          : "—";
        return `  ${i + 1}: ${name} [${raw}]`;
      }),
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

  $("sel-dpi-count")?.addEventListener("change", async (e) => {
    state.dpiCount = Number(e.target.value);
    if (state.dpiIndex >= state.dpiCount) {
      state.dpiIndex = state.dpiCount - 1;
      selectedStage = state.dpiIndex;
    }
    buildDpiCards();
    syncDpiControls();
    updateStageLed();
    updateDpiCaption();
    saveState();
    const res = await applyDpi();
    updateDiagnostics();
    if (!res.ok) showToast(res.error || "DPI write failed");
  });

  $("sel-sleep")?.addEventListener("change", async (e) => {
    state.sleep = Number(e.target.value);
    saveState();
    const res = await applyPower();
    updateDiagnostics();
    if (!res.ok) showToast(res.error || "Power write failed");
  });

  $("chk-wake")?.addEventListener("change", async (e) => {
    state.moveWake = e.target.checked;
    saveState();
    const res = await applyPower();
    updateDiagnostics();
    if (!res.ok) showToast(res.error || "Power write failed");
  });

  $("btn-record")?.addEventListener("click", () => {
    if (recording) stopRecording(); else startRecording();
  });

  $("sel-macro-key")?.addEventListener("change", (e) => {
    macroTarget = Number(e.target.value);
    saveMacro();
  });

  $("sel-macro-mode")?.addEventListener("change", (e) => {
    macroMode = e.target.value;
    const count = $("inp-macro-count");
    if (count) count.disabled = macroMode !== "repeat";
    saveMacro();
  });

  $("inp-macro-count")?.addEventListener("input", (e) => {
    macroRepeat = Math.max(1, Math.min(255, Math.round(Number(e.target.value) || 1)));
    saveMacro();
  });

  $("btn-upload-macro")?.addEventListener("click", uploadMacro);
  $("btn-unbind-macro")?.addEventListener("click", unbindMacro);

  $("btn-insert-step")?.addEventListener("click", insertMacroStep);
  $("sel-insert-type")?.addEventListener("change", buildMacroInsertKeys);

  $("btn-add-delay")?.addEventListener("click", () => {
    const ms = Math.max(1, Math.min(31000, Math.round(Number($("inp-delay")?.value) || 100)));
    macroSteps.push({ kind: "delay", ms });
    buildMacroList();
    saveMacro();
  });

  $("btn-clear-macro")?.addEventListener("click", () => {
    macroSteps = [];
    buildMacroList();
    saveMacro();
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

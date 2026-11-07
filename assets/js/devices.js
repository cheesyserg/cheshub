/* Shared device registry — used by the hub page and every studio sidebar. */
window.CHESHUB_DEVICES = [
  {
    id: "ajazz-aj139",
    name: "AJAZZ AJ139 V2 MC",
    short: "AJAZZ AJ139",
    type: "WebHID Gaming Mouse",
    kind: "mouse",
    image: "devices/ajazz-aj139/images/black.png",
    path: "devices/ajazz-aj139/index.html",
    filters: [
      { vendorId: 0xA8A4, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 },
      { vendorId: 0xA8A5, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 }
    ]
  },
  {
    id: "tecknet-tk-gm012",
    name: "TECKNET TK-GM012",
    short: "TK-GM012",
    type: "Wireless Gaming Mouse",
    kind: "mouse",
    image: "devices/tecknet-tk-gm012/images/mouse_tk-gm012.png",
    path: "devices/tecknet-tk-gm012/index.html",
    // Vendor collection measured on a real receiver: interface 2,
    // usage page 0xFF01 / usage 0x0010. The other interfaces have no
    // output report or never answer.
    filters: [
      { vendorId: 0x248A, productId: 0x5D2E, usagePage: 0xFF01, usage: 0x0010 },
      { vendorId: 0x249A, productId: 0x5C2F, usagePage: 0xFF01, usage: 0x0010 }
    ]
  },
  {
    id: "ilovbee-b75",
    name: "iLovbee B75",
    short: "iLovbee B75",
    type: "75% RGB Mechanical Keyboard",
    kind: "keyboard",
    path: "devices/ilovbee-b75/index.html",
    // Wired USB. The vendor tool talks to the collection on usage page
    // 0xFF00 (usage 1) or 0xFF02 (usage 1/2) that has a 0x208-byte
    // feature report.
    filters: [
      { vendorId: 0x258A, productId: 0x01E7, usagePage: 0xFF00 },
      { vendorId: 0x258A, productId: 0x01E7, usagePage: 0xFF02 }
    ]
  },
  {
    id: "tozo-ht3",
    name: "TOZO HT3 Headset",
    short: "TOZO HT3",
    type: "Bluetooth Audio & Hybrid ANC",
    kind: "headset",
    path: "devices/tozo-ht3/index.html",
    filters: [
      { namePrefix: "TOZO HT3" },
      { namePrefix: "TOZO" }
    ]
  }
];

(function () {
  const devices = window.CHESHUB_DEVICES;
  const TELEMETRY_KEY = "cheshub.telemetry";

  const icons = {
    mouse: '<rect x="7" y="2" width="10" height="20" rx="5"/><path d="M12 6v4"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10"/>',
    headset: '<path d="M4 14v-2a8 8 0 0116 0v2"/><rect x="2" y="13" width="4" height="7" rx="2"/><rect x="18" y="13" width="4" height="7" rx="2"/>'
  };

  function filterMatches(filter, device) {
    if (!filter || !device) return false;
    if (filter.namePrefix !== undefined) return false;
    if (filter.vendorId !== undefined && filter.vendorId !== device.vendorId) return false;
    if (filter.productId !== undefined && filter.productId !== device.productId) return false;
    if (filter.usagePage === undefined) return true;
    return (device.collections || []).some((collection) =>
      collection.usagePage === filter.usagePage
      && (filter.usage === undefined || collection.usage === filter.usage));
  }

  function match(device) {
    return devices.find((entry) => (entry.filters || []).some((filter) => filterMatches(filter, device)));
  }

  function loadTelemetry() {
    try {
      return JSON.parse(localStorage.getItem(TELEMETRY_KEY) || "{}");
    } catch (err) {
      return {};
    }
  }

  function saveTelemetry(id, data) {
    if (!id || !data) return;
    try {
      const all = loadTelemetry();
      all[id] = Object.assign({}, all[id], data, { at: Date.now() });
      localStorage.setItem(TELEMETRY_KEY, JSON.stringify(all));
    } catch (err) { /* storage disabled */ }
  }

  window.ChesHubRegistry = { devices, filterMatches, match, icons, loadTelemetry, saveTelemetry };
})();

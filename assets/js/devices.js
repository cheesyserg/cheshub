/* Shared device registry — used by the hub page and every studio sidebar. */
window.CHESHUB_DEVICES = [
  {
    id: "ajazz-aj139",
    name: "AJAZZ AJ139 V2 MC",
    short: "AJAZZ AJ139",
    type: "WebHID Gaming Mouse",
    kind: "mouse",
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

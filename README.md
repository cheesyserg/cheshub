# ChesHub

**Unified multi-device hardware configurator that runs entirely in your browser.**

### → [**Open ChesHub**](https://cheesyserg.github.io/cheshub/) ←

[![Live](https://img.shields.io/badge/live-cheesyserg.github.io-ff4655)](https://cheesyserg.github.io/cheshub/)
[![License](https://img.shields.io/badge/license-GPL--3.0-2ee6c5)](LICENSE)
[![No build step](https://img.shields.io/badge/build-none-17202a)](#development)

Vendor utilities are usually Windows-only, bundled with an installer, and
abandoned the moment the product line rotates. ChesHub replaces them with a
static site: open a tab, pair the peripheral over WebHID or Web Serial, and
configure it. No install, no admin rights, no background service.

## Supported devices

| Device | Type | Interface | Open |
|---|---|---|---|
| **TECKNET TK-GM012** | Wireless gaming mouse | WebHID | [Studio](https://cheesyserg.github.io/cheshub/devices/tecknet-tk-gm012/) |
| **AJAZZ AJ139 V2 MC** | Gaming mouse | WebHID | [Studio](https://cheesyserg.github.io/cheshub/devices/ajazz-aj139/) |
| **iLovbee B75** | 75% RGB mechanical keyboard | WebHID | [Studio](https://cheesyserg.github.io/cheshub/devices/ilovbee-b75/) |
| **TOZO HT3** | Hybrid ANC headset | Web Serial | [Studio](https://cheesyserg.github.io/cheshub/devices/tozo-ht3/) |

### TECKNET TK-GM012

USB (`248A:5D2E`) and 2.4 GHz (`249A:5C2F`) modes.

- Button mapping for all six keys, read back from the mouse (`0x11`) and with
  custom records preserved; defaults taken from the vendor XML
- Six DPI stages (50–24000), click-to-activate, selectable stage count and
  per-stage indicator colour
- Report rate 125 / 250 / 500 / 1000 Hz
- Sleep timeout (1, 2, 5, 6, 10, 15, 20, 30 min) and move wake-up
- Macro editor: records keyboard events with their real pauses, or lets you
  insert keyboard and mouse-button events by hand; every step can be edited,
  reordered or deleted (six events), then uploaded per key with play-once,
  repeat-N, loop-until-click and loop-while-held playback
- Named profile slots, factory restore
- Frosted-glass studio with six accent palettes, five animated background
  palettes and a custom wallpaper, stored in the browser only. Accent and
  background are shared by the hub and every studio; open the palette button
  on the hub or **Appearance** in a studio.

Which features exist at all is defined by the vendor's own
`device/mouse_tk-gm012.xml`, not by guesswork: `<menu light="0"/>` means there
is no lighting page, and `show_lod="0" show_sensor="0" show_respondtime="0"`
mean lift-off distance, sensor options and debounce are not configurable on this
unit — so the studio does not offer them. The button table, `key_value` indices
and factory defaults are transcribed from the same file.

The only LED on this model is the DPI indicator under the wheel, so the studio
has no lighting page — the API exposes the colour per DPI stage instead. The
mouse answers on interface 2, usage page `0xFF01` / usage `0x0010`; the mouse,
keyboard and consumer-control collections either have no output report or never
answer, so the studio filters on that exact collection.

The wire protocol was reverse-engineered from the vendor tool and is documented
in
[`devices/tecknet-tk-gm012/docs/PROTOCOL.md`](devices/tecknet-tk-gm012/docs/PROTOCOL.md),
with every field marked verified or inferred. A compact register-by-register
map is in
[`devices/tecknet-tk-gm012/docs/REGISTERS.md`](devices/tecknet-tk-gm012/docs/REGISTERS.md).

### AJAZZ AJ139 V2 MC

Lighting studio, report rate, DPI stages, and the sensor controls exposed by the
PAW sensor (motion sync, ripple control, angle snapping, esports mode, LOD,
debounce, sleep, invert scroll).

### iLovbee B75

Wired USB (`258A:01E7`). Protocol reverse-engineered from the vendor's
iLovbee utility (`CDevG5KB`, `Fw=2`) and its `Dev/01E7/KB.ini`, documented
with every field marked in
[`devices/ilovbee-b75/docs/PROTOCOL.md`](devices/ilovbee-b75/docs/PROTOCOL.md).

- 17 lighting effects with per-effect brightness, speed and a seven-colour
  palette (plus colourful), read back from the keyboard's config block; the
  on-screen keyboard animates an approximation of the selected effect
- Line-art keyboard with a layout switch: **Knob** (retail B75, rotary knob
  top right in place of End) or **End key** (the vendor tool's artwork)
- Per-key colour painting for the Custom effect
- Base-layer key remapping: keys with modifiers, media, mouse buttons,
  macros or disabled; the knob is included
- Macro editor with recording, repeat-N and three loop modes
- Debounce (Office / Gaming), wireless sleep timeout, factory restore

Key assignments, macros, palettes and the per-key pattern cannot be read
from the keyboard, so they are kept in the browser. Every change is written
to the keyboard automatically about half a second after it is made;
**Write All** rewrites everything. The 2.4 GHz dongle and Bluetooth are not supported.

### TOZO HT3

Noise cancellation engine and hardware DSP equaliser over Bluetooth RFCOMM.

## Requirements

| | |
|---|---|
| Browser | Chrome or Edge 98+ on desktop (WebHID + Web Serial, `structuredClone`) |
| Firefox / Safari | Not supported — the APIs do not exist there |
| Context | HTTPS or `localhost`. WebHID refuses insecure origins |
| OS | Windows, macOS, Linux |

The hosted site is served over HTTPS by GitHub Pages, so
[cheesyserg.github.io/cheshub](https://cheesyserg.github.io/cheshub/) works as-is.
Opening it in a browser without WebHID or Web Serial shows a blocking notice
instead of a half-working UI.

### Linux: udev rules

On Linux the browser opens `/dev/hidraw*` directly, and those nodes are
root-only by default. Without a rule the device either does not appear in the
picker or fails with `Failed to open the device`. Create
`/etc/udev/rules.d/70-cheshub.rules`:

```
# ChesHub — WebHID access for supported devices
# TECKNET TK-GM012 (USB cable)
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="248a", ATTRS{idProduct}=="5d2e", MODE="0660", TAG+="uaccess"
# TECKNET TK-GM012 (2.4 GHz receiver)
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="249a", ATTRS{idProduct}=="5c2f", MODE="0660", TAG+="uaccess"
# AJAZZ AJ139 V2 MC (USB cable)
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="a8a4", ATTRS{idProduct}=="2255", MODE="0660", TAG+="uaccess"
# AJAZZ AJ139 V2 MC (2.4 GHz receiver)
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="a8a5", ATTRS{idProduct}=="2255", MODE="0660", TAG+="uaccess"
# iLovbee B75 (USB cable)
KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="258a", ATTRS{idProduct}=="01e7", MODE="0660", TAG+="uaccess"
```

Then reload the rules and re-plug the device (or its receiver):

```bash
sudo udevadm control --reload-rules
```

```bash
sudo udevadm trigger --subsystem-match=hidraw
```

`TAG+="uaccess"` gives the logged-in desktop user access through systemd-logind.
On a system without logind, replace it with `GROUP="plugdev"` and add yourself to
that group. To check which node a device got and who can open it:

```bash
ls -l /dev/hidraw*
```

The TOZO HT3 needs no udev rule: Chrome reaches it through BlueZ, so pair it
in the system Bluetooth settings first. If you instead bind it to
`/dev/rfcomm0` yourself, your user must be in the `dialout` group
(`uucp` on Arch).

## Usage

1. Open the [hub](https://cheesyserg.github.io/cheshub/) and choose the device.
2. Plug in the device (for a 2.4 GHz mouse, plug in the dongle).
3. Close the vendor utility — Windows grants one handle per HID collection.
4. Click **Connect** (in the lock card or the header) and pick the device in
   the browser prompt.
5. Change settings, then click **Apply**.

Previous grants are remembered by the browser. Both the hub and the studio
sidebar list only paired devices, showing two at a time with a **Show more**
button; the sidebar always includes the device you are viewing. Hub cards show
the device render, its battery level and the link type; the two mice are polled
live, while the Bluetooth headset uses its last reading.

## How it works

Everything is client-side. The page talks directly to the device through the
browser's HID or serial API — packets never leave the machine, and there is no
backend, account, or telemetry.

- Device settings are written straight to the hardware.
- Named profiles are kept in `localStorage`, scoped to the origin.
- Shared shell, tokens and backdrop live in `assets/`; each device folder adds
  only its own layout and `driver.js` protocol code.
- The saved theme is applied in `<head>` before first paint, card space is
  reserved while pairing is checked, studio pages are prefetched on hover, and
  device images decode asynchronously — so navigation does not flash or jump.

## Project layout

```
index.html                      hub page
assets/
  css/
    base.css                    design tokens, backdrop, buttons, form controls
    studio.css                  shared studio shell (sidebar, header, panels, lock)
    hub.css                     hub-only layout
  js/
    devices.js                  shared device registry
    theme.js                    wallpaper preferences (shared by hub + studios)
    studio.js                   device switcher, tabs and connection lock
    hub.js                      hub card grid and pairing controls
devices/
  <slug>/
    index.html                  device studio
    driver.js                   transport + protocol + UI
    device.css                  device-specific layout
    images/                     product renders
    docs/                       PROTOCOL.md, REGISTERS.md
.github/workflows/static.yml    deploy to GitHub Pages on push to main
```

## Adding a device

1. Create `devices/<vendor>-<model>/` with `index.html`, `device.css`, and
   `driver.js`. Copy an existing studio as a starting point, then set
   `data-device="<registry id>"` on its `<body>`.
2. Register it in `CHESHUB_DEVICES` in `assets/js/devices.js`. That one array
   feeds the hub grid and the device list in every studio sidebar:

```js
{
  id: "vendor-model",
  name: "VENDOR MODEL",
  short: "MODEL",
  type: "Wireless Gaming Mouse",
  kind: "mouse",
  path: "devices/vendor-model/index.html",
  filters: [
    { vendorId: 0x1234, productId: 0x5678, usagePage: 0xFF01, usage: 0x01 }
  ]
}
```

`filters` are passed straight to `navigator.hid.requestDevice()`, so they must
be valid HID filters. `vendorId` + `productId` alone also works if the vendor
usage page is unknown. `namePrefix` filters are used for serial devices.

3. Keep device-specific protocol notes in that folder's `docs/PROTOCOL.md`, and
   mark anything not confirmed against hardware as inferred.

## Development

No build step, no dependencies. Because WebHID needs a secure context, serve
over localhost rather than opening the file directly:

```bash
git clone https://github.com/cheesyserg/cheshub.git
cd cheshub
python3 -m http.server 8000
# then open http://localhost:8000
```

Pushing to `main` deploys the repository root to GitHub Pages via
`.github/workflows/static.yml`.

## Troubleshooting

**The device never shows up in the browser prompt**
The vendor utility is probably holding the handle. Quit it completely (tray
icon included) and reload. On Linux, install the [udev rules](#linux-udev-rules),
check `lsusb`, and make sure nothing like `libratbag` grabbed the device.

If it still does not appear, the registry filter may be too narrow for your
board revision. Use **Scan Vendor HID** on the hub (or **Scan Any Vendor
HID** in a device's Diagnostics panel): those list every vendor-defined HID
collection the browser can see. Picking one there prints its `vendorId`,
`productId` and usage pages — that is the information needed to add or fix a
device entry.

**The page still shows an old error message**
GitHub Pages caches aggressively. Hard-reload with `Ctrl+Shift+R` (or
`Cmd+Shift+R`). If the Diagnostics link is missing, you are looking at a stale
build — the current studio always has it at the bottom of the sidebar.

**The device is connected but every command times out**
Open Diagnostics from the bottom of the sidebar. **Info reply (0x10)** should
show bytes after connecting, since
every session starts with that read. If it says `no reply` while **Interface** is
red, you are on the wrong HID collection; re-pair. If it says `no reply` while
**Interface** is green, the wire log shows exactly what was sent — attach it to a
bug report.

**The prompt shows the device but writes fail**
Devices expose several HID collections. The controllable one is normally the
vendor collection (`MI_02`, usage page `0xFF00`–`0xFFFF`) rather than the
standard mouse or keyboard interface. The TK-GM012 studio shows the collection
it bound to under **Diagnostics**; this receiver answers on interface 2, usage
page `0xFF01` / usage `0x0010`. A consumer-control collection has no output
report at all, and trying to write it reports `Failed to write the report.`

**Settings reset after unplugging**
Some firmware keeps settings in RAM until a save command is sent. Re-apply, or
use the device's own profile slot if it has one.

**Nothing renders on `file://`**
Expected — the HID APIs require `https://` or `localhost`.

## Contributing

New device folders and protocol corrections are welcome. If you verify a field
against real hardware, update that device's `docs/PROTOCOL.md` and drop the
"inferred" marker. Please don't commit vendor binaries; link to the vendor
download instead.

## License

[GNU General Public License v3.0](LICENSE).

ChesHub is an unofficial community project. It is not affiliated with, endorsed
by, or supported by AJAZZ, iLovbee, TECKNET, or TOZO. Writing to firmware-controlled
hardware carries risk — use at your own.

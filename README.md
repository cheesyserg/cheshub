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
| **TOZO HT3** | Hybrid ANC headset | Web Serial | [Studio](https://cheesyserg.github.io/cheshub/devices/tozo-ht3/) |

### TECKNET TK-GM012

USB (`248A:5D2E`) and 2.4 GHz (`249A:5C2F`) modes.

- Button mapping for all six keys, read back from the mouse (`0x11`) and with
  custom records preserved; defaults taken from the vendor XML
- Six DPI stages (50–24000), click-to-activate, selectable stage count and
  per-stage indicator colour
- Report rate 125 / 250 / 500 / 1000 Hz
- Sleep timeout (1, 2, 5, 6, 10, 15, 20, 30 min) and move wake-up
- Macro recorder with keyboard/modifier events (up to six), per-key upload and
  once / repeat / toggle playback
- Named profile slots, factory restore
- Frosted-glass studio with an animated backdrop or a custom wallpaper, stored
  in the browser only

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
in [`devices/tecknet-tk-gm012/PROTOCOL.md`](devices/tecknet-tk-gm012/PROTOCOL.md),
with every field marked verified or inferred. A compact register-by-register
map is in
[`devices/tecknet-tk-gm012/REGISTERS.md`](devices/tecknet-tk-gm012/REGISTERS.md).

### AJAZZ AJ139 V2 MC

Lighting studio, report rate, DPI stages, and the sensor controls exposed by the
PAW sensor (motion sync, ripple control, angle snapping, esports mode, LOD,
debounce, sleep, invert scroll).

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

## Usage

1. Open the [hub](https://cheesyserg.github.io/cheshub/) and choose the device.
2. Plug in the device (for a 2.4 GHz mouse, plug in the dongle).
3. Close the vendor utility — Windows grants one handle per HID collection.
4. Click **Connect** (in the lock card or the header) and pick the device in
   the browser prompt.
5. Change settings, then click **Apply**.

Previously granted devices are marked **Online** on the hub; the browser
remembers the grant. Every registered device is listed, so a studio can also
be opened before pairing.

## How it works

Everything is client-side. The page talks directly to the device through the
browser's HID or serial API — packets never leave the machine, and there is no
backend, account, or telemetry.

- Device settings are written straight to the hardware.
- Named profiles are kept in `localStorage`, scoped to the origin.
- Each device folder is self-contained: HTML, CSS, and one `driver.js` holding
  both the protocol constants and the UI wiring.

## Project layout

```
index.html                      hub page + device registry UI
css/hub.css                     hub styling
js/devices.js                   shared device registry (hub + studio sidebars)
devices/
  <slug>/
    index.html                  device studio
    driver.js                   transport + protocol + UI
    style.css                   device styling
    PROTOCOL.md                 wire-protocol notes (where recovered)
    REGISTERS.md                compact register-by-register map
.github/workflows/static.yml    deploy to GitHub Pages on push to main
```

## Adding a device

1. Create `devices/<vendor>-<model>/` with `index.html`, `style.css`, and
   `driver.js`. Copy an existing studio as a starting point, and set its
   `DEVICE_ID` constant to the registry `id` you add below.
2. Register it in `CHESHUB_DEVICES` in `js/devices.js`. That one array feeds
   the hub grid and the device list in every studio sidebar:

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

3. Keep device-specific protocol notes in that folder's `PROTOCOL.md`, and mark
   anything not confirmed against hardware as inferred.

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
icon included) and reload. On Linux, check `lsusb` and that nothing like
`libratbag` grabbed the device.

If it still does not appear, the registry filter may be too narrow for your
board revision. Use **Scan All Vendor HID** on the hub (or **Scan Any Vendor
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
against real hardware, update that device's `PROTOCOL.md` and drop the
"inferred" marker. Please don't commit vendor binaries; link to the vendor
download instead.

## License

[GNU General Public License v3.0](LICENSE).

ChesHub is an unofficial community project. It is not affiliated with, endorsed
by, or supported by AJAZZ, TECKNET, or TOZO. Writing to firmware-controlled
hardware carries risk — use at your own.

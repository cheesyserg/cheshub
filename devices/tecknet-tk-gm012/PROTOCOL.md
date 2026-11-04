# TECKNET TK-GM012 — recovered HID protocol

Everything below was recovered by static analysis of the vendor tool
(`TK-GM012.exe` + the shipped `TK-GM012.pdb`). Each claim is marked:

* **verified** — read directly out of the disassembly / constants
* **inferred** — structure deduced from how the vendor fills the buffer, but
  not confirmed against a live device

Confidence is shown per row so nothing here is presented as more certain than
it is. Anything marked *inferred* is worth confirming with a USB capture
(Wireshark + USBPcap) before trusting it.

## Transport

The tool talks to the vendor HID collection (`MI_02`) through `hidapi`:

```c
/* DriverComm::HIDSetDeviceData @ 0x4C430 (fastcall) */
hid_write(dev, buf, 64);
Sleep(3);
if (failed) { hid_write(dev, buf, 64); Sleep(5); }
hid_read_timeout(dev, buf, 64, 1000);
```

Enumeration uses SetupAPI (`SetupDiGetClassDevsA`,
`SetupDiEnumDeviceInterfaces`, `SetupDiEnumDeviceInfo`) and `HID.DLL`
(`HidD_GetAttributes`, `HidD_GetPreparsedData`, `HidP_GetCaps`).

| Mode | VID | PID | Interface | Collection |
|---|---|---|---|---|
| USB wired | `0x248A` | `0x5D2E` | `MI_02` | usage page `0xFF01`, usage `0x0010` |
| 2.4 GHz | `0x249A` | `0x5C2F` | `MI_02` | usage page `0xFF01`, usage `0x0010` |

The collection was measured with `hidapi` on a real receiver, which enumerates
four nodes:

```
if=2  usage_page=0xFF01 usage=0x0010   <- vendor collection, answers 0x10
if=0  usage_page=0x0001 usage=0x0002   <- mouse   (protected, hidden from WebHID)
if=1  usage_page=0x000C usage=0x0001   <- consumer control
if=1  usage_page=0x0001 usage=0x0006   <- keyboard (protected, hidden from WebHID)
```

`DriverComm::FindDevice @ 0x4C3A0` does compare `usage_page` against `0xFFEF`
and `usage` against `0`, but that is **not** the path this receiver is opened
through. `DriverComm::EnumerateDevice` never looks at the usage page at all: it
opens every enumerated interface and keeps the ones that answer the `0x10` read
(after one 500 ms retry). That is why the vendor app works regardless of the
page, and why filtering on `0xFFEF` produced an empty browser picker.

The collection is not optional.

```asm
0004C3C2  mov ecx, ffef
0004C3C7  movzx eax, [esi+0x4]      ; hid_device_info.vendor_id
0004C3CB  cmp eax, [ebp+0x8]
0004C3D4  cmp eax, ebx              ; product_id
0004C3D8  cmp [esi+0x18], cx        ; usage_page == 0xFFEF
0004C3DE  cmp [esi+0x1a], 0         ; usage == 0
```

Writes to a boot mouse/keyboard collection are silently dropped, and a
consumer-control collection has no output report at all — Chrome answers that
with `Failed to write the report.` The studio pins `0xFF01`/`0x0010` and also
probes every other granted interface with the `0x10` read, mirroring what
`EnumerateDevice` does.

The build uses the `__fastcall` convention (`/Gr`): first two arguments in
`ECX`/`EDX`. That detail matters when reading the disassembly.

## Frame format (**verified**)

`DriverComm::SetDeviceData @ 0x4B300` takes a 65-byte buffer, fixes byte 0,
computes a checksum and writes it to byte 32. **Only the first 33 bytes ever
reach the wire** — measured with `hid_probe.py`, a 65-byte write reports
`33 bytes accepted`, and the reply is 32 bytes.

```text
byte  0       report id, always 0x00
byte  1       command
byte  2       always 0x00
byte  3       write 0x01 / read 0x00
byte  4       command-specific length / type byte
byte  5..31   payload (zero padded)
byte 32       checksum = (sum of bytes 5..31) & 0xFF
```

The checksum loop is nine unrolled iterations adding three bytes each, i.e.
exactly bytes `5..31`, stored to `buf[0x20]`. That caps the checksummed payload
at 27 bytes, which is why everything fits in a 33-byte report; the 65-byte
buffer in the source is simply over-allocated.

### Replies

The device answers with 32 bytes: the request with its leading report-id byte
dropped, and a status byte inserted at `[1]`.

```text
byte 0        command echoed
byte 1        status: 0 = accepted, 1 = rejected
byte 2..3     echoed
byte 4        echoed length
byte 5..30    echoed payload
byte 31       checksum = (sum of bytes 4..30) & 0xFF
```

Captured reply to the `0x10` read on a real receiver:

```text
10 00 01 0b 4c 39 33 51 00 00 11 01 00 46 01 00 ... 62
            'L' '9' '3' 'Q'                 ^^ battery ~70%
```

`L93Q` is the `dev_id` from `config.xml`. Byte `[13]` tracks battery, `[14]`
the link state. Acknowledgement timing is loose on the 2.4G receiver: a write's
reply can arrive only on the next transaction, so a client must not treat a
short read timeout as a failure.

## Link startup and acknowledgement

Three details of the vendor I/O path matter when reimplementing it.

**Writes are resized to the report length.** `_hid_write @ 0x4D580` compares
the requested length against `dev->output_report_length` and zero-pads when the
caller passes less:

```c
if (len < output_report_length) {
    buf = malloc(output_report_length);
    memcpy(buf, data, len);
    memset(buf + len, 0, output_report_length - len);
    len = output_report_length;
}
WriteFile(handle, buf, len, &written, NULL);
```

The tool passes 65 bytes for a configuration packet and 33 for a read, but
`output_report_length` is 33: a 65-byte buffer is cut to the report size by the
driver, which is why the vendor's 65-byte buffer works and why WebHID — which
validates the length itself — refuses 64 bytes with
`Failed to write the report.`

**A reply only counts when byte 1 is zero.** `DriverComm::SetDeviceData @ 0x4B300`:

```c
sum = checksum(buf[5..31]); buf[32] = sum;
tmp = malloc(len); memcpy(tmp, buf, len);
if (hid_write(dev, tmp, len) > 0) {
    for (i = 0; i < 50; i++) {                    /* 50 x 30 ms = 1.5 s */
        n = hid_read_timeout(dev, tmp, len, 30);
        if (n > 0 && tmp[1] == 0) { ok = true; break; }
    }
    memcpy(buf, tmp, len);                        /* reply lands in the caller's buffer */
}
```

So the wait budget is up to 1.5 s per packet, and replies whose second byte is
non-zero are discarded while the read is retried. `hidapi` keeps the report id
at index 0, so `tmp[1]` is the first byte after the id; WebHID strips the id,
which makes the equivalent check `reply[0] === 0`.

**Every connection starts with a read.** `DriverComm::GetDeviceInfo @ 0x4B200`
builds `00 10 00 00`, computes the checksum itself, writes 33 bytes and reads
33 back. `EnumerateDevice` calls it immediately after opening the interface
(0x4BB8F and 0x4BBB0), and `GetDeviceNotify` reuses it as a poll. That is the
handshake: command `0x10`, read direction, no payload. A client that skips it
is talking to a link that has not been woken yet.

Read frames differ from writes in byte 3: `0x00` for a read, `0x01` for a write.
Byte 4 is the payload length, `0` on reads.

### Read commands

| Cmd | Emitted by | Contents |
|---|---|---|
| `0x10` | `GetDeviceInfo`, `GetDeviceNotify` | battery, firmware, link state |
| `0x11` | `GetMouseData` | not decoded |
| `0x12` | `GetMouseData` | report rate at `[4]`, printed as `%d` |
| `0x13` | `GetMouseData` | not decoded |

The `0x10` reply is parsed from `0x31C85` onward. Offsets below are into the
`hidapi` buffer, which includes the report id at `[0]`; subtract one for WebHID:

| Offset | Meaning |
|---|---|
| 7..8 | 16-bit value, little endian — probably firmware version |
| 10 | device type, compared against `0x11` |
| 11 | rate code, compared against `0x10` / `0x20` / `0x40` |
| 12 | battery level |
| 13 | charging state |
| 14 | link state; `0` takes the "not connected" branch |

The battery scaling was not confirmed, so the studio shows the raw reply in
DIAGNOSTICS rather than inventing a percentage.

## Feature set from the device descriptor

`device/mouse_tk-gm012.xml` is the vendor's own description of what this unit
exposes, and it drives both the UI flags and the defaults. Everything in the
studio derives from it.

```xml
<menu light="0" />
<custom show_dpitips="0" show_savetips="0" show_lod="0"
        show_sensor="0" show_respondtime="0"/>
```

* `menu light="0"` — no lighting page, matching a mouse whose only LED is the
  DPI indicator.
* `show_lod="0"`, `show_sensor="0"`, `show_respondtime="0"` — the lift-off
  distance, sensor option bits and button response time are **not** configurable
  on this model. `0x06` is implemented in firmware but never sent by the tool,
  so the studio does not expose it either.

### Buttons

| name | key_value | direction | default |
|---|---|---|---|
| 201 | 0 | 0 (label left) | Left-Click |
| 202 | 1 | 1 (label right) | Right-Click |
| 203 | 2 | 1 | Middle-Click |
| 204 | 4 | 0 | Forward |
| 205 | 3 | 0 | Backward |
| 206 | 5 | 1, dashed connector | DPI Loop |

`key_value` is the index written in the `0x08` payload — note that keys 204 and
205 carry `4` and `3`, so visual order and wire order differ. `direction` and
`rect` place the label on the device image; `dashed` gives key 206 its dashed
connector.

`func_desc` indexes `language/1033.lan`, which resolves the defaults exactly:

```
106=Left-Click   107=Right-Click  108=Middle-Click
109=Forward      110=Backward     141=DPI Loop
```

So `func_type=1, func_value=1` is Left-Click, `3` is Right-Click, `2` is
Middle-Click, `5` is Forward, `6` is Backward, and `func_type=5, func_value=1`
is DPI Loop. The full action list in the language file runs 106-142 plus 160
(`Keyboard`).

### Defaults

| Field | Value | Meaning |
|---|---|---|
| `dpi_info default_dpi` | `2` | second stage active (1600 CPI, green) |
| `dpi_count` | `6` | six stages |
| `report_rate default_value` | `1` | 125 Hz |
| `report_max` | `4` | 125 / 250 / 500 / 1000 |
| `sleep_light` | `180` | idle timeout, minutes |
| `move_wakeup` | `0` | off |
| `move_closelight` | `0` | not exposed in the UI |
| `lod` | `1` | not exposed in the UI |
| `button_respondtime` | `8` | not exposed in the UI |

These are factory defaults, not live state. The GET commands were not recovered
(see below), so the studio initialises from this table and cannot tell you what
the mouse is currently set to.

`<firmware url="..."/>` points at the vendor's Tencent COS bucket for OTA
updates. The update path uses an authentication step (`cmd get password`) and is
not implemented here.

## Commands

| Cmd | Function | byte 4 | Payload | Confidence |
|---|---|---|---|---|
| `0x02` | Report rate | `1` | `[rate]`, `1..4` = 125/250/500/1000 Hz | verified |
| `0x03` | DPI stages | `0x25` | 6 x 4 bytes at `[6..29]` | layout inferred |
| `0x04` | DPI stage colors | `0x12` | 6 x RGB at `[5..22]` | verified |
| `0x05` | Lighting | `2`/`3`/`5`/`0x18` | see below | not used by this model |
| `0x06` | Sensor / LOD | `5` | `[5]=lod`, `[6]=flag&8`, `[7]=flag&4` | verified, not exposed |
| `0x07` | Power management | `4` | 4 bytes at `[5..8]` | partially verified |
| `0x08` | Set one key / macro | `n*4+2` | `[5]=key`, then `n` x 4-byte records | verified |
| `0x0E` | Reset indicator / lighting | `1` | `[5]=0x01` | verified |
| `0x0F` | Restore factory | `1` | `[5]=0x01`, `[6]=0xFF` | verified |

The vendor tool logs each command with a `"0xNN: <error>"` string, which is how
the command bytes were cross-checked against the functions that emit them
(`SetMouseReportRateData`, `SetMouseDPIData`, `SetMouseDPIColorData`,
`SetLightModeData`, `SetMouseSensorLiftData`, `SetMouseSleepData`,
`SetMouseKeyMacroData`, `SetMouseResetLight`, `SetMouseRestoreFactoryData`).

### Report rate — `0x02`

```text
00 02 00 01 01 RR
```

`RR`: `1` -> 125 Hz, `2` -> 250 Hz, `3` -> 500 Hz, `4` -> 1000 Hz, matching
`report_max="4"` in `device/mouse_tk-gm012.xml`.

### DPI — `0x03` (layout **inferred**)

Six 4-byte stage records start at byte 6; byte 5 stays zero.

```text
[6..7]   DPI, little endian
[8..9]   16-bit stage colour
```

The vendor tool clamps values to 50..24000. Shipped defaults are
800 / 1600 / 2400 / 3200 / 6400 / 12000.

Note the length byte is `0x25` (37) while only 25 payload bytes are written —
byte 4 is therefore a command-specific constant here, not a plain length.

### DPI colours — `0x04`

Six RGB triplets, stage 1 first:

```text
00 04 00 01 12 R1 G1 B1 R2 G2 B2 ... R6 G6 B6
```

### Lighting — `0x05` (present in firmware, **not used by this mouse**)

This model has exactly one LED: the DPI indicator under the wheel. Its colour is
set per stage through `0x04`, and there is no lighting zone to drive. The vendor
data agrees — `device/mouse_tk-gm012.xml` contains `<menu light="0"/>`, and the
tool's own navigation is Home / Mouse Key / Mouse Config / Macro / Settings, with
no lighting page.

The command is documented here because the same firmware tree serves lit models
(keyboards, mice with light guides). Byte 4 selects the payload shape:

| Shape | Modes | Payload |
|---|---|---|
| `2` | flow (0), rainbow wave (4), off (5) | `[mode][packed]` |
| `3` | breathing (1) | `[mode][packed][speed]` |
| `5` | neon (3) | `[mode][packed][R][G][B]` |
| `0x18` | steady (2) | `[mode][packed][count=7][7 x RGB]` |

`packed` is `(hiNibble << 4) | loNibble`, built by
`(light[0x30] << 4) | light[0x2C]`, which maps onto brightness and speed, each
0..15. Mode indices are 0-based in the database (`SetCurSelLightMode`); the
vendor `.xml` lists them 1-based: flow, breathing, steady, neon, rainbow wave,
off.

### Sensor — `0x06`

```text
00 06 00 01 05 LOD F8 F4
```

`F8` is `(sensor_flags & 8) ? 1 : 0` and `F4` is `(sensor_flags & 4) ? 1 : 0`.
`sensor_flag` is a bitfield from the tool's config store, so bits 4 and 8 are
two independent on/off sensor options.

This model sets `show_lod="0"` and `show_sensor="0"`, so the vendor tool never
emits `0x06` for it. It is documented for sibling models in the same firmware
family; the studio does not send it.

### Power management — `0x07`

```text
00 07 00 01 04 sleep_light ? move_wakeup close_light
```

Four consecutive `_wtoi()` results from the config store. The shipped
`mouse_tk-gm012.xml` exposes `sleep_light="180"`, `move_wakeup="0"` and
`move_closelight="0"`, which line up with bytes 5, 7 and 8; byte 6 is
unlabelled.

Only sleep and move wake-up have UI on this model. `move_closelight` is always
written as `0`, its vendor default.

### Keys and macros — `0x08`

`SetMouseKeyMacroData(int key, int profile) @ 0x34930` builds:

```text
00 08 00 01 (n*4+2) key  r0 r1 r2 r3  r4 r5 r6 r7 ...
```

`n` is the record count, capped at 6 by `GetMouseMacroData`. A keyboard record
is encoded `[0x30][0x01][0x00][flash_key_code]`, with a `[0x20]` variant for
modifiers; delays pack into the middle bytes.

`0x09` is the "set all buttons" variant, built from a 3-byte per-key table. The
surrounding glue was not decoded far enough to be confident, so this page sends
`0x08` per key instead.

### Reset / factory

```text
00 0E 00 01 01 01        reset lighting
00 0F 00 01 01 01 FF     restore factory defaults
```

## Read path

`GetMouseData` / `GetMouseData2` contain the strings `cmd get password`,
`cmd get all key`, `cmd get reportrate`, `cmd get dpi value`,
`cmd get dpi color`, `cmd get led mode`, `cmd get Sensor advanced par` and
`cmd get power_management`. The GET command bytes were not recovered — they are
built through a different helper than `SetDeviceData`, so this page does not
read state back. Settings live in the browser profile and are only written.

`cmd get password` hints at an auth step in `FirmUpgradeOTAStart` /
`FirmUpgradeOTASendData`; firmware OTA is out of scope here.

## Probing the hardware

`tools/hid_probe.py` talks to the device through `hidapi` — the same library
the vendor tool uses — so it bypasses WebHID, Chromium and the browser picker
entirely. It is the fastest way to tell "the device is not answering" apart
from "the browser cannot send this".

```bash
pip install hidapi
python tools/hid_probe.py              # list the four interfaces
python tools/hid_probe.py --probe      # 0x10 read, then 0x02 write, on the vendor collection
python tools/hid_probe.py --probe --all  # try every interface
python tools/hid_probe.py --listen 10    # dump input reports for 10 s
python tools/hid_probe.py --send "02 00 01 01 04"   # inject one frame
```

`hid_write` pads short buffers up to the report length, so the script always
puts the same bytes on the wire the vendor tool would. Note it observes the
device, not the vendor process — to capture what the official tool sends you
need USBPcap + Wireshark, or an API monitor on its `WriteFile` calls.

## Reproducing

With the `re/` tooling from the reverse-engineering workspace:

```bash
re/.venv/bin/python re/disasm.py TK-GM012.exe re/TK-GM012.syms.txt 0x4B300 80
re/.venv/bin/python re/xref.py   TK-GM012.exe re/TK-GM012.syms.txt 4B300
```

`xref.py` lists the 35 call sites of `SetDeviceData` — each one is a command.

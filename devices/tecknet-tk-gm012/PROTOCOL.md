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
| USB wired | `0x248A` | `0x5D2E` | `MI_02` | usage page `0xFFEF`, usage `0x00` |
| 2.4 GHz | `0x249A` | `0x5C2F` | `MI_02` | usage page `0xFFEF`, usage `0x00` |

The collection is not optional. `DriverComm::FindDevice @ 0x4C3A0` walks the
`hid_enumerate()` list and rejects every entry that fails these checks:

```asm
0004C3C2  mov ecx, ffef
0004C3C7  movzx eax, [esi+0x4]      ; hid_device_info.vendor_id
0004C3CB  cmp eax, [ebp+0x8]
0004C3D4  cmp eax, ebx              ; product_id
0004C3D8  cmp [esi+0x18], cx        ; usage_page == 0xFFEF
0004C3DE  cmp [esi+0x1a], 0         ; usage == 0
```

Pairing the boot mouse or keyboard collection instead produces writes the
firmware silently ignores — no error, no reply. Trackpad/keyboard interfaces and
the vendor collection often share the same product name in the browser picker,
so a `usagePage` filter is the reliable way to select it.

The build uses the `__fastcall` convention (`/Gr`): first two arguments in
`ECX`/`EDX`. That detail matters when reading the disassembly.

## Frame format (**verified**)

`DriverComm::SetDeviceData @ 0x4B300` takes a 65-byte buffer, fixes byte 0,
computes a checksum and writes it to byte 32:

```text
byte  0       report id, always 0x00   (hidapi strips it -> sendReport(0, buf[1..64]))
byte  1       command
byte  2       always 0x00
byte  3       always 0x01
byte  4       command-specific length / type byte
byte  5..31   payload (zero padded)
byte 32       checksum = (sum of bytes 5..31) & 0xFF
```

The checksum loop is nine unrolled iterations adding three bytes each, i.e.
exactly bytes `5..31`, stored to `buf[0x20]`. That caps the checksummed payload
at 27 bytes; every command below fits.

## Commands

| Cmd | Function | byte 4 | Payload | Confidence |
|---|---|---|---|---|
| `0x02` | Report rate | `1` | `[rate]`, `1..4` = 125/250/500/1000 Hz | verified |
| `0x03` | DPI stages | `0x25` | 6 x 4 bytes at `[6..29]` | layout inferred |
| `0x04` | DPI stage colors | `0x12` | 6 x RGB at `[5..22]` | verified |
| `0x05` | Lighting | `2`/`3`/`5`/`0x18` | see below | not used by this model |
| `0x06` | Sensor / LOD | `5` | `[5]=lod`, `[6]=flag&8`, `[7]=flag&4` | verified |
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

### Power management — `0x07`

```text
00 07 00 01 04 sleep_light ? move_wakeup close_light
```

Four consecutive `_wtoi()` results from the config store. The shipped
`mouse_tk-gm012.xml` exposes `sleep_light="180"`, `move_wakeup="0"` and
`move_closelight="0"`, which line up with bytes 5, 7 and 8; byte 6 is
unlabelled.

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

## Reproducing

With the `re/` tooling from the reverse-engineering workspace:

```bash
re/.venv/bin/python re/disasm.py TK-GM012.exe re/TK-GM012.syms.txt 0x4B300 80
re/.venv/bin/python re/xref.py   TK-GM012.exe re/TK-GM012.syms.txt 4B300
```

`xref.py` lists the 35 call sites of `SetDeviceData` — each one is a command.

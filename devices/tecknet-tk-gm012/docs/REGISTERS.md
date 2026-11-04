# TK-GM012 — register map

Quick reference for the command/register interface used by the vendor control
tool. The narrative, captures and evidence live in [PROTOCOL.md](PROTOCOL.md).

**Confidence:** “verified” means measured on the device. “inferred” means
recovered from the vendor binary but not yet confirmed with a capture.

## Transport

| Item | Value |
|---|---|
| USB | `248A:5D2E` |
| 2.4 GHz | `249A:5C2F` |
| Vendor collection | interface 2, usage page `0xFF01`, usage `0x0010` |
| Report size | 33 bytes out, 32 bytes back |
| Report id | 0 |

### Frame

```text
[0]      report id        0x00
[1]      command
[2]      reserved        0x00
[3]      direction       0x01 = write, 0x00 = read
[4]      length/type
[5..31]  payload          up to 27 bytes
[32]     checksum         sum of bytes 5..31, low byte
```

A reply echoes the command at `[0]`, carries a status byte at `[1]`
(`0` = accepted, `1` = rejected), and repeats the checksum at `[31]`.
The vendor driver only accepts a reply whose status byte is `0`.

### Read commands

Reads are separate command numbers, **write + `0x10`**, not writes with the
direction bit flipped:

| Write | Read | Register |
|---|---|---|
| `0x02` | `0x12` | report rate |
| `0x03` | `0x13` | DPI stages |
| `0x04` | `0x14` | DPI stage colours |
| `0x05` | `0x15` | lighting (unused) |
| `0x06` | `0x16` | sensor / LOD (not exposed) |
| `0x07` | `0x17` | power management |
| `0x08` | — | macro body, no read |
| `0x09` | `0x11` | button bindings |
| `0x10` | — | device info |
| `0x20` | — | firmware |

## Register summary

| Cmd | Name | Direction | Byte 4 | Payload | Reply |
|---|---|---|---|---|---|
| `0x02` | Report rate | write | `1` | `[1000/hz]` | echo |
| `0x03` | DPI stages | write | `0x25` | `(index<<4)\|count`, 6 × 4 B | echo |
| `0x04` | DPI colours | write | `0x12` | 6 × RGB | echo |
| `0x05` | Lighting | write | varies | not used on this model | echo |
| `0x06` | Sensor / LOD | write | `5` | not exposed on this model | echo |
| `0x07` | Power | write | `4` | `[sleep*6][wake][1][close]` | echo |
| `0x08` | Macro body | write | `n*4+1` | key + n × 4 B records | echo |
| `0x09` | Button bindings | write | `0x0F` | 6 × 3 B records | echo |
| `0x0E` | Reset indicator | write | `1` | `01` | echo |
| `0x0F` | Factory reset | write | `1` | `01 FF` | echo |
| `0x10` | Device info | read | `0` | — | 32 B |
| `0x11` | Read bindings | read | `0` | — | 18 B |
| `0x12` | Read rate | read | `0` | — | 1 B |
| `0x13` | Read DPI | read | `0` | — | 25 B |
| `0x14` | Read colours | read | `0` | — | 18 B |
| `0x15` | Read lighting | read | `0` | — | 24 B |
| `0x16` | Read sensor | read | `0` | — | 5 B |
| `0x17` | Read power | read | `0` | — | 5 B |
| `0x20` | Firmware | read | `0` | — | 2 B |

---

## `0x02` / `0x12` — report rate

```text
write: 00 02 00 01 01 RR
read:  00 12 00 00 ...
```

`RR = 1000 / hz`:

| Rate | 125 Hz | 250 Hz | 500 Hz | 1000 Hz |
|---|---|---|---|---|
| `RR` | `08` | `04` | `02` | `01` |

The `0x12` reply returns `RR` at `[4]`. Verified.

## `0x03` / `0x13` — DPI stages

```text
write: 00 03 00 01 25 P R0 R1 R2 R3 R4 R5
read:  00 13 00 00 ...
```

`P = (active_index << 4) | stage_count`

- `active_index` is 0-based: `0` = stage 1, `5` = stage 6.
- `stage_count` is 1..6.
- `R0..R5` are 4-byte records: X code (LE) followed by Y code (LE). Both
  axes normally carry the same code.

The `0x13` reply returns `P` at `[4]`, then the six records from `[5]`.
Verified.

### DPI codec

```text
dpi <= 10000        -> code = dpi / 50
10000 < dpi < 13000 -> code = 200 + (dpi - 10000) / 100
dpi >= 13000        -> code = 221 + (dpi - 13000) / 1000
```

Examples: 1100 → `0x16`, 24000 → `0xE8`.

## `0x04` / `0x14` — DPI stage colours

```text
write: 00 04 00 01 12 R0 G0 B0 ... R5 G5 B5
read:  00 14 00 00 ...
```

Six RGB triples in stage order. The `0x14` reply starts at `[4]`. Verified.

## `0x05` / `0x15` — lighting

Present in the firmware for other models, but this unit declares
`<menu light="0"/>`. Do not send this register on the TK-GM012. The only LED is
the DPI indicator, whose colour comes from `0x04`.

## `0x06` / `0x16` — sensor / LOD

The descriptor sets `show_lod="0" show_sensor="0" show_respondtime="0"`, so the
studio does not expose it. The vendor write path is:

```text
00 06 00 01 05 lod flag8 flag4 ...
```

Not used on this model.

## `0x07` / `0x17` — power management

```text
write: 00 07 00 01 04 S W A C
read:  00 17 00 00 ...
```

| Payload | Frame | Meaning |
|---|---|---|
| `[0]` / S | `[5]` | sleep timeout, **minutes × 6** |
| `[1]` / W | `[6]` | move wake-up, 1 = on |
| `[2]` / A | `[7]` | constant `1`, echoed back from the device |
| `[3]` / C | `[8]` | close-light timeout, 0 on this model |

Captured from the vendor UI with the timeout at 6 minutes:

```text
wake off: 07 00 01 04 24 00 01 00
wake on:  07 00 01 04 24 01 01 00
```

The only byte that moves with the toggle is payload index 1, so move wake-up is
**not** the third payload byte (an earlier map placed it there and the toggle
then wrote the constant marker instead). The `0x17` reply mirrors the same layout
from `[4]`: `[4]` sleep, `[5]` wake, `[6]` aux, `[7]` close.

Sleep options:

| Minutes | 1 | 2 | 5 | 6 | 10 | 15 | 20 | 30 |
|---|---|---|---|---|---|---|---|---|
| Wire | `06` | `0C` | `1E` | `24` | `3C` | `5A` | `78` | `B4` |

The XML default `sleep_light="180"` is 30 minutes. The launch capture's
`17 00 01 05 1e 00 01 00 00` is a 5-minute timeout with wake off. Verified.

## `0x08` — macro body

```text
00 08 00 01 (n*4+1) K R0 R1 ... Rn-1
```

- `K` = `key_value` (0..5).
- `n` = number of events.
- The length byte is `n*4+1`.
- Records are written to the macro slot for that key. The key is then bound to
  the slot with a `0x90` record in `0x09`.

Each event is four bytes:

```text
[0]      class
[1..2]   delay after this event, little-endian milliseconds (minimum 1)
[3]      parameter
```

| Class | Meaning | Parameter |
|---|---|---|
| `0x30` | keyboard key down | USB HID keyboard usage |
| `0xB0` | keyboard key up | same usage |
| `0x20` | modifier down | modifier bitmap |
| `0xA0` | modifier up | same bitmap |
| `0x10` | mouse button down | button bit |
| `0x90` | mouse button up | same button bit |

Modifier bitmap:

| Key | Left Shift | Right Shift | Left Ctrl | Right Ctrl | Left Alt | Right Alt | Left Win | Right Win |
|---|---|---|---|---|---|---|---|---|
| Bit | `20` | `01` | `10` | `04` | `40` | `80` | `08` | `02` |

The delay belongs to the event it follows, so the final record can carry a
trailing pause. There is no read command for this register. The vendor chunks
sequences longer than six events across several `0x08` writes; the studio caps
at six. Verified capture for a press/release of A with a 78 ms hold:

```text
00 08 00 01 09 05 30 4e 00 04 b0 01 00 04
```

`0x4e` = 78 ms sits in the key-down record, i.e. the delay until the next
event. The key-up record keeps the minimum `1`. Idle time after the last event
is not recorded, so it never reaches the packet.

## `0x09` / `0x11` — button bindings

```text
write: 00 09 00 01 0F  B0 B1 B2  B3 B4 B5  ... 6 records
read:  00 11 00 00 ...
```

Six 3-byte records in `key_value` order. The length byte is `0x0F` even though
18 payload bytes follow.

### `key_value` order

| Wire | Button |
|---|---|
| `0` | left click |
| `1` | right click |
| `2` | middle click |
| `3` | rear side button (visual Key 5) |
| `4` | front side button (visual Key 4) |
| `5` | DPI loop |

### Record classes

| First byte | Meaning | Notes |
|---|---|---|
| `0x10` | mouse button / scroll | button bit, or direction in byte 2 |
| `0x20` | scroll | `01` up, `FF` down |
| `0x30` | double-click / speed | `30 32 03` for double-click |
| `0x40` | DPI | `01` = DPI loop |
| `0x60` | special / disabled | `00` = disabled |
| `0x70` | keyboard | modifier + scancode, not fully decoded |
| `0x80` | consumer / media | HID consumer usage |
| `0x90` | macro slot | `key_value \| mode`, byte 2 = repeat count |

### Known records

| Action | Record |
|---|---|
| Left click | `10 01 00` |
| Right click | `10 02 00` |
| Middle click | `10 04 00` |
| Backward | `10 08 00` |
| Forward | `10 10 00` |
| Double-click | `30 32 03` |
| Scroll up | `20 01 00` |
| Scroll down | `20 FF 00` |
| Scroll left | `10 00 F5` |
| Scroll right | `10 00 F6` |
| Volume + | `80 E9 00` |
| Volume − | `80 EA 00` |
| Mute | `80 E2 00` |
| Play/Pause | `80 CD 00` |
| Next | `80 B5 00` |
| Previous | `80 B6 00` |
| Stop | `80 B7 00` |
| DPI loop | `40 01 00` |
| Disabled | `60 00 00` |

Macro binding:

```text
90  (key_value | loop flag)  count
```

| Flag | Vendor setting | Behaviour |
|---|---|---|
| `0x20` | Loop Times | plays `count` times |
| `0x10` | Loops Until Stop Pressing | loops while the button is held |
| `0x40` | Loops Until Any Click | toggles on/off with each click |

`count` is only used with `0x20`. A one-shot macro is `0x20` with `count = 1`;
the firmware has no separate play-once flag. Using `0x10` for a one-shot makes
a single click repeat the whole macro while the button is down. Recovered from
`SetMouseKeyMacroData @ 0x33EA0` and the macro editor's loop radios
(`OnMacroSaveRecordDataMessage`).

The `0x11` reply returns the six records from `[4]`. The studio reads this on
connect, on SYNC, and from **READ FROM MOUSE**. Unknown records are preserved
byte-for-byte when another button is written.

## `0x0E` — reset indicator

```text
00 0E 00 01 01 01
```

Resets the DPI indicator / lighting state. Verified.

## `0x0F` — factory reset

```text
00 0F 00 01 01 01 FF
```

Restores DPI, button bindings, macros and power settings to the vendor
defaults. Verified.

## `0x10` — device info

```text
00 10 00 00 ...
```

Reply offsets (WebHID payload, no report id):

| Offset | Meaning |
|---|---|
| `[0]` | `0x10` |
| `[1]` | status |
| `[4..7]` | device id, `"L93Q"` |
| `[8..9]` | firmware BCD, wired mode only; zero over 2.4 GHz |
| `[10]` | device type, `0x11` |
| `[12]` | charging, 1 = charging |
| `[13]` | battery, 0..100 |
| `[14]` | link state |

Example: `45` at `[13]` = 69%. Verified.

## `0x11` — read button bindings

Returns 18 bytes from `[4]`; see `0x09` above.

## `0x12` — read report rate

Returns `RR` at `[4]`; see `0x02`.

## `0x13` — read DPI stages

Returns `P` at `[4]`, then six 4-byte records from `[5]`; see `0x03`.

## `0x14` — read DPI colours

Returns six RGB triples from `[4]`; see `0x04`.

## `0x15` — read lighting

Unused on this model.

## `0x16` — read sensor

Unused on this model.

## `0x17` — read power

Returns `[sleep*6][wake][aux][close][0]` from `[4]`; see `0x07`.

## `0x20` — firmware

```text
00 20 00 00 ...
```

Reply:

| Byte | Meaning |
|---|---|
| `[4]` | minor version, BCD |
| `[5]` | major version, BCD |

`26 03` → **3.26**, matching USB `bcdDevice = 0x0326`. Over 2.4 GHz the `0x10`
reply has zeros in `[8..9]`, so `0x20` is the only firmware source there.
Verified.

## Vendor config keys

The vendor tool stores these in its local database and writes them through the
registers above:

| Config key | Meaning | Register |
|---|---|---|
| `report_rate` | `1000 / hz` | `0x02[5]` |
| `dpi_index` | active stage, 0..5 | `0x03[5]` high nibble |
| `dpi_count` | enabled stages, 1..6 | `0x03[5]` low nibble |
| `dpi_groupN_value` | DPI value for stage N | `0x03` record N |
| `dpi_groupN_rgb` | indicator colour for stage N | `0x04` record N |
| `sleep_light` | idle timeout, minutes × 6 | `0x07[5]` |
| `move_wakeup` | wake on movement, 0/1 | `0x07[6]` |
| `move_closelight` | close-light timeout, 0 on this model | `0x07[8]` |
| `key_value` / `func_type` / `func_value` | button binding | `0x09` record `key_value` |
| macro records | events for one key | `0x08` |

# iLovbee B75 — USB protocol

Reverse-engineered from the vendor utility (`DeviceDriver.exe`, iLovbee /
RK-style "RKKB" driver, build of 2024-12-12) and its per-model config
`Dev/01E7/KB.ini`. Nothing here has been captured from a real keyboard yet.

Markers:

- **[bin]** read directly out of the disassembly (function and address given)
- **[ini]** taken from `KB.ini` / `Cfg.ini` / the language XML
- **[inferred]** a reasonable reading that the binary does not settle

## Device selection

| | |
|---|---|
| VID / PID | `258A:01E7` ("iLovbee B75", `Cfg.ini DevName5`) **[ini]** |
| Driver class | `CDevG5KB`, because `KB.ini` has `Fw=2` (a non-zero `Fw` picks G5KB over RKKB) **[bin 0x4155c0]** |
| Collection | usage page `0xFF00` / usage `1`, or `0xFF02` / usage `1` or `2`, **and** `FeatureReportByteLength == 0x208` **[bin `CDevG5KB::FindHIDDevice` 0x40f290]** |
| Report id | whatever id that collection's feature report carries ("RID") **[bin]** |
| Transfer | `HidD_SetFeature` / `HidD_GetFeature`, always 0x208 bytes including the report id **[bin]** |

The 2.4 GHz receiver goes through `CDev3632`; see [Wireless](#wireless-24-ghz-receiver)
below.

## Packet

`CDevG5KB::AccessData` (0x40f620) **[bin]**:

| Offset | Meaning |
|---|---|
| 0 | report id |
| 1 | command |
| 2 | sub-command (layer, group, or 0) |
| 3 | 0 |
| 4 | number of packets in this transfer |
| 5 | packet index, from 0 |
| 6–7 | bytes of data in this packet, little endian |
| 8–519 | data, up to 512 bytes |

Writes are split into 512-byte chunks; the tool sleeps 25 ms before every
packet (200 ms for macros) and retries a failed `SetFeature` three times
with 50 ms pauses. Reads send the same header (empty data, length field =
bytes wanted), sleep 25 ms, then `GetFeature`; the reply's byte 1 must echo
the command and the data starts at byte 8.

In WebHID terms: `sendFeatureReport(rid, bytes[1..519])` and
`receiveFeatureReport(rid)`. Chrome returns the report id in byte 0 of the
received view; the studio accepts either layout.

## Commands

| Cmd | Dir | Sub | Length | Name in the binary | Function |
|---|---|---|---|---|---|
| `0x03` | W | layer | 504 | SetMatrix | key matrix, 126 × 4 bytes **[bin 0x40f8d0]** |
| `0x04` | W | 0 | 128 | SetLED | config / lighting block **[bin 0x40f960]** |
| `0x05` | W | 0 | n | SetMacro | macro buffer **[bin 0x411f69]** |
| `0x06` | W | group | 378 | Set key color | per-key RGB, 3 planes × 126 **[bin 0x41270b]** |
| `0x0A` | W | 0 | 420 | SetLedRgbTab | 7 colours for every effect **[bin 0x4100a0]** |
| `0x0B` | W | 0 | n | SetScreenParam | screen models only **[bin 0x410120]** |
| `0x0D` | W | 0 | 5 | SetGIFParam | screen models only **[bin 0x412770]** |
| `0x08` | W | 0 | n | SetRealData | music / real-time lighting stream **[bin 0x410550]** |
| `0x11` | W | 0 | 1 | ResetDevice | `CmdReset=1` models only; not used for 01E7 **[bin 0x4101c0]** |
| `0x12` | W | 0 | n | SendWeb | URL for the "go to website" key **[bin 0x410250]** |
| `0x82` | R | 1 | 6 | GetPassword | pairing id **[bin 0x4102d0]** |
| `0x84` | R | 0 | 128 | GetLED | config block **[bin 0x40f9e0]** |
| `0x87` | R | 0 | 2 | GetPower | two bytes **[bin 0x40fc10]**; read as level, charging **[inferred]** |
| `0x88` | R | 0 | n | GetRealData | **[bin 0x40fe60]** |

## Config block (`0x84` read, `0x04` write)

The tool always reads the block, checks the signature, patches its own
bytes and writes the whole block back (`ApplySetting` 0x411eae,
`FillCfg_LowDaly` 0x4115e0 for `Fw=2`). Bytes it does not know are
preserved, and the studio does the same.

| Offset | Meaning |
|---|---|
| `0x02`, `0x03` | debounce, both set to `DebounceHW[i]`: Office `0x00`, Gaming `0x04` **[bin][ini]** (which name is which index is **[inferred]**) |
| `0x05` | forced to 0 **[bin]** |
| `0x08` | "Tap" — 0 when disabled, else a slider value **[bin]**; not exposed |
| `0x09` | sleep: `10/20/40/60/0` for 5/10/20/30 min / never (30 s units) **[bin 0x41177e, UI labels 0x424a40]** |
| `37` | set to 1 when restoring factory settings (`ResetItem=37,1`) **[ini][bin]** |
| `0x21` | active effect id (`LedOpt` hw value; 0 = off) **[bin]** |
| `0x22` | active colour slot (0–6, 7 = colourful) **[bin]** |
| `0x23` | active brightness (`LightHW`: 0, 5, 10, 15, 20) **[bin][ini]** |
| `0x24` | active speed (0–4, default 3; `SpeedParam=0x030400`) **[bin][ini]** |
| `0x53 + 2·id` | brightness for effect `id` **[bin]** |
| `0x54 + 2·id` | `speed << 4 \| colour slot` for effect `id` **[bin]** |
| `0x7E`, `0x7F` | signature `5A A5`; the tool retries the read up to five times until it is present **[bin 0x411fb4]** |

### Effects

From `LedOpt1..19` (`hw, speed, light, direct, random, colornum`) with
English names from `tc_eft1..19`. `LedMask=0x2100` hides #9 and #14 (both
hw 0). **[ini]**

| # | id | Name | Speed | Colour |
|---|---|---|---|---|
| 1 | 1 | Steady | – | ✓ |
| 2 | 2 | Breathing | ✓ | ✓ |
| 3 | 3 | Rainbow | ✓ | – |
| 4 | 4 | Flash Away | ✓ | ✓ |
| 5 | 5 | Raindrops | ✓ | ✓ |
| 6 | 6 | Rainbow Wheel | ✓ | ✓ |
| 7 | 7 | Ripples Shining | ✓ | ✓ |
| 8 | 8 | Stars Twinkle | ✓ | ✓ |
| 10 | 9 | Retro Snake | ✓ | ✓ |
| 11 | 10 | Neon Stream | ✓ | ✓ |
| 12 | 11 | Reaction | ✓ | ✓ |
| 13 | 12 | Sine Wave | ✓ | ✓ |
| 15 | 13 | Rotating Windmill | ✓ | – |
| 16 | 14 | Colorful Waterfall | ✓ | – |
| 17 | 15 | Blossoming | ✓ | – |
| 18 | 19 | Custom (per key) | – | – |
| 19 | 0 | Off | – | – |

Factory per-effect state: speed 3, brightness index 4, slot 0, colourful on,
palette red, green, blue, yellow, magenta, cyan, white **[bin 0x4594e0]**.

## Colour table (`0x0A`)

420 bytes = 20 × 21. Effect `id` owns bytes `id·21 … id·21+20`: seven
colours as R, G, B (`RGBIndex=0,1,2`). **[bin 0x412134]**

## Per-key colour (`0x06`)

378 bytes: 126 red bytes, 126 green, 126 blue, indexed by the key's LED
index (the same number as its matrix index in `KB.ini`). Sub-command is the
custom group; the studio writes group 0. **[bin 0x4124ce]**

## Key matrix (`0x03`)

126 entries × 4 bytes, indexed by the matrix number at the end of each
`K…=` line in `KB.ini` (column-major, six rows per column). Sub-command is
the layer (0 = base, `LayerNum=4`). **[bin `FillMatrix` 0x411140]**

Entry byte 0 is a category (`keyinfo_to_hardware_code` 0x410680) **[bin]**:

| Bytes | Meaning |
|---|---|
| `00 mods k2 k1` | keyboard: HID usage `k1`, optional second usage `k2`, modifier bits (1 LCtrl, 2 LShift, 4 LAlt, 8 LWin, 0x10–0x80 right) |
| `00 bit 00 00` | a modifier key on its own. Sending it as usage `E0`–`E7` in `k1` leaves the key dead (observed on hardware: Left Shift/Ctrl/Alt/Win stopped working) |
| `01 01 n 00` | mouse button `n` (1 left, 2 right, 3 middle, 4 back, 5 forward) |
| `01 08 00 00` / `01 09 00 00` | wheel up / down **[inferred]** |
| `02 00 hi lo` | consumer usage `hi lo` (e.g. `02 00 00 E2` mute, `02 00 01 92` calculator) |
| `03 mode count id` | macro `id` (0-based buffer index). Mode 1 = repeat `count` times; 2, 4, 3 = the three loop modes (labels **[inferred]**) |
| `07 …`, `08 …` | Fn-layer system and lighting functions, as in `[FN1]` |
| `0D 00 00 00` | Fn key |

`KB.ini` stores `0x09` raw codes big-endian (`0x020000E2` → bytes
`02 00 00 E2`). The studio's factory base layer and the `[FN1]` table are in
`../keymap.js`.

## Macros (`0x05`)

`StMacro_To_HdMacro` 0x410de0, `FillMatrix` **[bin]**:

```
header:  per macro  [offset lo, offset hi, size lo, size hi]   (offsets from buffer start)
body:    [name byte count] [name, UTF-16LE, up to 40 chars] [event × n]
event:   b0 = 0x80 (key down) | type << 4 | delay bits 19–16
         b1 = delay bits 15–8
         b2 = delay bits 7–0          (ms, max 0xFFFFF)
         b3 = code
types:   1 key (HID usage, modifiers as E0–E7), 2 mouse button mask
         (1 L, 2 R, 4 M, 8 back, 0x10 forward), 3/4 mouse X/Y, 5 wheel
```

Bit 7 = down follows the recorder, which stores 0 for key-down and 0x80 for
key-up and inverts it when encoding (0x42d5c6). Macros get buffer ids in the
order keys reference them; at most 10 (`MacroBufferNum`), 4096 bytes total.
Whether the delay is applied after or before an event is **[inferred]**
(after).

## Change notifications

The keyboard reports on-board changes (Fn lighting hotkeys, wake / sleep)
unprompted **[bin `ServiceThread_G5` 0x40eae0, `ServiceThread_3632` 0x40d250,
handler 0x447bd0]**:

| Link | Report | Layout |
|---|---|---|
| wired | 8-byte input report | `[rid, 0A, type, a, b, …]` |
| wireless | 20-byte input report `0x13` | `[13, 0A, …, type (byte 5), a, b, …]` |

`type 2` means the settings changed: the tool re-reads the config block
(`a = 1` is ignored; over wireless `a = 0` marks the keyboard asleep).
`type 5` and `type 8` drive screen and key-test UI on other models. The
studio re-reads on `type 2` at once, and polls the config block while the
page is visible and no edit is pending: every 1.5 s when idle (3 s over
wireless), every 0.3 s (0.7 s) for six seconds after a change is seen.

## Wireless (2.4 GHz receiver)

Receiver `258A:01BB` ("2.4G Wireless Receiver"). The tool opens the
collection on usage page `0xFF02` / usage `2` whose input and output reports
are 20 bytes with report id `0x13` **[bin `FindWireless` 0x415c10]**, and
hands it to `CDev3632`, which the keyboard class delegates to when it has no
wired handle.

Frame (`CDev3632::AccessData` 0x40d750, `WriteFile` of 20 bytes) **[bin]**:

| Byte | Meaning |
|---|---|
| 0 | `0x13` (report id) |
| 1 | command |
| 2 | packets in this transfer |
| 3 | packet index |
| 4 | `sub << 4 \| bytes in this packet` |
| 5–18 | data, 14 bytes per packet |
| 19 | checksum: sum of bytes 0–18 |

Every packet waits up to 4 s for an input report with byte 1 = command
(0x40d2e0): byte 0 `0xFF` is an error, bit 7 of byte 2 asks for a resend
(up to 5). 15 ms before each packet. Reads send one frame with packets = 1
and collect reply packets in the same layout until index = packets − 1.

| Wired | Wireless | Function |
|---|---|---|
| `0x03` | `0x01` | key matrix, sub = layer |
| `0x06` | `0x02` | per-key colour, sub = group |
| `0x05` | `0x03` | macros, one transfer per 512-byte page, sub = page, 100 ms apart |
| `0x04` | `0x04` | config block |
| `0x0A` | `0x09` | colour table |
| `0x84` | `0x44` | config read (128 bytes) |
| `0x87` | `0x4A` | battery read (2 bytes) |
| `0x82` | `0x05` | pairing id (6 bytes); `0A 00 00 00 00 12` = B75 (`Psd`) |
| — | `0x07` | 1 byte: 0 = keyboard asleep / not linked |

Payloads are identical to the wired ones.

## Bluetooth

`Cfg.ini` sets `DisableBT=1`, so the vendor tool never configures this model
over Bluetooth and has no code for its channel.

Observed on a paired board: the keyboard enumerates as **`046D:B35A`**,
product name `B75` (Logitech's vendor id), with collections `0xFF00 / 2`,
`0x0C / 1` (twice) and `0x01 / 2`. The vendor channel `0xFF00 / 2` carries a
single **1-byte input report `0x03`** and no output or feature reports, so
nothing can be sent to the keyboard over Bluetooth: it is not configurable
on that link. The studio recognises it and asks for the cable or receiver.
What the `0x03` byte reports is not known **[open]**.

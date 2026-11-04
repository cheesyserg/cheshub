#!/usr/bin/env python3
"""TK-GM012 / "Wireless-Receiver" HID probe.

Uses hidapi — the same library the vendor tool uses — so it can tell you
whether the hardware answers at all, independently of the browser and of
WebHID's restrictions.

Setup
-----
    pip install hidapi

Usage
-----
    python hid_probe.py                     # list interfaces (default)
    python hid_probe.py --probe             # exchange frames with the vendor collection
    python hid_probe.py --probe --all       # try every interface, vendor first
    python hid_probe.py --listen 10         # dump input reports for 10 seconds
    python hid_probe.py --send "02 00 01 01 04"   # one raw frame (report id is added)

Frames
------
The reports are small: 33 bytes out, 32 bytes in. The wire layout is

    [0] 0x00    [1] command    [2] 0x00    [3] 0x01 write / 0x00 read
    [4] length  [5..31] payload           [32] checksum = sum(5..31) & 0xFF

The vendor passes a 65-byte buffer to `hid_write`, which resizes it to the real
report length; `output_report_length` is 33. Replies come back as the request
with `[0]` dropped and a status byte at `[1]`.
"""

import argparse
import sys
import time

try:
    import hid
except ImportError:
    sys.exit("hidapi is missing — run: pip install hidapi")

RECEIVERS = [(0x249A, 0x5C2F), (0x248A, 0x5D2E)]
VENDOR_PAGE = 0xFF01
VENDOR_USAGE = 0x0010

FRAME_SIZE = 33
INFO_CMD = 0x10


def checksum(frame):
    return sum(frame[5:32]) & 0xFF


def build_frame(cmd, payload=b"", write=True, length=None):
    """Build a 33-byte vendor frame (report id + 32-byte report)."""
    frame = bytearray(FRAME_SIZE)
    frame[0] = 0x00
    frame[1] = cmd & 0xFF
    frame[2] = 0x00
    frame[3] = 0x01 if write else 0x00
    frame[4] = len(payload) if length is None else length
    frame[5:5 + len(payload)] = payload[:27]
    frame[32] = checksum(frame)
    return bytes(frame)


def hexs(data):
    return " ".join(f"{b:02x}" for b in bytes(data))


def is_vendor(entry):
    return entry["usage_page"] == VENDOR_PAGE and entry["usage"] == VENDOR_USAGE


def enumerate_receivers():
    found = []
    for vid, pid in RECEIVERS:
        try:
            found.extend(hid.enumerate(vid, pid))
        except OSError as err:
            print(f"enumerate({vid:04x}:{pid:04x}) failed: {err}")
    return found


def list_interfaces():
    entries = enumerate_receivers()
    if not entries:
        print("No receiver found. Is the dongle plugged in?")
        return entries
    print(f"{'':2} {'interface':>9}  {'usage page':>10}  {'usage':>7}  product")
    for entry in entries:
        mark = "*" if is_vendor(entry) else " "
        release = entry["release_number"]
        print(f"{mark:2} {entry['interface_number']:>9}  "
              f"0x{entry['usage_page']:04X}{'':>8}  0x{entry['usage']:04X}   "
              f"{entry['product_string']}")
        print(f"   vid:pid {entry['vendor_id']:04X}:{entry['product_id']:04X}   "
              f"bcdDevice 0x{release:04X} (v{release >> 8:X}.{release & 0xFF:02X})")
        print(f"   path: {entry['path']}")
    print("\n* marks the collection the protocol runs on")
    return entries


def open_entry(entry):
    device = hid.device()
    device.open_path(entry["path"])
    device.set_nonblocking(1)
    return device


def exchange(device, frame, wait_ms=1500):
    """Write one frame and wait for the first input report."""
    print(f"  TX  {hexs(frame)}")
    try:
        written = device.write(frame)
    except OSError as err:
        print(f"  !!  write failed: {err}")
        return None
    print(f"      ({written} bytes accepted)")

    deadline = time.time() + wait_ms / 1000.0
    while time.time() < deadline:
        data = device.read(FRAME_SIZE, 60)
        if data:
            reply = bytes(data)
            print(f"  RX  {hexs(reply)}")
            return reply
    print("  --  no reply")
    return None


def probe(entries, try_all):
    if not entries:
        print("No receiver found.")
        return

    ordered = sorted(entries, key=lambda e: (not is_vendor(e), e["interface_number"]))
    if not try_all:
        ordered = [e for e in ordered if is_vendor(e)]
        if not ordered:
            print(f"Vendor collection 0x{VENDOR_PAGE:04X}/0x{VENDOR_USAGE:04X} "
                  "not present. Re-run with --all to try every interface.")
            return

    for entry in ordered:
        label = "vendor" if is_vendor(entry) else "other"
        print(f"\n=== interface {entry['interface_number']} "
              f"(0x{entry['usage_page']:04X}/0x{entry['usage']:04X}, {label}) ===")
        try:
            device = open_entry(entry)
        except OSError as err:
            print(f"  open failed: {err}")
            continue

        try:
            print(" read device info (0x10)")
            reply = exchange(device, build_frame(INFO_CMD, write=False))
            if reply:
                print(f"  => {len(reply)} bytes, first 16: {hexs(reply[:16])}")

            print(" write report rate (0x02) = 1000 Hz")
            exchange(device, build_frame(0x02, b"\x04", write=True, length=1))

            print(" read device info again")
            exchange(device, build_frame(INFO_CMD, write=False))
        finally:
            device.close()


def listen(entries, seconds):
    entry = next((e for e in entries if is_vendor(e)), None)
    if entry is None:
        print("Vendor collection not found.")
        return
    device = open_entry(entry)
    print(f"Listening on interface {entry['interface_number']} for {seconds}s "
          "(ctrl-c to stop)\n")
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            data = device.read(FRAME_SIZE, 100)
            if data:
                print(f"{time.strftime('%H:%M:%S')}  {hexs(data)}")
    except KeyboardInterrupt:
        pass
    finally:
        device.close()


def send_raw(entries, raw_hex, wait_ms):
    payload = bytes.fromhex(raw_hex.replace(",", " ").replace("0x", " "))
    entry = next((e for e in entries if is_vendor(e)), None)
    if entry is None:
        print("Vendor collection not found.")
        return

    frame = bytearray(FRAME_SIZE)
    if payload[:1] == b"\x00":
        frame[0:len(payload)] = payload[:FRAME_SIZE]
    else:
        frame[0] = 0x00
        frame[1:1 + len(payload)] = payload[:FRAME_SIZE - 1]
    if len(payload) <= FRAME_SIZE:
        frame[32] = checksum(frame)

    device = open_entry(entry)
    try:
        exchange(device, bytes(frame), wait_ms)
    finally:
        device.close()


def main():
    parser = argparse.ArgumentParser(description="TK-GM012 HID probe")
    parser.add_argument("--probe", action="store_true",
                        help="exchange the documented frames with the device")
    parser.add_argument("--all", action="store_true",
                        help="with --probe, try every interface instead of the vendor one")
    parser.add_argument("--listen", type=int, metavar="SECONDS",
                        help="dump input reports for N seconds")
    parser.add_argument("--send", metavar="HEX",
                        help="send a raw frame, e.g. \"02 00 01 01 04\"")
    parser.add_argument("--wait", type=int, default=1500,
                        help="reply timeout in ms (default 1500)")
    args = parser.parse_args()

    entries = list_interfaces()

    if args.probe:
        probe(entries, args.all)
    if args.send:
        send_raw(entries, args.send, args.wait)
    if args.listen:
        listen(entries, args.listen)
    if not (args.probe or args.send or args.listen):
        print("\nAdd --probe to talk to it, --listen N to record, "
              "or --send HEX to inject a frame.")


if __name__ == "__main__":
    main()

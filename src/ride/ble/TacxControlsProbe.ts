/**
 * TacxControlsProbe — a CAPTURE RIG for the Tacx vendor service, not a decoder.
 *
 * WHY THIS IS NOT A PARSER, AND MUST NOT BECOME ONE UNTIL A CAPTURE EXISTS:
 * The owner asked for the handlebar controls (brake levers, shifters, steering)
 * to be forwarded "like Zwift does". Everything below is what a gpt-5.6-sol
 * source review (2026-07-15) established, and every line of it argues against
 * writing a parser today:
 *
 *  - `cf800001-00db-15a1-0e3f-ffa5794c3719` is the only non-DFU custom service
 *    on the owner's trainer (dumped live over the native bridge). It is very
 *    probably Garmin's private "Tacx Trainer BLE Service", which Garmin's own
 *    developer page says carries BUTTON STATUS and VIRTUAL-GEAR STATUS.
 *  - Garmin does NOT publish the frame format; it is available by request only.
 *    No public decoder exists — QDomyos-Zwift, Gymnasticon and openant were all
 *    checked, and none touch cf8000*. There is no byte layout to copy, so any
 *    parser written now would be invented, i.e. a lie with a struct around it.
 *  - THE BRAKE IS PROBABLY NOT REPORTED AT ALL. The levers brake the flywheel
 *    internally (Garmin's own manual), and independent testing plus Garmin
 *    forum reports on both fw 0.0.46 and the 4.5 beta describe the physical
 *    bike stopping while the app merely coasts down — i.e. ZWIFT DOES NOT
 *    RECEIVE THE BRAKE EITHER. Zwift's braking comes from Zwift Play/Ride
 *    controllers, which is a different device entirely. Expect this capture to
 *    prove the brake is invisible; that is a real result, not a failure.
 *  - What plausibly IS forwardable: virtual GEAR position, and the two small
 *    inner control buttons (which is how Zwift steering works on supported
 *    firmware). Both ride on this same service.
 *  - The owner's trainer reports FE-C and NO FTMS, which matches the LEGACY
 *    first-generation NEO Bike BLE configuration rather than the NEO Bike Plus
 *    / firmware 4.5 one. On legacy firmware the buttons may not be exported at
 *    all. `readIdentity()` below settles this before anyone spends time on it.
 *
 * So this file does exactly two honest things: it reports what the device says
 * about itself, and it logs raw frames with timestamps so that a decode can be
 * EARNED from a real capture with the owner's hands on the bike.
 *
 * HOW TO RUN A CAPTURE (needs the owner, the trainer, and ~10 minutes):
 *   1. Pair the trainer normally (Add Device), then in the page console:
 *        await window.__laasDbg.tacxProbe()
 *      It prints the identity block + the vendor service's real property
 *      bitmasks, subscribes to whatever actually notifies, and starts logging.
 *   2. Ride in SIM/slope mode — the manual says the virtual shifters are
 *      DISABLED in ERG/resistance mode, so a capture in ERG proves nothing.
 *   3. Work the action matrix, pausing ~2 s between actions and calling
 *        window.__laasDbg.tacxMark('left brake 50%')
 *      immediately BEFORE each one, so the log has operator markers:
 *        10 s idle; each shifter x10; hold each shifter 3 s; each inner button
 *        press+hold; both together; each brake at 25/50/100% held 3 s; both
 *        brakes; brakes while stationary; brakes while coasting.
 *   4. `window.__laasDbg.tacxDump()` returns the whole log (also mirrored to
 *      console, so `adb logcat -s LaasWeb` captures it on the APK).
 *
 * READING THE RESULT (shapes to look for, per the same review):
 *   - a field that increments and STAYS  -> absolute gear position
 *   - bits that set on press, clear on release -> button bitfield
 *   - exactly one packet per press, none on release -> momentary event
 *   - a byte/word tracking 25/50/100%   -> analog brake position
 *   - NOTHING changes on brake, while CSC/FE-C speed decays faster
 *                                        -> brake is internal-only, as expected
 * If the vendor service stays silent even for shifters, it likely needs an
 * initialization write. DO NOT brute-force it: capture Zwift talking to the
 * bike via Android HCI snoop (Developer options -> enable Bluetooth HCI snoop
 * log -> `adb bugreport`) and read the handles for cf800002/cf800003 in
 * Wireshark to see what it sends first.
 */

import { CHR, SVC, type BleDeviceHandle } from './Transport';

/** BluetoothGattCharacteristic property bits — the native bridge reports this
 *  bitmask verbatim, because direction cannot be inferred from UUID numbering. */
const PROP = {
  read: 0x02,
  writeNoResponse: 0x04,
  write: 0x08,
  notify: 0x10,
  indicate: 0x20,
} as const;

export function describeProps(props: number): string {
  const names: string[] = [];
  if (props & PROP.read) names.push('READ');
  if (props & PROP.writeNoResponse) names.push('WRITE_NO_RESP');
  if (props & PROP.write) names.push('WRITE');
  if (props & PROP.notify) names.push('NOTIFY');
  if (props & PROP.indicate) names.push('INDICATE');
  return names.length > 0 ? names.join('|') : `none(0x${props.toString(16)})`;
}

export function toHex(dv: DataView): string {
  let s = '';
  for (let i = 0; i < dv.byteLength; i++) s += dv.getUint8(i).toString(16).padStart(2, '0');
  return s;
}

/** a handle that can report characteristic properties — the native bridge
 *  does; the shared BleDeviceHandle contract deliberately does not, since no
 *  sensor code needs it. Feature-detected rather than required. */
interface PropertyAwareHandle extends BleDeviceHandle {
  properties(service: string | number, chr: string | number): number | null;
  dumpTree(): Record<string, { uuid: string; props: number }[]>;
}

function isPropertyAware(h: BleDeviceHandle): h is PropertyAwareHandle {
  return typeof (h as PropertyAwareHandle).properties === 'function';
}

export interface CaptureEvent {
  /** ms since capture start — relative, so frames line up with markers */
  t: number;
  kind: 'notify' | 'marker';
  chr?: string;
  hex?: string;
  len?: number;
  /** FE-C only: the page id (byte 4 of the 13-byte tunnel frame). Manufacturer
   *  -specific pages live in 0xF0-0xFF; standard pages like 0x10/0x19 change on
   *  their own as speed/cadence/power move and prove nothing about buttons. */
  fecPage?: number;
  note?: string;
}

export class TacxControlsCapture {
  private t0 = performance.now();
  readonly events: CaptureEvent[] = [];

  private push(e: CaptureEvent): void {
    this.events.push(e);
    // mirrored to console so `adb logcat -s LaasWeb` catches it on the APK,
    // where there is no devtools window to read
    console.log(`[tacxcap] ${e.t.toFixed(0)}ms ${e.kind} ${e.note ?? `${e.chr} len=${e.len} ${e.hex}`}`);
  }

  mark(note: string): void {
    this.push({ t: performance.now() - this.t0, kind: 'marker', note: `--- ${note} ---` });
  }

  record(chr: string, dv: DataView, fecPage?: number): void {
    this.push({
      t: performance.now() - this.t0,
      kind: 'notify',
      chr,
      len: dv.byteLength,
      hex: toHex(dv),
      ...(fecPage !== undefined ? { fecPage } : {}),
    });
  }

  /** page-id histogram over the FE-C tunnel: the cheap test for whether button
   *  state rides a manufacturer-specific page we already receive but ignore */
  fecPageHistogram(): Record<string, number> {
    const h: Record<string, number> = {};
    for (const e of this.events) {
      if (e.fecPage === undefined) continue;
      const k = `0x${e.fecPage.toString(16).padStart(2, '0')}`;
      h[k] = (h[k] ?? 0) + 1;
    }
    return h;
  }
}

export interface TacxProbeReport {
  deviceName: string;
  /** model/firmware/hardware, read from 0x180A. Firmware decides whether
   *  button/steering export can exist on this machine at all. */
  identity: Record<string, string>;
  hasVendorService: boolean;
  /** what the vendor characteristics ACTUALLY are, read off the device */
  vendorCharacteristics: { uuid: string; props: string }[];
  subscribed: string[];
  subscribeErrors: string[];
  fullTree?: Record<string, { uuid: string; props: number }[]>;
  note: string;
}

async function readString(handle: BleDeviceHandle, chr: number): Promise<string | null> {
  const dv = await handle.read(SVC.deviceInformation, chr);
  if (!dv) return null;
  let s = '';
  for (let i = 0; i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(i));
  return s.replace(/\0+$/, '').trim();
}

/**
 * Attach the capture to a connected trainer. Subscribes ONLY to vendor
 * characteristics that genuinely advertise notify/indicate, and never writes to
 * the vendor service — an undocumented control point is not something to poke
 * blind while the owner is sitting on the bike.
 */
export async function probeTacxControls(
  handle: BleDeviceHandle,
  capture: TacxControlsCapture,
): Promise<TacxProbeReport> {
  const identity: Record<string, string> = {};
  for (const [label, chr] of [
    ['model', CHR.modelNumber],
    ['firmware', CHR.firmwareRevision],
    ['hardware', CHR.hardwareRevision],
  ] as const) {
    const v = await readString(handle, chr);
    if (v !== null) identity[label] = v;
  }

  const report: TacxProbeReport = {
    deviceName: handle.name,
    identity,
    hasVendorService: handle.hasService(SVC.tacxControls),
    vendorCharacteristics: [],
    subscribed: [],
    subscribeErrors: [],
    note: '',
  };

  if (isPropertyAware(handle)) report.fullTree = handle.dumpTree();

  if (!report.hasVendorService) {
    report.note =
      'No cf800001 vendor service on this device. On the Web Bluetooth path this can also mean the service exists but is unauthorized; on the native bridge the tree is the real one.';
    return report;
  }

  for (const chr of [CHR.tacxControlsA, CHR.tacxControlsB]) {
    if (!handle.hasCharacteristic(SVC.tacxControls, chr)) continue;
    const props = isPropertyAware(handle) ? handle.properties(SVC.tacxControls, chr) : null;
    report.vendorCharacteristics.push({ uuid: chr, props: props === null ? 'unknown' : describeProps(props) });
    // subscribe only where the device says it can notify/indicate. Where props
    // are unknown (Web Bluetooth path) try anyway and record the failure — a
    // rejected subscribe is information too.
    const canNotify = props === null || (props & (PROP.notify | PROP.indicate)) !== 0;
    if (!canNotify) continue;
    try {
      await handle.startNotify(SVC.tacxControls, chr, (dv) => capture.record(chr, dv));
      report.subscribed.push(chr);
    } catch (e) {
      report.subscribeErrors.push(`${chr}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // FE-C in parallel: settles question 3 (do the buttons ride a
  // manufacturer-specific page we already receive?) at zero extra cost. The
  // page id is byte 4 of the 13-byte tunnel frame.
  if (handle.hasService(SVC.tacxFec)) {
    try {
      await handle.startNotify(SVC.tacxFec, CHR.tacxFecTx, (dv) => {
        capture.record(CHR.tacxFecTx, dv, dv.byteLength > 4 ? dv.getUint8(4) : undefined);
      });
      report.subscribed.push(CHR.tacxFecTx);
    } catch (e) {
      report.subscribeErrors.push(`fec: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  report.note =
    report.subscribed.length === 0
      ? 'Vendor service present but nothing subscribable — it may need an initialization write. Do NOT brute-force: capture Zwift with Android HCI snoop and read the cf800002/cf800003 handles in Wireshark.'
      : 'Capture armed. Ride in SIM/slope mode (shifters are disabled in ERG). Call __laasDbg.tacxMark("...") before each action, then __laasDbg.tacxDump().';
  return report;
}

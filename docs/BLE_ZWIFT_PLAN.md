# BLE device support — the Zwift-grade rebuild (PAUSED, not abandoned)

**Status 2026-07-15:** researched, root-caused, briefed, workflow written — then
**paused** because it edits the same tree/branch as the tablet FPS campaign and
would have poisoned its measurements. Nothing here is speculative: the device
facts below were scanned off real hardware.

**The owner graded the current implementation 2/5.** His bar, verbatim:

> "я все датчики свои ble хочу увидеть и чтобы было разумно как в zwift —
> понимает сложные датчики все дела"
>
> "напоминаю, я жду не поделку а уровень подключения девайсов как в Zwift. если
> ты думаешь отделать файнтюном под одно устройство — не прокатит. не
> разбираешься где каденс где мощность и как устройства связаны — не прокатит"
>
> "может быть отдельный источник (педали например) для мощности и каденса, а
> тренажёр для управления и т.п."
>
> "ты будешь знать все варианты. до следующего деплоя. изучишь интернет, если
> галлюцинируешь эти знания."

A filter tweak that makes one trainer appear is an explicit FAIL.

---

## MEASURED GROUND TRUTH — do not re-derive, do not contradict

Scanned off a Realtek BT 5.4 dongle on the owner's box (controller
`XX:XX:XX:XX:XX:XX`), `bluetoothctl info <MAC>`, 2026-07-15:

### Tacx Smart Bike 12583 — `XX:XX:XX:XX:XX:XX`
```
0x1818  Cycling Power
0x1816  Cycling Speed and Cadence
0x180a  Device Information
6e40fec1-b5a3-f393-e0a9-e50e24dcca9e   Tacx/Garmin proprietary "FE-C over BLE"
```
**NO `0x1826` FTMS.**

### HRMPro+:506196 — `XX:XX:XX:XX:XX:XX`  (connects fine today)
```
0x180d  Heart Rate
0x1814  Running Speed and Cadence
6a4e3e10-667b-11e3-949a-0800200c9a66   Garmin proprietary
00003e10-0000-1000-8000-00805f9b34fb
```

## ROOT CAUSE — why the trainer is invisible (proven, not guessed)

`src/ride/ble/Transport.ts` → `KIND_PROFILE.trainer.filterServices = [SVC.ftms]`.
Web Bluetooth matches the **advertised** packet. This trainer never advertises
FTMS, so it can never appear in that chooser. No amount of UI work fixes it.

Second, subtler bug in the same call:
```ts
filters: [{ services: prof.filterServices }]   // ← AND, not OR
```
One filter entry listing several services requires the device to advertise
**all** of them. OR alternatives need **separate filter entries**.

Third: this Tacx's resistance control speaks **FE-C over `6e40fec1-…`**, not
FTMS SIM. Our SIM path cannot drive it at all.

## WHAT THE REBUILD MUST BE (device-first, not slot-first)

Today's UI is slot-first: four rows (trainer/power/cadence/hr), each with its
own CONNECT that opens a filtered chooser. That shape *is* the problem.

1. **Add a device** — one chooser listing every cycling device (OR-filter
   entries over FTMS, 0x1818, 0x1816, 0x180d + known vendor services incl. Tacx
   FE-C).
2. **Connect → probe GATT → derive a CAPABILITY SET** (power? cadence? speed?
   hr? controllable?) from what is actually present plus the CPM/CSC flag bits —
   never from a device name or a per-vendor `if`-chain. A capability must be
   provable from the protocol.
3. **Role/source mux** — each metric (power, cadence, speed, hr, control) is fed
   by a chosen device. One device can fill several roles. Roles are
   re-assignable. **A capability being available must never force it to be
   used.**
4. **Persist pairings** within what Web Bluetooth actually permits.

### The acceptance case (owner's own example — the design fails without it)
> power-meter **PEDALS** → Power + Cadence, while the **SMART TRAINER** →
> Controllable **only**, with the trainer's own power channel deliberately
> **ignored**.

Two devices, split roles, one capability consciously unused. If a present
capability silently forces itself into use, it is still slot-first.

### Where cadence actually comes from (the owner's explicit test)
Cadence is almost never a standalone sensor. `Cycling Power Measurement`
(`0x2a63`) carries a flags field whose bits declare optional **Crank Revolution
Data** (cumulative crank revs + last crank event time, 1/1024 s units); cadence
is *derived*: `Δcrankრevs / ΔcrankEventTime`, with 16-bit rollover handling. CSC
(`0x2a5b`) carries the same revs separately. So a device advertising only
`0x1818` can still provide cadence — which is exactly why the Tacx gives cadence
through its Power service. A parser that misreads the flag bits produces
confident WRONG cadence, which is worse than none.

## PLAN OF RECORD

A fully-briefed 4-phase Opus workflow already exists on disk:

```
.claude/projects/-d-models2-dev-my-fable5-world-roaming-cycling/
  5b3b268d-8632-44f1-82f7-c4355e726c82/workflows/scripts/ble-zwift-grade-wf_33d1ceff-022.js
```
Relaunch with `Workflow({scriptPath: "<that path>"})`. Phases:

1. **Research** — protocol-level: CPM/CSC flag bits + offsets + event-time units
   + rollover; FTMS; Tacx FE-C pages/UUIDs; the Zwift model and its conflict
   rules; **`setupVariants`: every real-world combination, researched on the web
   with REQUIRED source URLs** (the schema rejects an answer without them,
   because the owner pre-called memory-recall as hallucination). Variants to
   cover: smart trainer alone; pedals + smart trainer (his case); power meter +
   dumb trainer; speed sensor + virtual power; standalone cadence sensor;
   single- vs dual-sided pedals; FTMS vs FE-C vs Wahoo; a `0x1818` device with
   no crank data; running `0x1814` devices that must NOT be offered as cycling
   sources.
2. **Design** — capability model + role mux + module boundaries.
3. **Build** — implement; keep the `FakeTransport` seam alive (headless
   Chromium has no BT stack; `tools/probe-ble.ts` depends on it).
4. **Verify** — adversarial: hunt per-device hacks, check the cadence maths
   against the spec, drive the pedals+trainer acceptance case through two staged
   fake devices, spot-check research claims against their cited URLs.

## TEST RIG (available, verified working)

- Realtek BT 5.4 dongle in this box; `bluetoothctl --timeout 20 scan le` sees
  both devices above.
- Linux Chrome needs `chrome://flags/#enable-experimental-web-platform-features`
  for `navigator.bluetooth` (already documented in `Transport.ts`).
- On-device: Web Bluetooth in the APK's Chrome Custom Tab **works** — the owner
  connected the HRM Pro live (`HEART — HRMPro+:506196`, green, DROP).

## WHY IT IS PAUSED

The tablet FPS campaign edits `src/vegetation`, `src/gpu/passes`, `src/render`
and measures through the dev server on the same working tree. A BLE agent
committing mid-measurement would silently poison every fps number. Sequential,
not concurrent. **Resume after the FPS campaign wraps.**

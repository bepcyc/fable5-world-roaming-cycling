# BLE for the ride layer — research notes (M1.4)

Date: 2026-07-03. Method: multi-agent deep research (106 agents, 24 sources,
117 claims extracted, 25 adversarially verified 3-vote, 24 confirmed / 1
refuted-and-re-researched) + three targeted follow-up rounds (FTMS 0x2AD2
exact layout from the spec PDF, per-brand trainer quirks from open-source
code, gear shifting / steering reverse-engineering). Owner directive: M1.4
is built WITHOUT real devices — spec conformance + defensive parsing;
hardware session deferred (Q8, ROADMAP M3.2).

Primary sources: Bluetooth SIG GATT Specification Supplement (GSS), FTMS
v1.0 spec PDF, CPS 1.1 + test spec, Chrome developer docs, Web Bluetooth CG
spec + implementation-status, and code: pycycling, Auuki (Web Bluetooth
production app), gymnasticon, zwack, sensors-swift-trainers, zwiftplay,
ESP32Sterzo, Ki2.

Everything below is little-endian unless stated.

---

## 1. Heart Rate — service 0x180D, HR Measurement 0x2A37 (notify)

- Flags **uint8**: bit0 = HR value format (0 → uint8 bpm, 1 → uint16 bpm);
  bits1–2 sensor contact (2 = supported+no contact, 3 = supported+contact,
  0/1 = feature unsupported); bit3 = Energy Expended present (uint16, kJ);
  bit4 = RR-Intervals present.
- RR-Intervals: repeated **uint16, unit 1/1024 s**, packed to end of payload,
  transmitted OLDEST FIRST (up to 8 per notification at 23-octet MTU; sensor
  discards oldest on overflow).
- Battery via standard Battery Service 0x180F if present.

## 2. Cycling Power — service 0x1818

### 2.1 CP Measurement 0x2A63 (notify)

Flags **uint16** + mandatory **Instantaneous Power sint16 (W, 1 W)**. Then
optional fields IN BIT ORDER, each also gated by the corresponding
"Supported" bit of CP Feature 0x2A65:

| Flags bit | Field | Type / unit |
|---|---|---|
| 0 | Pedal Power Balance | uint8, **1/2 %** (bit1 = reference: 1 → left) |
| 2 | Accumulated Torque | uint16, **1/32 N·m** (bit3 = source: wheel/crank) |
| 4 | Wheel Revolution Data | uint32 cum revs + uint16 event time **1/2048 s** |
| 5 | Crank Revolution Data | uint16 cum revs + uint16 event time **1/1024 s** |
| 6 | Extreme Force Magnitudes | 2 × sint16 (max/min N) |
| 7 | Extreme Torque Magnitudes | 2 × sint16 (1/32 N·m) |
| 8 | Extreme Angles | uint24 = two packed 12-bit angles (deg) |
| 9 / 10 | Top / Bottom Dead Spot Angle | uint16 deg |
| 11 | Accumulated Energy | uint16 kJ |
| 12 | Offset Compensation Indicator | (flag only) |

**TRAP: CPS wheel event time is 1/2048 s; CSC wheel event time is 1/1024 s.**
Crank time is 1/1024 s in both. Wheel time wraps every 32 s (CPS), counters
wrap mod 2^32 (wheel) / 2^16 (crank) — rate math must be modular.

Cadence rpm = ΔcrankRevs / (ΔeventTicks/1024) × 60. Speed m/s =
ΔwheelRevs × circumference / (ΔeventTicks/2048). Identical event time ⇒ no
new event (rider stopped) — hold then decay, never divide by 0.

### 2.2 CP Control Point 0x2A66 (write + indicate)

Response = indication op **0x20** {request op, result}; result 0x01 =
success. Ops (each optional, gated by CP Feature bits):
0x01 Set Cumulative Wheel Value · 0x02 Update Sensor Location ·
**0x04 Set Crank Length (uint16, 1/2 mm)** · 0x05 Request Crank Length ·
0x06/0x07 Set/Request Chain Length · 0x08 Set Chain Weight · 0x0A Set Span
Length · **0x0C Start Offset Compensation (zero-offset calibration)** ·
0x0D Mask CP Measurement Content · 0x0E Request Sampling Rate ·
0x0F Request Factory Calibration Date.

### 2.3 CP Vector 0x2A64 (notify) — per-stroke force/torque arrays

Instantaneous force/torque magnitude arrays + first crank measurement angle.
Enabling its notifications can fail with ATT error 0x80 "Inappropriate
Connection Parameters" — and **Web Bluetooth gives no control over
connection parameters**, so Vector is best-effort only.

### 2.4 Cycling Dynamics reality check (OPEN)

The SPEC defines extreme force/torque/angles + Vector; whether Garmin
Rally / Favero Assioma actually populate them over BLE is **unverified** —
community consensus says full Cycling Dynamics is ANT+/proprietary in
practice. Do not promise these metrics until the hardware session.

## 3. CSC — service 0x1816, CSC Measurement 0x2A5B (notify)

Flags **uint8**: bit0 wheel (uint32 cum + uint16 time **1/1024 s**), bit1
crank (uint16 cum + uint16 time 1/1024 s). Same modular rate math.

**Wheel circumference lives in the APP, not the sensor** — a wheel-speed
sensor reports revolutions only; the client multiplies by configured
circumference (default 2.105 m for 700×25c) to get speed/distance.

## 4. FTMS — service 0x1826

### 4.1 Indoor Bike Data 0x2AD2 (notify) — FTMS §4.9, GSS §3.138

Flags **uint16**, then fields in bit order:

| Bit | Field (present when bit = 1 unless noted) | Type / unit |
|---|---|---|
| 0 | **INVERTED**: Instantaneous Speed present when bit0 == 0 | uint16, 0.01 km/h |
| 1 | Average Speed | uint16, 0.01 km/h |
| 2 | Instantaneous Cadence | uint16, **0.5 rpm (wire = rpm×2!)** |
| 3 | Average Cadence | uint16, 0.5 rpm |
| 4 | Total Distance | **uint24**, m |
| 5 | Resistance Level | see note |
| 6 | Instantaneous Power | sint16, W |
| 7 | Average Power | sint16, W |
| 8 | Expended Energy = 3 fields: Total uint16 kcal + Per-Hour uint16 + Per-Minute uint8 (0xFFFF/0xFF = not available) |
| 9 | Heart Rate | uint8 bpm |
| 10 | Metabolic Equivalent | uint8, 0.1 MET |
| 11 | Elapsed Time | uint16 s |
| 12 | Remaining Time | uint16 s |

- Bit 0 "More Data" semantics (§4.19): record too big for one notification →
  first/middle notifications have bit0=1 (NO speed), the LAST has bit0=0
  (speed present). Parse speed iff bit0==0. Known FTMS v1.0 Table 4.10
  erratum prints bit 2 with inverted wording — GSS + all implementations
  agree only bit 0 is inverted.
- **Resistance Level width is ambiguous in the wild**: current GSS says
  uint8, FTMS-era Assigned Numbers said sint16 — real trainers ship
  **sint16 (2 bytes)**; pycycling parses i16, Auuki 2 bytes. We parse s16.
- Cadence ×2 bug is the classic mistake (qdomyos-zwift #1814): halve it.
- Notification rate ~1–4 Hz per brand, not configurable — timestamp on
  receipt, never assume dt.

### 4.2 Fitness Machine Feature 0x2ACC (read)

8 octets = two uint32 bitfields: machine features ‖ target-setting features.
Machine: bit1 Cadence, bit2 Total Distance, bit7 Resistance Level, bit10 HR,
bit14 Power Measurement. Targets: bit2 Resistance Target, **bit3 Power
Target (ERG)**, **bit13 Indoor Bike Simulation**, bit14 Wheel Circumference,
bit15 Spin Down Control.

### 4.3 Fitness Machine Control Point 0x2AD9 (write + indicate)

Response = indication **0x80** {request op, result}; results: 0x01 success,
0x02 not supported, 0x03 invalid param, 0x04 failed, **0x05 control not
permitted**. Ops:

- **0x00 Request Control — MUST precede any control op** or trainer answers
  0x05. Some trainers drop control after stop/idle; on Machine Status
  "Control Permission Lost" re-request.
- 0x01 Reset · 0x04 Set Target Resistance (uint8, 0.1) ·
  **0x05 Set Target Power (sint16 W — ERG)** · 0x07 Start/Resume · 0x08 Stop/Pause
- **0x11 Set Indoor Bike Simulation Parameters**: wind sint16 (0.001 m/s) +
  grade sint16 (**0.01 %**) + Crr uint8 (0.0001) + Cw uint8 (0.01 kg/m)
- 0x12 Set Wheel Circumference (uint16, 0.1 mm) · 0x13 Spin Down Control
  (start/ignore)

### 4.4 Fitness Machine Status 0x2ADA (notify) — optional in the wild

Op + params: 0x08 Target Power Changed (sint16 W) · 0x12 Sim Params Changed
(same layout as CP 0x11) · 0x13 Wheel Circumference Changed · 0x14 Spin Down
Status (0x01 requested / 0x02 success / 0x03 error / 0x04 stop pedaling) ·
**0xFF Control Permission Lost** (sent to the client that lost it). Not all
vendors implement 0x2ADA/Training Status — treat optional.

## 5. Per-brand trainer quirks

- **Tacx FE-C over BLE** (verified in pycycling/abellono): service
  `6e40fec1-b5a3-f393-e0a9-e50e24dcca9e`, TX(notify) `6e40fec2-…`,
  RX(write) `6e40fec3-…` (Nordic-UART-like, numbering swapped vs NUS).
  Full ANT+ FE-C frames tunneled: `[0xA4, 0x09, 0x4F, 0x05, page…, checksum]`;
  pycycling computes checksum as sum-of-bytes&0xFF (works on real Tacx).
  Pages: 0x30 basic resistance, 0x31 target power (0.25 W), 0x33 track
  resistance (grade = (pct+200)/0.01), 0x46 request page; telemetry pages
  16/25/71. Older Tacx (NEO 1, Flow, Vortex, Flux 1) are FE-C-only; NEO
  2/2T+ got FTMS by firmware. Strategy: FTMS first, FE-C fallback (Auuki
  does exactly this).
- **Wahoo WCPS** (verified in Auuki wcps/, sensors-swift-trainers):
  characteristic `a026e005-0a7d-4ab3-97fa-f1500f9feb8b` INSIDE the standard
  CPS 0x1818. Unlock FIRST: `[0x20, 0xEE, 0xFC]`. Ops: 0x42 ERG
  `[0x42, u16 W]`, 0x43 sim init (weight/crr/wind), 0x46 sim grade
  `[0x46, u16]` where value = (grade_fraction+1)×32768, 0x48 wheel circ
  (mm×10). Newer "Wahoo Fitness Machine" service `a026ee0b-…` w/ CP
  `a026e037-…` (virtual shifting / race mode). KICKR ≤2017 + SNAP are
  WCPS-only; KICKR v5(2020)+ expose FTMS too.
- **Elite**: FTMS-native (Direto/Suito/Justo), cleanest conformance; known
  spin-down-over-BLE weirdness (misreported target speed). **JetBlack
  Volt**: FTMS-native; spindown UI quirks (Berg0162/simcline #9 documents
  real Volt FTMS behavior).
- Spin-down calibration is unevenly implemented across brands — safest to
  direct users to the vendor app (we do).
- **Trainer already connected to Zwift/phone can't be connected again** —
  one central per peripheral; most common support case. Prefer trainer's
  own CPS for power over a second connection.

## 6. Gear shifting / steering (beyond M1.4 scope; recorded for the backlog)

- **Zwift Click/Play/Ride**: newer firmware/Ride = service 0xFC82 (legacy
  `00000001-19ca-4651-86e5-fa29dcdd09d1`), chars `…0002` notify (buttons),
  `…0003` write, `…0004` response. Handshake = ASCII "RideOn". Newer path
  PLAINTEXT protobuf; op 0x23 = button bitmap (INVERSE logic, bit 0 =
  pressed); analog levers = zigzag varints. Older Play/Click encrypt with
  ECDH P-256 + HKDF + **AES-CCM (absent from WebCrypto — needs JS shim)**.
  Browser-native demo exists (lord gist). Feasibility HIGH on the
  unencrypted path.
- **Zwift Cog / virtual shifting**: NOT a gear event source — Zwift pushes
  GearRatioX10000 to the trainer over its proprietary service; shifts
  originate in the app. For our sim: consume controller buttons, keep gear
  state ourselves, drive resistance via FTMS.
- **Shimano Di2** (D-Fly): gear position IS broadcast over private BLE (Ki2
  app consumes it); exact UUIDs need extraction from Ki2 source. **SRAM
  AXS: no BLE gear broadcast, no third-party surface — dead end.**
- **Elite Sterzo Smart steering**: service
  `347b0001-7635-408b-8918-8ff3949ce592`; `…0030` notify float32 angle
  (deg), `…0031` write, `…0032` indicate challenge-response handshake
  (bytes in ESP32Sterzo repo). Feasibility HIGH.

## 7. Web Bluetooth API constraints

- `requestDevice()` requires **transient user activation** (click) — no
  auto-connect ever; the Connect UI button is mandatory, not decoration.
- Services not named in a `filters[].services` entry MUST be pre-listed in
  `optionalServices`, or later `getPrimaryService` throws SecurityError —
  critical for proprietary services (Wahoo `a026…`, Tacx `6e40fec1…`)
  living beside standard ones.
- **Linux (owner machine!)**: Web Bluetooth NOT shipped by default — needs
  `chrome://flags/#enable-experimental-web-platform-features`
  (or `#enable-web-bluetooth`), kernel 3.19+, BlueZ ≥ 5.41; officially
  "partially implemented, not supported". Re-test on the actual Chrome 149
  at the hardware session.
- `getDevices()` / `watchAdvertisements()` (silent reconnect to permitted
  devices) are flag-gated (`#enable-web-bluetooth-new-permissions-backend`) —
  assume the user re-picks from the chooser each session; auto-retry only
  the still-held BluetoothDevice via `gattserverdisconnected`.
- Headless Chromium has NO Bluetooth stack ⇒ probes MUST fake the transport
  under the adapter interface (P6's wording in ROADMAP).
- Multiple simultaneous GATT links: no spec limit; 3–4 concurrent
  (trainer+HR+power) is routine in Auuki on Win/mac/Android; on Linux/BlueZ
  serialize connects, retry on NetworkError, expect the 3rd+ link to be the
  flaky one. `disconnect()` completion isn't awaitable — ~200 ms grace
  before reconnect.
- No control over connection parameters, MTU, or pairing/bonding from JS.

## 8. Refuted / open items

- REFUTED (1-2 vote), then re-researched from the spec PDF: the first-round
  0x2AD2 field table (final table in §4.1 above is spec-verified).
- OPEN: do Garmin Rally / Favero Assioma populate extremes/Vector over BLE?
  (hardware session).
- OPEN: exact Di2 BLE UUIDs (read Ki2 source when/if Di2 support is wanted).
- OPEN: Linux BlueZ multi-connection ceiling on the owner's adapter —
  measure at the hardware session; capture trainer/HR model names then.

## 9. Design consequences for M1.4 (implemented)

1. `BleTransport` adapter interface; `WebBluetoothTransport` (real) +
   `FakeTransport`/`FakeDevice` (probes) — headless BT absence is a hard
   constraint, not a convenience.
2. Pure `Parsers.ts` (DataView in, plain object out, bounds-checked,
   never throws) — defensive parsing per owner directive.
3. Device slots: trainer (FTMS) / power (CPS) / CSC / HR; per-slot connect
   buttons in a Connect UI (user gesture); channel priority into RideSample:
   power CPS > FTMS; cadence CPS crank > FTMS > CSC crank; HR dedicated >
   FTMS-embedded.
4. FTMS control: Request Control 0x00 → SIM params 0x11 per grade change
   (rate-limited, resend-on-0x05/permission-lost); graceful read-only
   fallback when Feature bit13 absent or writes fail.
5. Staleness: every channel carries last-notification timestamp; > 3 s stale
   → null (dashboard "—"), > 5 s → dropout state; solver just sees
   powerW=null → coasts (P6 behavior falls out of the existing seam).
6. Wahoo WCPS / Tacx FE-C fallbacks: OUT of M1.4 (no hardware to verify
   against); UUIDs + op codes recorded above for the hardware session.

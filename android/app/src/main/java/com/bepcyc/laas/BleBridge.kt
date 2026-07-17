package com.bepcyc.laas

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Native BLE bridge — the WebView replacement for Web Bluetooth.
 *
 * WHY THIS HAS TO EXIST AT ALL: `navigator.bluetooth` does NOT exist in Android
 * WebView. Web Bluetooth is a Chrome-browser feature, not a Chromium-embedder
 * one; the chooser UI and permission model live in the browser layer that
 * WebView does not ship. Moving from a Custom Tab (real Chrome, real Web
 * Bluetooth) to an in-process WebView therefore COSTS us the sensor stack
 * unless the app provides it. This bridge re-implements the transport natively
 * (BluetoothAdapter/BluetoothGatt) and re-exposes it to JS under the same
 * contract as `src/ride/ble/Transport.ts` (`BleTransport`/`BleDeviceHandle`) —
 * that file exists precisely so the sensor layer never learns which stack is
 * underneath. `src/ride/ble/NativeBridgeTransport.ts` is the JS half.
 *
 * PROTOCOL (the shape is forced by the platform, not chosen for taste):
 * `addJavascriptInterface` can only hand JS a SYNCHRONOUS return value, and
 * every interesting GATT operation is asynchronous. So `call()` takes a JSON
 * request carrying a JS-generated `id`, returns only a sync ack ("was this
 * accepted at all"), and the real outcome arrives later as
 * `window.__laasBleRecv('{"t":"reply","id":...}')` via evaluateJavascript.
 * Unsolicited traffic (scan hits, notifications, link drops) rides the same
 * channel with `t` = scan/notify/gone and no id. Payload bytes are base64:
 * the channel is a JS string literal, and base64 keeps arbitrary GATT bytes
 * from ever having to survive escaping.
 *
 * THREADING, and it is not optional:
 *  - `call()` is invoked on WebView's private "JavaBridge" thread, NOT the UI
 *    thread. Everything it does is posted to `main`.
 *  - BluetoothGattCallback fires on a binder thread. Every callback posts to
 *    `main` before touching queue state, so the queue is single-threaded.
 *  - evaluateJavascript is UI-thread-only.
 *
 * ONE OUTSTANDING GATT OP PER LINK. Android's GATT client silently drops a
 * second read/write/descriptor-write issued while one is in flight — it does
 * not queue for you and it does not error. `Conn.queue` serializes them, with
 * a timeout per op so an unresponsive peripheral stalls one operation rather
 * than wedging the link forever.
 *
 * SUBSCRIBE = setCharacteristicNotification + a CCCD write, and the CCCD value
 * must match the characteristic's own property: FTMS's control point (0x2AD9)
 * is INDICATE, while every measurement characteristic we use is NOTIFY.
 * Writing the notify value to an indicate-only characteristic subscribes to
 * nothing and reports success, so this picks by property.
 *
 * DISCOVER ONCE. `discoverServices()` runs exactly one time per link and the
 * tree is served from the GATT cache afterwards. This mirrors the fix on the
 * Web Bluetooth side (see Transport.ts discoverServices): a per-service probe
 * loop made connect cost scale with our registry, and single-service
 * peripherals (HR straps) dropped the link on their supervision timeout before
 * anyone managed to subscribe.
 */
class BleBridge(
    private val activity: Activity,
    private val webView: WebView,
) {
    companion object {
        private const val TAG = "LaasBle"

        /** window.LaasBle — the object src/ride/ble/ looks for when deciding
         *  whether a native transport is available. */
        const val JS_NAME = "LaasBle"

        /** MainActivity routes onRequestPermissionsResult back here. */
        const val PERM_REQUEST_CODE = 4711

        private const val CONNECT_TIMEOUT_MS = 20_000L
        private const val OP_TIMEOUT_MS = 10_000L

        /** Default ATT MTU is 23 (20 payload bytes). A fully-populated FTMS
         *  Indoor Bike Data or Cycling Power Measurement frame can exceed that
         *  and would arrive truncated. Requested once, after discovery, and
         *  never fatal — peripherals that refuse simply keep 23. */
        private const val PREFERRED_MTU = 247

        private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /** minSdk is 31, so both are runtime permissions on every device that
         *  can install this APK and the legacy BLUETOOTH/BLUETOOTH_ADMIN pair
         *  (maxSdkVersion 30) is dead weight. ACCESS_FINE_LOCATION is likewise
         *  NOT here: it is the Android <= 11 scan tax, and the manifest instead
         *  declares neverForLocation, which is the truth — we derive nothing
         *  about location from an advertisement. */
        private val PERMS = arrayOf(
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
        )
    }

    private val main = Handler(Looper.getMainLooper())

    private val adapter: BluetoothAdapter? =
        (activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    /** keyed by MAC — the identity the JS side hands DeviceRegistry as
     *  `BleDeviceHandle.id`, standing in for BluetoothDevice.id. It is stable
     *  across sessions, which is what the persisted role assignments need. */
    private val conns = HashMap<String, Conn>()

    private var scanning = false
    private var permCallback: ((Boolean) -> Unit)? = null

    // ---- JS-facing surface ----------------------------------------------------

    /** Feature probe for the JS side: lets the sim tell "native bridge present"
     *  from "no Bluetooth at all" and surface an honest message either way,
     *  rather than silently pretending a sensor is connected.
     *
     *  Deliberately true when the adapter merely exists, mirroring
     *  `'bluetooth' in navigator` — which is also true with Bluetooth switched
     *  off. A powered-off adapter is a fixable condition reported per-scan with
     *  a real message, not a reason to claim the machine has no radio. */
    @JavascriptInterface
    fun available(): Boolean = adapter != null

    /** Human-readable reason `available()` is false — shown in DeviceManagerUi. */
    @JavascriptInterface
    fun unavailableReason(): String =
        if (adapter == null) "This device has no Bluetooth adapter." else ""

    /**
     * Single entry point for every async operation. `request` is JSON:
     *   {id, op, ...args}
     * Returns a SYNC ack only ({"ok":true} = accepted for dispatch). The
     * operation's real outcome is delivered later to window.__laasBleRecv
     * keyed by the same `id`.
     */
    @JavascriptInterface
    fun call(request: String): String {
        return try {
            val o = JSONObject(request)
            val id = o.getString("id")
            val op = o.getString("op")
            main.post { dispatch(id, op, o) }
            """{"ok":true}"""
        } catch (e: Exception) {
            Log.w(TAG, "malformed call: $request", e)
            JSONObject().put("ok", false).put("error", "malformed request: ${e.message}").toString()
        }
    }

    private fun dispatch(id: String, op: String, o: JSONObject) {
        when (op) {
            "scan" -> withPermission(id) { startScan(id, o) }
            "stopScan" -> { stopScan(); replyOk(id) }
            "connect" -> withPermission(id) { connect(id, o.getString("addr")) }
            "notify" -> gattOp(id, o, PendingOp.KIND_CCCD)
            "read" -> gattOp(id, o, PendingOp.KIND_READ)
            "write" -> gattOp(id, o, PendingOp.KIND_WRITE)
            "disconnect" -> { conns[o.getString("addr")]?.gatt?.disconnect(); replyOk(id) }
            // liveness probe: the JS side can hold a stale "ready" after a BT
            // stack restart that never delivered onConnectionStateChange (the
            // zombie-READY the owner hit live, 2026-07-17). Truth is conns[].
            "alive" -> reply(id, JSONObject().put("ok", true).put("alive", conns.containsKey(o.getString("addr"))))
            else -> replyErr(id, "badop", "unknown op: $op")
        }
    }

    // ---- permissions ----------------------------------------------------------

    private fun hasPermissions(): Boolean =
        PERMS.all { activity.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    /** Without these the scanner returns an EMPTY result set and reports
     *  success — the single most common way a native BLE port looks "written
     *  but broken". Fail loudly with a code the UI can translate instead. */
    private fun withPermission(id: String, body: () -> Unit) {
        if (adapter == null) return replyErr(id, "noadapter", "This device has no Bluetooth adapter.")
        if (adapter.isEnabled != true) return replyErr(id, "off", "Bluetooth is switched off.")
        if (hasPermissions()) return body()
        permCallback = { granted ->
            if (granted) body()
            else replyErr(id, "perm", "Bluetooth permission denied.")
        }
        activity.requestPermissions(PERMS, PERM_REQUEST_CODE)
    }

    fun onPermissionsResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != PERM_REQUEST_CODE) return
        val cb = permCallback ?: return
        permCallback = null
        cb(grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED })
    }

    // ---- scanning -------------------------------------------------------------

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val rec = result.scanRecord
            val services = JSONArray()
            rec?.serviceUuids?.forEach { services.put(it.uuid.toString()) }
            emit(
                JSONObject()
                    .put("t", "scan")
                    .put("addr", result.device.address)
                    // scanRecord's name needs no BLUETOOTH_CONNECT, unlike
                    // BluetoothDevice.name — prefer it, fall back honestly.
                    .put("name", rec?.deviceName ?: result.device.address)
                    .put("rssi", result.rssi)
                    .put("services", services)
            )
        }

        override fun onScanFailed(errorCode: Int) {
            Log.w(TAG, "scan failed: $errorCode")
            emit(JSONObject().put("t", "scanfail").put("code", errorCode))
        }
    }

    @SuppressLint("MissingPermission") // gated by withPermission()
    private fun startScan(id: String, o: JSONObject) {
        val scanner = adapter?.bluetoothLeScanner
            ?: return replyErr(id, "noscanner", "Bluetooth scanner unavailable — is Bluetooth on?")
        if (scanning) scanner.stopScan(scanCallback)

        // ONE ScanFilter PER SERVICE = OR across filters, matching the
        // requestAnyDevice() chooser shape on the web side. A single filter
        // cannot express "advertises any of these" — and the AND reading is
        // exactly the bug that once hid the Tacx (it advertises 0x1818/0x1816
        // and FE-C, but no 0x1826 FTMS) behind a trainer-shaped filter.
        // Empty list = the acceptAllDevices escape hatch.
        val uuids = o.optJSONArray("services")
        val filters = ArrayList<ScanFilter>()
        if (uuids != null) {
            for (i in 0 until uuids.length()) {
                filters.add(
                    ScanFilter.Builder()
                        .setServiceUuid(ParcelUuid(UUID.fromString(uuids.getString(i))))
                        .build()
                )
            }
        }
        // Saved-device MAC filters, OR'd alongside the service filters: a
        // bonded trainer may drop the service UUIDs from its advertisement
        // (the owner's Tacx does after its first connect), which makes every
        // service filter miss it forever — the address filter still matches.
        // Defense in depth: honored ONLY when service filters exist. Without
        // that gate a show-all scan (no services) would degrade into
        // "saved devices only" — the exact bug the owner hit live.
        val addrs = if (filters.isEmpty()) null else o.optJSONArray("addrs")
        if (addrs != null) {
            for (i in 0 until addrs.length()) {
                try {
                    filters.add(ScanFilter.Builder().setDeviceAddress(addrs.getString(i)).build())
                } catch (e: IllegalArgumentException) {
                    Log.w(TAG, "bad addr filter: ${addrs.optString(i)}")
                }
            }
        }
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .build()
        scanner.startScan(if (filters.isEmpty()) null else filters, settings, scanCallback)
        scanning = true
        Log.i(TAG, "scan started (${filters.size} filters incl. saved-addr)")
        replyOk(id)
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try {
            adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        } catch (e: Exception) {
            Log.w(TAG, "stopScan", e)
        }
    }

    // ---- connect / GATT -------------------------------------------------------

    @SuppressLint("MissingPermission") // gated by withPermission()
    private fun connect(id: String, addr: String) {
        // A scan running across a connect measurably slows the connection and
        // buys nothing: the chooser is over.
        stopScan()
        conns.remove(addr)?.teardown()
        val device = try {
            adapter?.getRemoteDevice(addr)
        } catch (e: IllegalArgumentException) {
            null
        } ?: return replyErr(id, "badaddr", "unknown device address: $addr")

        val conn = Conn(addr)
        conn.connectId = id
        conns[addr] = conn
        // autoConnect=false: direct, fast connect. autoConnect=true is the
        // background-reconnect mode and can take tens of seconds to land.
        conn.gatt = device.connectGatt(activity, false, conn, android.bluetooth.BluetoothDevice.TRANSPORT_LE)
        conn.armConnectTimeout()
    }

    private fun gattOp(id: String, o: JSONObject, kind: Int) {
        val addr = o.getString("addr")
        val conn = conns[addr] ?: return replyErr(id, "gone", "device not connected: $addr")
        val op = PendingOp(
            id = id,
            kind = kind,
            svc = UUID.fromString(o.getString("svc")),
            chr = UUID.fromString(o.getString("chr")),
            data = o.optString("data", "").takeIf { it.isNotEmpty() }
                ?.let { Base64.decode(it, Base64.NO_WRAP) },
        )
        conn.enqueue(op)
    }

    private class PendingOp(
        val id: String,
        val kind: Int,
        val svc: UUID,
        val chr: UUID,
        val data: ByteArray?,
    ) {
        companion object {
            const val KIND_READ = 0
            const val KIND_WRITE = 1
            const val KIND_CCCD = 2
        }
    }

    @SuppressLint("MissingPermission") // every path below is post-connect, i.e. post-withPermission()
    private inner class Conn(val addr: String) : BluetoothGattCallback() {
        var gatt: BluetoothGatt? = null
        var connectId: String? = null

        private val queue = ArrayDeque<PendingOp>()
        private var current: PendingOp? = null
        private var opTimeout: Runnable? = null
        private var connectTimeout: Runnable? = null

        fun armConnectTimeout() {
            val r = Runnable {
                val id = connectId ?: return@Runnable
                connectId = null
                conns.remove(addr)
                teardown()
                replyErr(id, "timeout", "connection to $addr timed out")
            }
            connectTimeout = r
            main.postDelayed(r, CONNECT_TIMEOUT_MS)
        }

        private fun cancelConnectTimeout() {
            connectTimeout?.let { main.removeCallbacks(it) }
            connectTimeout = null
        }

        fun teardown() {
            cancelConnectTimeout()
            cancelOpTimeout()
            // close() and not just disconnect(): every connectGatt allocates a
            // client interface, and Android's GATT client pool is small and
            // finite. Leaking them is how a long session stops being able to
            // connect at all, with no error that names the cause.
            try {
                gatt?.close()
            } catch (e: Exception) {
                Log.w(TAG, "close", e)
            }
            gatt = null
        }

        // -- queue ---------------------------------------------------------------

        fun enqueue(op: PendingOp) {
            queue.addLast(op)
            pump()
        }

        private fun pump() {
            if (current != null) return
            val op = queue.removeFirstOrNull() ?: return
            current = op
            val started = try {
                start(op)
            } catch (e: Exception) {
                Log.w(TAG, "op start threw", e)
                false
            }
            if (!started) {
                current = null
                replyErr(op.id, "opfail", "could not start op on ${op.chr}")
                pump()
                return
            }
            val r = Runnable {
                val cur = current ?: return@Runnable
                current = null
                replyErr(cur.id, "timeout", "no response for op on ${cur.chr}")
                pump()
            }
            opTimeout = r
            main.postDelayed(r, OP_TIMEOUT_MS)
        }

        private fun cancelOpTimeout() {
            opTimeout?.let { main.removeCallbacks(it) }
            opTimeout = null
        }

        /** completes `current` if it is the op the callback is about, then
         *  pumps. Always called on `main`. */
        private fun finish(op: PendingOp, body: JSONObject) {
            if (current !== op) return
            cancelOpTimeout()
            current = null
            reply(op.id, body)
            pump()
        }

        private fun characteristic(op: PendingOp): BluetoothGattCharacteristic? =
            gatt?.getService(op.svc)?.getCharacteristic(op.chr)

        private fun start(op: PendingOp): Boolean {
            val g = gatt ?: return false
            val c = characteristic(op) ?: return false
            return when (op.kind) {
                PendingOp.KIND_READ -> g.readCharacteristic(c)
                PendingOp.KIND_WRITE -> write(g, c, op.data ?: ByteArray(0))
                PendingOp.KIND_CCCD -> subscribe(g, c)
                else -> false
            }
        }

        private fun write(g: BluetoothGatt, c: BluetoothGattCharacteristic, data: ByteArray): Boolean {
            // Prefer with-response (the control-point contract on both FTMS and
            // FE-C), but fall back to no-response when that is all the
            // characteristic offers. Web Bluetooth's writeValueWithResponse
            // would simply throw there; this is strictly more permissive, and a
            // vendor RX characteristic that is write-without-response only is a
            // real shape (Nordic UART, which FE-C over BLE is modelled on).
            val withResponse = c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
            val type = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(c, data, type) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    c.writeType = type
                    c.value = data
                    g.writeCharacteristic(c)
                }
            }
        }

        private fun subscribe(g: BluetoothGatt, c: BluetoothGattCharacteristic): Boolean {
            if (!g.setCharacteristicNotification(c, true)) return false
            val cccd = c.getDescriptor(CCCD) ?: return false
            // NOTIFY vs INDICATE by the characteristic's OWN property. FTMS
            // 0x2AD9 (control point) is indicate-only; writing the notify value
            // to it enables nothing and still reports success, which would show
            // up much later as "the trainer never answers control requests".
            val value = if (c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            } else {
                BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            }
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, value) == BluetoothGatt.GATT_SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    cccd.value = value
                    g.writeDescriptor(cccd)
                }
            }
        }

        // -- GATT callbacks (binder thread -> main) --------------------------------

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            main.post {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Log.i(TAG, "connected $addr, discovering")
                    if (!g.discoverServices()) {
                        val id = connectId
                        connectId = null
                        conns.remove(addr)
                        teardown()
                        if (id != null) replyErr(id, "discovery", "discoverServices() refused to start")
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Log.i(TAG, "disconnected $addr (status=$status)")
                    val id = connectId
                    connectId = null
                    conns.remove(addr)
                    // fail every op still waiting — otherwise their JS promises
                    // hang forever on a link that is already gone
                    cancelOpTimeout()
                    val dead = ArrayList<PendingOp>(queue)
                    current?.let { dead.add(0, it) }
                    current = null
                    queue.clear()
                    for (op in dead) replyErr(op.id, "gone", "link dropped during op")
                    teardown()
                    if (id != null) replyErr(id, "gone", "link dropped before connect completed (status=$status)")
                    else emit(JSONObject().put("t", "gone").put("addr", addr))
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            main.post {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    val id = connectId ?: return@post
                    connectId = null
                    conns.remove(addr)
                    teardown()
                    return@post replyErr(id, "discovery", "service discovery failed (status=$status)")
                }
                // MTU after discovery, never during: a concurrent MTU exchange
                // is a known way to make discovery flaky on some stacks.
                if (!g.requestMtu(PREFERRED_MTU)) finishConnect(g)
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            main.post {
                Log.i(TAG, "mtu=$mtu (status=$status)")
                finishConnect(g)
            }
        }

        /** guarded by connectId so a peripheral-initiated MTU change later in
         *  the session cannot re-send the connect reply */
        private fun finishConnect(g: BluetoothGatt) {
            val id = connectId ?: return
            connectId = null
            cancelConnectTimeout()
            val services = JSONArray()
            for (s in g.services) {
                val chars = JSONArray()
                // `props` is the raw BluetoothGattCharacteristic property bitmask
                // (READ 0x02, WRITE_NO_RESPONSE 0x04, WRITE 0x08, NOTIFY 0x10,
                // INDICATE 0x20). Reported because direction CANNOT be inferred
                // from UUID numbering: on the owner's Tacx the vendor service
                // cf800001 exposes cf800002/cf800003 and nothing public says
                // which is the notify path and which is the write path. The only
                // honest way to find out is to look.
                for (c in s.characteristics) {
                    chars.put(JSONObject().put("uuid", c.uuid.toString()).put("props", c.properties))
                }
                services.put(JSONObject().put("uuid", s.uuid.toString()).put("chars", chars))
            }
            Log.i(TAG, "ready $addr: ${g.services.size} services")
            reply(
                id,
                JSONObject()
                    .put("ok", true)
                    .put("addr", addr)
                    .put("name", g.device.name ?: addr)
                    .put("services", services)
            )
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            main.post { completeRead(c, value, status) }
        }

        @Deprecated("pre-33 signature; the framework calls exactly one of the two")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            val value = c.value ?: ByteArray(0)
            main.post { completeRead(c, value, status) }
        }

        private fun completeRead(c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            val op = current ?: return
            if (op.kind != PendingOp.KIND_READ || op.chr != c.uuid) return
            finish(
                op,
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    JSONObject().put("ok", true).put("data", b64(value))
                } else {
                    JSONObject().put("ok", false).put("code", "read").put("error", "read failed (status=$status)")
                }
            )
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            main.post {
                val op = current ?: return@post
                if (op.kind != PendingOp.KIND_WRITE || op.chr != c.uuid) return@post
                finish(
                    op,
                    if (status == BluetoothGatt.GATT_SUCCESS) JSONObject().put("ok", true)
                    else JSONObject().put("ok", false).put("code", "write")
                        .put("error", "write failed (status=$status)")
                )
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            main.post {
                val op = current ?: return@post
                if (op.kind != PendingOp.KIND_CCCD || op.chr != d.characteristic.uuid) return@post
                finish(
                    op,
                    if (status == BluetoothGatt.GATT_SUCCESS) JSONObject().put("ok", true)
                    else JSONObject().put("ok", false).put("code", "subscribe")
                        .put("error", "subscribe failed (status=$status)")
                )
            }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            pushNotify(c, value)
        }

        @Deprecated("pre-33 signature; the framework calls exactly one of the two")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            pushNotify(c, c.value ?: return)
        }

        /** No main.post round trip and no JSON parse of our own: this is the
         *  hot path (every measurement frame from every sensor). */
        private fun pushNotify(c: BluetoothGattCharacteristic, value: ByteArray) {
            emit(
                JSONObject()
                    .put("t", "notify")
                    .put("addr", addr)
                    .put("svc", c.service.uuid.toString())
                    .put("chr", c.uuid.toString())
                    .put("data", b64(value))
            )
        }
    }

    // ---- JS channel -----------------------------------------------------------

    private fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun reply(id: String, body: JSONObject) {
        emit(body.put("t", "reply").put("id", id))
    }

    private fun replyOk(id: String) = reply(id, JSONObject().put("ok", true))

    private fun replyErr(id: String, code: String, msg: String) {
        Log.w(TAG, "reply $id error $code: $msg")
        reply(id, JSONObject().put("ok", false).put("code", code).put("error", msg))
    }

    private fun emit(msg: JSONObject) {
        val payload = jsString(msg.toString())
        main.post {
            webView.evaluateJavascript("window.__laasBleRecv&&window.__laasBleRecv($payload);", null)
        }
    }

    /** JSON as a JS *string literal*, parsed by JSON.parse on the far side.
     *  Interpolating the JSON as a JS object literal instead would be a bug:
     *  JSON is not a subset of JS, because U+2028/U+2029 are line terminators
     *  in JS source but legal raw inside a JSON string — and a device name is
     *  attacker-adjacent free text we render into that source. */
    private fun jsString(s: String): String =
        JSONObject.quote(s)
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")

    fun shutdown() {
        main.post {
            stopScan()
            for (c in conns.values) c.teardown()
            conns.clear()
        }
        Log.i(TAG, "shutdown")
    }
}

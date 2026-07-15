package com.bepcyc.laas

import android.app.Activity
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * Native BLE bridge — the WebView replacement for Web Bluetooth.
 *
 * WHY THIS HAS TO EXIST AT ALL: `navigator.bluetooth` does NOT exist in Android
 * WebView. Web Bluetooth is a Chrome-browser feature, not a Chromium-embedder
 * one; the chooser UI and permission model live in the browser layer that
 * WebView does not ship. Moving from a Custom Tab (real Chrome, real Web
 * Bluetooth) to an in-process WebView therefore COSTS us the sensor stack
 * unless the app provides it. The owner's sensors are non-negotiable, so this
 * bridge re-implements the transport natively (BluetoothAdapter/BluetoothGatt)
 * and re-exposes it to JS under the same contract as
 * `src/ride/ble/Transport.ts` (`BleTransport` / `BleDeviceHandle`) — that file
 * exists precisely so the sensor layer never learns which stack is underneath.
 *
 * STATUS: skeleton. Wired and reachable from JS so the WebView path compiles and
 * runs, but no GATT yet — WebGPU + Game Mode had to be proven first (they are
 * the reason for the whole move; a BLE bridge onto a WebView that cannot render
 * would be wasted work). Until this is filled in, the Custom Tab escape hatch
 * (`--ez customtab true`) is the way to ride with real sensors.
 */
class BleBridge(
    @Suppress("unused") private val activity: Activity,
    @Suppress("unused") private val webView: WebView,
) {
    companion object {
        private const val TAG = "LaasBle"
        /** window.LaasBle — the object src/ride/ble/ looks for when deciding
         *  whether a native transport is available. */
        const val JS_NAME = "LaasBle"
    }

    /** Feature probe for the JS side: lets the sim tell "native bridge present"
     *  from "no Bluetooth at all" and surface an honest message either way,
     *  rather than silently pretending a sensor is connected. */
    @JavascriptInterface
    fun available(): Boolean = false

    /** Human-readable reason `available()` is false — shown in DeviceManagerUi. */
    @JavascriptInterface
    fun unavailableReason(): String =
        "Native BLE bridge not implemented yet. Relaunch via the Custom Tab " +
            "fallback (adb shell am start -n com.bepcyc.laas/.MainActivity " +
            "--ez customtab true) to use real sensors through Chrome."

    fun shutdown() {
        Log.i(TAG, "shutdown")
    }
}

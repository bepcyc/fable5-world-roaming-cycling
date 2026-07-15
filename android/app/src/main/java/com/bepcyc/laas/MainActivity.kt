package com.bepcyc.laas

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * In-process host for the ride sim (variant C, replaces the Custom Tab).
 *
 * WHY THIS IS AN IN-PROCESS WebView AND NOT A CUSTOM TAB (measured, not argued):
 * Game Mode and ADPF are applied PER PACKAGE, to the caller's own threads, and
 * AOSP only keeps a game's power mode alive while that UID is
 * PROCESS_STATE_TOP. The Custom Tab handed the foreground to Chrome one second
 * after launch, so com.bepcyc.laas dropped out of TOP. Every knob in GamePerf.kt
 * was applied to a package that drew nothing. A WebView renders inside OUR
 * process under OUR package (Chromium's GPU service runs in the host app's
 * "browser process" — android_webview/gpu/README.md), so our UID is the one on
 * screen and Game Mode finally acts on the package that draws.
 *
 * TWO THINGS THIS DOES *NOT* BUY — corrected after codex checked the sources,
 * because the first draft of this comment overclaimed both:
 *  - `dumpsys game` showing `Modes: {}` was NEVER evidence of the Custom Tab
 *    problem. That map lists the OEM's *interventions*, and our own
 *    game_mode_config.xml opts out of every one (allowGameDownscaling=false,
 *    allowGameAngleDriver=false). It is empty BY OUR OWN CONFIG and stays empty
 *    here. The real tell is `cmd game list-modes com.bepcyc.laas`, which reports
 *    performance as available and is what actually changed meaning.
 *  - ADPF does NOT follow automatically. PerformanceHintManager sessions act on
 *    explicitly supplied thread IDs, and there is no supported API to enroll
 *    WebView's private GPU/Dawn threads into our session. Game Mode is
 *    per-package and now lands correctly; ADPF thread hinting remains out of
 *    reach for a WebView-hosted renderer. Do not claim otherwise without a
 *    measurement.
 *
 * The loopback origin is kept EXACTLY as it was: http://127.0.0.1:47862 is a
 * "potentially trustworthy" origin in Chromium, so it is a secure context with
 * no TLS and no flags — which is what WebGPU (and Web Bluetooth, in Chrome)
 * require. Loading the assets through the server rather than file:// is load
 * bearing; do not "simplify" it to a file:// URL.
 *
 * HONEST PERF EXPECTATION — do not sell this as a fix. Frame time on the tablet
 * fits `frame = 106246/clock + 20.3 ms` (0.1-0.6% error). Even pinned at the
 * maximum 818 MHz that is a 150 ms frame = 6.66 fps. WebView + Game Mode + ADPF
 * can win at most the clock lottery (492 -> 818 MHz, x1.66). Reaching 30 fps
 * needs ~10x less GPU work per frame, which is a different job entirely. What
 * this activity actually buys: a stable clock instead of a 4-8 fps lottery,
 * Game Mode/ADPF becoming possible at all, and no browser chrome on screen.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "LaasMain"
        /** Escape hatch back to the old Chrome Custom Tab path:
         *    adb shell am start -n com.bepcyc.laas/.MainActivity --ez customtab true
         *  Kept because Web Bluetooth does NOT exist in WebView (see BleBridge):
         *  if the native bridge ever misbehaves, the owner still has a way to run
         *  the sim with real sensors through Chrome. */
        private const val EXTRA_CUSTOM_TAB = "customtab"
        /** Override the URL query so a harness can pin the measurement pose:
         *    adb shell am start -n com.bepcyc.laas/.MainActivity \
         *      --es params 'preset=min&dpr=0.6&nosplash=1&cam=...'
         *  Applies to BOTH paths, which is the point: an A/B of WebView vs
         *  Custom Tab is meaningless unless both load the identical URL. */
        private const val EXTRA_PARAMS = "params"
        private const val DEFAULT_PARAMS = "preset=min&dpr=0.6&ride=ble"
    }

    private lateinit var server: AssetHttpServer
    private var serverStarted = false
    private var webView: WebView? = null
    private var bleBridge: BleBridge? = null
    private var customTabLaunched = false
    private var useCustomTab = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Now meaningful: this activity is the one on screen, so the package this
        // applies to is the package that draws. See GamePerf.kt.
        GamePerf.apply(this)

        useCustomTab = intent?.getBooleanExtra(EXTRA_CUSTOM_TAB, false) ?: false

        if (useCustomTab && !isChromeInstalled()) {
            showChromeMissingDialog()
            return
        }

        server = AssetHttpServer(assets)
        server.start()
        serverStarted = true
        Log.i(TAG, "asset server on http://${AssetHttpServer.HOST}:${server.port} (customTab=$useCustomTab)")

        if (!useCustomTab) setupWebView()
    }

    private fun rideUrl(): String {
        val q = intent?.getStringExtra(EXTRA_PARAMS)?.takeIf { it.isNotBlank() } ?: DEFAULT_PARAMS
        return "http://${AssetHttpServer.HOST}:${server.port}/?$q"
    }

    // ---- WebView path ---------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        // Remote debugging over CDP (chrome://inspect). This is how fps is measured
        // on device and how a WebGPU failure gets diagnosed; the APK is a debug
        // build already, so this exposes nothing that adb did not already have.
        WebView.setWebContentsDebuggingEnabled(true)

        val wv = WebView(this)
        webView = wv
        wv.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )

        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // the sim autostarts audio/animation; no gesture to wait for
            mediaPlaybackRequiresUserGesture = false
            // loopback http:// inside an app whose manifest allows cleartext
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            // never let the sim get re-laid-out as a "mobile page"
            useWideViewPort = true
            loadWithOverviewMode = false
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
        }

        wv.setBackgroundColor(0xFF000000.toInt())
        wv.isScrollbarFadingEnabled = true
        wv.overScrollMode = View.OVER_SCROLL_NEVER

        // Keep every navigation inside our WebView; the sim is a single origin.
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val host = request?.url?.host
                return host != null && host != AssetHttpServer.HOST
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                Log.i(TAG, "page finished: $url")
                probeWebGpu()
            }
        }

        // Console -> logcat. This is the only way to see what the sim thinks went
        // wrong on device, and it is what the WebGPU probe below reports through.
        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                Log.i("LaasWeb", "[${cm.messageLevel()}] ${cm.message()} @${cm.sourceId()}:${cm.lineNumber()}")
                return true
            }

            /** WebView asks the app, not the user, for page permissions. The sim
             *  requests nothing it does not need; grant what it asks for rather
             *  than silently denying and leaving a mystery. */
            override fun onPermissionRequest(request: PermissionRequest?) {
                Log.i(TAG, "page permission request: ${request?.resources?.joinToString()}")
                request?.grant(request.resources)
            }
        }

        bleBridge = BleBridge(this, wv).also {
            wv.addJavascriptInterface(it, BleBridge.JS_NAME)
        }
        wv.addJavascriptInterface(Diag(), "LaasDiag")

        setContentView(wv)
        goImmersive()
        wv.loadUrl(rideUrl())
    }

    /** Reports whether WebGPU actually exists in this WebView, and if an adapter
     *  can be had. Printed to logcat as LaasGpu — the acceptance check for the
     *  whole variant-C move. Written as a probe rather than trusting a version
     *  number because WebGPU is NOT on by default in WebView on any milestone we
     *  could confirm, and "the docs said 149 has it" is not evidence. */
    private fun probeWebGpu() {
        val js = """
            (function () {
              try {
                var has = ('gpu' in navigator);
                if (!has) { LaasDiag.gpu('NO navigator.gpu'); return; }
                navigator.gpu.requestAdapter().then(function (a) {
                  if (!a) { LaasDiag.gpu('navigator.gpu present, requestAdapter -> null'); return; }
                  var info = (a.info || {});
                  LaasDiag.gpu('ADAPTER OK vendor=' + (info.vendor || '?') +
                               ' arch=' + (info.architecture || '?') +
                               ' desc=' + (info.description || '?'));
                }).catch(function (e) { LaasDiag.gpu('requestAdapter threw: ' + e); });
              } catch (e) { LaasDiag.gpu('probe threw: ' + e); }
            })();
        """.trimIndent()
        webView?.evaluateJavascript(js, null)
    }

    inner class Diag {
        @JavascriptInterface
        fun gpu(msg: String) = Log.i("LaasGpu", msg)
    }

    private fun goImmersive() {
        // Immersive sticky, both era-appropriate paths. No status/nav bar, and a
        // swipe brings them back transiently rather than resizing the canvas.
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && !useCustomTab) goImmersive()
    }

    // ---- Custom Tab fallback path --------------------------------------------

    override fun onResume() {
        super.onResume()
        if (!serverStarted) return

        if (!useCustomTab) {
            webView?.onResume()
            // re-assert on every resume: Game Mode tracks PROCESS_STATE_TOP
            GamePerf.apply(this)
            return
        }

        if (!customTabLaunched) {
            val intent = CustomTabsIntent.Builder()
                .setShowTitle(false)
                .setUrlBarHidingEnabled(true)
                .build()
            intent.intent.setPackage("com.android.chrome")
            try {
                intent.launchUrl(this, Uri.parse(rideUrl()))
                customTabLaunched = true
            } catch (_: ActivityNotFoundException) {
                showChromeMissingDialog()
            }
        } else {
            finish()
        }
    }

    override fun onPause() {
        if (!useCustomTab) webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        bleBridge?.shutdown()
        if (serverStarted) server.stop()
        super.onDestroy()
    }

    private fun isChromeInstalled(): Boolean {
        return try {
            packageManager.getPackageInfo("com.android.chrome", 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private fun showChromeMissingDialog() {
        AlertDialog.Builder(this)
            .setTitle("Google Chrome required")
            .setMessage(
                "The Custom Tab fallback renders through Chrome's WebGPU. Please " +
                    "install Google Chrome, or relaunch without the customtab flag."
            )
            .setPositiveButton("Get Chrome") { _, _ ->
                try {
                    startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.android.chrome"))
                    )
                } catch (_: ActivityNotFoundException) {
                    startActivity(
                        Intent(
                            Intent.ACTION_VIEW,
                            Uri.parse("https://play.google.com/store/apps/details?id=com.android.chrome")
                        )
                    )
                }
                finish()
            }
            .setNegativeButton("Close") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }
}

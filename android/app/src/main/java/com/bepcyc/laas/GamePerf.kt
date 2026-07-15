package com.bepcyc.laas

import android.app.Activity
import android.app.GameManager
import android.app.GameState
import android.os.Build
import android.util.Log

/**
 * Best-effort "treat us as a game" signalling — every knob a normal, unrooted,
 * Play-signable APK is allowed to touch, on Pixel, Samsung, or anything else.
 *
 * WHY THIS EXISTS (measured on the owner's devices 2026-07-15, not assumed):
 *   Tab S8 Ultra (Adreno 730): GPU sat at 285 MHz of a possible 818, gpubusy
 *   2.1%. Frame time fits frame = 106246/clock + 20.3 ms with 0.1-0.6% error —
 *   i.e. the CLOCK is the frame time, and the fps "lottery" of 4-8 is really a
 *   clock lottery of 492-818 MHz.
 *
 * WHAT IS *NOT* POSSIBLE, checked on both devices rather than argued:
 *   /sys/class/kgsl/kgsl-3d0/devfreq/governor (tablet) and
 *   /sys/class/devfreq/34f00000.gpu0/governor (Pixel) are both `-rw-r--r-- root
 *   root`; writing them as uid=2000(shell) gives "Permission denied", and the
 *   tablet does not even OFFER a `performance` governor (available_governors =
 *   msm-adreno-tz, exactly one). So "games just set the performance governor"
 *   is a myth: no app can, and on that SoC no such governor exists.
 *
 * THE HONEST LIMIT OF THIS FILE (rewritten 2026-07-15 — variant C). The old
 * text said "our activity is a launcher, Chrome renders under its own package,
 * so none of this can apply". Half of that is now obsolete and the other half
 * was wrong:
 *
 *   - OBSOLETE: MainActivity now hosts an in-process WebView, and WebView's GPU
 *     service runs in the host app's process (android_webview/gpu/README.md).
 *     Our package IS the one on screen, so Game Mode targets the package that
 *     draws. `cmd game list-modes com.bepcyc.laas` reports performance as
 *     available, which is our game_mode_config.xml being honoured.
 *   - WRONG: `dumpsys game` printing `[Name:com.bepcyc.laas Modes: {}]` was
 *     cited as proof that Game Mode was not applying because we were not TOP.
 *     It never meant that. MEASURED on the Pixel with our WebView focused and
 *     TOP, `Modes` is STILL `{}` — and every other game on that device prints
 *     "No intervention found for package" (Hitman, Unciv, SGT Puzzles), because
 *     `Modes` is populated from server/OEM-pushed DeviceConfig `game_overlay`
 *     interventions keyed by package name, which nobody pushes for a sideloaded
 *     APK. `Modes: {}` vs "No intervention found" is in fact the tell that our
 *     XML *was* parsed — we are the only package on the Pixel with a config
 *     object at all. Do not treat an empty `Modes` as a bug to chase.
 *
 * WHAT IT STILL DOES NOT BUY, measured, so nobody re-litigates it:
 *   - Game Mode performance vs standard, same code/URL/pose: IDENTICAL clock
 *     (818/818 MHz both) and identical fps. Setting performance changed nothing
 *     measurable. The clock win came from being in-process, not from Game Mode.
 *   - ADPF does NOT follow. PerformanceHintManager sessions act on explicitly
 *     supplied thread IDs, and there is no supported API to enroll WebView's
 *     private GPU/Dawn threads into our session. Do not claim ADPF is "on".
 *
 * (Related: Chromium enables its OWN ADPF integration by default only when
 * ro.soc.manufacturer == "Google" — verified on the devices: Pixel reports
 * "Google"/Tensor G5, the tablet reports "QTI"/SM8450. So the two devices are on
 * opposite sides of that check and their numbers do not transfer.)
 */
object GamePerf {
    private const val TAG = "LaasGamePerf"

    /** Call from onCreate/onResume. Never throws — every call here is optional
     *  on some OEM/API level, and a missing one must not break the launcher. */
    fun apply(activity: Activity) {
        gameMode(activity)
        sustained(activity)
    }

    /**
     * Android 13+ (API 33): declare we are in real-time gameplay.
     *
     * UNINTERRUPTIBLE, not INTERRUPTIBLE — corrected after codex checked the
     * docs against a first draft of this file. The flag does not mean "can the
     * user leave"; it means "is this real-time rendering that should not be
     * interrupted". A ride sim is exactly that. (It is still not a
     * "disable throttling" switch — nothing public is.)
     *
     * MEASURED CONSEQUENCE, do not expect more: under variant C our UID really
     * is PROCESS_STATE_TOP while riding, so the call now applies to the package
     * that draws — but an A/B of `cmd game mode performance` vs `standard` on
     * the tablet moved NOTHING (same 818 MHz, same fps). Accepted (gameMode=1),
     * correctly targeted, and still worth nothing measurable on these two
     * devices. Kept because it is free and an OEM layer may honour it; the
     * on-device GPU clock remains the only thing that decides.
     */
    private fun gameMode(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        try {
            val gm = activity.getSystemService(GameManager::class.java) ?: return
            gm.setGameState(GameState(/* isLoading = */ false, GameState.MODE_GAMEPLAY_UNINTERRUPTIBLE))
            Log.i(TAG, "GameManager.setGameState(GAMEPLAY_UNINTERRUPTIBLE); gameMode=${gm.gameMode}")
        } catch (t: Throwable) {
            Log.w(TAG, "GameManager unavailable: $t")
        }
    }

    /**
     * Sustained performance mode (API 24+).
     *
     * DELIBERATELY OFF, and this is not laziness: the API asks for a STABLE
     * long-run level, which the platform delivers by CAPPING the peak so
     * thermals never force a cliff. We are nowhere near a thermal cliff — we are
     * starved at 285/818 MHz — so capping the peak is exactly backwards here. It
     * is left wired and documented so nobody "discovers" it later and turns it
     * on expecting a boost.
     */
    private fun sustained(activity: Activity) {
        val enable = false
        if (!enable) return
        try {
            activity.window.setSustainedPerformanceMode(true)
            Log.i(TAG, "sustainedPerformanceMode=true")
        } catch (t: Throwable) {
            Log.w(TAG, "sustained mode unavailable: $t")
        }
    }
}

import { defineConfig } from "vite";

// LAN mode (`LAN=1 npm run dev`, i.e. `just run-lan`): bind 0.0.0.0 so a
// phone/tablet on the same Wi-Fi can reach the box. Plain HTTP — WebGPU and
// Web Bluetooth need a SECURE CONTEXT, which a LAN IP over http is NOT, so each
// client browser must whitelist the origin once:
//   chrome://flags/#unsafely-treat-insecure-origin-as-secure → http://<IP>:5173
// (No TLS cert: mkcert-per-device was a fragile dead end. See `just run-lan`.)
const lan = process.env.LAN === "1";

// POLL=1 (`POLL=1 npm run dev`): force chokidar polling. Native fs events
// miss tool-driven file writes on SOME setups (inotify limits, network
// filesystems, certain agent environments) — the symptom is edits not
// triggering reload / the module graph serving stale code. Opt-in because
// polling burns dev-time CPU for a quirk most machines don't have; if your
// edits don't hot-reload, set POLL=1 (see CONTRIBUTING.md).
const poll = process.env.POLL === "1";

export default defineConfig(({ command }) => ({
  build: {
    target: "esnext",
    // Just above the largest chunk currently emitted — growth now warns
    // again (was 4096, which silenced the tripwire at a 1.57 MB app chunk).
    chunkSizeWarningLimit: 1700,
    rollupOptions: {
      output: {
        // Vendor split: app code vs the three.js framework — the app chunk
        // churns every commit while 'three' is cache-stable on GH Pages.
        // Function form because 'three/webgpu', 'three/tsl' and
        // 'three/addons/*' are separate module ids, not caught by the
        // object form's bare-'three' entry.
        manualChunks(id: string): string | undefined {
          if (id.includes("node_modules/three")) return "three";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: lan, // 0.0.0.0 for LAN, localhost otherwise
    watch: poll ? { usePolling: true, interval: 200 } : undefined,
  },
  esbuild: {
    target: "esnext",
  },
  // ELECTRON=1 (just linux-binary) and ANDROID_APK=1 (just android-apk, the
  // offline variant-B shell) both serve dist from a 127.0.0.1 loopback root, so
  // assets must be root-absolute ('/'), NOT the '/laas/' GitHub-Pages base the
  // hosted web / TWA build uses.
  base:
    process.env.ELECTRON === "1" || process.env.ANDROID_APK === "1"
      ? "/"
      : command === "build"
        ? "/laas/"
        : "/",
}));

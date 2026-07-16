import { defineConfig } from "vite";

// LAN mode (`LAN=1 npm run dev`, i.e. `just run-lan`): bind 0.0.0.0 so a
// phone/tablet on the same Wi-Fi can reach the box. Plain HTTP — WebGPU and
// Web Bluetooth need a SECURE CONTEXT, which a LAN IP over http is NOT, so each
// client browser must whitelist the origin once:
//   chrome://flags/#unsafely-treat-insecure-origin-as-secure → http://<IP>:5173
// (No TLS cert: mkcert-per-device was a fragile dead end. See `just run-lan`.)
const lan = process.env.LAN === "1";

export default defineConfig(({ command }) => ({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: lan, // 0.0.0.0 for LAN, localhost otherwise
    // tool-driven file writes are missed by fsevents on this setup; poll so
    // the module graph never serves stale code (cost: dev-only CPU)
    watch: { usePolling: true, interval: 200 },
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

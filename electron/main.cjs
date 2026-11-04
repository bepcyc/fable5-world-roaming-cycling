// LAAS desktop shell (Electron). Rationale: this app is WebGPU + TSL compute +
// Web Bluetooth. The joint Claude+Codex packaging decision is "ship a full
// Chromium everywhere" — on Android that is a TWA over the user's Chrome, on
// the desktop that is Electron (bundled Chromium). Tauri/WebKitGTK was rejected
// for the same reason as Capacitor/System-WebView: no reliable WebGPU and no
// Web Bluetooth. See docs/PACKAGING.md.
//
// Two things this shell MUST get right, both proven on the owner's box
// (Pop!_OS, RX 6800 XT / RADV NAVI21, Chrome 149):
//   1. WebGPU on Linux/AMD needs `--enable-unsafe-webgpu --enable-features=Vulkan`.
//      Electron ships Chromium but WebGPU is NOT default-on on Linux, so we set
//      the same flags `just run-rxgpu` uses.
//   2. Do NOT add `--use-angle=vulkan`. Dawn drives its own Vulkan backend;
//      ANGLE-on-Vulkan opens a second uncoordinated Vulkan client on the same
//      GPU and native-crashes the GPU process (SIGFPE, exit 136) the moment the
//      cockpit mounts. 100% reproducible, headed only. (Justfile: run-rxgpu.)

const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ── WebGPU: match `just run-rxgpu` exactly (NO --use-angle=vulkan) ──────────
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');
// ── Web Bluetooth: navigator.bluetooth is blink-gated in Electron 43 —
// without this the API surface doesn't exist in the renderer at all.
app.commandLine.appendSwitch('enable-blink-features', 'WebBluetooth');

const DIST = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

// Serve dist/ from a loopback origin. 127.0.0.1 is a "potentially trustworthy"
// origin in Chromium → secure context → WebGPU + Web Bluetooth are permitted,
// and absolute asset paths (/assets, /splash) resolve. file:// would break the
// leading-slash asset refs in index.html, hence the tiny server.
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let rel = decodeURIComponent((req.url || '/').split('?')[0]);
        if (rel.endsWith('/')) rel += 'index.html';
        // contain within DIST (defense against ../ traversal)
        const abs = path.join(DIST, path.normalize(rel));
        if (!abs.startsWith(DIST)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        fs.readFile(abs, (err, buf) => {
          if (err) {
            // SPA-ish fallback to index.html for unknown routes
            fs.readFile(path.join(DIST, 'index.html'), (e2, idx) => {
              if (e2) { res.writeHead(404).end('not found'); return; }
              res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(idx);
            });
            return;
          }
          const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type }).end(buf);
        });
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// ── Web Bluetooth: Electron does not show Chromium's native device chooser.
// requestDevice() hangs unless the app answers `select-bluetooth-device`.
// v1 policy: auto-pick the first device the filters surface (the cycling
// sensors the app asks for are singular per kind). A proper in-renderer picker
// is a follow-up. Also grant bluetooth permission unconditionally on loopback.
function wireBluetooth(win, ses) {
  // Explicit allowlist — extend deliberately, never widen to 'all'.
  // 'bluetooth': the ride layer pairs BLE sensors via Web Bluetooth
  //   (src/ride/ble/) — the only device API the app legitimately needs.
  // Everything else (media, geolocation, notifications, hid, usb, serial,
  // fullscreen, clipboard, pointerLock, openExternal) is denied. Verified
  // by grep: no getUserMedia/clipboard/Notification/usb/hid/serial use in
  // src/; requestFullscreen is mobile-only (ImmersiveMobile no-ops on
  // desktop — isMobileDevice() gate).
  const ALLOW = new Set(['bluetooth']);
  ses.setPermissionCheckHandler((wc, permission) => ALLOW.has(permission));
  // Without a request handler Electron defaults to granting every request —
  // scope it too, or the allowlist only half-applies.
  ses.setPermissionRequestHandler((wc, permission, callback) =>
    callback(ALLOW.has(permission)),
  );
  ses.setDevicePermissionHandler((details) => ALLOW.has(details.deviceType));
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (devices.length > 0) {
      console.log(`[laas-electron] bluetooth auto-pick: ${devices[0].deviceName || devices[0].deviceId}`);
      callback(devices[0].deviceId); // first match wins
    }
    // else: wait for the next discovery event (do not cancel)
  });
}

async function main() {
  await app.whenReady();
  const origin = await startServer();
  const ses = session.defaultSession;

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: '#06080a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wireBluetooth(win, ses);
  win.once('ready-to-show', () => win.show());
  // ?nogate=1 skips BrowserGate (harmless on desktop Chrome; keeps parity with
  // the Android start_url). No preset forced on desktop — full quality.
  await win.loadURL(`${origin}/?nogate=1`);
}

app.on('window-all-closed', () => app.quit());
main().catch((err) => {
  console.error('[laas-electron] fatal:', err);
  app.quit();
});

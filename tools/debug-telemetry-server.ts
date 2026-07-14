/**
 * Tiny CORS telemetry sink for on-device (phone) debug runs. The sim, in
 * ?debug=1, POSTs boot info / steps / crash here so the desktop collects what
 * a mobile GPU did — especially the device-loss crash (sent via sendBeacon so
 * it survives the page dying). Standalone (does not touch vite.config).
 *
 *   TELE_LOG=/path/telemetry.jsonl npx tsx tools/debug-telemetry-server.ts
 *   → listens 0.0.0.0:5199, appends one JSON line per event, echoes to stdout.
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.TELE_PORT ?? 5199);
const LOG = process.env.TELE_LOG ?? './telemetry.jsonl';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      const ip = req.socket.remoteAddress ?? '?';
      const line = `${new Date().toISOString()} ${ip} ${body.replace(/\s+/g, ' ').trim()}`;
      try {
        appendFileSync(LOG, line + '\n');
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line no-console
      console.log('TELE ' + line.slice(0, 600));
      res.writeHead(204, cors);
      res.end();
    });
    return;
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
  res.end('telemetry ok\n');
}).listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[telemetry] listening 0.0.0.0:${PORT} → ${LOG}`);
});

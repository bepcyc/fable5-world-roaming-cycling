/**
 * Tacx vendor-service capture CLI — stateless page.evaluate calls against the
 * live APK WebView over CDP (adb forward tcp:9333 must be up). State (the
 * event log) lives in the page inside TacxControlsProbe; each invocation just
 * pokes it.
 *
 * Usage:
 *   npx tsx tacx-cap.ts status            — registry devices + probe state
 *   npx tsx tacx-cap.ts probe             — start the capture rig (identity+subscribe)
 *   npx tsx tacx-cap.ts mark "note"       — operator marker into the log
 *   npx tsx tacx-cap.ts dump [n]          — last n events (default 40) + page histogram
 *   npx tsx tacx-cap.ts count             — event count only (cheap poll)
 */
import { chromium } from 'playwright';

type Dbg = Record<string, unknown>;

async function main(): Promise<void> {
  const [cmd = 'status', arg = ''] = process.argv.slice(2);
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => p.url().includes('127.0.0.1')) ?? pages[0];
    if (!page) throw new Error('no page over CDP');

    if (cmd === 'status') {
      const out = await page.evaluate(() => {
        const dbg = (window as unknown as { __laasDbg?: Dbg }).__laasDbg ?? {};
        const src = dbg['bleSource'] as
          | { available(): boolean; registry: { list(): { id: string; name: string; stage: string; protocols: string[] }[] } }
          | undefined;
        return {
          url: location.href,
          bleSource: !!src,
          available: src?.available() ?? false,
          devices: src?.registry.list().map((d) => ({ id: d.id, name: d.name, stage: d.stage, protocols: d.protocols })) ?? [],
          probeStarted: !!dbg['tacxCapture'],
        };
      });
      console.log(JSON.stringify(out, null, 1));
    } else if (cmd === 'probe') {
      const out = await page.evaluate(async () => {
        const dbg = (window as unknown as { __laasDbg?: Dbg }).__laasDbg ?? {};
        const fn = dbg['tacxProbe'] as (() => Promise<unknown>) | undefined;
        if (!fn) return { error: 'tacxProbe missing (is ?ride=ble active?)' };
        return await fn();
      });
      console.log(JSON.stringify(out, null, 1));
    } else if (cmd === 'mark') {
      await page.evaluate((note) => {
        const dbg = (window as unknown as { __laasDbg?: Dbg }).__laasDbg ?? {};
        (dbg['tacxMark'] as ((n: string) => void) | undefined)?.(note);
      }, arg);
      console.log(`marked: ${arg}`);
    } else if (cmd === 'dump' || cmd === 'count') {
      const n = cmd === 'count' ? 0 : Math.max(1, parseInt(arg || '40', 10) || 40);
      const out = await page.evaluate((take) => {
        const dbg = (window as unknown as { __laasDbg?: Dbg }).__laasDbg ?? {};
        const fn = dbg['tacxDump'] as (() => { events: unknown[]; fecPages: unknown }) | undefined;
        if (!fn) return { error: 'no capture running' };
        const d = fn();
        return {
          total: d.events.length,
          fecPages: d.fecPages,
          tail: take > 0 ? d.events.slice(-take) : [],
        };
      }, n);
      console.log(JSON.stringify(out, null, 1));
    } else if (cmd === 'click') {
      await page.click(arg, { timeout: 6000 });
      console.log(`clicked: ${arg}`);
    } else if (cmd === 'clicktext') {
      // click the element whose visible text contains arg (buttons have no
      // ids). String-eval: tsx injects a __name helper into serialized
      // closures, which does not exist inside the page.
      const ok = await page.evaluate(
        `(() => { const t=${JSON.stringify(arg.toUpperCase())};` +
          `const all=[...document.querySelectorAll('.bm-btn,.bs-item,.bm-pickopt,.opt-card,.rp-btn')];` +
          `const el=all.find(e=>(e.textContent||'').toUpperCase().includes(t));` +
          `if(!el)return false; el.click(); return true; })()`,
      );
      console.log(ok ? `clicked text: ${arg}` : `NOT FOUND: ${arg}`);
    } else if (cmd === 'openmgr' || cmd === 'closemgr') {
      await page.evaluate((open) => {
        const dbg = (window as unknown as { __laasDbg?: Dbg }).__laasDbg ?? {};
        const ui = dbg['bleUi'] as { open(): void; close(): void } | undefined;
        if (open) ui?.open();
        else ui?.close();
      }, cmd === 'openmgr');
      console.log(cmd);
    } else if (cmd === 'reconnect') {
      // fire-and-forget: opens the in-page scan chooser (native path, no gesture needed)
      await page.evaluate(() => {
        const dbg = (window as unknown as { __laasDbg?: Dbg }).__laasDbg ?? {};
        const src = dbg['bleSource'] as { registry: { reconnect(): Promise<void> } } | undefined;
        void src?.registry.reconnect().catch(() => {});
      });
      console.log('chooser opened');
    } else if (cmd === 'ui') {
      // read the visible overlay state as TEXT — cheaper and more honest than
      // screenshot-guessing; screenshots are for the owner-facing receipts
      const out = await page.evaluate(
        `(() => { const clean=s=>(s||'').replace(/\\s+/g,' ').trim();` +
          `const scan=document.getElementById('ble-scan');` +
          `const mgr=document.getElementById('ble-mgr');` +
          `return { scanOpen: !!scan,` +
          ` scanRows: scan?[...scan.querySelectorAll('.bs-item')].map(r=>({addr:r.dataset.addr,text:clean(r.textContent)})):[],` +
          ` mgrOpen: mgr?mgr.classList.contains('on'):false,` +
          ` cards: [...document.querySelectorAll('.bm-devcard')].map(c=>clean(c.textContent).slice(0,220)),` +
          ` roles: [...document.querySelectorAll('.bm-rolerow')].map(r=>clean(r.textContent)) }; })()`,
      );
      console.log(JSON.stringify(out, null, 1));
    } else if (cmd === 'shot') {
      const path = arg || 'shots/wip/tacx-cap.png';
      await page.screenshot({ path });
      console.log(path);
    } else {
      console.log('unknown cmd');
    }
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});

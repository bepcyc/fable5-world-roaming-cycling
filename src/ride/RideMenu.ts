/**
 * RideMenu — the ride-recording control surface (design notes in
 * docs/STRAVA_RECORDING_UX.md).
 *
 * While a bike is being ridden a small record pill (top-right) and the `P`
 * key open the PAUSE card: it pauses the RideRecorder feed and shows an
 * elapsed / distance snapshot, with RESUME and FINISH. FINISH opens the
 * end-ride card:
 *   - activity name (default "LAAS Ride YYYY-MM-DD")
 *   - Strava connection row (CONNECT / DISCONNECT + a settings disclosure
 *     holding Client ID / secret / redirect URI / CORS proxy)
 *   - SAVE & SYNC TO STRAVA (uploads via StravaUpload; launches OAuth first
 *     if not connected) with live progress + a result toast
 *   - SAVE .FIT FILE (the existing local download)
 *   - DISCARD (confirm → reset the recorder, resume a fresh session)
 *
 * DOM+CSS like RideHud/OptionsMenu (TRAA never touches it); a MenuBus citizen
 * (opening it closes the other overlays); every string is t()-localized.
 */

import type { Engine } from '../core/Engine';
import { t } from '../core/I18n';
import { announceMenuOpen, onOtherMenuOpen } from '../core/MenuBus';
import { StravaAuth } from './strava/StravaAuth';
import { StravaUpload, type UploadPhase } from './strava/StravaUpload';
import {
  getClientId,
  getClientSecret,
  getCorsProxy,
  getRedirectUri,
  isConfigured,
  setClientId,
  setClientSecret,
  setCorsProxy,
  setRedirectUri,
} from './strava/StravaConfig';

/**
 * The narrow session seam RideMenu drives. Built in main.ts from the live
 * RideRecorder (inside RideHud); `exportFit` is the FIT-bytes provider the
 * upload consumes. A parallel branch's richer FitExport swaps in behind this
 * same shape (see RideRecorder.exportForUpload).
 */
export interface RideSessionControl {
  exportFit: (baseName: string) => { bytes: Uint8Array; name: string } | null;
  saveFile: (baseName: string) => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  snapshot: () => { elapsedS: number; distanceM: number; samples: number };
  isRiding: () => boolean;
}

const FAB_ID = 'ridemenu-fab';
const CARD_ID = 'ridemenu-card';

const STYLE = `
#${FAB_ID}{position:fixed;top:calc(10px + env(safe-area-inset-top,0px));
  right:max(16px,env(safe-area-inset-right));z-index:1300;width:48px;height:48px;
  border-radius:14px;display:none;align-items:center;justify-content:center;
  background:rgba(9,13,11,0.66);border:1px solid rgba(255,255,255,0.14);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#ff8c5a;
  cursor:pointer;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,0.35);
  transition:transform 0.16s,background 0.16s}
#${FAB_ID}.on{display:flex}
#${FAB_ID}:hover{background:rgba(24,32,28,0.8);transform:scale(1.06)}
#${FAB_ID} svg{width:24px;height:24px}
#ridemenu-backdrop{position:fixed;inset:0;z-index:1590;background:rgba(4,7,6,0.5);
  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);opacity:0;
  visibility:hidden;transition:opacity 0.2s,visibility 0.2s}
#ridemenu-backdrop.on{opacity:1;visibility:visible}
#${CARD_ID}{position:fixed;left:50%;top:50%;transform:translate(-50%,-46%) scale(0.98);
  z-index:1600;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);
  overflow-y:auto;border-radius:18px;background:rgba(10,14,12,0.94);
  border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(18px);
  -webkit-backdrop-filter:blur(18px);color:#cfe3d6;
  font-family:ui-monospace,Menlo,Consolas,monospace;padding:18px 18px 20px;
  box-shadow:0 18px 50px rgba(0,0,0,0.55);opacity:0;visibility:hidden;
  transition:opacity 0.2s,visibility 0.2s,transform 0.2s}
#${CARD_ID}.on{opacity:1;visibility:visible;transform:translate(-50%,-50%) scale(1)}
.rm-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.rm-title{font:bold 13px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.18em;
  color:#eaf6ee;text-transform:uppercase}
.rm-x{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;
  justify-content:center;cursor:pointer;color:#8fb2a2;font:15px/1 ui-monospace,monospace;
  border:1px solid transparent;transition:all 0.15s}
.rm-x:hover{color:#eaf6ee;border-color:rgba(255,255,255,0.15);background:rgba(255,255,255,0.06)}
.rm-snap{display:flex;gap:10px;margin-bottom:16px}
.rm-stat{flex:1;background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);
  border-radius:12px;padding:10px 8px;text-align:center}
.rm-stat .k{font:bold 9px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.14em;
  color:#7d9c8d;text-transform:uppercase}
.rm-stat .v{font:bold 22px/1.2 ui-monospace,Menlo,monospace;color:#eaf6ee;
  font-variant-numeric:tabular-nums;margin-top:3px}
.rm-stat .u{font:9px/1.2 ui-monospace,Menlo,monospace;color:#7d9c8d}
.rm-btn{display:block;width:100%;box-sizing:border-box;margin-top:10px;
  min-height:50px;border-radius:13px;border:1px solid rgba(255,255,255,0.14);
  background:rgba(255,255,255,0.05);color:#eaf6ee;cursor:pointer;
  font:bold 12px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.1em;
  text-transform:uppercase;user-select:none;transition:all 0.15s}
.rm-btn:hover{background:rgba(255,255,255,0.1)}
.rm-btn:active{transform:scale(0.98)}
.rm-btn.primary{background:linear-gradient(180deg,#fc5200,#e04600);
  border-color:rgba(255,120,60,0.6);color:#fff}
.rm-btn.primary:hover{background:linear-gradient(180deg,#ff6a1f,#f24d00)}
.rm-btn.primary[data-disabled]{filter:grayscale(0.7) brightness(0.7);cursor:default}
.rm-btn.danger{color:#ff9d7a;border-color:rgba(255,120,80,0.35)}
.rm-btn.danger:hover{background:rgba(120,30,16,0.4)}
.rm-btn.go{background:rgba(120,200,150,0.16);border-color:rgba(120,200,150,0.4);color:#c8f0d6}
.rm-h{font:bold 9.5px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.16em;
  color:#7d9c8d;margin:16px 0 7px;text-transform:uppercase}
.rm-field{margin-top:9px}
.rm-field label{display:block;font:9px/1.3 ui-monospace,Menlo,monospace;
  letter-spacing:0.08em;color:#7d9c8d;text-transform:uppercase;margin-bottom:4px}
.rm-input{width:100%;box-sizing:border-box;min-height:42px;padding:8px 11px;
  border-radius:10px;border:1px solid rgba(255,255,255,0.14);
  background:rgba(0,0,0,0.28);color:#eaf6ee;font:12px/1.3 ui-monospace,Menlo,monospace}
.rm-input:focus{outline:none;border-color:rgba(255,209,102,0.7)}
.rm-strava-row{display:flex;align-items:center;gap:10px;margin-top:6px;
  padding:11px 12px;border-radius:12px;background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.09)}
.rm-dot{width:9px;height:9px;border-radius:50%;flex:none;background:#7d9c8d}
.rm-dot.on{background:#5ad07a;box-shadow:0 0 8px rgba(90,208,122,0.7)}
.rm-strava-row .lbl{flex:1;font:11px/1.3 ui-monospace,Menlo,monospace;color:#cfe3d6}
.rm-link{background:none;border:none;color:#8fb2a2;cursor:pointer;
  font:11px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.06em;
  text-decoration:underline;padding:6px 4px}
.rm-link:hover{color:#eaf6ee}
.rm-mini{background:none;border:1px solid rgba(255,255,255,0.18);border-radius:9px;
  color:#cfe3d6;cursor:pointer;padding:8px 12px;min-height:38px;
  font:bold 10px/1.2 ui-monospace,Menlo,monospace;letter-spacing:0.08em;
  text-transform:uppercase;transition:all 0.15s}
.rm-mini:hover{background:rgba(255,255,255,0.08)}
.rm-settings{margin-top:4px;padding:2px 0 0;display:none}
.rm-settings.on{display:block}
.rm-note{font:10px/1.5 ui-monospace,Menlo,monospace;color:#7d9c8d;margin-top:9px}
.rm-note a{color:#8fb2a2}
.rm-toast{font:11px/1.5 ui-monospace,Menlo,monospace;margin-top:12px;min-height:16px;
  color:#cfe3d6;transition:opacity 0.2s}
.rm-toast.err{color:#ff9d7a}
.rm-toast.ok{color:#8fe0a4}
.rm-toast a{color:#ffd166}
.rm-hidden{display:none !important}
`;

const RECORD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8.4"/></svg>';

function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true;
}

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function defaultActivityName(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `LAAS Ride ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class RideMenu {
  private fab: HTMLButtonElement;
  private backdrop: HTMLDivElement;
  private card: HTMLDivElement;
  private open = false;
  private fabShown = false;
  private busy = false;

  // finish-view elements
  private pauseView!: HTMLDivElement;
  private finishView!: HTMLDivElement;
  private elapsedEl!: HTMLDivElement;
  private distEl!: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private stravaDot!: HTMLSpanElement;
  private stravaLbl!: HTMLDivElement;
  private connectBtn!: HTMLButtonElement;
  private settingsPanel!: HTMLDivElement;
  private codeRow!: HTMLDivElement;
  private codeInput!: HTMLInputElement;
  private clientIdInput!: HTMLInputElement;
  private clientSecretInput!: HTMLInputElement;
  private redirectInput!: HTMLInputElement;
  private proxyInput!: HTMLInputElement;
  private syncBtn!: HTMLButtonElement;
  private toast!: HTMLDivElement;

  constructor(
    engine: Engine,
    private session: RideSessionControl,
    private auth: StravaAuth,
    private upload: StravaUpload,
  ) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.fab = document.createElement('button');
    this.fab.id = FAB_ID;
    this.fab.type = 'button';
    this.fab.setAttribute('aria-label', t('ride.menu.recordTitle'));
    this.fab.title = t('ride.menu.recordTitle');
    this.fab.innerHTML = RECORD_ICON;
    this.fab.addEventListener('click', () => this.openCard());
    document.body.appendChild(this.fab);

    this.backdrop = document.createElement('div');
    this.backdrop.id = 'ridemenu-backdrop';
    this.backdrop.addEventListener('click', () => this.close());
    document.body.appendChild(this.backdrop);

    this.card = document.createElement('div');
    this.card.id = CARD_ID;
    this.card.addEventListener('click', (e) => e.stopPropagation());
    this.buildCard();
    document.body.appendChild(this.card);

    // MenuBus: another overlay opening closes this one (and un-pauses the feed)
    onOtherMenuOpen('ride-menu', () => {
      if (this.open) this.close();
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyP' && !e.repeat && !isTypingTarget(e)) {
        if (!this.open && this.session.isRiding()) this.openCard();
      }
      if (e.code === 'Escape' && this.open) {
        e.stopPropagation();
        this.close();
      }
    });

    // FAB visibility follows the ride state (cheap boolean compare per frame)
    engine.onUpdate(() => {
      const show = this.session.isRiding() && !this.open;
      if (show !== this.fabShown) {
        this.fabShown = show;
        this.fab.classList.toggle('on', show);
      }
    });

    // Complete a same-tab OAuth redirect if the app booted with ?code=…&scope=…
    void this.auth.captureRedirect().then((f) => {
      if (f && f.statusCode === 0) this.refreshStrava();
    });
  }

  // ---- card construction ---------------------------------------------------

  private buildCard(): void {
    const head = document.createElement('div');
    head.className = 'rm-head';
    const title = document.createElement('div');
    title.className = 'rm-title';
    const x = document.createElement('div');
    x.className = 'rm-x';
    x.textContent = '✕';
    x.setAttribute('role', 'button');
    x.setAttribute('aria-label', t('ride.menu.close'));
    x.addEventListener('click', () => this.close());
    head.append(title, x);
    this.card.appendChild(head);
    this.titleEl = title;

    this.pauseView = this.buildPauseView();
    this.finishView = this.buildFinishView();
    this.card.append(this.pauseView, this.finishView);
  }

  private titleEl!: HTMLDivElement;

  private buildPauseView(): HTMLDivElement {
    const v = document.createElement('div');
    const snap = document.createElement('div');
    snap.className = 'rm-snap';
    const mk = (k: string, u: string): HTMLDivElement => {
      const s = document.createElement('div');
      s.className = 'rm-stat';
      s.innerHTML = `<div class="k">${k}</div><div class="v">—</div><div class="u">${u}</div>`;
      snap.appendChild(s);
      return s.querySelector('.v') as HTMLDivElement;
    };
    this.elapsedEl = mk(t('ride.menu.elapsed'), '');
    this.distEl = mk(t('ride.distance'), 'km');
    v.appendChild(snap);

    const resume = this.mkBtn(t('ride.menu.resume'), 'go', () => this.resumeRide());
    const finish = this.mkBtn(t('ride.menu.finish'), 'primary', () => this.showFinish());
    v.append(resume, finish);
    return v;
  }

  private buildFinishView(): HTMLDivElement {
    const v = document.createElement('div');
    v.classList.add('rm-hidden');

    // activity name
    const nameField = document.createElement('div');
    nameField.className = 'rm-field';
    const nameLbl = document.createElement('label');
    nameLbl.textContent = t('ride.menu.activityName');
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'rm-input';
    this.nameInput.type = 'text';
    nameField.append(nameLbl, this.nameInput);
    v.appendChild(nameField);

    // strava connection row
    const row = document.createElement('div');
    row.className = 'rm-strava-row';
    this.stravaDot = document.createElement('span');
    this.stravaDot.className = 'rm-dot';
    this.stravaLbl = document.createElement('div');
    this.stravaLbl.className = 'lbl';
    this.connectBtn = document.createElement('button');
    this.connectBtn.className = 'rm-mini';
    this.connectBtn.type = 'button';
    this.connectBtn.addEventListener('click', () => this.onConnectToggle());
    row.append(this.stravaDot, this.stravaLbl, this.connectBtn);
    v.appendChild(row);

    // settings disclosure
    const settingsLink = document.createElement('button');
    settingsLink.className = 'rm-link';
    settingsLink.type = 'button';
    settingsLink.textContent = t('ride.strava.settings');
    settingsLink.addEventListener('click', () => this.settingsPanel.classList.toggle('on'));
    v.appendChild(settingsLink);

    this.settingsPanel = this.buildSettingsPanel();
    v.appendChild(this.settingsPanel);

    // paste-code row (revealed after CONNECT opens the auth tab)
    this.codeRow = document.createElement('div');
    this.codeRow.className = 'rm-field rm-hidden';
    const codeLbl = document.createElement('label');
    codeLbl.textContent = t('ride.strava.pasteCode');
    this.codeInput = document.createElement('input');
    this.codeInput.className = 'rm-input';
    this.codeInput.type = 'text';
    this.codeInput.placeholder = 'code=…';
    const codeBtn = this.mkBtn(t('ride.strava.connectCode'), 'go', () => this.onPasteCode());
    const codeHint = document.createElement('div');
    codeHint.className = 'rm-note';
    codeHint.textContent = t('ride.strava.pasteHint');
    this.codeRow.append(codeLbl, this.codeInput, codeBtn, codeHint);
    v.appendChild(this.codeRow);

    // primary + secondary actions
    this.syncBtn = this.mkBtn(t('ride.menu.saveSync'), 'primary', () => void this.onSync());
    const saveFile = this.mkBtn(t('ride.menu.saveFile'), '', () => this.onSaveFile());
    const discard = this.mkBtn(t('ride.menu.discard'), 'danger', () => this.onDiscard());
    v.append(this.syncBtn, saveFile, discard);

    this.toast = document.createElement('div');
    this.toast.className = 'rm-toast';
    v.appendChild(this.toast);

    return v;
  }

  private buildSettingsPanel(): HTMLDivElement {
    const p = document.createElement('div');
    p.className = 'rm-settings';
    const mkField = (labelKey: string, placeholder: string, isSecret = false): HTMLInputElement => {
      const f = document.createElement('div');
      f.className = 'rm-field';
      const l = document.createElement('label');
      l.textContent = t(labelKey);
      const i = document.createElement('input');
      i.className = 'rm-input';
      i.type = isSecret ? 'password' : 'text';
      i.placeholder = placeholder;
      i.autocomplete = 'off';
      f.append(l, i);
      p.appendChild(f);
      return i;
    };
    this.clientIdInput = mkField('ride.strava.clientId', '12345');
    this.clientSecretInput = mkField('ride.strava.clientSecret', '••••••••', true);
    this.redirectInput = mkField('ride.strava.redirectUri', getRedirectUri());
    this.proxyInput = mkField('ride.strava.corsProxy', 'https://proxy.example/{url}');

    const save = this.mkBtn(t('ride.strava.save'), 'go', () => this.onSaveSettings());
    p.appendChild(save);

    const note = document.createElement('div');
    note.className = 'rm-note';
    note.innerHTML = `${t('ride.strava.registerHint')} <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a>`;
    p.appendChild(note);
    return p;
  }

  private mkBtn(label: string, variant: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rm-btn' + (variant ? ' ' + variant : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- open / close --------------------------------------------------------

  private openCard(): void {
    if (this.open || !this.session.isRiding()) return;
    announceMenuOpen('ride-menu'); // one-overlay rule: closes options/BLE/pause
    this.open = true;
    this.fab.classList.remove('on');
    this.fabShown = false;
    this.session.pause();
    this.showPause();
    this.backdrop.classList.add('on');
    this.card.classList.add('on');
  }

  /** any close resumes the same recorder feed (DISCARD resets first) */
  private close(): void {
    if (!this.open) return;
    this.open = false;
    this.card.classList.remove('on');
    this.backdrop.classList.remove('on');
    this.session.resume();
  }

  private showPause(): void {
    this.titleEl.textContent = t('ride.menu.paused');
    this.finishView.classList.add('rm-hidden');
    this.pauseView.classList.remove('rm-hidden');
    const s = this.session.snapshot();
    this.elapsedEl.textContent = fmtDuration(s.elapsedS);
    this.distEl.textContent = (s.distanceM / 1000).toFixed(2);
  }

  private showFinish(): void {
    this.titleEl.textContent = t('ride.menu.finishTitle');
    this.pauseView.classList.add('rm-hidden');
    this.finishView.classList.remove('rm-hidden');
    if (!this.nameInput.value) this.nameInput.value = defaultActivityName();
    this.clientIdInput.value = getClientId();
    this.clientSecretInput.value = getClientSecret();
    this.redirectInput.value = getRedirectUri();
    this.proxyInput.value = getCorsProxy();
    this.refreshStrava();
    this.setToast('', '');
  }

  private resumeRide(): void {
    this.close();
  }

  // ---- Strava connection ---------------------------------------------------

  private refreshStrava(): void {
    this.auth.reload();
    const connected = this.auth.isAuthorized();
    this.stravaDot.classList.toggle('on', connected);
    this.stravaLbl.textContent = connected
      ? t('ride.strava.connected')
      : t('ride.strava.notConnected');
    this.connectBtn.textContent = connected ? t('ride.strava.disconnect') : t('ride.strava.connect');
  }

  private onConnectToggle(): void {
    if (this.auth.isAuthorized()) {
      void this.auth.deauthorize().then(() => {
        this.refreshStrava();
        this.setToast(t('ride.strava.disconnected'), 'ok');
      });
      return;
    }
    // connect: need credentials first
    if (!isConfigured()) {
      this.settingsPanel.classList.add('on');
      this.setToast(t('ride.strava.needCreds'), 'err');
      return;
    }
    // open the authorize URL in a new tab and reveal the paste-code field
    const url = this.auth.buildAuthorizeUrl('auto');
    window.open(url, '_blank', 'noopener');
    this.codeRow.classList.remove('rm-hidden');
    this.codeInput.focus();
    this.setToast(t('ride.strava.authOpening'), '');
  }

  private onPasteCode(): void {
    const raw = this.codeInput.value.trim();
    if (!raw) return;
    // accept a full "code=xxxx" paste or the bare code
    const code = raw.includes('code=') ? (new URLSearchParams(raw.split('?').pop() ?? raw).get('code') ?? raw) : raw;
    this.setToast(t('ride.strava.authOpening'), '');
    void this.auth.exchangeCode(code).then((f) => {
      if (f.statusCode === 0) {
        this.codeRow.classList.add('rm-hidden');
        this.codeInput.value = '';
        this.refreshStrava();
        this.setToast(t('ride.strava.connected'), 'ok');
      } else {
        this.setToast(`${t('ride.strava.connectFailed')}: ${f.message}`, 'err');
      }
    });
  }

  private onSaveSettings(): void {
    setClientId(this.clientIdInput.value);
    setClientSecret(this.clientSecretInput.value);
    setRedirectUri(this.redirectInput.value);
    setCorsProxy(this.proxyInput.value);
    this.auth.reload();
    this.refreshStrava();
    this.setToast(t('ride.strava.saved'), 'ok');
  }

  // ---- finish actions ------------------------------------------------------

  private baseName(): string {
    return (this.nameInput.value || defaultActivityName()).trim();
  }

  private onSaveFile(): void {
    const s = this.session.snapshot();
    if (s.samples < 2) {
      this.setToast(t('ride.menu.tooShort'), 'err');
      return;
    }
    this.session.saveFile(this.baseName());
    this.setToast(t('ride.menu.savedFile'), 'ok');
  }

  private async onSync(): Promise<void> {
    if (this.busy) return;
    const payload = this.session.exportFit(this.baseName());
    if (!payload) {
      this.setToast(t('ride.menu.tooShort'), 'err');
      return;
    }
    // not connected → launch the OAuth flow first (Zwift: connect once, sync at finish)
    if (!this.auth.isAuthorized()) {
      this.onConnectToggle();
      return;
    }
    this.busy = true;
    this.syncBtn.setAttribute('data-disabled', '1');
    const phaseText: Record<UploadPhase, string> = {
      auth: t('ride.strava.authOpening'),
      uploading: t('ride.strava.uploading'),
      processing: t('ride.strava.processing'),
      done: t('ride.strava.uploaded'),
      error: t('ride.strava.uploadFailed'),
    };
    const result = await this.upload.upload(payload, {
      name: this.baseName(),
      onProgress: (phase) => this.setToast(phaseText[phase], phase === 'done' ? 'ok' : ''),
    });
    this.busy = false;
    this.syncBtn.removeAttribute('data-disabled');
    if (result.ok) {
      if (result.activityUrl) {
        this.toast.className = 'rm-toast ok';
        this.toast.innerHTML = `${t('ride.strava.uploaded')} — <a href="${result.activityUrl}" target="_blank" rel="noopener">${t('ride.strava.viewActivity')}</a>`;
      } else {
        this.setToast(t('ride.strava.uploaded'), 'ok');
      }
    } else {
      this.setToast(`${t('ride.strava.uploadFailed')}: ${result.fault.message}`, 'err');
    }
  }

  private onDiscard(): void {
    if (!window.confirm(t('ride.menu.discardConfirm'))) return;
    this.session.reset();
    this.open = false;
    this.card.classList.remove('on');
    this.backdrop.classList.remove('on');
    this.session.resume(); // fresh session keeps recording
  }

  private setToast(text: string, kind: '' | 'ok' | 'err'): void {
    this.toast.className = 'rm-toast' + (kind ? ' ' + kind : '');
    this.toast.textContent = text;
  }
}

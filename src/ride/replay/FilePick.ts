/**
 * FilePick — the ONLY DOM-touching file in the replay stack. A hidden
 * <input type=file> element that resolves to the chosen file's bytes and text,
 * so CsvImport (string) and FitImport (ArrayBuffer) can both consume it without
 * either importer knowing about the DOM.
 *
 * Isolated on purpose: importers/replay stay pure and unit-testable; only this
 * helper needs a browser. Guarded so a headless/SSR context rejects cleanly
 * instead of throwing on `document`.
 */

export interface PickedFile {
  name: string;
  /** raw bytes — feed to FitImport.decodeFit */
  arrayBuffer: ArrayBuffer;
  /** UTF-8 text — feed to CsvImport.import */
  text: string;
  /** last-modified epoch ms (0 if unavailable) */
  lastModified: number;
}

/**
 * Open the native file chooser and resolve with the picked file's bytes+text,
 * or null if the user cancels. `accept` is the standard input accept string,
 * e.g. ".csv,.fit" (default). Never rejects on user cancel; rejects only when
 * no DOM is available or the file cannot be read.
 */
export function pickFile(accept = '.csv,.fit,text/csv,application/octet-stream'): Promise<PickedFile | null> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('pickFile requires a browser DOM'));
  }
  return new Promise<PickedFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';

    let settled = false;
    const done = (v: PickedFile | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const cleanup = (): void => {
      window.removeEventListener('focus', onFocus, true);
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    // Cancel detection: the window regains focus without a change event.
    const onFocus = (): void => {
      // defer past the change event, which fires after focus returns
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) done(null);
      }, 400);
    };

    input.addEventListener(
      'change',
      () => {
        const file = input.files && input.files[0];
        if (!file) {
          done(null);
          return;
        }
        readPicked(file).then(done, fail);
      },
      { once: true },
    );

    document.body.appendChild(input);
    window.addEventListener('focus', onFocus, true);
    input.click();
  });
}

/** read a File (or Blob with a name) into the PickedFile shape. */
export async function readPicked(file: File): Promise<PickedFile> {
  const arrayBuffer = await file.arrayBuffer();
  const text = decodeText(arrayBuffer);
  return {
    name: file.name,
    arrayBuffer,
    text,
    lastModified: typeof file.lastModified === 'number' ? file.lastModified : 0,
  };
}

/** heuristic: ".fit" extension or a ".FIT" signature at byte 8 → treat as FIT. */
export function looksLikeFit(picked: PickedFile): boolean {
  if (/\.fit$/i.test(picked.name)) return true;
  const b = new Uint8Array(picked.arrayBuffer);
  return b.length >= 12 && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;
}

function decodeText(buf: ArrayBuffer): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(buf);
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

import { logger } from './logger';

/* Every action the browse route can perform. Names and field shapes follow
 * Anthropic's computer-use vocabulary so models drive this with in-weights
 * priors rather than schema-reading, plus the browser-level verbs an
 * OS-level computer tool has no equivalent for. */
export type BrowseActionType =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'left_click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'wait'
  | 'screenshot';

export interface BrowseAction {
  type: BrowseActionType;
  url?: string;
  coordinate?: [number, number];
  text?: string;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  scroll_amount?: number;
  duration?: number;
}

export interface BrowseActionResult {
  type: BrowseActionType;
  ok: boolean;
  message?: string;
}

export interface PageState {
  url: string;
  title: string;
  scroll_y: number;
  scroll_height: number;
}

export interface BrowseDriver {
  run(action: BrowseAction): Promise<BrowseActionResult>;
  screenshot(): Promise<Buffer>;
  state(): Promise<PageState>;
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 20_000;
const REATTACH_RETRY_MS = 100;
const SCROLL_STEP_PX = 100;

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

interface NavigateResult {
  frameId?: string;
  errorText?: string;
}

interface ScreenshotResult {
  data: string;
}

interface EvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string };
}

interface HistoryEntry {
  id: number;
}

interface HistoryResult {
  currentIndex: number;
  entries: HistoryEntry[];
}

interface PendingCommand {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/* CDP key events need more than a name: Chromium's editing commands key off
 * windowsVirtualKeyCode, and printable keys additionally need `text` or the
 * character never reaches the page. Only keys an agent realistically presses
 * are mapped; anything else falls through as a single-character key. */
const KEY_TABLE: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/** Parses "ctrl+a" / "Return" into a CDP key event descriptor. */
export function parseKeyCombo(combo: string): {
  modifiers: number;
  key: string;
  code: string;
  vk: number;
  text?: string;
} {
  const parts = combo.trim().split('+').filter(part => part !== '');
  if (parts.length === 0) throw new Error('key must not be empty');
  const rawKey = parts[parts.length - 1].toLowerCase();
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const bit = MODIFIER_BITS[parts[i].toLowerCase()];
    if (bit === undefined) throw new Error(`unknown key modifier: ${parts[i]}`);
    modifiers |= bit;
  }
  const mapped = KEY_TABLE[rawKey];
  if (mapped) {
    /* A modified key is a shortcut, not text entry: sending `text` would make
     * Chromium insert the character instead of running the command. */
    return modifiers === 0 ? { modifiers, ...mapped } : { modifiers, ...mapped, text: undefined };
  }
  if (rawKey.length !== 1) throw new Error(`unknown key: ${combo}`);
  const upper = rawKey.toUpperCase();
  return {
    modifiers,
    key: rawKey,
    code: `Key${upper}`,
    vk: upper.charCodeAt(0),
    text: modifiers === 0 ? rawKey : undefined,
  };
}

/** Wheel deltas for a scroll action, in CSS pixels. */
export function scrollDelta(
  direction: BrowseAction['scroll_direction'],
  amount: number,
): { deltaX: number; deltaY: number } {
  const distance = amount * SCROLL_STEP_PX;
  switch (direction) {
    case 'up': return { deltaX: 0, deltaY: -distance };
    case 'down': return { deltaX: 0, deltaY: distance };
    case 'left': return { deltaX: -distance, deltaY: 0 };
    case 'right': return { deltaX: distance, deltaY: 0 };
    default: return { deltaX: 0, deltaY: distance };
  }
}

async function pageTargetUrl(cdpPort: number): Promise<string> {
  const listed = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (listed.ok) {
    const targets = (await listed.json()) as CdpTarget[];
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  }
  /* A browser with no page target (every tab closed) is still usable. */
  const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (!created.ok) throw new Error(`could not open a browser page (${created.status})`);
  const target = (await created.json()) as CdpTarget;
  if (!target.webSocketDebuggerUrl) throw new Error('browser page has no debugger endpoint');
  return target.webSocketDebuggerUrl;
}

/**
 * Minimal CDP client over a single page target's WebSocket. Attaching to the
 * page endpoint directly (rather than the browser endpoint plus
 * Target.attachToTarget) keeps every message session-less.
 */
class CdpSession implements BrowseDriver {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly loadWaiters: Array<() => void> = [];
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event: MessageEvent) => this.onMessage(event));
    socket.addEventListener('close', () => this.failAll(new Error('browser connection closed')));
    socket.addEventListener('error', () => this.failAll(new Error('browser connection failed')));
  }

  static async connect(cdpPort: number): Promise<CdpSession> {
    const url = await pageTargetUrl(cdpPort);
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out connecting to the browser')),
        CONNECT_TIMEOUT_MS,
      );
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('failed to connect to the browser'));
      }, { once: true });
    });
    const session = new CdpSession(socket);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    return session;
  }

  private onMessage(event: MessageEvent): void {
    const raw = typeof event.data === 'string' ? event.data : '';
    if (raw === '') return;
    let parsed: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.method === 'Page.loadEventFired') {
      const waiters = this.loadWaiters.splice(0, this.loadWaiters.length);
      for (const waiter of waiters) waiter();
      return;
    }
    if (parsed.id === undefined) return;
    const command = this.pending.get(parsed.id);
    if (!command) return;
    this.pending.delete(parsed.id);
    clearTimeout(command.timer);
    if (parsed.error) {
      command.reject(new Error(parsed.error.message ?? 'browser command failed'));
      return;
    }
    (command.resolve as (value: unknown) => void)(parsed.result ?? {});
  }

  private failAll(error: Error): void {
    for (const [, command] of this.pending) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    this.pending.clear();
    const waiters = this.loadWaiters.splice(0, this.loadWaiters.length);
    for (const waiter of waiters) waiter();
  }

  /* Chromium briefly detaches the page session after it refuses a navigation
   * (blocked scheme, unsafe port), so a command issued in that window fails
   * with this exact message and succeeds a few tens of ms later. Retrying once
   * turns a cryptic dead end into a normal result for the caller. */
  private async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.sendOnce<T>(method, params);
    } catch (error) {
      const detached = error instanceof Error
        && error.message === 'Not attached to an active page';
      if (!detached || this.closed) throw error;
      await new Promise(resolve => setTimeout(resolve, REATTACH_RETRY_MS));
      return this.sendOnce<T>(method, params);
    }
  }

  private sendOnce<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('browser connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /* Page.navigate resolves when navigation begins, not when the document is
   * usable. Screenshotting there yields a blank or half-painted frame, which
   * for a pixel-driven agent is worse than an error. */
  private waitForLoad(): { promise: Promise<void>; cancel: () => void } {
    let cancel = (): void => {};
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.dropLoadWaiter(waiter);
        resolve();
      }, LOAD_TIMEOUT_MS);
      const waiter = (): void => { clearTimeout(timer); resolve(); };
      cancel = (): void => {
        clearTimeout(timer);
        this.dropLoadWaiter(waiter);
        resolve();
      };
      this.loadWaiters.push(waiter);
    });
    return { promise, cancel };
  }

  private dropLoadWaiter(waiter: () => void): void {
    const index = this.loadWaiters.indexOf(waiter);
    if (index >= 0) this.loadWaiters.splice(index, 1);
  }

  /* A navigation that never starts (bad scheme, refused port) emits no load
   * event, so the waiter has to be torn down explicitly or it survives for the
   * full load timeout and fires on an unrelated later navigation. */
  private async withLoad(begin: () => Promise<void>): Promise<void> {
    const load = this.waitForLoad();
    try {
      await begin();
    } catch (error) {
      load.cancel();
      throw error;
    }
    await load.promise;
  }

  private async click(action: BrowseAction, button: string, clickCount: number): Promise<void> {
    if (!action.coordinate) throw new Error('coordinate is required for click actions');
    const [x, y] = action.coordinate;
    const base = { x, y, button, clickCount, buttons: button === 'right' ? 2 : 1 };
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  async run(action: BrowseAction): Promise<BrowseActionResult> {
    try {
      switch (action.type) {
        case 'navigate':
          await this.withLoad(async () => {
            const result = await this.send<NavigateResult>('Page.navigate', { url: action.url });
            if (result.errorText) throw new Error(result.errorText);
          });
          break;
        case 'back':
        case 'forward':
          await this.withLoad(async () => {
            const history = await this.send<HistoryResult>('Page.getNavigationHistory');
            const offset = action.type === 'back' ? -1 : 1;
            const target = history.entries[history.currentIndex + offset];
            if (!target) throw new Error(`no ${action.type} history entry`);
            await this.send('Page.navigateToHistoryEntry', { entryId: target.id });
          });
          break;
        case 'reload':
          await this.withLoad(() => this.send('Page.reload'));
          break;
        case 'left_click':
          await this.click(action, 'left', 1);
          break;
        case 'double_click':
          await this.click(action, 'left', 2);
          break;
        case 'right_click':
          await this.click(action, 'right', 1);
          break;
        case 'type':
          await this.send('Input.insertText', { text: action.text ?? '' });
          break;
        case 'key': {
          const combo = parseKeyCombo(action.text ?? '');
          const common = {
            modifiers: combo.modifiers,
            key: combo.key,
            code: combo.code,
            windowsVirtualKeyCode: combo.vk,
            nativeVirtualKeyCode: combo.vk,
          };
          await this.send('Input.dispatchKeyEvent', {
            ...common,
            type: combo.text ? 'keyDown' : 'rawKeyDown',
            ...(combo.text ? { text: combo.text } : {}),
          });
          await this.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
          break;
        }
        case 'scroll': {
          const { deltaX, deltaY } = scrollDelta(action.scroll_direction, action.scroll_amount ?? 3);
          const [x, y] = action.coordinate ?? [0, 0];
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x, y, deltaX, deltaY,
          });
          break;
        }
        case 'wait':
          await new Promise(resolve => setTimeout(resolve, (action.duration ?? 1) * 1000));
          break;
        case 'screenshot':
          break;
      }
      return { type: action.type, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug({ action: action.type, message }, 'browse action failed');
      return { type: action.type, ok: false, message };
    }
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send<ScreenshotResult>('Page.captureScreenshot', {
      format: 'png',
      /* Viewport only. A full-page capture changes the coordinate space the
       * model is handed relative to the space clicks are dispatched in. */
      captureBeyondViewport: false,
    });
    return Buffer.from(result.data, 'base64');
  }

  async state(): Promise<PageState> {
    const result = await this.send<EvaluateResult>('Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.href,
        title: document.title,
        scroll_y: Math.round(window.scrollY),
        scroll_height: Math.round(document.documentElement.scrollHeight)
      })`,
      returnByValue: true,
    });
    const value = result.result?.value;
    if (typeof value !== 'string') {
      return { url: '', title: '', scroll_y: 0, scroll_height: 0 };
    }
    return JSON.parse(value) as PageState;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('browser connection closed'));
    this.socket.close();
  }
}

export function connectBrowseDriver(cdpPort: number): Promise<BrowseDriver> {
  return CdpSession.connect(cdpPort);
}

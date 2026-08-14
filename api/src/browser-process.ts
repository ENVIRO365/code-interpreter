import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { logger } from './logger';
import { config } from './config';

/* Chromium cold start is slower than the Node tool-call proxy, especially on
 * the first launch after a MicroVM restore when nothing is in page cache. */
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const READY_PROBE_TIMEOUT_MS = 250;
const READY_POLL_INTERVAL_MS = 25;

export interface BrowserHandle {
  cdpPort: number;
  profileDir: string;
}

export interface ChromiumLaunchOptions {
  cdpPort: number;
  profileDir: string;
  viewport: { width: number; height: number };
}

let child: ChildProcess | undefined;
let starting: Promise<BrowserHandle> | undefined;
let idleTimer: NodeJS.Timeout | undefined;

/**
 * Chromium argv for a headless, single-session browser inside the MicroVM.
 * Pure so the security-relevant properties are assertable without a browser:
 * loopback-only CDP, no setuid sandbox, and a profile outside the workspace.
 */
export function chromiumLaunchArgs(opts: ChromiumLaunchOptions): string[] {
  return [
    '--headless=new',
    /* The image-wide setuid strip in the Dockerfile neuters chrome-sandbox, and
     * the MicroVM is the real trust boundary (one VM per runtime session). */
    '--no-sandbox',
    '--disable-setuid-sandbox',
    /* /dev/shm in the guest is small; without this renderers crash on real
     * pages rather than falling back to disk. */
    '--disable-dev-shm-usage',
    '--disable-gpu',
    /* Loopback only. NEVER add --remote-debugging-address: the AWS MicroVM
     * proxy can mint a token for an arbitrary guest port (see
     * microvmPortHeaders in the control plane), so a CDP endpoint bound to a
     * routable interface would be remotely drivable with a proxy token alone. */
    `--remote-debugging-port=${opts.cdpPort}`,
    `--user-data-dir=${opts.profileDir}`,
    `--window-size=${opts.viewport.width},${opts.viewport.height}`,
    /* Deterministic screenshot dimensions: the model is handed CSS pixel
     * coordinates and clicks are dispatched in the same space, so any scaling
     * between capture and dispatch silently misaims every click. */
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    'about:blank',
  ];
}

function browserEnv(profileDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: profileDir };
  if (config.browser_library_path) env.LD_LIBRARY_PATH = config.browser_library_path;
  if (config.browser_fontconfig_path) env.FONTCONFIG_PATH = config.browser_fontconfig_path;
  return env;
}

/**
 * True once the CDP HTTP endpoint answers. Never throws: an unreachable port,
 * a refused connection, and a slow start are all just "not ready yet".
 */
async function cdpEndpointResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilReady(
  started: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (started.exitCode !== null || started.signalCode !== null) {
      throw new Error(
        `browser exited before readiness`
        + ` (code=${String(started.exitCode)}, signal=${String(started.signalCode)})`,
      );
    }
    if (await cdpEndpointResponds(port)) return;
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`browser did not become ready within ${timeoutMs}ms`);
}

function clearIdleTimer(): void {
  if (idleTimer === undefined) return;
  clearTimeout(idleTimer);
  idleTimer = undefined;
}

/**
 * Restarts the idle countdown. The hookless MicroVM image never receives the
 * AWS suspend/terminate lifecycle hooks, so this is the only mechanism that
 * releases browser memory on a VM that sits idle between conversation turns.
 */
function armIdleTimer(): void {
  clearIdleTimer();
  const idleMs = config.browser_idle_ms;
  if (idleMs <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    logger.info({ idleMs }, 'Reaping idle browser');
    void stopBrowser().catch((err: unknown) => {
      logger.warn({ err }, 'Idle browser reap failed');
    });
  }, idleMs);
  /* Must not hold the runner's event loop open during shutdown. */
  idleTimer.unref();
}

async function launch(): Promise<BrowserHandle> {
  if (!config.browser_enabled || !config.browser_binary) {
    throw new Error('browser is not configured');
  }

  const port = config.browser_cdp_port;
  const profileDir = config.browser_profile_dir;
  await fs.promises.mkdir(profileDir, { recursive: true });

  const args = chromiumLaunchArgs({
    cdpPort: port,
    profileDir,
    viewport: {
      width: config.browser_viewport_width,
      height: config.browser_viewport_height,
    },
  });
  const started = spawn(config.browser_binary, args, {
    env: browserEnv(profileDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = started;
  let rejectSpawnFailure: (error: Error) => void;
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    rejectSpawnFailure = reject;
  });
  /* A failed spawn emits `error`; it does not reliably set exitCode or
   * signalCode. Without an immediate listener Node treats ENOENT/EACCES as an
   * uncaught event and crashes the runner instead of failing this request. */
  started.on('error', (error) => {
    if (child === started) child = undefined;
    const launchError = new Error(
      `browser failed to spawn: ${error.message}`,
      { cause: error },
    );
    logger.error({ error }, 'browser spawn failed');
    rejectSpawnFailure(launchError);
  });
  started.stdout?.on('data', (chunk: Buffer) => {
    logger.debug({ browser: chunk.toString().trim() }, 'browser');
  });
  /* Chromium is extremely chatty on stderr in a container (dbus, upower, GPU
   * probes) and none of it is actionable, so this stays at debug. */
  started.stderr?.on('data', (chunk: Buffer) => {
    logger.debug({ browser: chunk.toString().trim() }, 'browser stderr');
  });
  started.once('exit', (code, signal) => {
    if (child === started) {
      child = undefined;
      clearIdleTimer();
    }
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      logger.error({ code, signal }, 'browser exited unexpectedly');
    }
  });

  try {
    await Promise.race([
      waitUntilReady(started, port, START_TIMEOUT_MS),
      spawnFailure,
    ]);
    logger.info({ port, profileDir }, 'Browser started after MicroVM restore');
    return { cdpPort: port, profileDir };
  } catch (error) {
    started.kill('SIGKILL');
    if (child === started) child = undefined;
    throw error;
  }
}

/**
 * Starts Chromium only when a browse request actually arrives. Lambda MicroVM
 * image creation snapshots the already-running container, so a browser started
 * in entrypoint would clone its RNG state, listening CDP socket, /dev/shm
 * mappings and fd-heavy process tree into every VM. This is the same boundary
 * the Node tool-call proxy is kept behind, and Chromium violates it harder.
 */
async function ensureBrowserReadyOnce(): Promise<BrowserHandle> {
  const running = child;
  if (running && running.exitCode === null && running.signalCode === null) {
    if (await cdpEndpointResponds(config.browser_cdp_port)) {
      return { cdpPort: config.browser_cdp_port, profileDir: config.browser_profile_dir };
    }
    /* Process alive but CDP gone: a wedged browser is not reusable. */
    running.kill('SIGKILL');
    if (child === running) child = undefined;
  }
  return launch();
}

export async function ensureBrowserReady(): Promise<BrowserHandle> {
  /* Serialize the whole probe/relaunch transaction, not only spawn readiness,
   * so concurrent browse actions cannot both fail a probe and then each
   * kill/relaunch through the shared `child` slot. Publishing this promise
   * before the first probe await makes every follower join one attempt. */
  if (starting) return starting;
  const attempt = ensureBrowserReadyOnce();
  starting = attempt;
  try {
    const handle = await attempt;
    armIdleTimer();
    return handle;
  } finally {
    /* A successful launch must not leave a resolved promise cached forever: if
     * CDP later disappears while the process is still alive, the next caller
     * has to kill/relaunch rather than be handed false readiness. */
    if (starting === attempt) starting = undefined;
  }
}

export async function stopBrowser(): Promise<void> {
  const running = child;
  child = undefined;
  starting = undefined;
  clearIdleTimer();
  if (!running || running.exitCode !== null || running.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      running.kill('SIGKILL');
      finish();
    }, STOP_TIMEOUT_MS);
    running.once('exit', finish);
    running.kill('SIGTERM');
  });
}

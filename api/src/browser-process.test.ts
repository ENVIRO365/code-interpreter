import { afterEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { chromiumLaunchArgs, ensureBrowserReady, stopBrowser } from './browser-process';

const original = {
  enabled: config.browser_enabled,
  binary: config.browser_binary,
  port: config.browser_cdp_port,
  profileDir: config.browser_profile_dir,
  idleMs: config.browser_idle_ms,
};
let tempDir: string | undefined;

afterEach(async () => {
  await stopBrowser();
  config.browser_enabled = original.enabled;
  config.browser_binary = original.binary;
  config.browser_cdp_port = original.port;
  config.browser_profile_dir = original.profileDir;
  config.browser_idle_ms = original.idleMs;
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/* A stand-in for Chromium that speaks just enough CDP HTTP to be probed:
 * it records each launch and serves /json/version on --remote-debugging-port.
 * SIGUSR1 drops the listener while the process stays alive, which is how a
 * wedged-but-running browser is reproduced. */
async function writeFakeBrowser(
  dir: string,
  markerPath: string,
  pidPath: string,
): Promise<string> {
  const binaryPath = path.join(dir, 'fake-chromium');
  await fsp.writeFile(binaryPath, `#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
fs.appendFileSync(${JSON.stringify(markerPath)}, 'launch\\n');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const portArg = process.argv.find(a => a.startsWith('--remote-debugging-port='));
const port = Number(portArg.split('=')[1]);
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'FakeChromium/1.0' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
process.on('SIGUSR1', () => server.close());
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`);
  await fsp.chmod(binaryPath, 0o755);
  return binaryPath;
}

async function setupFakeBrowser(
  prefix: string,
): Promise<{ markerPath: string; pidPath: string }> {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const markerPath = path.join(tempDir, 'launches.txt');
  const pidPath = path.join(tempDir, 'browser.pid');
  await fsp.writeFile(markerPath, '');
  config.browser_enabled = true;
  config.browser_binary = await writeFakeBrowser(tempDir, markerPath, pidPath);
  config.browser_cdp_port = await freePort();
  config.browser_profile_dir = path.join(tempDir, 'profile');
  return { markerPath, pidPath };
}

async function launchCount(markerPath: string): Promise<number> {
  const raw = (await fsp.readFile(markerPath, 'utf8')).trim();
  return raw === '' ? 0 : raw.split('\n').length;
}

describe('chromiumLaunchArgs', () => {
  const args = chromiumLaunchArgs({
    cdpPort: 9333,
    profileDir: '/tmp/profile',
    viewport: { width: 1280, height: 800 },
  });

  test('binds CDP to loopback only', () => {
    expect(args).toContain('--remote-debugging-port=9333');
    /* A routable CDP endpoint would be drivable by anything that can obtain a
     * MicroVM proxy token for an arbitrary guest port. */
    expect(args.some(a => a.startsWith('--remote-debugging-address'))).toBe(false);
  });

  test('runs without the setuid sandbox the image strips', () => {
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-setuid-sandbox');
  });

  test('avoids the small guest /dev/shm', () => {
    expect(args).toContain('--disable-dev-shm-usage');
  });

  test('pins an unscaled viewport so screenshot and click share a space', () => {
    expect(args).toContain('--window-size=1280,800');
    expect(args).toContain('--force-device-scale-factor=1');
  });

  test('keeps the profile out of the checkpointed workspace', () => {
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args.some(a => a.includes('/mnt/data'))).toBe(false);
  });
});

describe('lazy browser process', () => {
  test('starts once under concurrent demand and stops cleanly', async () => {
    const { markerPath } = await setupFakeBrowser('browser-lazy-');

    const handles = await Promise.all([
      ensureBrowserReady(),
      ensureBrowserReady(),
      ensureBrowserReady(),
    ]);

    expect(handles[0].cdpPort).toBe(config.browser_cdp_port);
    expect(await launchCount(markerPath)).toBe(1);

    const probe = await fetch(`http://127.0.0.1:${config.browser_cdp_port}/json/version`);
    expect(probe.ok).toBe(true);

    await stopBrowser();
    await expect(
      fetch(`http://127.0.0.1:${config.browser_cdp_port}/json/version`, {
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow();
  });

  test('relaunches a live process whose CDP endpoint has gone away', async () => {
    const { markerPath, pidPath } = await setupFakeBrowser('browser-wedged-');
    await ensureBrowserReady();
    expect(await launchCount(markerPath)).toBe(1);

    /* Alive but no longer serving CDP. A resolved launch promise must not mask
     * that, or every later browse action drives a browser that cannot answer. */
    const pid = Number((await fsp.readFile(pidPath, 'utf8')).trim());
    process.kill(pid, 'SIGUSR1');
    await new Promise(resolve => setTimeout(resolve, 200));

    await Promise.all([ensureBrowserReady(), ensureBrowserReady()]);
    expect(await launchCount(markerPath)).toBe(2);

    const probe = await fetch(`http://127.0.0.1:${config.browser_cdp_port}/json/version`);
    expect(probe.ok).toBe(true);
  });

  test('fails closed when the browser is not configured', async () => {
    config.browser_enabled = false;
    await expect(ensureBrowserReady()).rejects.toThrow('not configured');
  });

  test('reports a spawn failure without crashing and permits a later retry', async () => {
    const { markerPath } = await setupFakeBrowser('browser-spawn-');
    const goodBinary = config.browser_binary;
    config.browser_binary = path.join(tempDir as string, 'missing-chromium');

    await expect(ensureBrowserReady()).rejects.toThrow('browser failed to spawn');

    config.browser_binary = goodBinary;
    await ensureBrowserReady();
    expect(await launchCount(markerPath)).toBe(1);
  });

  test('reaps the browser after the configured idle period', async () => {
    await setupFakeBrowser('browser-idle-');
    config.browser_idle_ms = 120;
    await ensureBrowserReady();

    const before = await fetch(`http://127.0.0.1:${config.browser_cdp_port}/json/version`);
    expect(before.ok).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 700));

    await expect(
      fetch(`http://127.0.0.1:${config.browser_cdp_port}/json/version`, {
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toThrow();
  });
});

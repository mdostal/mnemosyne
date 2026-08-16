import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { lockPathFor, withLock } from '../lock.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mnemosyne-lock-'));
  tempRoots.push(root);
  return root;
}

describe('withLock', () => {
  it('runs fn and leaves no lock file behind on success', () => {
    const root = makeTempRoot();
    const targetPath = path.join(root, 'target.txt');

    const result = withLock(targetPath, () => {
      writeFileSync(targetPath, 'hello', 'utf8');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(readFileSync(targetPath, 'utf8')).toBe('hello');
    expect(existsSync(lockPathFor(targetPath))).toBe(false);
  });

  it('release-on-error: when fn throws, the error propagates and the lock file is gone afterward', () => {
    const root = makeTempRoot();
    const targetPath = path.join(root, 'target.txt');
    const lockPath = lockPathFor(targetPath);

    expect(() =>
      withLock(targetPath, () => {
        // Sanity: the lock really is held while fn runs.
        expect(existsSync(lockPath)).toBe(true);
        throw new Error('boom-from-fn');
      }),
    ).toThrow('boom-from-fn');

    // finally-release must have fired even though fn threw -- a failed write
    // must never leave a permanent lock.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('stale-lock steal: an abandoned lock file (mtime older than the stale threshold) is stolen rather than blocked on forever', () => {
    const root = makeTempRoot();
    const targetPath = path.join(root, 'target.txt');
    const lockPath = lockPathFor(targetPath);

    // Simulate a crashed process's leftover lock: create the lock file for real,
    // then fake its mtime to be well older than the default 30s stale threshold.
    writeFileSync(lockPath, 'stale-owner-token', 'utf8');
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(lockPath, oldTime, oldTime);

    const startedAt = Date.now();
    const result = withLock(targetPath, () => 'stole-it');
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBe('stole-it');
    // Must not have waited anywhere near the 30s stale threshold itself --
    // proves the lock was detected as stale and stolen, not blocked until timeout.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails loudly (does not deadlock forever) when a live, non-stale lock is held past maxWaitMs', () => {
    const root = makeTempRoot();
    const targetPath = path.join(root, 'target.txt');
    const lockPath = lockPathFor(targetPath);

    // A fresh (non-stale) lock held by "someone else".
    writeFileSync(lockPath, 'live-owner-token', 'utf8');

    expect(() =>
      withLock(targetPath, () => 'unreachable', {
        staleMs: 60_000, // far longer than maxWaitMs below, so staleness never kicks in
        retryIntervalMs: 10,
        maxWaitMs: 80,
      }),
    ).toThrow(/timed out/i);

    // The lock we never owned must be left exactly as it was -- we must not delete
    // someone else's live lock just because our own wait timed out.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('live-owner-token');
  });

  describe('concurrency (real cross-process contention)', () => {
    const workerPath = fileURLToPath(new URL('./fixtures/lock-worker.ts', import.meta.url));

    interface WorkerResult {
      pid: number;
      start: number;
      end: number;
    }

    async function tsxLoaderPath(): Promise<string> {
      const resolved = import.meta.resolve('tsx');
      return fileURLToPath(resolved);
    }

    async function runWorker(targetPath: string, holdMs: number): Promise<WorkerResult> {
      const loader = await tsxLoaderPath();
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', loader, workerPath, targetPath, String(holdMs)],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(`lock-worker exited with code ${code}. stderr:\n${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim()) as WorkerResult);
          } catch (err) {
            reject(new Error(`could not parse worker stdout ${JSON.stringify(stdout)}: ${String(err)}`));
          }
        });
      });
    }

    it(
      'two overlapping withLock calls (separate OS processes) against the same path serialize: no lost update, no corruption',
      async () => {
        const root = makeTempRoot();
        const targetPath = path.join(root, 'counter.txt');

        // Both processes launched together, each doing a racy read-current -> hold -> write
        // increment. Without mutual exclusion this classically loses one of the two increments
        // (both read 0, both write 1). holdMs widens the race window.
        const [a, b] = await Promise.all([runWorker(targetPath, 150), runWorker(targetPath, 150)]);

        const final = Number(readFileSync(targetPath, 'utf8').trim());
        expect(final).toBe(2); // no lost update
        expect(Number.isInteger(final)).toBe(true); // no corrupted/partial content

        // Prove actual mutual exclusion: the two workers' critical sections must not overlap.
        const overlapped = a.start < b.end && b.start < a.end;
        expect(overlapped).toBe(false);
      },
      20_000,
    );
  });
});

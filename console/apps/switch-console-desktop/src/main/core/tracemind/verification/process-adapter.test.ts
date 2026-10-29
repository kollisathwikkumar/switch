import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canVerifyRun } from './command-contract';
import { ProcessAdapter, type ProcessInput } from './process-adapter';
import { detectSandboxMode } from './sandbox';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tracemind-process-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
function command(script: string): ProcessInput {
  return {
    executable: process.execPath,
    args: ['-e', script],
    cwd: dir,
    env: {},
    timeoutMs: 5_000,
    outputBytes: 1_000,
  };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('controlled process adapter on local temporary fixtures', () => {
  it.skipIf(process.platform !== 'win32')(
    'keeps Windows fallback runs incomplete and unverified when no sandbox is available',
    async () => {
      expect(detectSandboxMode()).toBe('unavailable');
      const result = await new ProcessAdapter().run({
        ...command('process.exit(0)'),
        sandboxMode: 'unavailable',
      });
      expect(result).toMatchObject({
        status: 'exited',
        sandboxMode: 'unavailable',
        terminationUnconfirmed: true,
        capturedComplete: false,
        effectiveLimits: { processCount: false, memory: false },
      });
      expect(
        canVerifyRun({
          state: 'exited',
          exitCode: result.exitCode,
          signal: result.signal,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          isolation: result.sandboxMode,
          approved: true,
          capturedComplete: result.capturedComplete,
          executionMatchesProposal: true,
          terminationUnconfirmed: result.terminationUnconfirmed,
        })
      ).toBe(false);
    }
  );
  it.skipIf(process.platform !== 'win32')(
    'records Windows timeouts and user cancellation as distinct incomplete outcomes',
    async () => {
      const timedOut = await new ProcessAdapter().run({
        ...command("process.stdout.write('timeout-started'); setTimeout(() => {}, 10000)"),
        timeoutMs: 500,
        sandboxMode: 'unavailable',
      });
      const cancellation = new AbortController();
      const pendingCancellation = new ProcessAdapter().run({
        ...command("process.stdout.write('cancel-started'); setTimeout(() => {}, 10000)"),
        timeoutMs: 5000,
        sandboxMode: 'unavailable',
        signal: cancellation.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      cancellation.abort();
      const cancelled = await pendingCancellation;

      expect(timedOut).toMatchObject({
        status: 'timed_out',
        sandboxMode: 'unavailable',
        capturedComplete: false,
        terminationUnconfirmed: true,
      });
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        sandboxMode: 'unavailable',
        capturedComplete: false,
        terminationUnconfirmed: true,
      });
      for (const result of [timedOut, cancelled]) {
        expect(
          canVerifyRun({
            state: result.status === 'timed_out' ? 'timed_out' : 'cancelled',
            exitCode: result.exitCode,
            signal: result.signal,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            isolation: result.sandboxMode,
            approved: true,
            capturedComplete: result.capturedComplete,
            executionMatchesProposal: true,
            terminationUnconfirmed: result.terminationUnconfirmed,
          })
        ).toBe(false);
      }
    }
  );
  it.skipIf(process.platform === 'win32')(
    'launches real npm with an explicit runtime path without inheriting secrets',
    async () => {
      const npm = execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim();
      const result = await new ProcessAdapter().run({
        executable: npm,
        args: ['--version'],
        cwd: dir,
        env: {},
        runtimeDirectory: dirname(process.execPath),
        timeoutMs: 10000,
        outputBytes: 10000,
      });
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        execution: { environmentKeys: ['PATH'] },
      });
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      vi.stubEnv('TRACEMIND_TEST_SECRET', 'private');
      const probe = await new ProcessAdapter().run({
        ...command(
          "process.stdout.write((process.env.TRACEMIND_TEST_SECRET || 'absent') + '|' + process.env.PATH)"
        ),
        runtimeDirectory: dirname(process.execPath),
      });
      expect(probe.stdout).toBe(`absent|${dirname(process.execPath)}:/usr/bin:/bin`);
      await expect(
        new ProcessAdapter().run({ ...command(''), runtimeDirectory: '/tmp:/evil' })
      ).rejects.toThrow();
      await expect(
        new ProcessAdapter().run({ ...command(''), runtimeDirectory: 'relative' })
      ).rejects.toThrow();
    }
  );
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'runs a real npm test with a descriptor-bound cwd and the adapter environment',
    async () => {
      const npm = execFileSync('/usr/bin/which', ['npm'], { encoding: 'utf8' }).trim();
      const helper = join(dir, 'verification-cwd');
      execFileSync('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
        '-o',
        helper,
      ]);
      const project = join(dir, 'project');
      await mkdir(project);
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({ scripts: { test: 'printf fixture-check' } })
      );
      const handle = await open(project, 'r');
      try {
        const info = await handle.stat({ bigint: true });
        const result = await new ProcessAdapter().run({
          executable: npm,
          args: ['run', 'test'],
          cwd: project,
          env: {},
          runtimeDirectory: dirname(process.execPath),
          timeoutMs: 10000,
          outputBytes: 10000,
          pinnedCwd: {
            fd: handle.fd,
            identity: `${info.dev}:${info.ino}`,
            helperExecutable: helper,
          },
        });
        expect(result).toMatchObject({
          status: 'exited',
          exitCode: 0,
          stdout: expect.stringContaining('fixture-check'),
          terminationUnconfirmed: true,
          capturedComplete: false,
          sandboxMode: 'unavailable',
          execution: { workingDirectoryBinding: 'descriptor', targetHandoff: 'exec_handoff' },
        });
        expect(result.execution.environmentKeys).toEqual(['PATH']);
      } finally {
        await handle.close();
      }
    }
  );
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'attaches the host helper before exec and preserves the pinned cwd and final-exec pipe',
    async () => {
      const helper = join(dir, 'verification-cwd');
      execFileSync('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
        '-o',
        helper,
      ]);
      const cwd = await open(dir, 'r');
      const cgroupProcsPath = join(dir, 'cgroup.procs');
      const cgroupProcs = await open(cgroupProcsPath, 'w');
      try {
        const output = execFileSync(
          helper,
          [
            '--cgroup-procs-fd',
            '5',
            '--preserve-helper-fds',
            helper,
            process.execPath,
            '-e',
            'process.stdout.write(process.cwd())',
          ],
          {
            cwd: '/',
            stdio: ['ignore', 'pipe', 'ignore', cwd.fd, 'pipe', cgroupProcs.fd],
            encoding: 'utf8',
            timeout: 5000,
          }
        );
        expect(await readFile(cgroupProcsPath, 'utf8')).toMatch(/^\d+\n$/);
        expect(output).toBe(await realpath(dir));
      } finally {
        await cgroupProcs.close();
        await cwd.close();
      }
    }
  );
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'rejects a missing executable instead of treating helper setup as a successful handoff',
    async () => {
      const helper = join(dir, 'verification-cwd-missing-exec');
      execFileSync('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
        '-o',
        helper,
      ]);
      const cwd = await open(dir, 'r');
      try {
        const info = await cwd.stat({ bigint: true });
        const result = await new ProcessAdapter().run({
          ...command(''),
          executable: join(dir, 'does-not-exist'),
          pinnedCwd: {
            fd: cwd.fd,
            identity: `${info.dev}:${info.ino}`,
            helperExecutable: helper,
          },
        });
        expect(result).toMatchObject({
          status: 'spawn_error',
          exitCode: null,
          capturedComplete: false,
          execution: { targetHandoff: 'failed' },
        });
      } finally {
        await cwd.close();
      }
    }
  );
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'enforces and records the trusted helper per-process CPU limit',
    async () => {
      const helper = join(dir, 'verification-cwd-cpu');
      execFileSync('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
        '-o',
        helper,
      ]);
      const handle = await open(dir, 'r');
      try {
        const info = await handle.stat({ bigint: true });
        const input: ProcessInput & { cpuTimeSeconds: number } = {
          ...command('while (true) {}'),
          timeoutMs: 10_000,
          cpuTimeSeconds: 1,
          sandboxMode: detectSandboxMode(),
          pinnedCwd: {
            fd: handle.fd,
            identity: `${info.dev}:${info.ino}`,
            helperExecutable: helper,
          },
        };
        const result = await new ProcessAdapter().run(input);
        expect(result).toMatchObject({
          status: 'crashed',
          signal: 'SIGXCPU',
          capturedComplete: false,
          effectiveLimits: { cpuTimeSeconds: 1 },
          execution: { targetHandoff: 'exec_handoff' },
        });
        expect(
          canVerifyRun({
            state: 'crashed',
            exitCode: result.exitCode,
            signal: result.signal,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            isolation: result.sandboxMode,
            approved: true,
            capturedComplete: result.capturedComplete,
            executionMatchesProposal: true,
            terminationUnconfirmed: result.terminationUnconfirmed,
          })
        ).toBe(false);
      } finally {
        await handle.close();
      }
    }
  );
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'uses an opened working directory even after its pathname is replaced',
    async () => {
      const root = join(dir, 'project');
      const old = join(dir, 'original');
      const helper = join(dir, 'verification-cwd');
      execFileSync('cc', [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(process.cwd(), 'src/main/core/tracemind/native/verification-cwd.c'),
        '-o',
        helper,
      ]);
      await mkdir(root);
      await writeFile(join(root, 'marker'), 'original');
      const handle = await open(root, 'r');
      try {
        const info = await handle.stat({ bigint: true });
        await rename(root, old);
        await mkdir(root);
        await writeFile(join(root, 'marker'), 'replacement');
        const result = await new ProcessAdapter().run({
          ...command("process.stdout.write(require('node:fs').readFileSync('marker', 'utf8'))"),
          cwd: root,
          pinnedCwd: {
            fd: handle.fd,
            identity: `${info.dev}:${info.ino}`,
            helperExecutable: helper,
          },
        });
        expect(result).toMatchObject({
          status: 'exited',
          exitCode: 0,
          stdout: 'original',
          execution: { workingDirectoryBinding: 'descriptor', targetHandoff: 'exec_handoff' },
        });
        const runner = new ProcessAdapter();
        await expect(
          runner.run({
            ...command(''),
            pinnedCwd: { fd: handle.fd, identity: '0:0', helperExecutable: helper },
          })
        ).rejects.toThrow('descriptor changed');
        const failed = await runner.run({
          ...command(''),
          executable: join(dir, 'missing-target'),
          pinnedCwd: {
            fd: handle.fd,
            identity: `${info.dev}:${info.ino}`,
            helperExecutable: helper,
          },
        });
        expect(failed).toMatchObject({
          status: 'spawn_error',
          exitCode: null,
          capturedComplete: false,
          execution: { workingDirectoryBinding: 'descriptor', targetHandoff: 'failed' },
        });
      } finally {
        await handle.close();
      }
    }
  );
  it.skipIf(process.platform !== 'win32')(
    'rejects descriptor-bound execution on Windows before starting a process',
    async () => {
      await expect(
        new ProcessAdapter().run({
          ...command("process.stdout.write('must not start')"),
          pinnedCwd: { fd: 0, identity: '1:2', helperExecutable: process.execPath },
        })
      ).rejects.toThrow('Descriptor-bound execution unavailable');
    }
  );
  it.skipIf(process.platform === 'win32')(
    'bounds a timeout when an escaped descendant holds an inherited pipe',
    async () => {
      const runner = new ProcessAdapter();
      const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{detached:true,stdio:'inherit'}); console.log(c.pid); c.unref();`;
      const result = await runner.run({ ...command(script), timeoutMs: 400 });
      const descendant = Number(result.stdout.trim());
      try {
        expect(result.status).toBe('timed_out');
        expect(result.durationMs).toBeLessThan(1500);
        expect(result).toMatchObject({ capturedComplete: false, terminationUnconfirmed: true });
        await expect(runner.run(command('process.exit(0)'))).rejects.toThrow('unavailable');
      } finally {
        if (Number.isSafeInteger(descendant) && descendant > 0) {
          try {
            process.kill(descendant, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
      }
    }
  );
  it.skipIf(process.platform === 'win32')(
    'quarantines unconfirmed cancellation and output-limit termination',
    async () => {
      for (const reason of ['cancelled', 'output_limit'] as const) {
        const runner = new ProcessAdapter();
        const controller = new AbortController();
        const noisy = reason === 'output_limit' ? "process.stdout.write('x'.repeat(10000));" : '';
        const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{detached:true,stdio:'inherit'});console.log(c.pid);c.unref();${noisy}`;
        const timer =
          reason === 'cancelled' ? setTimeout(() => controller.abort(), 500) : undefined;
        const result = await runner.run({
          ...command(script),
          signal: controller.signal,
          outputBytes: reason === 'output_limit' ? 64 : 1000,
        });
        if (timer) clearTimeout(timer);
        const descendant = Number(result.stdout.split('\n')[0]);
        try {
          expect(result).toMatchObject({
            status: reason,
            terminationUnconfirmed: true,
            capturedComplete: false,
          });
          await expect(runner.run(command('process.exit(0)'))).rejects.toThrow('unavailable');
        } finally {
          if (Number.isSafeInteger(descendant) && descendant > 0) {
            try {
              process.kill(descendant, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }
        }
      }
    }
  );
  it.skipIf(process.platform === 'win32')(
    'does not claim process-tree termination when a successful parent leaves a detached child',
    async () => {
      const runner = new ProcessAdapter();
      const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();`;
      const result = await runner.run(command(script));
      const descendant = Number(result.stdout.trim());
      try {
        expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
        expect(() => process.kill(descendant, 0)).not.toThrow();
        expect(result).toMatchObject({
          status: 'exited',
          exitCode: 0,
          terminationUnconfirmed: true,
          capturedComplete: false,
        });
        await expect(runner.run(command('process.exit(0)'))).rejects.toThrow('unavailable');
      } finally {
        if (Number.isSafeInteger(descendant) && descendant > 0) {
          try {
            process.kill(descendant, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
      }
    }
  );
  it('captures actual exit, separate output and hashes without inheriting environment', async () => {
    vi.stubEnv('TRACEMIND_TEST_SECRET', 'should-not-reach-child');
    const result = await new ProcessAdapter().run(
      command(
        "process.stdout.write(String(process.env.TRACEMIND_TEST_SECRET ?? 'absent'));process.stderr.write('error');process.exitCode=7"
      )
    );
    expect(result).toMatchObject({
      status: 'exited',
      exitCode: 7,
      stdout: 'absent',
      stderr: 'error',
      stdoutHash: hash('absent'),
      stderrHash: hash('error'),
      capturedComplete: false,
      terminationUnconfirmed: true,
      sandboxMode: 'unavailable',
      execution: {
        executable: process.execPath,
        args: ['-e', expect.any(String)],
        cwd: dir,
        environmentKeys: [],
        timeoutMs: 5000,
        outputBytes: 1000,
        spawned: true,
      },
    });
  });
  it('marks timeout and output limits as incomplete, not passing', async () => {
    const runner = new ProcessAdapter();
    expect(
      await runner.run({ ...command('setInterval(() => {},1000)'), timeoutMs: 150 })
    ).toMatchObject({ status: 'timed_out', capturedComplete: false, terminationUnconfirmed: true });
    await expect(runner.run(command('process.exit(0)'))).rejects.toThrow('unavailable');
    expect(
      await new ProcessAdapter().run({
        ...command("process.stdout.write('x'.repeat(10000))"),
        outputBytes: 64,
      })
    ).toMatchObject({ status: 'output_limit', stdoutTruncated: true, capturedComplete: false });
  });
  it('honors cancellation and rejects a second simultaneous run', async () => {
    const runner = new ProcessAdapter();
    const controller = new AbortController();
    const first = runner.run({
      ...command('setInterval(() => {},1000)'),
      signal: controller.signal,
    });
    await expect(runner.run(command('process.exit(0)'))).rejects.toThrow('already running');
    controller.abort();
    expect(await first).toMatchObject({ status: 'cancelled', capturedComplete: false });
  });
  it('distinguishes pre-cancellation, signal crashes and spawn errors', async () => {
    const runner = new ProcessAdapter();
    const controller = new AbortController();
    controller.abort();
    expect(
      await runner.run({ ...command('process.exit(0)'), signal: controller.signal })
    ).toMatchObject({
      status: 'cancelled',
      exitCode: null,
      capturedComplete: false,
      execution: { spawned: false },
    });
    if (process.platform !== 'win32') {
      expect(await runner.run(command("process.kill(process.pid, 'SIGTERM')"))).toMatchObject({
        status: 'crashed',
        signal: 'SIGTERM',
        capturedComplete: false,
      });
    }
    expect(
      await new ProcessAdapter().run({ ...command(''), executable: join(dir, 'nonexistent') })
    ).toMatchObject({
      status: 'spawn_error',
      exitCode: null,
      capturedComplete: false,
      execution: { spawned: false },
    });
    expect(await new ProcessAdapter().run(command('process.exit(0)'))).toMatchObject({
      status: 'exited',
      exitCode: 0,
      capturedComplete: false,
      terminationUnconfirmed: true,
    });
  });
  it('rejects invalid commands, resource limits, and environment keys before spawning', async () => {
    const runner = new ProcessAdapter();
    await expect(runner.run({ ...command(''), executable: 'node' })).rejects.toThrow();
    await expect(runner.run({ ...command(''), outputBytes: 0 })).rejects.toThrow();
    await expect(runner.run({ ...command(''), cpuTimeSeconds: 0 })).rejects.toThrow();
    await expect(runner.run({ ...command(''), env: { HOME: '/tmp' } })).rejects.toThrow();
    const allowed = await runner.run({
      ...command("process.stdout.write(process.env.CI || '')"),
      env: { CI: '1' },
    });
    expect(allowed).toMatchObject({
      status: 'exited',
      stdout: '1',
      execution: { environmentKeys: ['CI'], spawned: true },
      effectiveLimits: {
        timeout: 'termination-request',
        concurrency: 'per-instance',
        cpuTimeSeconds: false,
        processCount: false,
        memory: false,
      },
    });
  });
});

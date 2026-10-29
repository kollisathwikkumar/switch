import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probe, run } from '@microsoft/mxc-sdk/v1';
import { expect, it } from 'vitest';
import { buildWindowsMxcRequest, quoteWindowsArgv } from './windows-mxc';

if (process.env.TRACEMIND_REQUIRE_WINDOWS === '1' && process.platform !== 'win32') {
  throw new Error('TRACEMIND_REQUIRE_WINDOWS=1 requires a Windows runner');
}

it.skipIf(process.platform !== 'win32')(
  'Windows MXC ProcessContainer confines writes and denies host-loopback networking',
  async () => {
    const systemRoot = process.env.SystemRoot;
    expect(systemRoot).toBeTruthy();

    const root = await mkdtemp(join(tmpdir(), 'tracemind-windows-mxc-'));
    const approvedDirectory = join(root, 'approved');
    const temporaryDirectory = join(root, 'temporary');
    const outsidePath = join(root, 'outside.txt');
    const server = createServer((socket) => socket.end('outside-network-reached'));
    await mkdir(approvedDirectory);
    await mkdir(temporaryDirectory);

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback fixture unavailable');

      const program = [
        "const fs = require('node:fs');",
        "const net = require('node:net');",
        "fs.writeFileSync('allowed.txt', 'allowed');",
        'let outsideWriteBlocked = false;',
        'try { fs.writeFileSync(' + JSON.stringify(outsidePath) + ", 'escaped'); }",
        "catch (error) { outsideWriteBlocked = error.code === 'EACCES' || error.code === 'EPERM'; }",
        'let completed = false;',
        'const finish = (loopbackBlocked) => {',
        '  if (completed) return; completed = true;',
        "  console.log('TRACE_RESULT=' + JSON.stringify({ outsideWriteBlocked, loopbackBlocked }));",
        '  socket.destroy();',
        '};',
        "const socket = net.connect({ host: '127.0.0.1', port: " + address.port + ' });',
        "socket.once('connect', () => finish(false));",
        "socket.once('error', () => finish(true));",
        'setTimeout(() => finish(true), 1500).unref();',
      ].join('');
      const request = buildWindowsMxcRequest({
        nodeExecutable: process.execPath,
        args: ['-e', program],
        approvedProjectRoot: approvedDirectory,
        workingDirectory: approvedDirectory,
        runtimeDirectory: dirname(process.execPath),
        systemRoot: systemRoot as string,
        temporaryDirectory,
        timeoutMs: 10_000,
        environment: {},
      });
      // Run known executables outside MXC first. If these pass but the identical
      // controls fail in ProcessContainer, the failure is in the native container
      // launch path rather than the hosted Windows image or ARM64 Node runtime.
      const directSystemControl = spawnSync(
        join(systemRoot as string, 'System32', 'where.exe'),
        ['cmd.exe'],
        { encoding: 'utf8' }
      );
      const directNodeControl = spawnSync(
        process.execPath,
        ['-e', 'process.stdout.write(process.arch)'],
        { encoding: 'utf8' }
      );
      // Capture the native backend's request-specific capability report before
      // launch so an OS-level startup failure is distinguishable from a request
      // rejected by the installed ProcessContainer tier.
      const capability = probe(request);
      const systemControlRequest = {
        ...request,
        command: quoteWindowsArgv([join(systemRoot as string, 'System32', 'where.exe'), 'cmd.exe']),
      };
      const systemControl = await run(systemControlRequest, { telemetry: { enabled: false } });
      const result = await run(request, { telemetry: { enabled: false } });
      const diagnostic = JSON.stringify({
        directHostControl: {
          system: {
            status: directSystemControl.status,
            error: directSystemControl.error?.message ?? null,
            stdout: directSystemControl.stdout,
            stderr: directSystemControl.stderr,
          },
          node: {
            status: directNodeControl.status,
            error: directNodeControl.error?.message ?? null,
            stdout: directNodeControl.stdout,
            stderr: directNodeControl.stderr,
          },
        },
        systemControl: {
          exitCode: systemControl.exitCode,
          timedOut: systemControl.timedOut,
          stdout: systemControl.stdout,
          stderr: systemControl.stderr,
          warnings: systemControl.warnings,
        },
        target: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          warnings: result.warnings,
        },
        capability,
      });
      expect(directSystemControl.status, diagnostic).toBe(0);
      expect(directSystemControl.stdout.toLowerCase(), diagnostic).toContain('cmd.exe');
      expect(directNodeControl.status, diagnostic).toBe(0);
      expect(directNodeControl.stdout).toBe('arm64');
      expect(systemControl.exitCode, diagnostic).toBe(0);
      expect(systemControl.stdout.toLowerCase(), diagnostic).toContain('cmd.exe');
      expect(result.timedOut).toBe(false);
      expect(result.exitCode, diagnostic).toBe(0);
      const resultLine = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('TRACE_RESULT='));
      expect(resultLine, result.stdout + result.stderr).toBeTruthy();
      expect(JSON.parse(resultLine!.slice('TRACE_RESULT='.length))).toEqual({
        outsideWriteBlocked: true,
        loopbackBlocked: true,
      });
      expect(await readFile(join(approvedDirectory, 'allowed.txt'), 'utf8')).toBe('allowed');
      await expect(readFile(outsidePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000
);

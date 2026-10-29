import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  consumeLinuxBubblewrapStatusLine,
  ProcessAdapter,
  type LinuxBubblewrapStatusState,
} from './process-adapter';
import {
  detectSandboxMode,
  linuxBubblewrapArgs,
  linuxBubblewrapHostHelperArgs,
  linuxCgroupHostHelperArgs,
} from './sandbox';

it('binds the pinned cwd descriptor and requests Bubblewrap exec-status reporting', () => {
  const args = linuxBubblewrapArgs({
    workingDirectory: '/workspace/project',
    temporaryDirectory: '/tmp/tracemind-run-abc',
    pinnedDirectoryFd: 3,
    executable: '/trusted/verification-helper',
    args: ['/trusted/npm', 'run', 'test'],
  });
  expect(args).toContain('--unshare-net');
  expect(args).toContain('--unshare-pid');
  expect(args).toContain('--die-with-parent');
  expect(args).toContain('--ro-bind');
  expect(args.slice(args.indexOf('--bind-fd'), args.indexOf('--bind-fd') + 3)).toEqual([
    '--bind-fd',
    '3',
    '/workspace/project',
  ]);
  expect(
    args.slice(args.indexOf('--json-status-fd'), args.indexOf('--json-status-fd') + 2)
  ).toEqual(['--json-status-fd', '4']);
  expect(args.slice(-4)).toEqual(['/trusted/verification-helper', '/trusted/npm', 'run', 'test']);
  const resourceArgs = linuxBubblewrapArgs({
    workingDirectory: '/workspace/project',
    temporaryDirectory: '/tmp/tracemind-run-abc',
    pinnedDirectoryFd: 3,
    executable: '/trusted/verification-helper',
    args: ['/trusted/npm', 'run', 'test'],
  });
  expect(resourceArgs).toEqual(args);
  expect(
    linuxCgroupHostHelperArgs('/usr/bin/bwrap', ['--unshare-pid', '/trusted/verification-helper'])
  ).toEqual([
    '--cgroup-procs-fd',
    '5',
    '--preserve-helper-fds',
    '/usr/bin/bwrap',
    '--unshare-pid',
    '/trusted/verification-helper',
  ]);
  expect(() => linuxCgroupHostHelperArgs('relative-bwrap', [])).toThrow(
    'Invalid Bubblewrap executable'
  );
  expect(
    linuxBubblewrapHostHelperArgs('/usr/bin/bwrap', ['/usr/bin/true'], {
      cgroup: false,
      cpuTimeSeconds: 30,
    })
  ).toEqual(['--cpu-seconds', '30', '--preserve-helper-fds', '/usr/bin/bwrap', '/usr/bin/true']);
});

const execute = promisify(execFile);

it('validates known Bubblewrap JSON status events and ignores future event objects', () => {
  const status: LinuxBubblewrapStatusState = {
    hostHelperReady: false,
    cgroupAttached: false,
    childStarted: false,
    childExitCode: null,
  };
  expect(consumeLinuxBubblewrapStatusLine('{"future-event":"ignored"}', status)).toBe(true);
  expect(
    consumeLinuxBubblewrapStatusLine(
      '{"tracemind-host-helper-ready":true,"tracemind-cgroup-attached":true}',
      status
    )
  ).toBe(true);
  expect(status).toMatchObject({ hostHelperReady: true, cgroupAttached: true });
  expect(consumeLinuxBubblewrapStatusLine('{"future-event":true}', status)).toBe(true);
  expect(consumeLinuxBubblewrapStatusLine('{"child-pid":2,"future-field":true}', status)).toBe(
    true
  );
  expect(consumeLinuxBubblewrapStatusLine('{"exit-code":137}', status)).toBe(true);
  expect(status).toMatchObject({ childStarted: true, childExitCode: 137 });
  expect(consumeLinuxBubblewrapStatusLine('{"child-pid":3}', status)).toBe(false);
  expect(consumeLinuxBubblewrapStatusLine('{"exit-code":0}', status)).toBe(false);
  expect(consumeLinuxBubblewrapStatusLine('not-json', status)).toBe(false);
});

it.skipIf(process.platform !== 'linux' || process.env.CI !== 'true')(
  'CI provides the supported Linux sandbox used by the verification runner',
  () => expect(detectSandboxMode()).toBe('linux-bubblewrap')
);

it.skipIf(process.platform !== 'linux')(
  'Linux bubblewrap isolates network, writable paths, and the process namespace',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-bwrap-'));
    const server = createServer();
    const outsidePath = `/etc/tracemind-denied-${process.pid}-${Date.now()}`;
    try {
      expect(execFileSync('bwrap', ['--version'], { encoding: 'utf8' })).toContain('bubblewrap');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      const script = `(async()=>{const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');let outside='allowed';try{fs.writeFileSync(process.argv[1],'x')}catch(e){outside=e.code}const child=cp.spawnSync(process.execPath,['-e',"try{require('node:fs').writeFileSync(process.argv[1],'x');process.exit(0)}catch(e){process.exit(1)}",process.argv[1]]);const insidePath='/tmp/tracemind-inside';fs.writeFileSync(insidePath,'x');const network=await new Promise(resolve=>{const socket=net.connect(Number(process.argv[2]),'127.0.0.1');socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve('connected')});socket.once('error',e=>resolve(e.code));socket.once('timeout',()=>{socket.destroy();resolve('timeout')})});console.log(JSON.stringify({outside,child:child.status,inside:fs.existsSync(insidePath),network,pid:process.pid}))})().catch(error=>{console.error(error);process.exitCode=1});`;
      const result = await execute(
        'bwrap',
        [
          '--unshare-user',
          '--unshare-pid',
          '--unshare-net',
          '--die-with-parent',
          '--new-session',
          '--ro-bind',
          '/',
          '/',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--tmpfs',
          '/tmp',
          '--bind',
          directory,
          '/tmp',
          '--chdir',
          '/tmp',
          process.execPath,
          '-e',
          script,
          outsidePath,
          String(address.port),
        ],
        { timeout: 5000 }
      );
      const observed = JSON.parse(result.stdout.trim()) as {
        outside: string;
        child: number | null;
        inside: boolean;
        network: string;
        pid: number;
      };
      expect(observed).toMatchObject({ outside: 'EROFS', child: 1, inside: true, pid: 2 });
      expect(observed.network).not.toBe('connected');
      await expect(readFile(outsidePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(directory, 'tracemind-inside'), 'utf8')).toBe('x');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'linux' || detectSandboxMode() !== 'linux-bubblewrap')(
  'adapter confines writes and networking and reports PID-namespace completion',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-adapter-linux-'));
    const cwd = join(root, 'project');
    await (await import('node:fs/promises')).mkdir(cwd);
    const helper = join(root, 'verification-cwd');
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
    const workingDirectory = await open(cwd, 'r');
    const identity = await workingDirectory.stat({ bigint: true });
    const pinnedCwd = {
      fd: workingDirectory.fd,
      identity: `${identity.dev}:${identity.ino}`,
      helperExecutable: helper,
    };
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      const result = await new ProcessAdapter().run({
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs'),net=require('node:net');fs.writeFileSync('inside','ok');fs.writeFileSync(process.env.TMPDIR+'/temp','ok');let outside='allowed';try{fs.writeFileSync(${JSON.stringify(join(root, 'outside'))},'x')}catch(e){outside=e.code}const socket=net.connect(${address.port},'127.0.0.1');socket.setTimeout(1000);socket.once('connect',()=>{console.log(JSON.stringify({outside,network:'connected'}));process.exitCode=4;socket.destroy()});socket.once('error',e=>{console.log(JSON.stringify({outside,network:e.code}))});socket.once('timeout',()=>{console.log(JSON.stringify({outside,network:'timeout'}));socket.destroy()});setTimeout(()=>process.exitCode=5,2000).unref();`,
        ],
        cwd,
        env: {},
        timeoutMs: 5000,
        outputBytes: 4096,
        sandboxMode: 'linux-bubblewrap',
        pinnedCwd,
      });
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        sandboxMode: 'linux-bubblewrap',
        terminationUnconfirmed: false,
        capturedComplete: true,
        execution: { environmentKeys: ['HOME', 'TMPDIR'] },
      });
      expect(JSON.parse(result.stdout.trim()).outside).toBe('EROFS');
      expect(JSON.parse(result.stdout.trim()).network).not.toBe('connected');
      expect(await readFile(join(cwd, 'inside'), 'utf8')).toBe('ok');
      await expect(readFile(join(root, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(server.listening).toBe(true);

      const descendantProgram = [
        "const {spawn}=require('node:child_process');",
        "const nested=spawn(process.execPath,['-e',\"setTimeout(()=>console.log('nested-survived'),5000)\"],{detached:true,stdio:['ignore','inherit','inherit']});",
        'nested.unref();',
        "setTimeout(()=>console.log('descendant-survived'),5000);",
      ].join('');
      const descendants = await new ProcessAdapter().run({
        executable: process.execPath,
        args: [
          '-e',
          `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantProgram)}],{detached:true,stdio:['ignore','inherit','inherit']});child.unref();console.log('parent-exited')`,
        ],
        cwd,
        env: {},
        timeoutMs: 3000,
        outputBytes: 4096,
        sandboxMode: 'linux-bubblewrap',
        pinnedCwd,
      });
      expect(descendants).toMatchObject({
        status: 'exited',
        exitCode: 0,
        terminationUnconfirmed: false,
        capturedComplete: true,
      });
      expect(descendants.stdout).toContain('parent-exited');
      expect(descendants.stdout).not.toContain('descendant-survived');
      expect(descendants.stdout).not.toContain('nested-survived');
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await workingDirectory.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'linux' || detectSandboxMode() !== 'linux-bubblewrap')(
  'reports the target exit/signal contract through the real Bubblewrap adapter path',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-status-linux-'));
    const cwd = join(root, 'project');
    await (await import('node:fs/promises')).mkdir(cwd);
    const helper = join(root, 'verification-cwd');
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
    const workingDirectory = await open(cwd, 'r');
    const identity = await workingDirectory.stat({ bigint: true });
    const pinnedCwd = {
      fd: workingDirectory.fd,
      identity: `${identity.dev}:${identity.ino}`,
      helperExecutable: helper,
    };
    const run = (args: string[], timeoutMs = 3_000) =>
      new ProcessAdapter().run({
        executable: '/bin/sh',
        args,
        cwd,
        env: {},
        timeoutMs,
        outputBytes: 4096,
        sandboxMode: 'linux-bubblewrap',
        pinnedCwd,
      });
    try {
      await expect(run(['-c', 'exit 0'])).resolves.toMatchObject({
        status: 'exited',
        exitCode: 0,
        signal: null,
      });
      await expect(run(['-c', 'exit 23'])).resolves.toMatchObject({
        status: 'exited',
        exitCode: 23,
        signal: null,
      });
      // Bubblewrap sees a normal wrapper exit of 137, while this field preserves
      // the target's distinction between exit(137) and SIGKILL.
      await expect(run(['-c', 'exit 137'])).resolves.toMatchObject({
        status: 'exited',
        exitCode: 137,
        signal: null,
      });
      await expect(run(['-c', 'kill -TERM $$'])).resolves.toMatchObject({
        status: 'crashed',
        exitCode: null,
        signal: 'SIGTERM',
      });
      await expect(run(['-c', 'kill -KILL $$'])).resolves.toMatchObject({
        status: 'crashed',
        exitCode: null,
        signal: 'SIGKILL',
        terminationUnconfirmed: false,
      });
      await expect(run(['-c', 'sleep 5'], 100)).resolves.toMatchObject({
        status: 'timed_out',
        exitCode: null,
        signal: null,
      });

      const cancellation = new AbortController();
      const cancelTimer = setTimeout(() => cancellation.abort(), 100);
      const cancellable = new ProcessAdapter().run({
        executable: '/bin/sh',
        args: ['-c', 'sleep 5'],
        cwd,
        env: {},
        timeoutMs: 3000,
        outputBytes: 4096,
        sandboxMode: 'linux-bubblewrap',
        pinnedCwd,
        signal: cancellation.signal,
      });
      await expect(cancellable).resolves.toMatchObject({
        status: 'cancelled',
        exitCode: null,
        signal: null,
        terminationUnconfirmed: false,
      });
      clearTimeout(cancelTimer);
      await expect(
        new ProcessAdapter().run({
          executable: '/no/such/tracemind-target',
          args: [],
          cwd,
          env: {},
          timeoutMs: 3000,
          outputBytes: 4096,
          sandboxMode: 'linux-bubblewrap',
          pinnedCwd,
        })
      ).resolves.toMatchObject({
        status: 'spawn_error',
        exitCode: null,
        signal: null,
        execution: { targetHandoff: 'failed' },
      });
    } finally {
      await workingDirectory.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);

import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ProcessAdapter } from './process-adapter';
import { detectSandboxMode } from './sandbox';
const execute = promisify(execFile);

it.skipIf(process.platform !== 'darwin' || process.env.CI !== 'true')(
  'CI provides the supported macOS sandbox used by the verification runner',
  () => expect(detectSandboxMode()).toBe('macos-sandbox-exec')
);

it.skipIf(process.platform !== 'darwin')(
  'macOS sandbox denies fixture writes and network in parent and child',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracemind-sandbox-'));
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture port');
      const profileRoot = await realpath(dir);
      const profile = `(version 1) (allow default) (deny file-write* (subpath ${JSON.stringify(profileRoot)})) (deny network*)`;
      const script = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');let write='allowed';try{fs.writeFileSync(process.argv[1],'x')}catch(e){write=e.code}const child=cp.spawnSync('/usr/bin/touch',[process.argv[2]]);const socket=net.connect(Number(process.argv[3]),'127.0.0.1');socket.on('connect',()=>{console.log(JSON.stringify({write,child:child.status,network:'connected'}));socket.destroy()});socket.on('error',e=>console.log(JSON.stringify({write,child:child.status,network:e.code})));setTimeout(()=>process.exit(3),3000).unref();`;
      const result = await execute(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          profile,
          process.execPath,
          '-e',
          script,
          join(dir, 'parent'),
          join(dir, 'child'),
          String(address.port),
        ],
        { timeout: 5000 }
      );
      const observed = JSON.parse(result.stdout.trim());
      expect(observed).toMatchObject({ write: 'EPERM', child: 1, network: 'EPERM' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'darwin' || detectSandboxMode() !== 'macos-sandbox-exec')(
  'adapter enforces the approved macOS sandbox and reports its termination limitation',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-adapter-macos-'));
    const cwd = join(root, 'project');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd));
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
          `const fs=require('node:fs'),net=require('node:net');fs.writeFileSync('inside','ok');fs.writeFileSync(process.env.TMPDIR+'/temp','ok');let outside='allowed';try{fs.writeFileSync(${JSON.stringify(join(root, 'outside'))},'x')}catch(e){outside=e.code}const socket=net.connect(${address.port},'127.0.0.1');socket.once('connect',()=>{console.log(JSON.stringify({outside,network:'connected'}));process.exitCode=4;socket.destroy()});socket.once('error',e=>{console.log(JSON.stringify({outside,network:e.code}));});setTimeout(()=>process.exitCode=5,2000).unref();`,
        ],
        cwd,
        env: {},
        timeoutMs: 5000,
        outputBytes: 4096,
        sandboxMode: 'macos-sandbox-exec',
      });
      expect(result, `adapter result: ${JSON.stringify(result)}`).toMatchObject({
        status: 'exited',
        exitCode: 0,
        sandboxMode: 'macos-sandbox-exec',
        terminationUnconfirmed: true,
        capturedComplete: false,
        execution: { environmentKeys: ['HOME', 'TMPDIR'] },
      });
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        outside: 'EPERM',
        network: 'EPERM',
      });
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(cwd, 'inside'), 'utf8')).toBe('ok');
      await expect(readFile(join(root, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'darwin' || detectSandboxMode() !== 'macos-sandbox-exec')(
  'keeps completion unconfirmed while a same-group sandbox descendant is still alive',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tracemind-adapter-macos-descendant-'));
    let descendantPid: number | undefined;
    try {
      const result = await new ProcessAdapter().run({
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs'),childProcess=require('node:child_process');const output=fs.openSync('child.log','w');const child=childProcess.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1500)'],{stdio:['ignore',output,output]});fs.closeSync(output);child.unref();console.log('child:'+child.pid)`,
        ],
        cwd,
        env: {},
        timeoutMs: 5000,
        outputBytes: 4096,
        sandboxMode: 'macos-sandbox-exec',
      });
      const match = result.stdout.match(/^child:(\d+)\n$/);
      if (match?.[1]) descendantPid = Number(match[1]);
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        sandboxMode: 'macos-sandbox-exec',
        terminationUnconfirmed: true,
        capturedComplete: false,
        stdout: expect.stringMatching(/^child:\d+\n$/),
      });
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The fixture child may already have exited.
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'darwin' || detectSandboxMode() !== 'macos-sandbox-exec')(
  'keeps completion unconfirmed when a detached macOS sandbox descendant outlives its command',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tracemind-adapter-macos-detached-'));
    let detachedPid: number | undefined;
    try {
      const result = await new ProcessAdapter().run({
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs'),childProcess=require('node:child_process');const output=fs.openSync('detached.log','w');const child=childProcess.spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000)'],{detached:true,stdio:['ignore',output,output]});child.once('spawn',()=>{console.log('spawned:'+child.pid);child.unref()});child.once('error',error=>console.log('error:'+error.code));setTimeout(()=>process.exit(0),100)`,
        ],
        cwd,
        env: {},
        timeoutMs: 5000,
        outputBytes: 4096,
        sandboxMode: 'macos-sandbox-exec',
      });
      const match = result.stdout.match(/spawned:(\d+)/);
      if (match?.[1]) detachedPid = Number(match[1]);
      let detachedAlive = false;
      if (detachedPid) {
        try {
          process.kill(detachedPid, 0);
          detachedAlive = true;
        } catch {
          detachedAlive = false;
        }
      }
      expect(detachedAlive).toBe(true);
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        sandboxMode: 'macos-sandbox-exec',
        terminationUnconfirmed: true,
        capturedComplete: false,
      });
    } finally {
      if (detachedPid) {
        try {
          process.kill(detachedPid, 'SIGKILL');
        } catch {
          // The sandbox may already have rejected or terminated the child.
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  }
);

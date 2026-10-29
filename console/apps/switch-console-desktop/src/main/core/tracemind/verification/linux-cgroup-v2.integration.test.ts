import { execFileSync } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareLinuxCgroupLimits } from './linux-cgroup-v2';
import { ProcessAdapter } from './process-adapter';
import { detectSandboxMode } from './sandbox';

const memoryMiB = 1024 * 1024;

async function buildHelper(directory: string): Promise<string> {
  const helper = join(directory, 'verification-cwd');
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
  return helper;
}

async function cgroupSupportOrSkip(skip: (message?: string) => never): Promise<void> {
  if (detectSandboxMode() !== 'linux-bubblewrap') {
    const missing = 'Linux Bubblewrap isolation is unavailable.';
    if (process.env.TRACEMIND_REQUIRE_CGROUP === '1') throw new Error(`UNSUPPORTED: ${missing}`);
    skip(missing);
  }
  const probe = await prepareLinuxCgroupLimits({ processCount: 8, memoryBytes: 256 * memoryMiB });
  if (!probe) {
    const missing = 'Writable delegated cgroup v2 memory and pids controllers are unavailable.';
    if (process.env.TRACEMIND_REQUIRE_CGROUP === '1') throw new Error(`UNSUPPORTED: ${missing}`);
    skip(missing);
  }
  expect(await probe.cleanup()).toBe(true);
}

it.skipIf(process.platform !== 'linux')(
  'enforces the actual delegated cgroup v2 process-count limit through the trusted helper',
  async ({ skip }) => {
    await cgroupSupportOrSkip(skip);
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-cgroup-pids-'));
    const helper = await buildHelper(directory);
    const workingDirectory = await open(directory, 'r');
    try {
      const info = await workingDirectory.stat({ bigint: true });
      const result = await new ProcessAdapter().run({
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs'),{spawn}=require('node:child_process');let cgroupEscape='allowed';try{fs.writeFileSync('/sys/fs/cgroup/cgroup.procs',String(process.pid))}catch(e){cgroupEscape=e.code||'denied'}const children=[];const errors=[];for(let i=0;i<64;i++){const child=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'ignore'});child.once('spawn',()=>children.push(child));child.once('error',error=>errors.push(error.code))}setTimeout(()=>{for(const child of children)child.kill('SIGKILL');console.log(JSON.stringify({spawned:children.length,errors,cgroupEscape}))},200)`,
        ],
        cwd: directory,
        env: {},
        timeoutMs: 5000,
        outputBytes: 4096,
        sandboxMode: 'linux-bubblewrap',
        processCount: 32,
        memoryBytes: 512 * memoryMiB,
        pinnedCwd: {
          fd: workingDirectory.fd,
          identity: `${info.dev}:${info.ino}`,
          helperExecutable: helper,
        },
      });
      expect(result).toMatchObject({
        status: 'exited',
        exitCode: 0,
        effectiveLimits: { processCount: 32, memory: 512 * memoryMiB },
        terminationUnconfirmed: false,
        capturedComplete: true,
      });
      const observed = JSON.parse(result.stdout.trim()) as {
        spawned: number;
        errors: string[];
        cgroupEscape: string;
      };
      expect(observed.spawned).toBeLessThan(64);
      expect(observed.errors).toContain('EAGAIN');
      expect(observed.cgroupEscape).not.toBe('allowed');
    } finally {
      await workingDirectory.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.skipIf(process.platform !== 'linux')(
  'enforces the actual delegated cgroup v2 memory limit on an allocated and touched buffer',
  async ({ skip }) => {
    await cgroupSupportOrSkip(skip);
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-cgroup-memory-'));
    const helper = await buildHelper(directory);
    const probeSource = join(directory, `tracemind-cgroup-memory-${process.pid}.c`);
    const probeExecutable = join(directory, `tracemind-cgroup-memory-${process.pid}`);
    await writeFile(
      probeSource,
      `#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nstatic void report_cgroup_control(const char *cgroup_path, const char *name) { char path[8192], value[128]; snprintf(path,sizeof(path),"/sys/fs/cgroup%s/%s",cgroup_path,name); FILE *control=fopen(path,"r"); if(!control){printf("%s=<unavailable>\\n",name);return;} if(fgets(value,sizeof(value),control)) printf("%s=%s",name,value); else printf("%s=<empty>\\n",name); fclose(control); }\nint main(void){char line[4096],cgroup_path[4096]="/";FILE *cgroup=fopen("/proc/self/cgroup","r");if(cgroup){while(fgets(line,sizeof(line),cgroup)){if(sscanf(line,"0::%4095s",cgroup_path)==1)break;}fclose(cgroup);}printf("cgroup_path=%s\\n",cgroup_path);report_cgroup_control(cgroup_path,"memory.max");report_cgroup_control(cgroup_path,"memory.swap.max");report_cgroup_control(cgroup_path,"memory.swap.current");report_cgroup_control(cgroup_path,"memory.current");puts("allocation-started");fflush(stdout);size_t n=256u*1024u*1024u;volatile unsigned char *p=(volatile unsigned char*)malloc(n);if(!p){puts("allocation-refused");return 0;}for(size_t i=0;i<n;i+=4096)p[i]=1;report_cgroup_control(cgroup_path,"memory.current");report_cgroup_control(cgroup_path,"memory.swap.current");report_cgroup_control(cgroup_path,"memory.events");puts("allocation-complete");free((void*)p);return 0;}\n`
    );
    execFileSync('cc', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      probeSource,
      '-o',
      probeExecutable,
    ]);
    const workingDirectory = await open(directory, 'r');
    try {
      const info = await workingDirectory.stat({ bigint: true });
      const result = await new ProcessAdapter().run({
        executable: probeExecutable,
        args: [],
        cwd: directory,
        env: {},
        timeoutMs: 5000,
        outputBytes: 4096,
        sandboxMode: 'linux-bubblewrap',
        processCount: 32,
        memoryBytes: 128 * memoryMiB,
        pinnedCwd: {
          fd: workingDirectory.fd,
          identity: `${info.dev}:${info.ino}`,
          helperExecutable: helper,
        },
      });
      expect(result.effectiveLimits).toMatchObject({
        processCount: 32,
        memory: 128 * memoryMiB,
      });
      expect(['exec_handoff', 'failed']).toContain(result.execution.targetHandoff);
      const deniedByLimit = result.stdout.includes('allocation-refused');
      const killedByLimit =
        (result.status === 'crashed' && result.signal === 'SIGKILL') ||
        (result.status === 'spawn_error' && result.execution.targetHandoff === 'failed');
      expect(
        deniedByLimit || killedByLimit,
        `Memory-limit exceedance result: ${JSON.stringify({
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          terminationUnconfirmed: result.terminationUnconfirmed,
          targetHandoff: result.execution.targetHandoff,
          effectiveLimits: result.effectiveLimits,
          stdout: result.stdout,
          stderr: result.stderr,
        })}`
      ).toBe(true);
      expect(result.stdout).toContain('allocation-started');
      expect(result.stdout).toContain('memory.swap.max=0');
      expect(result.stdout).not.toContain('memory.swap.max=<unavailable>');
      expect(result.stdout).not.toContain('allocation-complete');
      expect(result.terminationUnconfirmed).toBe(false);
    } finally {
      await workingDirectory.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

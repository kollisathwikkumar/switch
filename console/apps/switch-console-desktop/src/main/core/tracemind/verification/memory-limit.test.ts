import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProcessAdapter } from './process-adapter';

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'measures actual RLIMIT_AS support without treating a successful call as enforcement',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracemind-memory-limit-'));
    try {
      const source = join(dir, 'probe.c');
      const executable = join(dir, 'probe');
      await writeFile(
        source,
        `#include <stdio.h>\n#include <stdlib.h>\n#include <sys/resource.h>\nint main(void) {\n struct rlimit r = {64u * 1024 * 1024, 64u * 1024 * 1024};\n if (setrlimit(RLIMIT_AS, &r)) { puts("unsupported"); return 0; }\n volatile char *p = malloc(128u * 1024 * 1024);\n if (!p) { puts("enforced"); return 0; }\n for (size_t i=0; i<128u*1024*1024; i+=4096) p[i]=1;\n free((void *)p); puts("not-enforced"); return 0;\n}\n`
      );
      execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', executable]);
      const observed = execFileSync(executable, { encoding: 'utf8', timeout: 5000 }).trim();
      console.info(`RLIMIT_AS probe: ${observed}`);
      expect(['unsupported', 'enforced', 'not-enforced']).toContain(observed);
      const result = await new ProcessAdapter().run({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: dir,
        env: {},
        timeoutMs: 5000,
        outputBytes: 1000,
      });
      expect(result.effectiveLimits.memory).toBe(false);
      expect(result.sandboxMode).toBe('unavailable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

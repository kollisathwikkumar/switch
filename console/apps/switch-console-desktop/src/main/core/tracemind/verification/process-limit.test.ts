import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProcessAdapter } from './process-adapter';

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'observes RLIMIT_NPROC behavior without presenting it as a process-tree limit',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracemind-nproc-limit-'));
    try {
      const source = join(dir, 'probe.c');
      const executable = join(dir, 'probe');
      await writeFile(
        source,
        `#include <errno.h>\n#include <stdio.h>\n#include <sys/resource.h>\n#include <sys/types.h>\n#include <sys/wait.h>\n#include <unistd.h>\nint main(void) {\n struct rlimit r = {2, 2};\n if (setrlimit(RLIMIT_NPROC, &r)) { puts("unavailable"); return 0; }\n pid_t child = fork();\n if (child < 0) { puts("fork-denied"); return 0; }\n if (child == 0) _exit(0);\n if (waitpid(child, 0, 0) < 0) return 2;\n puts("fork-allowed"); return 0;\n}\n`
      );
      execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', executable]);
      const observed = execFileSync(executable, { encoding: 'utf8', timeout: 5000 }).trim();
      console.info(`RLIMIT_NPROC probe: ${observed}`);
      expect(['unavailable', 'fork-denied', 'fork-allowed']).toContain(observed);
      const result = await new ProcessAdapter().run({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: dir,
        env: {},
        timeoutMs: 5000,
        outputBytes: 1000,
      });
      expect(result.effectiveLimits.processCount).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

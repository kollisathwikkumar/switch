import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProcessAdapter, ResourceLimitRefusalError } from './process-adapter';

if (process.env.TRACEMIND_REQUIRE_WINDOWS === '1' && process.platform !== 'win32') {
  throw new Error('TRACEMIND_REQUIRE_WINDOWS=1 requires a Windows runner');
}

it.skipIf(process.platform === 'linux')(
  'fails closed before spawning when memory or process-count enforcement has no verified OS control',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-resource-fail-closed-'));
    const marker = join(directory, 'must-not-exist');
    const base = {
      executable: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      cwd: directory,
      env: {},
      timeoutMs: 5000,
      outputBytes: 1000,
    };
    try {
      const memory = new ProcessAdapter().run({ ...base, memoryBytes: 64 * 1024 * 1024 });
      await expect(memory).rejects.toBeInstanceOf(ResourceLimitRefusalError);
      await expect(memory).rejects.toMatchObject({
        platform: process.platform,
        missingControls: ['memoryBytes'],
      });
      await expect(new ProcessAdapter().run({ ...base, processCount: 2 })).rejects.toMatchObject({
        platform: process.platform,
        missingControls: ['processCount'],
      });
      await expect(
        new ProcessAdapter().run({
          ...base,
          memoryBytes: 64 * 1024 * 1024,
          processCount: 2,
        })
      ).rejects.toMatchObject({
        platform: process.platform,
        missingControls: ['memoryBytes', 'processCount'],
      });
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const nativeRoot = join(appRoot, 'src/main/core/tracemind/native');
const output = join(appRoot, 'dist-tracemind-native');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
  await writeFile(
    join(output, 'UNAVAILABLE.txt'),
    'TraceMind native filesystem access is not available on this platform.\n'
  );
  console.log('TraceMind native filesystem access is unavailable on this platform.');
} else {
  const require = createRequire(import.meta.url);
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', '--directory', nativeRoot], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  await copyFile(
    join(nativeRoot, 'build/Release/tracemind_fs.node'),
    join(output, 'tracemind_fs.node')
  );
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const helper = spawnSync(
      process.env.CC ?? 'cc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(nativeRoot, 'git-cwd.c'),
        '-o',
        join(output, 'tracemind_git_cwd'),
      ],
      { stdio: 'inherit' }
    );
    if (helper.error) throw helper.error;
    if (helper.status !== 0) process.exit(helper.status ?? 1);
    const verification = spawnSync(
      process.env.CC ?? 'cc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(nativeRoot, 'verification-cwd.c'),
        '-o',
        join(output, 'tracemind_verification_cwd'),
      ],
      { stdio: 'inherit' }
    );
    if (verification.error) throw verification.error;
    if (verification.status !== 0) process.exit(verification.status ?? 1);
    console.log('Built TraceMind native filesystem module and descriptor-bound helpers.');
  } else {
    console.log(
      'Built TraceMind Windows filesystem module; execution remains gated pending supervisor support.'
    );
  }
}

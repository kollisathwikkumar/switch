import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeProjectFs } from './access-registry';

/** Loads only the build-owned addon path, never a renderer-supplied path. */
export function loadNativeProjectFs(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): NativeProjectFs {
  if (
    options.platform !== 'darwin' &&
    options.platform !== 'linux' &&
    options.platform !== 'win32'
  ) {
    throw new Error('Native project scanning is unavailable on this platform');
  }
  const base = options.packaged ? options.resourcesPath : options.appPath;
  const addon = createRequire(import.meta.url)(
    join(base, 'dist-tracemind-native', 'tracemind_fs.node')
  ) as NativeProjectFs;
  if (
    !addon ||
    typeof addon.openRoot !== 'function' ||
    typeof addon.openDirectory !== 'function' ||
    typeof addon.openFile !== 'function' ||
    typeof addon.classify !== 'function' ||
    typeof addon.list !== 'function' ||
    typeof addon.identity !== 'function' ||
    typeof addon.close !== 'function'
  ) {
    throw new Error('Invalid native project filesystem module');
  }
  return addon;
}

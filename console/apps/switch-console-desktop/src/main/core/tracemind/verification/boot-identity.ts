import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function digest(label: string, value: string): string {
  return createHash('sha256').update(`tracemind-${label}-v1\0${value.toLowerCase()}`).digest('hex');
}
/** Returns null unless both kernel boot and machine identities are available. */
export async function getBootIdentity(): Promise<{ host: string; boot: string } | null> {
  try {
    let host: string;
    let boot: string;
    if (process.platform === 'darwin') {
      const [machine, session] = await Promise.all([
        exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
          timeout: 2000,
          maxBuffer: 65536,
        }),
        exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
          timeout: 2000,
          maxBuffer: 1024,
        }),
      ]);
      host = machine.stdout.match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i)?.[1] ?? '';
      boot = session.stdout.trim();
    } else if (process.platform === 'linux') {
      host = (await readFile('/etc/machine-id', 'utf8')).trim();
      boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (/^[a-f0-9]{32}$/i.test(host))
        host = `${host.slice(0, 8)}-${host.slice(8, 12)}-${host.slice(12, 16)}-${host.slice(16, 20)}-${host.slice(20)}`;
    } else return null;
    if (!uuid.test(host) || !uuid.test(boot)) return null;
    return { host: digest('host', host), boot: digest('boot', boot) };
  } catch {
    return null;
  }
}

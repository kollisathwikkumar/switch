import { describe, expect, it } from 'vitest';
import { parseLinuxCgroupLocation } from './linux-cgroup-v2';

describe('Linux cgroup v2 path resolution', () => {
  it('maps the process cgroup under the mounted delegated subtree', () => {
    const location = parseLinuxCgroupLocation(
      '29 23 0:26 /delegated/user.slice/user-1000.slice /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate,memory_recursiveprot',
      '0::/delegated/user.slice/user-1000.slice/app.slice/switch-console'
    );
    expect(location).toEqual({
      mountPoint: '/sys/fs/cgroup',
      mountRoot: '/delegated/user.slice/user-1000.slice',
      processPath: '/sys/fs/cgroup/app.slice/switch-console',
    });
  });

  it('decodes mountinfo escapes without treating them as path separators', () => {
    const location = parseLinuxCgroupLocation(
      '32 23 0:26 /tenant /sys/fs/cgroup\\040delegated rw - cgroup2 cgroup rw',
      '0::/tenant/build.slice'
    );
    expect(location?.mountPoint).toBe('/sys/fs/cgroup delegated');
    expect(location?.processPath).toBe('/sys/fs/cgroup delegated/build.slice');
  });

  it('rejects cgroup paths outside the mounted root and non-cgroup2 mounts', () => {
    expect(
      parseLinuxCgroupLocation(
        '29 23 0:26 /delegated/user.slice /sys/fs/cgroup rw - cgroup2 cgroup rw',
        '0::/other/user.slice/build'
      )
    ).toBeNull();
    expect(
      parseLinuxCgroupLocation(
        '29 23 0:26 / /sys/fs/cgroup rw - tmpfs tmpfs rw',
        '0::/user.slice/build'
      )
    ).toBeNull();
  });
});

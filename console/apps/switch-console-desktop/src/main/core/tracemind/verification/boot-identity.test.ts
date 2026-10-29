import { expect, it } from 'vitest';
import { getBootIdentity } from './boot-identity';
it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'reads stable hashed local machine and boot identities',
  async () => {
    const first = await getBootIdentity();
    expect(first).toMatchObject({
      host: expect.stringMatching(/^[a-f0-9]{64}$/),
      boot: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await getBootIdentity()).toEqual(first);
  }
);

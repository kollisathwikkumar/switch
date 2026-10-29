import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLocalAudit } from '../audit/audit-service';
import type { AuditInput } from '../audit/audit-store';
import type { NativeProjectFs } from '../native/access-registry';
import { VerificationApprovalService } from './approval-service';
import { discoverPackageChecks } from './command-contract';
import type { StoredRunProposal } from './run-store';
import { verifyApprovalSnapshot } from './snapshot-verifier';
import * as discovery from './snapshot-verifier';

const native = (): NativeProjectFs =>
  createRequire(import.meta.url)(
    join(process.cwd(), 'dist-tracemind-native', 'tracemind_fs.node')
  ) as NativeProjectFs;
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'approval snapshot verification',
  () => {
    it('matches a real audited snapshot and rejects changed or forged scripts', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-snapshot-'));
      try {
        const manifest = JSON.stringify({
          scripts: { pretest: 'echo pre', test: 'echo test', posttest: 'echo post' },
        });
        await writeFile(join(root, 'package.json'), manifest);
        await writeFile(join(root, 'main.ts'), 'export const x = 1;');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const audit = await runLocalAudit('project-1', {
          consume: async () => ({
            locationId: 'project-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: native(),
          save: async (record: AuditInput) => ({
            ...record,
            id: '00000000-0000-4000-8000-000000000001',
          }),
        });
        const proposal = discoverPackageChecks(manifest, '.', `audit:${audit.id}`)[0]!;
        expect(
          await verifyApprovalSnapshot({ ...audit, fingerprint: null }, proposal, native())
        ).toBeNull();
        expect(
          await verifyApprovalSnapshot(audit, { ...proposal, revision: 'audit:other' }, native())
        ).toBeNull();
        expect(
          await verifyApprovalSnapshot(
            audit,
            { ...proposal, workingDirectory: 'missing' },
            native()
          )
        ).toBeNull();
        expect(await verifyApprovalSnapshot(audit, proposal, native())).toEqual({
          root: canonical,
          identity: audit.identity,
          fingerprint: audit.fingerprint,
          workingDirectoryIdentity: audit.identity,
        });
        const forged = discoverPackageChecks(
          '{"scripts":{"test":"echo forged"}}',
          '.',
          `audit:${audit.id}`
        )[0]!;
        expect(await verifyApprovalSnapshot(audit, forged, native())).toBeNull();
        const run: StoredRunProposal = {
          id: '00000000-0000-4000-8000-000000000002',
          projectId: 'project-1',
          auditId: audit.id,
          proposal,
          state: 'proposed',
          verified: false,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        };
        const approval = new VerificationApprovalService({
          load: async () => run,
          snapshot: async (_projectId, _auditId, proposed) =>
            verifyApprovalSnapshot(audit, proposed, native()),
          confirm: async () => 'approve',
          deny: async () => {},
          now: () => 1000,
        });
        expect(await approval.request('project-1', run.id)).toBe(true);
        await writeFile(join(root, 'main.ts'), 'export const x = 2;');
        expect(await verifyApprovalSnapshot(audit, proposal, native())).toBeNull();
        expect(await approval.consume('project-1', run.id)).toBe(false);
        await rename(root, `${root}-original`);
        try {
          await mkdir(root);
          await writeFile(join(root, 'package.json'), manifest);
          await writeFile(join(root, 'main.ts'), 'export const x = 1;');
          expect(await verifyApprovalSnapshot(audit, proposal, native())).toBeNull();
        } finally {
          await rm(root, { recursive: true, force: true });
          await rename(`${root}-original`, root);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('checks the manifest in the selected nested working directory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-approval-nested-'));
      try {
        await mkdir(join(root, 'packages', 'app'), { recursive: true });
        const manifest = '{"scripts":{"test":"echo nested"}}';
        await writeFile(join(root, 'packages', 'app', 'package.json'), manifest);
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const audit = await runLocalAudit('project-1', {
          consume: async () => ({
            locationId: 'project-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: native(),
          save: async (record: AuditInput) => ({
            ...record,
            id: '00000000-0000-4000-8000-000000000001',
          }),
        });
        const proposal = discoverPackageChecks(manifest, 'packages/app', `audit:${audit.id}`)[0]!;
        const cwdStat = await stat(join(root, 'packages', 'app'), { bigint: true });
        expect(await verifyApprovalSnapshot(audit, proposal, native())).toMatchObject({
          fingerprint: audit.fingerprint,
          workingDirectoryIdentity: `${cwdStat.dev}:${cwdStat.ino}`,
        });
        expect(
          await verifyApprovalSnapshot(audit, { ...proposal, workingDirectory: '.' }, native())
        ).toBeNull();
        const run: StoredRunProposal = {
          id: '00000000-0000-4000-8000-000000000002',
          projectId: 'project-1',
          auditId: audit.id,
          proposal,
          state: 'proposed',
          verified: false,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        };
        let replacedAfterFirstConfirmation = false;
        const approval = new VerificationApprovalService({
          load: async () => run,
          snapshot: async (_projectId, _auditId, proposed) =>
            verifyApprovalSnapshot(audit, proposed, native()),
          confirm: async () => {
            if (!replacedAfterFirstConfirmation) {
              await rename(join(root, 'packages', 'app'), `${root}-old`);
              await mkdir(join(root, 'packages', 'app'));
              await writeFile(join(root, 'packages', 'app', 'package.json'), manifest);
              replacedAfterFirstConfirmation = true;
            }
            return 'approve';
          },
          deny: async () => {},
          now: () => 1000,
        });
        expect(await approval.request('project-1', run.id)).toBe(false);
        expect(await approval.consume('project-1', run.id)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(`${root}-old`, { recursive: true, force: true });
      }
    });
    it('discovers commands in audited manifests without executing them and rejects changed snapshots', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-discovery-'));
      try {
        await mkdir(join(root, 'nested'), { recursive: true });
        await mkdir(join(root, 'broken'), { recursive: true });
        await writeFile(
          join(root, 'package.json'),
          JSON.stringify({ scripts: { test: 'touch should-not-exist' } })
        );
        await writeFile(
          join(root, 'nested', 'package.json'),
          JSON.stringify({ scripts: { pretest: 'echo pre', test: 'echo nested' } })
        );
        await writeFile(join(root, 'broken', 'package.json'), '{');
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const audit = await runLocalAudit('project-1', {
          consume: async () => ({
            locationId: 'project-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: native(),
          save: async (record: AuditInput) => ({
            ...record,
            id: '00000000-0000-4000-8000-000000000001',
          }),
        });
        const result = await discovery.discoverAuditedChecks(audit, native());
        expect(result?.candidates.map((item) => item.workingDirectory)).toEqual(['.', 'nested']);
        expect(result?.limitations).toEqual(
          expect.arrayContaining([expect.stringContaining('broken/package.json')])
        );
        await expect(stat(join(root, 'should-not-exist'))).rejects.toThrow();
        await writeFile(
          join(root, 'nested', 'package.json'),
          '{"scripts":{"test":"echo changed"}}'
        );
        expect(await discovery.discoverAuditedChecks(audit, native())).toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('bounds manifest capture, keeps the root package and reports omissions', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracemind-discovery-limit-'));
      try {
        const manifest = '{"scripts":{"test":"echo check"}}';
        await writeFile(join(root, 'package.json'), manifest);
        for (let index = 0; index < 33; index++) {
          const dir = join(root, `pkg-${String(index).padStart(2, '0')}`);
          await mkdir(dir);
          await writeFile(join(dir, 'package.json'), manifest);
        }
        const canonical = await realpath(root);
        const info = await stat(canonical, { bigint: true });
        const audit = await runLocalAudit('project-1', {
          consume: async () => ({
            locationId: 'project-1',
            root: canonical,
            identity: `${info.dev}:${info.ino}`,
          }),
          native: native(),
          save: async (record: AuditInput) => ({
            ...record,
            id: '00000000-0000-4000-8000-000000000001',
          }),
        });
        const result = await discovery.discoverAuditedChecks(audit, native());
        expect(result?.candidates).toHaveLength(32);
        expect(result?.candidates.some((item) => item.workingDirectory === '.')).toBe(true);
        expect(result?.limitations).toEqual(
          expect.arrayContaining([expect.stringContaining('first 32 of 34')])
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
);

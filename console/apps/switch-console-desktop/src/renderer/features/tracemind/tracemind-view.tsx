import { useEffect, useRef, useState } from 'react';
import type {
  AuditEvidence,
  AuditRecord,
  EvidenceComparison,
} from '@main/core/tracemind/audit/audit-store';
import type { GraphInspection } from '@main/core/tracemind/graph/graph-query';
import type { GraphOverview } from '@main/core/tracemind/graph/graph-store';
import type { TraceMindIssue } from '@main/core/tracemind/investigation/issue-store';
import type { CommandProposal } from '@main/core/tracemind/verification/command-contract';
import type { RunProposalSummary } from '@main/core/tracemind/verification/run-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { Location } from '@shared/core/locations/locations';

export function TraceMindMainPanel() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [section, setSection] = useState<'issues' | 'audit' | 'graph'>('issues');
  const [issues, setIssues] = useState<TraceMindIssue[]>([]);
  const [editing, setEditing] = useState<TraceMindIssue | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [issueAuditId, setIssueAuditId] = useState('');
  const [viewedAuditId, setViewedAuditId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshAvailable, setRefreshAvailable] = useState(false);
  const [reviewVersion, setReviewVersion] = useState<TraceMindIssue | null>(null);
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [auditing, setAuditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditMessage, setAuditMessage] = useState('');

  useEffect(() => {
    let active = true;
    void rpc.locations.getLocations().then(
      (items) => {
        if (active) setLocations(items.filter((item) => item.sshHost === null));
      },
      () => {
        if (active) setError('Could not load local projects.');
      }
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setIssues([]);
    setEditing(null);
    setTitle('');
    setDescription('');
    setIssueAuditId('');
    setViewedAuditId('');
    setRefreshAvailable(false);
    setReviewVersion(null);
    setError('');
    if (!locationId) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void rpc.tracemind
      .listIssues(locationId)
      .then(
        (items) => {
          if (active) setIssues(items);
        },
        () => {
          if (active) setError('Could not load issues for this project.');
        }
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locationId]);

  useEffect(() => {
    let active = true;
    setAudits([]);
    setAuditMessage('');
    if (!locationId) {
      setAuditLoading(false);
      return () => {
        active = false;
      };
    }
    setAuditLoading(true);
    void rpc.tracemind
      .listAudits(locationId)
      .then(
        (items) => {
          if (active) setAudits(items);
        },
        () => {
          if (active) setAuditMessage('Could not load audit history.');
        }
      )
      .finally(() => {
        if (active) setAuditLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locationId]);

  async function addLocalProject(): Promise<void> {
    if (picking) return;
    setPicking(true);
    setError('');
    try {
      const location = await rpc.tracemind.pickLocalProject();
      if (location) {
        setLocations((current) => [location, ...current.filter((item) => item.id !== location.id)]);
        setLocationId(location.id);
      }
    } catch {
      setError('Could not add the selected local project.');
    } finally {
      setPicking(false);
    }
  }

  async function runAudit(): Promise<void> {
    if (!locationId || auditing) return;
    setAuditing(true);
    setAuditMessage('');
    try {
      const approved = await rpc.tracemind.requestAuditApproval(locationId);
      if (!approved) {
        setAuditMessage('Audit was not approved.');
        return;
      }
      const audit = await rpc.tracemind.runAudit(locationId);
      setAudits((current) => [audit, ...current.filter((item) => item.id !== audit.id)]);
      setViewedAuditId('');
    } catch (error) {
      setAuditMessage(error instanceof Error ? `Audit failed: ${error.message}` : 'Audit failed.');
    } finally {
      setAuditing(false);
    }
  }

  function selectIssue(issue: TraceMindIssue | null): void {
    setEditing(issue);
    setTitle(issue?.title ?? '');
    setDescription(issue?.description ?? '');
    setIssueAuditId(issue?.auditId ?? '');
    setError('');
    setRefreshAvailable(false);
    setReviewVersion(null);
  }

  async function refreshIssueVersion(): Promise<void> {
    if (!editing || !locationId || saving) return;
    setSaving(true);
    setError('');
    try {
      const items = await rpc.tracemind.listIssues(locationId);
      const latest = items.find((item) => item.id === editing.id);
      setIssues(items);
      if (!latest) {
        setError('This issue is no longer available. Your draft is unchanged.');
        return;
      }
      setEditing(latest);
      setReviewVersion(latest);
      setRefreshAvailable(false);
    } catch {
      setError('Could not refresh the issue. Your draft is unchanged.');
    } finally {
      setSaving(false);
    }
  }

  async function saveIssue(): Promise<void> {
    if (!locationId || !title.trim() || saving || loading) return;
    setSaving(true);
    setError('');
    try {
      const input = {
        title,
        description,
        ...(issueAuditId ? { auditId: issueAuditId } : editing?.auditId ? { auditId: null } : {}),
      };
      const saved = editing
        ? await rpc.tracemind.updateIssue(locationId, editing.id, editing.version, input)
        : await rpc.tracemind.createIssue(locationId, input);
      setIssues((current) => [saved, ...current.filter((issue) => issue.id !== saved.id)]);
      selectIssue(saved);
    } catch {
      setError('Could not save the issue. It may have changed; reload before retrying.');
      setRefreshAvailable(Boolean(editing));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-background px-8 py-10 text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <PageHeader
          title="TraceMind"
          description="Record and investigate issues in a local project."
        />
        <label className="flex max-w-xl flex-col gap-2 text-sm">
          Local project
          <select
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
            disabled={saving || auditing || picking}
            className="h-9 rounded-md border border-border bg-background px-2"
          >
            <option value="">Select a local project</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name} — {location.dir}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void addLocalProject()}
            disabled={picking || saving || auditing}
          >
            {picking ? 'Selecting…' : 'Add local project'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {locationId && (
          <nav
            aria-label="TraceMind sections"
            className="flex flex-wrap gap-1 border-b border-border"
          >
            {(['issues', 'audit', 'graph'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-current={section === item ? 'page' : undefined}
                onClick={() => setSection(item)}
                className="focus-visible:outline-primary aria-[current=page]:border-primary border-b-2 border-transparent px-4 py-2 text-sm text-foreground-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 aria-[current=page]:text-foreground"
              >
                {item === 'issues'
                  ? 'Investigations'
                  : item === 'audit'
                    ? 'Audit'
                    : 'Evidence graph'}
              </button>
            ))}
          </nav>
        )}
        <div hidden={section !== 'issues'}>
          {locationId && (
            <div className="grid gap-6 md:grid-cols-[minmax(12rem,1fr)_2fr]">
              <section aria-label="Issues" className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">Issues</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => selectIssue(null)}
                    disabled={saving || loading}
                  >
                    New issue
                  </Button>
                </div>
                {loading ? (
                  <p className="text-sm text-foreground-muted">Loading issues…</p>
                ) : issues.length === 0 ? (
                  <p className="text-sm text-foreground-muted">No issues yet.</p>
                ) : (
                  issues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      disabled={saving || loading}
                      onClick={() => selectIssue(issue)}
                      aria-pressed={editing?.id === issue.id}
                      className="aria-pressed:border-primary rounded-md border border-border px-3 py-2 text-left text-sm"
                    >
                      {issue.title}
                    </button>
                  ))
                )}
              </section>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveIssue();
                }}
                className="flex flex-col gap-4 rounded-lg border border-border p-4"
              >
                <h3 className="font-medium">{editing ? 'Edit issue' : 'New issue'}</h3>
                <label className="flex flex-col gap-2 text-sm">
                  Title
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                    required
                    disabled={saving || loading}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm">
                  Description
                  <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={20000}
                    disabled={saving || loading}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm">
                  Related audit
                  <select
                    aria-label="Related audit"
                    value={issueAuditId}
                    onChange={(event) => setIssueAuditId(event.target.value)}
                    disabled={saving || loading || auditLoading}
                    className="h-9 rounded-md border border-border bg-background px-2"
                  >
                    <option value="">No related audit</option>
                    {issueAuditId && !audits.some((item) => item.id === issueAuditId) && (
                      <option value={issueAuditId}>
                        Related audit unavailable — {issueAuditId}
                      </option>
                    )}
                    {audits.map((item) => (
                      <option key={item.id} value={item.id}>
                        {new Date(item.capturedAt).toLocaleString()} — {item.id}
                      </option>
                    ))}
                  </select>
                </label>
                {issueAuditId && audits.some((item) => item.id === issueAuditId) && (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setViewedAuditId(issueAuditId);
                        setSection('audit');
                      }}
                    >
                      View related audit
                    </Button>
                  </div>
                )}
                <div>
                  <Button type="submit" disabled={saving || loading || !title.trim()}>
                    {saving ? 'Saving…' : 'Save issue'}
                  </Button>
                </div>
                {refreshAvailable && (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void refreshIssueVersion()}
                      disabled={saving}
                    >
                      Refresh issue version
                    </Button>
                  </div>
                )}
                {reviewVersion && (
                  <div className="rounded-md border border-border p-3 text-sm">
                    <p>
                      Your draft is unchanged. Saving overwrites the latest version shown below.
                    </p>
                    <p>Latest title: {reviewVersion.title}</p>
                    <p className="whitespace-pre-wrap">
                      Latest description: {reviewVersion.description || '(empty)'}
                    </p>
                    <p>Latest related audit: {reviewVersion.auditId ?? 'None'}</p>
                  </div>
                )}
              </form>
            </div>
          )}
        </div>
        <div hidden={section !== 'audit'}>
          {locationId && (
            <section
              aria-label="Project audit"
              className="flex flex-col gap-4 rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">Project audit</h3>
                  <p className="text-sm text-foreground-muted">
                    Inspect eligible files on this device after approval.
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={() => void runAudit()}
                  disabled={auditing || auditLoading || saving}
                >
                  {auditing ? 'Auditing…' : 'Run audit'}
                </Button>
              </div>
              {auditMessage && (
                <p role="status" className="text-sm text-foreground-muted">
                  {auditMessage}
                </p>
              )}
              {auditLoading ? (
                <p className="text-sm text-foreground-muted">Loading audit history…</p>
              ) : audits.length === 0 ? (
                <p className="text-sm text-foreground-muted">No audits yet.</p>
              ) : (
                <>
                  <label className="flex flex-col gap-2 text-sm">
                    Audit to inspect
                    <select
                      aria-label="Audit to inspect"
                      value={viewedAuditId || audits[0]?.id}
                      onChange={(event) => setViewedAuditId(event.target.value)}
                      className="h-9 rounded-md border border-border bg-background px-2"
                    >
                      {audits.map((item) => (
                        <option key={item.id} value={item.id}>
                          {new Date(item.capturedAt).toLocaleString()} — {item.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <AuditDetails
                    audit={audits.find((item) => item.id === viewedAuditId) ?? audits[0]}
                    previous={
                      audits[
                        Math.max(
                          0,
                          audits.findIndex((item) => item.id === viewedAuditId)
                        ) + 1
                      ]
                    }
                  />
                </>
              )}
            </section>
          )}
        </div>
        <div hidden={section !== 'graph'}>
          {locationId && audits.length > 0 ? (
            <GraphPanel
              key={`graph:${locationId}:${viewedAuditId || audits[0]?.id}`}
              locationId={locationId}
              revision={`audit:${viewedAuditId || audits[0]?.id}`}
              coverage={
                (audits.find((item) => item.id === viewedAuditId) ?? audits[0])?.inventory
                  .graphCoverage
              }
              filesParsed={
                (audits.find((item) => item.id === viewedAuditId) ?? audits[0])?.inventory
                  .filesParsed
              }
              filesDiscovered={
                (audits.find((item) => item.id === viewedAuditId) ?? audits[0])?.inventory
                  .filesDiscovered
              }
            />
          ) : (
            <p className="rounded-lg border border-border p-6 text-sm text-foreground-muted">
              Select a local project and run an audit to explore its evidence graph.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export const tracemindView = { MainPanel: TraceMindMainPanel, worksWithoutServer: true };

function AuditDetails({
  audit,
  previous,
}: {
  audit: AuditRecord | undefined;
  previous: AuditRecord | undefined;
}) {
  if (!audit) return null;
  const inventory = audit.inventory;
  const comparison = !previous
    ? 'No previous audit for comparison.'
    : audit.root !== previous.root ||
        !audit.identity ||
        audit.identity !== previous.identity ||
        !audit.fingerprint ||
        !previous.fingerprint
      ? 'Comparison unavailable because the root identity or fingerprint is missing or different.'
      : audit.fingerprint === previous.fingerprint
        ? 'Snapshot fingerprints match the previous audit.'
        : 'Snapshots differ; eligible files or scan exclusions may have changed.';
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-foreground-muted">
        Selected audit: {new Date(audit.capturedAt).toLocaleString()}
      </p>
      <p>
        {inventory.filesDiscovered} {inventory.filesDiscovered === 1 ? 'file' : 'files'} inventoried
        · {inventory.filesParsed} parsed · {inventory.skipped} skipped ·{' '}
        {inventory.inventoryComplete ? 'Inventory complete' : 'Inventory incomplete'}
      </p>
      <GraphCoverageNotice
        coverage={inventory.graphCoverage}
        filesParsed={inventory.filesParsed}
        filesDiscovered={inventory.filesDiscovered}
        label="Audit graph coverage"
      />
      <p>
        Revision: {audit.revision ?? 'Unknown'} · Working tree:{' '}
        {audit.dirty === null ? 'Unknown' : audit.dirty ? 'Dirty' : 'Clean'}
      </p>
      <p>Filesystem identity: {audit.identity ?? 'Unavailable in this audit'}</p>
      <p className="break-all">Fingerprint: {audit.fingerprint ?? 'Unavailable'}</p>
      <p>Fingerprints are TraceMind path-aware hashes, not a plain file-content SHA-256.</p>
      <p>
        {comparison} The current project state is not monitored; run another audit to compare again.
      </p>
      {previous && (
        <EvidenceChanges
          key={`${previous.id}:${audit.id}`}
          locationId={audit.locationId}
          previousId={previous.id}
          currentId={audit.id}
        />
      )}
      {inventory.languages.length > 0 && (
        <p>
          Languages:{' '}
          {inventory.languages.map((item) => `${item.language} (${item.files})`).join(', ')}
        </p>
      )}
      {inventory.manifests.length > 0 && (
        <p className="break-words">Manifests: {inventory.manifests.join(', ')}</p>
      )}
      {inventory.skippedEntries &&
        (inventory.skippedEntries.length > 0 || inventory.skipDetailsTruncated) && (
          <div>
            <p className="font-medium">Skipped entries</p>
            <ul className="list-disc pl-5">
              {inventory.skippedEntries.map((item) => (
                <li key={item.path} className="break-all">
                  <code>{item.path}</code>: {item.reason}
                </li>
              ))}
            </ul>
            {inventory.skipDetailsTruncated && <p>Additional skipped entries are not listed.</p>}
          </div>
        )}
      {inventory.skipped > 0 && !inventory.skippedEntries && (
        <p>Skipped-entry details were not recorded for this audit.</p>
      )}
      {inventory.errors.length > 0 && (
        <div>
          <p className="font-medium">Errors</p>
          <ul className="list-disc pl-5">
            {inventory.errors.map((item, index) => (
              <li key={`${item.path}-${index}`}>
                {item.path || '(project root)'}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <EvidencePanel
        key={`evidence:${audit.locationId}:${audit.id}`}
        locationId={audit.locationId}
        auditId={audit.id}
      />
      <CheckDiscoveryPanel
        key={`checks:${audit.locationId}:${audit.id}`}
        locationId={audit.locationId}
        auditId={audit.id}
      />
      <AuditReportPanel
        key={`report:${audit.locationId}:${audit.id}`}
        locationId={audit.locationId}
        auditId={audit.id}
      />
      <div>
        <p className="font-medium">Limitations</p>
        <ul className="list-disc pl-5">
          {inventory.limitations.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CheckDiscoveryPanel({ locationId, auditId }: { locationId: string; auditId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{
    discoveryId: string;
    candidates: CommandProposal[];
    limitations: string[];
  } | null>(null);
  const [saved, setSaved] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const savingRef = useRef(false);
  async function discover(): Promise<void> {
    setLoading(true);
    setMessage('');
    setResult(null);
    setSaved({});
    try {
      const found = await rpc.tracemind.discoverAuditChecks(locationId, auditId);
      if (!found) setMessage('Check discovery was not approved.');
      else setResult(found);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Check discovery failed: ${error.message}`
          : 'Check discovery failed.'
      );
    } finally {
      setLoading(false);
    }
  }
  async function save(index: number): Promise<void> {
    if (!result || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage('');
    try {
      const proposal = await rpc.tracemind.saveDiscoveredCheck(
        locationId,
        auditId,
        result.discoveryId,
        index
      );
      setSaved((current) => ({ ...current, [index]: proposal.id }));
      setHistoryVersion((value) => value + 1);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Could not save proposal: ${error.message}`
          : 'Could not save proposal.'
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <section
      aria-label="Candidate checks"
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <p className="font-medium">Candidate checks</p>
      <p className="text-foreground-muted">
        Discovery asks for approval to inspect the project. It does not run commands.
      </p>
      <Button type="button" disabled={loading || saving} onClick={() => void discover()}>
        {loading ? 'Discovering…' : 'Discover checks'}
      </Button>
      {message && <p role="status">{message}</p>}
      {result && (
        <>
          {result.candidates.length === 0 && <p>No supported checks found.</p>}
          {result.candidates.map((candidate, index) => (
            <div key={candidate.workingDirectory} className="rounded-md border border-border p-3">
              <p>
                <strong>
                  {candidate.executable} {candidate.args.join(' ')}
                </strong>{' '}
                · {candidate.workingDirectory}
              </p>
              {candidate.declaredScripts.pretest !== undefined && (
                <p className="break-all">
                  Pretest: <code>{candidate.declaredScripts.pretest}</code>
                </p>
              )}
              <p className="break-all">
                Test: <code>{candidate.declaredScripts.test}</code>
              </p>
              {candidate.declaredScripts.posttest !== undefined && (
                <p className="break-all">
                  Posttest: <code>{candidate.declaredScripts.posttest}</code>
                </p>
              )}
              <p className="text-foreground-muted">Proposed only; not executed or verified.</p>
              <p>Effective sandbox mode: {candidate.sandboxMode}</p>
              {saved[index] ? (
                <p>
                  Saved proposal: <code>{saved[index]}</code>
                </p>
              ) : (
                <Button type="button" disabled={saving} onClick={() => void save(index)}>
                  Save proposal
                </Button>
              )}
            </div>
          ))}
          {result.limitations.map((item) => (
            <p key={item} className="text-foreground-muted">
              {item}
            </p>
          ))}
        </>
      )}
      <CheckProposalHistory locationId={locationId} auditId={auditId} refresh={historyVersion} />
    </section>
  );
}

function CheckProposalHistory({
  locationId,
  auditId,
  refresh,
}: {
  locationId: string;
  auditId: string;
  refresh: number;
}) {
  const [items, setItems] = useState<RunProposalSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [approvedId, setApprovedId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const actionRef = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void rpc.tracemind
      .listCheckProposals(locationId, auditId, null)
      .then(
        (page) => {
          if (active) {
            setItems(page.items);
            setCursor(page.nextCursor);
          }
        },
        () => {
          if (active) setMessage('Could not load saved checks.');
        }
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [locationId, auditId, refresh, reload]);
  // A remounted view no longer owns the original run promise. Refresh durable
  // running records so cancellation and terminal outcomes become visible.
  useEffect(() => {
    if (runningId || !items.some((item) => item.state === 'running')) return;
    const timer = setInterval(() => setReload((value) => value + 1), 3000);
    return () => clearInterval(timer);
  }, [items, runningId]);
  async function loadMore(): Promise<void> {
    if (!cursor || busy || actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    try {
      const page = await rpc.tracemind.listCheckProposals(locationId, auditId, cursor);
      setItems((current) => [
        ...current,
        ...page.items.filter((item) => !current.some((existing) => existing.id === item.id)),
      ]);
      setCursor(page.nextCursor);
    } catch {
      setMessage('Could not load more saved checks.');
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function cancel(item: RunProposalSummary): Promise<void> {
    if (busy || actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const record = await rpc.tracemind.cancelCheckProposal(
        locationId,
        auditId,
        item.id,
        item.version
      );
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, state: record.state, version: record.version } : entry
        )
      );
    } catch {
      setMessage('Could not cancel proposal; it may have changed. Reload this audit.');
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function review(item: RunProposalSummary): Promise<void> {
    if (busy || actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      setApprovedId(null);
      const decision = await rpc.tracemind.requestCheckApproval(locationId, auditId, item.id);
      if (decision === 'approved') {
        setApprovedId(item.id);
        setMessage(
          `Approved once for up to 60 seconds (${item.sandboxMode}). No check has run yet.`
        );
      } else if (decision === 'denied') {
        setMessage('Proposal denied. No check was run.');
        setReload((value) => value + 1);
      } else if (decision === 'unavailable') {
        setMessage(
          'Verification runtime is unavailable on this host. No approval was created and no check was run.'
        );
      } else
        setMessage(
          'Approval was not granted. No check was run. The project may have changed or review was cancelled.'
        );
    } catch (error) {
      setMessage(
        error instanceof Error ? `Check review failed: ${error.message}` : 'Check review failed.'
      );
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function run(item: RunProposalSummary): Promise<void> {
    if (busy || actionRef.current || approvedId !== item.id) return;
    actionRef.current = true;
    setBusy(true);
    setRunningId(item.id);
    setApprovedId(null);
    setMessage(
      item.sandboxMode === 'unavailable'
        ? 'Running without a sandbox. Result will not be verified.'
        : `Running with ${item.sandboxMode}. The result will only be verified if capture, command matching, and termination checks all pass.`
    );
    try {
      const result = await rpc.tracemind.runApprovedCheck(locationId, auditId, item.id);
      setMessage(
        result.state === 'refused'
          ? 'Check refused before target start because required resource controls are unavailable. Inspect the recorded refusal.'
          : 'Check finished. Inspect its recorded outcome and limitations.'
      );
    } catch (error) {
      setMessage(error instanceof Error ? `Check failed: ${error.message}` : 'Check failed.');
    } finally {
      setRunningId(null);
      actionRef.current = false;
      setBusy(false);
      setReload((value) => value + 1);
    }
  }
  async function stop(runId: string): Promise<void> {
    try {
      const requested = await rpc.tracemind.cancelRunningCheck(locationId, auditId, runId);
      setMessage(
        requested
          ? 'Cancellation requested; process-tree termination may remain unconfirmed.'
          : 'No active runner was found. Process-tree termination may still be unconfirmed.'
      );
    } catch {
      setMessage('Could not request cancellation.');
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">Saved checks</p>
      {message && <p role="status">{message}</p>}
      {!busy && items.length === 0 && (
        <p className="text-foreground-muted">No saved checks for this audit.</p>
      )}
      {items.map((item) => (
        <div key={item.id} className="rounded-md border border-border p-3">
          <p>
            {item.executable} run test · {item.workingDirectory}
          </p>
          <p>
            Status: {item.state}
            {item.resultStatus ? ` · ${item.resultStatus}` : ''} ·{' '}
            {item.verified ? 'verified' : 'not verified'}
          </p>
          <p>Approved sandbox mode: {item.sandboxMode}</p>
          <p>
            Requested caps: process/task limit {item.processCount ?? 'not recorded'} (Linux counts
            threads and sandbox helpers) · memory{' '}
            {item.memoryBytes?.toLocaleString() ?? 'not recorded'} bytes.
          </p>
          <p className="break-all">
            ID: <code>{item.id}</code>
          </p>
          {item.state === 'proposed' && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={() => void review(item)}>
                Review check
              </Button>
              {approvedId === item.id && (
                <>
                  <p role="alert">
                    {item.sandboxMode === 'linux-bubblewrap'
                      ? 'Linux PID namespace isolation is active. Process/task and memory caps are enforced only with writable delegated cgroup v2 support; the result will report which limits were effective.'
                      : 'This mode cannot confirm process-tree termination. After it starts, later checks remain blocked until a detected reboot on this host. Recovery requires a detected reboot on this host; older reservations may still require manual investigation.'}
                  </p>
                  <Button type="button" disabled={busy} onClick={() => void run(item)}>
                    Run approved check
                  </Button>
                </>
              )}
              <Button type="button" disabled={busy} onClick={() => void cancel(item)}>
                Cancel proposal
              </Button>
            </div>
          )}
          {(runningId === item.id || item.state === 'running') && (
            <Button type="button" onClick={() => void stop(item.id)}>
              Cancel running check
            </Button>
          )}
          {(item.state === 'finished' || item.state === 'refused') && (
            <CheckResultPreview
              key={item.id}
              locationId={locationId}
              auditId={auditId}
              runId={item.id}
              verified={item.verified}
              processCount={item.processCount ?? undefined}
              memoryBytes={item.memoryBytes ?? undefined}
            />
          )}
          {item.state === 'outcome_unknown' && (
            <p>Outcome unknown; process termination is not confirmed.</p>
          )}
        </div>
      ))}
      {cursor && (
        <Button type="button" disabled={busy} onClick={() => void loadMore()}>
          Load more checks
        </Button>
      )}
    </div>
  );
}

function CheckResultPreview({
  locationId,
  auditId,
  runId,
  verified,
  processCount,
  memoryBytes,
}: {
  locationId: string;
  auditId: string;
  runId: string;
  verified: boolean;
  processCount?: number;
  memoryBytes?: number;
}) {
  const [result, setResult] = useState<NonNullable<
    Awaited<ReturnType<typeof rpc.tracemind.getCheckResultPreview>>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function show(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const data = await rpc.tracemind.getCheckResultPreview(locationId, auditId, runId);
      if (!data) setMessage('Result is unavailable.');
      else setResult(data);
    } catch {
      setMessage('Could not load check result.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" disabled={busy} onClick={() => void show()}>
        {busy ? 'Loading…' : 'View result'}
      </Button>
      {message && <p role="status">{message}</p>}
      <p>
        Requested caps: process/task limit {processCount ?? 'not recorded'} (Linux counts threads
        and sandbox helpers) · memory {memoryBytes?.toLocaleString() ?? 'not recorded'} bytes.
      </p>
      {result && (
        <div className="flex flex-col gap-2">
          <p>
            Outcome: {result.status} · exit: {result.exitCode ?? 'unknown'} · signal:{' '}
            {result.signal ?? 'none'} · {Math.round(result.durationMs)} ms
          </p>
          {result.resourceLimitRefusal && (
            <p role="alert">
              Execution refused before target start on {result.resourceLimitRefusal.platform}:{' '}
              {result.resourceLimitRefusal.reason}. No target exit code exists.
            </p>
          )}
          <p>
            Sandbox: {result.sandboxMode} · capture:{' '}
            {result.capturedComplete ? 'complete' : 'incomplete'} · termination:{' '}
            {result.terminationUnconfirmed ? 'unconfirmed' : 'no termination uncertainty recorded'}{' '}
            · {verified ? 'verified' : 'not verified'}
          </p>
          {result.execution ? (
            <div>
              <p>
                Adapter requested executable:{' '}
                <code className="break-all">{result.execution.executable}</code>
              </p>
              <p>
                Arguments:{' '}
                <code className="break-all">{JSON.stringify(result.execution.args)}</code>
              </p>
              <p>
                Working directory: <code className="break-all">{result.execution.cwd}</code>
              </p>
              <p>
                Adapter child: {result.execution.spawned ? 'started' : 'not started'} · Target
                handoff: {result.execution.targetHandoff ?? 'unknown'}
              </p>
              <p>
                Working-directory binding: {result.execution.workingDirectoryBinding ?? 'unknown'}
              </p>
              <p>Environment keys: {result.execution.environmentKeys.join(', ') || '(none)'}</p>
              <p>
                Requested timeout: {result.execution.timeoutMs} ms · output cap:{' '}
                {result.execution.outputBytes} bytes
              </p>
            </div>
          ) : (
            <p>Recorded execution details are unavailable.</p>
          )}
          {result.effectiveLimits && (
            <p>
              Memory limit:{' '}
              {typeof result.effectiveLimits.memory === 'number'
                ? `${result.effectiveLimits.memory.toLocaleString()} bytes`
                : 'not enforced'}{' '}
              · Process/task limit:{' '}
              {typeof result.effectiveLimits.processCount === 'number'
                ? `${result.effectiveLimits.processCount} ${result.effectiveLimits.processCount === 1 ? 'task' : 'tasks'}`
                : 'not enforced'}{' '}
              · CPU-time limit:{' '}
              {typeof result.effectiveLimits.cpuTimeSeconds === 'number'
                ? `${result.effectiveLimits.cpuTimeSeconds} seconds per process`
                : 'not enforced'}{' '}
              · Timeout: termination request · Concurrency:{' '}
              {result.effectiveLimits.concurrency === 'durable-single-flight'
                ? 'one durable check at a time across the application database'
                : 'per adapter instance'}
            </p>
          )}
          {result.executionMismatch ? (
            <p role="alert">
              The adapter-reported command or effective resource limits did not match the approved
              proposal.
            </p>
          ) : result.executionMatchConfirmed ? (
            <p>Executed command matched the approved proposal.</p>
          ) : (
            <p>Match to approved proposal is unconfirmed; absence of a mismatch is not proof.</p>
          )}
          <details>
            <summary>Output references</summary>
            <p>These references resolve scoped stored UTF-8 previews, not raw output files.</p>
            {result.outputReferences.map((reference) => (
              <p key={reference.stream}>
                {reference.stream}: <code className="break-all">{JSON.stringify(reference)}</code>
              </p>
            ))}
          </details>
          <p>Output hashes describe observed bytes; they may not match a truncated preview.</p>
          <p>
            Stdout SHA-256: <code className="break-all">{result.stdoutHash}</code>
            {result.stdoutTruncated ? ' · capture truncated' : ''}
            {result.stdoutPreviewTruncated ? ' · preview truncated' : ''}
          </p>
          <pre className="max-h-48 overflow-auto rounded-md border border-border p-2 break-all whitespace-pre-wrap">
            {result.stdout || '(empty)'}
          </pre>
          <p>
            Stderr SHA-256: <code className="break-all">{result.stderrHash}</code>
            {result.stderrTruncated ? ' · capture truncated' : ''}
            {result.stderrPreviewTruncated ? ' · preview truncated' : ''}
          </p>
          <pre className="max-h-48 overflow-auto rounded-md border border-border p-2 break-all whitespace-pre-wrap">
            {result.stderr || '(empty)'}
          </pre>
        </div>
      )}
    </div>
  );
}

function AuditReportPanel({ locationId, auditId }: { locationId: string; auditId: string }) {
  const [report, setReport] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(false);
    try {
      const result = await rpc.tracemind.getAuditReport(locationId, auditId);
      if (mounted.current) setReport(result);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  return (
    <section aria-label="Audit report" className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Loading report…' : 'View audit report'}
        </Button>
      </div>
      {error && <p role="alert">Could not load the audit report.</p>}
      {report === null && <p>This older audit has no saved report.</p>}
      {typeof report === 'string' && (
        <pre className="max-h-96 overflow-auto rounded-md border border-border p-3 break-words whitespace-pre-wrap">
          {report}
        </pre>
      )}
    </section>
  );
}

function EvidenceChanges({
  locationId,
  previousId,
  currentId,
}: {
  locationId: string;
  previousId: string;
  currentId: string;
}) {
  const [result, setResult] = useState<EvidenceComparison | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.tracemind.compareAuditEvidence(locationId, previousId, currentId).then(
      (value) => {
        if (active) setResult(value);
      },
      () => {
        if (active) setFailed(true);
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, previousId, currentId]);
  if (failed) return <p>File comparison could not be loaded.</p>;
  if (!result) return <p>Comparing captured file evidence…</p>;
  if (result.status === 'unavailable')
    return <p>File comparison unavailable for incomplete or incompatible audits.</p>;
  return (
    <section aria-label="File evidence changes">
      <p>
        Between the two captured audits: {result.counts.changed} changed, {result.counts.removed}{' '}
        removed, {result.counts.added} added.
      </p>
      <p>
        Added and removed mean present or absent in the eligible-file inventory, not necessarily
        created or deleted on disk.
      </p>
      {(result.counts.changed > 0 || result.counts.removed > 0) && (
        <p>
          Earlier evidence is stale for changed or removed files relative to the selected audit.
        </p>
      )}
      <ul>
        {result.items.map((item) => (
          <li key={item.path}>
            <code>{item.path}</code>: {item.change}
          </li>
        ))}
      </ul>
      {result.truncated && <p>Only the first 200 changed paths are shown.</p>}
    </section>
  );
}

function EvidencePanel({ locationId, auditId }: { locationId: string; auditId: string }) {
  const [items, setItems] = useState<AuditEvidence[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void rpc.tracemind
      .listAuditEvidence(locationId, auditId, 0)
      .then(
        (page) => {
          if (mounted.current) {
            setItems(page.items);
            setNextOffset(page.nextOffset);
          }
        },
        () => {
          if (mounted.current) setError('Could not load captured file evidence.');
        }
      )
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [locationId, auditId]);

  async function loadMore(): Promise<void> {
    if (nextOffset === null || loading) return;
    setLoading(true);
    setError('');
    try {
      const page = await rpc.tracemind.listAuditEvidence(locationId, auditId, nextOffset);
      if (mounted.current) {
        setItems((current) => [...current, ...page.items]);
        setNextOffset(page.nextOffset);
      }
    } catch {
      if (mounted.current) setError('Could not load more file evidence.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  return (
    <section aria-label="Captured file evidence" className="flex flex-col gap-2">
      <p className="font-medium">Captured file evidence</p>
      <p className="text-foreground-muted">
        Project-relative paths and file fingerprints from this audit; no source content is stored
        here.
      </p>
      {error && <p role="alert">{error}</p>}
      {items.length === 0 && !loading && !error && (
        <p className="text-foreground-muted">No file evidence was captured.</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.path} className="rounded-md border border-border p-2 break-all">
              <code>{item.path}</code>
              <p className="text-foreground-muted">Fingerprint: {item.fingerprint}</p>
            </li>
          ))}
        </ul>
      )}
      {loading && <p className="text-foreground-muted">Loading evidence…</p>}
      {nextOffset !== null && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function GraphCoverageNotice({
  coverage,
  filesParsed,
  filesDiscovered,
  label,
}: {
  coverage?: { status: 'complete' | 'partial'; omittedFiles: number };
  filesParsed?: number;
  filesDiscovered?: number;
  label?: string;
}) {
  if (coverage?.status === 'complete') return null;
  const state = coverage?.status ?? 'unknown';
  return (
    <p role="status" aria-label={label} className="rounded-md border border-border p-3 text-sm">
      Graph coverage is {state}
      {coverage
        ? coverage.omittedFiles > 0
          ? filesParsed !== undefined && filesDiscovered !== undefined
            ? ` · ${filesParsed} of ${filesDiscovered} inventoried files have parser-derived graph evidence · ${coverage.omittedFiles} omitted`
            : ` · at least ${coverage.omittedFiles} eligible ${coverage.omittedFiles === 1 ? 'file lacks' : 'files lack'} parser-derived graph evidence`
          : ' · no file-level parser omissions are currently quantified; additional omissions may be unknown'
        : ''}
      . File inventory and fingerprints may still be available. Some evidence may be missing;
      freshness is not guaranteed, and this graph must not be treated as up to date.
    </p>
  );
}

function GraphPanel({
  locationId,
  revision,
  coverage,
  filesParsed,
  filesDiscovered,
}: {
  locationId: string;
  revision: string;
  coverage?: { status: 'complete' | 'partial'; omittedFiles: number };
  filesParsed?: number;
  filesDiscovered?: number;
}) {
  const [overview, setOverview] = useState<GraphOverview | null | undefined>(undefined);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const [inspection, setInspection] = useState<GraphInspection | null>(null);
  const [inspectionStart, setInspectionStart] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [benchmark, setBenchmark] = useState<{
    readMs: number;
    traversalMs: number;
    traversalNodes: number;
    traversalRelationships: number;
    truncated: boolean;
    stopReason: 'time_limit' | 'edge_limit' | 'result_limit' | 'memory_limit' | null;
  } | null>(null);
  const [entryKind, setEntryKind] = useState<
    'observation' | 'command_run' | 'hypothesis' | 'evidence' | 'finding'
  >('observation');
  const [entryLabel, setEntryLabel] = useState('');
  const [entryReason, setEntryReason] = useState('');
  const [entryTarget, setEntryTarget] = useState('');
  const [entryRelation, setEntryRelation] = useState<
    'SUPPORTS' | 'CONTRADICTS' | 'VERIFIED_BY' | ''
  >('');
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    setOverview(undefined);
    void rpc.tracemind.getGraphOverview(locationId, revision, cursor).then(
      (item) => {
        if (active) setOverview(item);
      },
      () => {
        if (active) setError('Could not load the evidence graph.');
      }
    );
    return () => {
      active = false;
    };
  }, [locationId, revision, cursor]);
  async function inspect(): Promise<void> {
    if (!overview?.rootNodeId) return;
    setError('');
    try {
      setInspection(
        await rpc.tracemind.inspectGraph(
          locationId,
          overview.revision,
          inspectionStart || overview.rootNodeId,
          {
            direction: 'both',
            maxDepth: 4,
            maxResults: 100,
            maxEdges: 5_000,
            maxTimeMs: 1_000,
            maxMemoryBytes: 16 * 1024 * 1024,
          }
        )
      );
    } catch {
      setError('Could not inspect the evidence graph.');
    }
  }
  async function measure(): Promise<void> {
    if (!overview) return;
    try {
      setBenchmark(await rpc.tracemind.benchmarkGraphAdapter(locationId, overview.revision));
    } catch {
      setError('Could not benchmark the local graph adapter.');
    }
  }
  async function recordEntry(): Promise<void> {
    if (
      recordingRef.current ||
      !overview ||
      !entryLabel.trim() ||
      !entryReason.trim() ||
      Boolean(entryTarget) !== Boolean(entryRelation)
    )
      return;
    recordingRef.current = true;
    setRecording(true);
    try {
      await rpc.tracemind.recordGraphEntry(locationId, overview.revision, {
        kind: entryKind,
        label: entryLabel,
        reason: entryReason,
        ...(entryTarget && entryRelation
          ? { targetNodeId: entryTarget, relation: entryRelation }
          : {}),
      });
      setEntryLabel('');
      setEntryReason('');
      setEntryTarget('');
      setEntryRelation('');
      try {
        setOverview(await rpc.tracemind.getGraphOverview(locationId, revision, cursor));
      } catch {
        setError('Entry recorded, but the graph summary could not refresh.');
      }
    } catch {
      setError('Could not record this investigation entry.');
    } finally {
      recordingRef.current = false;
      setRecording(false);
    }
  }
  return (
    <section aria-label="Evidence graph" className="flex flex-col gap-2">
      <p className="font-medium">Evidence graph</p>
      <GraphCoverageNotice
        coverage={coverage}
        filesParsed={filesParsed}
        filesDiscovered={filesDiscovered}
      />
      <p className="text-foreground-muted">
        Relationships are extracted leads, not proof. Inspect source locations and provenance before
        drawing conclusions.
      </p>
      {error && <p role="alert">{error}</p>}
      {overview === undefined && !error && <p>Loading graph…</p>}
      {overview === null && <p>No graph was captured for this audit.</p>}
      {overview && (
        <>
          <p>
            {overview.nodeCount} nodes · {overview.relationshipCount} relationships ·{' '}
            {overview.parserFailureCount} parser limitations.
          </p>
          <label>
            Inspection start
            <select
              aria-label="Graph inspection start"
              value={inspectionStart}
              onChange={(event) => setInspectionStart(event.target.value)}
            >
              <option value="">Revision root</option>
              {inspectionStart && !overview.nodes.some((node) => node.id === inspectionStart) && (
                <option value={inspectionStart}>{inspectionStart}</option>
              )}
              {overview.nodes
                .filter((node) => node.id !== overview.rootNodeId)
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.kind} · {node.label}
                  </option>
                ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void inspect()}>
              Inspect graph
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void measure()}>
              Benchmark local adapter
            </Button>
          </div>
          <div className="order-last grid gap-2 rounded-md border border-border p-3">
            <p className="font-medium">Record investigation entry</p>
            <select
              aria-label="Investigation entry kind"
              value={entryKind}
              onChange={(event) => setEntryKind(event.target.value as typeof entryKind)}
              className="h-9 rounded-md border border-border bg-background px-2"
            >
              <option value="observation">Observation</option>
              <option value="hypothesis">Hypothesis</option>
              <option value="evidence">Evidence</option>
              <option value="command_run">Command run</option>
              <option value="finding">Finding</option>
            </select>
            <Input
              aria-label="Investigation entry label"
              value={entryLabel}
              onChange={(event) => setEntryLabel(event.target.value)}
              maxLength={1024}
              placeholder="Entry label"
            />
            <Textarea
              aria-label="Retrieval or recording rationale"
              value={entryReason}
              onChange={(event) => setEntryReason(event.target.value)}
              maxLength={4096}
              placeholder="Why this evidence was retrieved or recorded"
            />
            <select
              aria-label="Graph relationship target"
              value={entryTarget}
              onChange={(event) => setEntryTarget(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2"
            >
              <option value="">No relationship</option>
              {overview.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.kind}: {node.label}
                  {node.stale ? ' · stale' : ''}
                </option>
              ))}
            </select>
            <p aria-live="polite">Target page {cursors.length} · up to 50 nodes per page.</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={recording || cursors.length <= 1}
                onClick={() => {
                  setEntryTarget('');
                  setEntryRelation('');
                  setCursors((current) => current.slice(0, -1));
                }}
              >
                Previous targets
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={recording || !overview.nextCursor}
                onClick={() => {
                  if (overview.nextCursor) {
                    setEntryTarget('');
                    setEntryRelation('');
                    setCursors((current) => [...current, overview.nextCursor]);
                  }
                }}
              >
                Next targets
              </Button>
            </div>
            {entryTarget && (
              <select
                aria-label="Graph relationship type"
                value={entryRelation}
                onChange={(event) => setEntryRelation(event.target.value as typeof entryRelation)}
                className="h-9 rounded-md border border-border bg-background px-2"
              >
                <option value="">Select relationship</option>
                <option value="SUPPORTS">Supports</option>
                <option value="CONTRADICTS">Contradicts</option>
                <option value="VERIFIED_BY">Verified by</option>
              </select>
            )}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  recording ||
                  !entryLabel.trim() ||
                  !entryReason.trim() ||
                  Boolean(entryTarget) !== Boolean(entryRelation)
                }
                onClick={() => void recordEntry()}
              >
                Record entry
              </Button>
            </div>
          </div>
          {benchmark && (
            <p>
              Normalized SQLite counts: {benchmark.readMs.toFixed(2)} ms · bounded traversal:{' '}
              {benchmark.traversalMs.toFixed(2)} ms · {benchmark.traversalNodes} nodes /{' '}
              {benchmark.traversalRelationships} relationships ·{' '}
              {benchmark.truncated
                ? `bounded traversal stopped at ${benchmark.stopReason ?? 'unknown limit'}`
                : 'bounded traversal completed within limits'}
              .
            </p>
          )}
          {overview.parserFailures.length > 0 && (
            <ul>
              {overview.parserFailures.map((failure) => (
                <li key={`${failure.path}:${failure.message}`}>
                  <code>{failure.path}</code>: {failure.language} — {failure.message}
                </li>
              ))}
            </ul>
          )}
          {overview.parserFailureCount > overview.parserFailures.length && (
            <p>Additional parser limitations are not shown in this preview.</p>
          )}
          {inspection && (
            <>
              <p>
                {inspection.nodes.length} reachable nodes · {inspection.relationships.length}{' '}
                inspected relationships
                {inspection.truncated ? ` · truncated by ${inspection.stopReason}` : ''}.
              </p>
              <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <GraphCanvas
                  inspection={inspection}
                  selectedId={selectedNodeId}
                  onSelect={(id) => {
                    setInspectionStart(id);
                    setSelectedNodeId(id);
                  }}
                />
                <SelectedNodeDetails inspection={inspection} nodeId={selectedNodeId} />
              </div>
              <ul aria-label="Inspected graph nodes" className="flex flex-col gap-2">
                {inspection.nodes.map((node) => (
                  <li key={node.id} className="rounded-md border border-border p-2">
                    <code>{node.kind}</code> · {node.label}
                    {node.source && (
                      <>
                        {' '}
                        ·{' '}
                        <code>
                          {node.source.path}:{node.source.startLine}
                        </code>
                      </>
                    )}
                    {node.stale && <> · stale</>}
                  </li>
                ))}
              </ul>
              <ul className="flex flex-col gap-2">
                {inspection.relationships.map((relationship) => (
                  <li key={relationship.id} className="rounded-md border border-border p-2">
                    <code>{relationship.relation}</code> ·{' '}
                    {inspection.nodes.find((node) => node.id === relationship.sourceId)?.label ??
                      relationship.sourceId}{' '}
                    →{' '}
                    {inspection.nodes.find((node) => node.id === relationship.targetId)?.label ??
                      relationship.targetId}{' '}
                    · {relationship.extractionMethod} · {relationship.provenance}
                    {relationship.source && (
                      <>
                        {' '}
                        ·{' '}
                        <code>
                          {relationship.source.path}:{relationship.source.startLine}
                        </code>
                      </>
                    )}
                    {relationship.stale && <> · stale</>}
                  </li>
                ))}
              </ul>
              <p>
                Retrieval rationale:{' '}
                {overview.retrievalReasons.map((item) => item.reason).join(' ') ||
                  'No evidence retrieval rationale recorded.'}
              </p>
              {inspection.relationships.some((item) => item.relation === 'CONTRADICTS') && (
                <p>
                  Contradictory evidence is preserved and shown alongside supporting evidence; it is
                  not discarded.
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Shows only data returned by the currently inspected, bounded subgraph. */
function SelectedNodeDetails({
  inspection,
  nodeId,
}: {
  inspection: GraphInspection;
  nodeId: string;
}) {
  const node = inspection.nodes.find((item) => item.id === nodeId);
  if (!node)
    return (
      <p className="text-sm text-foreground-muted">
        Select a node to see its details and connected relationships.
      </p>
    );
  const relationships = inspection.relationships.filter(
    (edge) => edge.sourceId === node.id || edge.targetId === node.id
  );
  return (
    <aside
      aria-label="Selected node details"
      className="rounded-lg border border-border p-4 text-sm"
    >
      <p className="font-medium">Selected node · {node.kind}</p>
      <p className="break-all">{node.label}</p>
      <dl className="mt-3 grid gap-2 text-foreground-muted">
        <div>
          <dt className="inline font-medium">Revision: </dt>
          <dd className="inline break-all">{node.revision}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Source: </dt>
          <dd className="inline break-all">
            {node.source
              ? `${node.source.path}:${node.source.startLine}–${node.source.endLine}`
              : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Extraction: </dt>
          <dd className="inline">{node.extractionMethod}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Provenance: </dt>
          <dd className="inline break-all">{node.provenance}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Status: </dt>
          <dd className="inline">{node.stale ? 'Stale' : 'Not marked stale in this snapshot'}</dd>
        </div>
      </dl>
      <p className="mt-3 font-medium">Connected relationships · {relationships.length}</p>
      <p className="text-xs text-foreground-muted">
        Only relationships in this inspection are shown; graph links are not proof.
      </p>
      <ul className="mt-2 space-y-1">
        {relationships.map((edge) => {
          const incoming = edge.targetId === node.id;
          const other = inspection.nodes.find(
            (item) => item.id === (incoming ? edge.sourceId : edge.targetId)
          );
          return (
            <li key={edge.id} className="break-words">
              <code>{edge.relation}</code> · {incoming ? 'Incoming from' : 'Outgoing to'}{' '}
              {other?.label ?? (incoming ? edge.sourceId : edge.targetId)} · {edge.extractionMethod}{' '}
              · {edge.provenance}
              {edge.stale ? ' · stale' : ''}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

type GraphPoint = { x: number; y: number; vx: number; vy: number };
function initialGraphPositions(inspection: GraphInspection): Map<string, GraphPoint> {
  return new Map(
    inspection.nodes.slice(0, 101).map((node, index) => {
      const angle = index * 2.399963229728653;
      const radius = index === 0 ? 0 : Math.min(180, 24 * Math.sqrt(index));
      return [
        node.id,
        { x: 400 + radius * Math.cos(angle), y: 240 + radius * Math.sin(angle), vx: 0, vy: 0 },
      ] as const;
    })
  );
}

/** Bounded, gently settling layout over returned nodes and edges; no graph data is changed. */
function GraphCanvas({
  inspection,
  onSelect,
  selectedId,
}: {
  inspection: GraphInspection;
  onSelect: (id: string) => void;
  selectedId: string;
}) {
  const nodes = inspection.nodes.slice(0, 101);
  const [positions, setPositions] = useState(() => initialGraphPositions(inspection));
  const positionsRef = useRef(positions);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ nodeId: string | null; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const current = initialGraphPositions(inspection);
    positionsRef.current = current;
    setPositions(new Map(current));
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof window.requestAnimationFrame !== 'function') return;
    let frame = 0;
    let handle = 0;
    const step = () => {
      if (!drag.current) {
        const points = [...current.values()];
        const cooling = Math.max(0.04, 1 - frame / 140);
        for (let i = 0; i < points.length; i++) {
          const a = points[i];
          if (!a) continue;
          a.vx += (400 - a.x) * 0.0008;
          a.vy += (240 - a.y) * 0.0008;
          for (let j = i + 1; j < points.length; j++) {
            const b = points[j];
            if (!b) continue;
            const dx = a.x - b.x,
              dy = a.y - b.y;
            const d2 = Math.max(64, dx * dx + dy * dy);
            const force = Math.min(0.5, 80 / d2) * cooling;
            a.vx += dx * force;
            a.vy += dy * force;
            b.vx -= dx * force;
            b.vy -= dy * force;
          }
        }
        for (const edge of inspection.relationships) {
          const a = current.get(edge.sourceId),
            b = current.get(edge.targetId);
          if (!a || !b || a === b) continue;
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const force = (distance - 85) * 0.0008 * cooling;
          a.vx += dx * force;
          a.vy += dy * force;
          b.vx -= dx * force;
          b.vy -= dy * force;
        }
        for (const point of points) {
          point.vx *= 0.8;
          point.vy *= 0.8;
          point.x = Math.max(15, Math.min(785, point.x + point.vx));
          point.y = Math.max(15, Math.min(465, point.y + point.vy));
        }
        setPositions(new Map(current));
        frame++;
      }
      if (frame < 140) handle = window.requestAnimationFrame(step);
    };
    handle = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(handle);
  }, [inspection]);
  const movePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    const bounds = svg.current?.getBoundingClientRect();
    if (!active || !bounds || !bounds.width || !bounds.height) return;
    const dx = ((event.clientX - active.x) * (800 / zoom)) / bounds.width;
    const dy = ((event.clientY - active.y) * (480 / zoom)) / bounds.height;
    if (Math.abs(event.clientX - active.x) + Math.abs(event.clientY - active.y) > 1)
      active.moved = true;
    active.x = event.clientX;
    active.y = event.clientY;
    if (active.nodeId) {
      const point = positionsRef.current.get(active.nodeId);
      if (point) {
        point.x += dx;
        point.y += dy;
        point.vx = 0;
        point.vy = 0;
        setPositions(new Map(positionsRef.current));
      }
    } else setPan((previous) => ({ x: previous.x - dx, y: previous.y - dy }));
  };
  const beginDrag = (event: React.PointerEvent<SVGElement>, nodeId: string | null) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    drag.current = { nodeId, x: event.clientX, y: event.clientY, moved: false };
    svg.current?.setPointerCapture?.(event.pointerId);
  };
  const endDrag = () => {
    suppressClick.current = drag.current?.moved ?? false;
    drag.current = null;
  };
  return (
    <div className="rounded-lg border border-border bg-background p-2">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs text-foreground-muted">
        <span className="mr-auto">
          Drag nodes or background to move · select a node for details
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Zoom out graph"
          onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}
        >
          −
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Zoom in graph"
          onClick={() => setZoom((value) => Math.min(4, value * 1.25))}
        >
          +
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          Reset view
        </Button>
      </div>
      <svg
        ref={svg}
        aria-label="Inspected evidence graph"
        role="group"
        viewBox={`${400 - 400 / zoom + pan.x} ${240 - 240 / zoom + pan.y} ${800 / zoom} ${480 / zoom}`}
        className="min-h-72 w-full touch-none text-foreground-muted"
        onPointerDown={(event) => beginDrag(event, null)}
        onPointerMove={movePointer}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <title>Evidence graph. Select a node to see details; drag to move.</title>
        {inspection.relationships.map((edge) => {
          const from = positions.get(edge.sourceId),
            to = positions.get(edge.targetId);
          return from && to ? (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className="stroke-current opacity-30"
              strokeWidth="1"
            />
          ) : null;
        })}
        {nodes.map((node) => {
          const point = positions.get(node.id);
          if (!point) return null;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`Inspect from ${node.kind}: ${node.label}`}
              onPointerDown={(event) => beginDrag(event, node.id)}
              onClick={() => {
                if (!suppressClick.current) onSelect(node.id);
                suppressClick.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
              className="focus-visible:outline-primary cursor-grab focus-visible:outline-2"
            >
              <title>{`${node.kind}: ${node.label}${node.stale ? ' (stale)' : ''}`}</title>
              <circle
                cx={point.x}
                cy={point.y}
                r={node.id === selectedId ? 10 : node.kind === 'repository_revision' ? 9 : 6}
                stroke={node.id === selectedId ? 'currentColor' : 'none'}
                strokeWidth={node.id === selectedId ? 2 : 0}
                className={
                  node.stale ? 'fill-current text-destructive' : 'fill-current text-foreground'
                }
              />
              {(nodes.length <= 18 || node.id === selectedId) && (
                <text
                  x={point.x + 10}
                  y={point.y - 10}
                  className="pointer-events-none fill-current text-[10px]"
                >
                  {node.kind === 'repository_revision' || node.kind === 'observation'
                    ? node.kind.replace('_', ' ')
                    : node.label.length > 22
                      ? `${node.label.slice(0, 21)}…`
                      : node.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="px-2 pb-1 text-xs text-foreground-muted">
        The graph shows the current bounded inspection. Select a node, then choose Inspect graph to
        explore its neighborhood.
      </p>
    </div>
  );
}

import { createReferenceHost, createKDNAServer, handleKDNARequest, type RetainedReadSessionOptions, type RetainedReadSessionState } from '@aikdna/kdna-web-server';
import { createKDNARouter } from '@aikdna/kdna-web-server/express';
import { createNextHandlers } from '@aikdna/kdna-web-server/nextjs';
const retained: RetainedReadSessionOptions<{ trusted: boolean }> = {
  binding_id: 'binding', authorization_domain_id: 'domain', verifyContext: value => value.trusted,
  ttlMs: 30000, maxReads: 16, maxRetainedContainerBytes: 100, maxRetainedViewBytes: 100,
  maxHandleRecords: 4, maxHandleRecordBytes: 10000,
};
const h = createReferenceHost({ retainedSession: retained, observePolicy: ({ snapshot }) => ({
  decision: 'allow', scope: snapshot.ir.nodes.map(n => n.id), epoch: 'epoch', policyId: 'policy' }) });
h.read(new Uint8Array(), {}, { context: { trusted: true }, deliverResponse: result => result.channel === 'read_envelope' });
const state: RetainedReadSessionState = h.retentionState(); h.dispose();
// @ts-expect-error readonly management summary
state.active_reads = 1;
// @ts-expect-error closed management summary has no snapshot
state.snapshot;
// @ts-expect-error closed trusted config
const bad: RetainedReadSessionOptions = { ...retained, verifyContext: () => true, session_id: 'wire' };
// @ts-expect-error Next cannot confirm finish
createNextHandlers({ retainedSession: retained });
// @ts-expect-error stateless helper cannot retain
handleKDNARequest(new Request('http://localhost'), { retainedSession: retained });
const server = createKDNAServer({ retainedSession: retained });
server.handle(new Request('http://localhost'), { context: { trusted: true }, deliverResponse: () => true }); server.dispose();
const router = createKDNARouter({ retainedSession: retained, getContext: () => ({ trusted: true }) });
router.dispose(); router.retentionState();
createNextHandlers({ retainedSession: false });
void bad;

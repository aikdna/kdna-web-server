import type { CanonicalReadSnapshotData, ReadCallResult, ReadRequest, CoreStaticStates, CoreComponentFailure, ReadDiagnostic, ReadDiagnosticCode } from '@aikdna/kdna-core';
export interface RetainedReadSessionOptions<C = unknown> {
  readonly binding_id: string;
  readonly authorization_domain_id: string;
  readonly verifyContext: (context: C) => boolean | Promise<boolean>;
  readonly ttlMs?: number;
  readonly maxRetainedContainerBytes?: number;
  readonly maxRetainedViewBytes?: number;
  readonly maxReads?: number;
  readonly maxHandleRecords?: number;
  readonly maxHandleRecordBytes?: number;
}
export interface RetainedReadSessionState {
  readonly state: 'disabled' | 'unbound' | 'preparing' | 'delivering' | 'active' | 'closed';
  readonly active_reads: number;
  readonly retained_container_bytes: number;
  readonly retained_view_charge_bytes: number;
  readonly issued_handle_records: number;
  readonly issued_handle_charge_bytes: number;
  readonly consumed_request_ids: number;
}
export interface HostPolicy {
  readonly decision: 'allow' | 'deny'; readonly scope: readonly string[];
  readonly epoch: string; readonly policyId: string;
  readonly issuedAt?: number; readonly expiresAt?: number;
  readonly revoked?: boolean; readonly liftDenial?: boolean;
}
export interface HostPolicyObservation<C = unknown> {
  readonly request: ReadRequest; readonly snapshot: CanonicalReadSnapshotData;
  readonly context: C; readonly currentMs: number;
}
export interface ReferenceHostOptions<C = unknown> {
  readonly retainedSession?: false | RetainedReadSessionOptions<C>;
  readonly hostId?: string;
  readonly clock?: () => number;
  readonly observePolicy?: (observation: HostPolicyObservation<C>) => HostPolicy | null | Promise<HostPolicy | null>;
  readonly maxInputBytes?: number; readonly maxResponseBytes?: number;
  readonly admissionResponseBytes?: number; readonly policyTimeoutMs?: number;
  readonly maxReads?: number; readonly maxConcurrentReads?: number;
}
export interface SessionManagement { dispose(): void; retentionState(): RetainedReadSessionState; }
export type ReadResultSink = (result: ReadCallResult) => boolean | Promise<boolean>;
export interface HostReadSettings<C = unknown> {
  readonly context?: C | PromiseLike<C>;
  /** Default-disabled compatibility sink. */
  readonly deliver?: ReadResultSink;
  /** Required for enabled retention; only confirm the real trusted delivery boundary. */
  readonly deliverResponse?: ReadResultSink;
  /** Trusted transport lifecycle, never an identity or authorization source. */
  readonly signal?: AbortSignal;
}
/** valid preserves Host admission, not a substitute for public Core states. */
export type HostValidationResult = Readonly<
  { valid: true; action_authorization: 'not_evaluated' } |
  { valid: false; code: ReadDiagnosticCode; action_authorization: 'not_evaluated';
    states: CoreStaticStates; diagnostics: readonly ReadDiagnostic[]; component_failure: CoreComponentFailure | null }
>;
export interface ReferenceHost<C = unknown> extends SessionManagement {
  readonly limits: Readonly<{ maxInputBytes: number; maxResponseBytes: number; admissionResponseBytes: number }>;
  validate(input: Uint8Array): Promise<HostValidationResult>;
  read(input: Uint8Array, candidate: unknown, settings?: HostReadSettings<C>): Promise<ReadCallResult>;
}
export interface KDNAServerOptions<C = unknown> extends ReferenceHostOptions<C> {
  readonly basePath?: string; readonly maxRequestBytes?: number;
  readonly maxRequestJsonBytes?: number; readonly requestTimeoutMs?: number;
}
export interface ServerHandleSettings<C = unknown> {
  readonly operation?: string; readonly context?: C | PromiseLike<C>;
  readonly deliverResponse?: (response: Response) => boolean | Promise<boolean>;
}
export interface KDNAServer<C = unknown> extends SessionManagement {
  handle(request: Request, settings?: ServerHandleSettings<C>): Promise<Response>;
}
export declare class KDNAWebServerError extends Error { readonly code: string; readonly status: number; constructor(code: string, status?: number); }
export declare function createReferenceHost<C = unknown>(options?: ReferenceHostOptions<C>): ReferenceHost<C>;
export declare function createKDNAServer<C = unknown>(options?: KDNAServerOptions<C>): KDNAServer<C>;
export declare function readResultResponse(result: ReadCallResult): Response;
export declare function handleKDNARequest(request: Request, options?: Omit<KDNAServerOptions, 'retainedSession'> & { readonly retainedSession?: false }): Promise<Response>;

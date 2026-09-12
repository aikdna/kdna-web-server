import type { KDNAServerOptions, SessionManagement } from '../../index.js';
export interface NodeRequestLike extends AsyncIterable<Uint8Array> {
  method: string; url?: string; headers: Record<string, string | readonly string[] | undefined>;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface NodeResponseLike {
  destroyed: boolean; writableEnded: boolean; writableFinished: boolean; headersSent: boolean; statusCode: number;
  setHeader(name: string, value: string): unknown; end(bytes: Uint8Array): unknown; destroy(): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export interface ExpressHostOptions<C = unknown> extends KDNAServerOptions<C> {
  readonly getContext?: (request: NodeRequestLike) => C | PromiseLike<C>;
  readonly deliveryTimeoutMs?: number;
}
export interface KDNARouter extends SessionManagement {
  (request: NodeRequestLike, response: NodeResponseLike, next?: () => void): Promise<void>;
}
export declare function createKDNARouter<C = unknown>(options?: ExpressHostOptions<C>): KDNARouter;

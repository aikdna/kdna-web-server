import type { KDNAServerOptions } from '../../index.js';
export type NextHostOptions<C = unknown> = Omit<KDNAServerOptions<C>, 'retainedSession'> & {
  readonly retainedSession?: false;
  readonly getContext?: (request: Request) => C | PromiseLike<C>;
};
export interface NextRouteContext { readonly params?: { readonly route?: string | readonly string[] } | Promise<{ readonly route?: string | readonly string[] }>; }
export declare function createNextHandlers<C = unknown>(options?: NextHostOptions<C>): {
  GET(request: Request, context?: NextRouteContext): Promise<Response>;
  POST(request: Request, context?: NextRouteContext): Promise<Response>;
};

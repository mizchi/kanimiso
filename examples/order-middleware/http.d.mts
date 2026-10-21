import type { AppHost } from './index.js';
/** HTTP parsing stays in JS; the generated host performs domain processing. */
export declare function createMiddleware(api: Pick<AppHost, 'process'>): (request: Request) => Promise<Response>;
export declare const MAX_BODY_BYTES: 65536;

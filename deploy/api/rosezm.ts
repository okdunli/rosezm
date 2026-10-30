/**
 * Vercel function entry: the edge adapter, behind the entry shape the Node
 * runtime actually accepts.
 *
 * vercel.json rewrites every unmatched path here and ships dist/ with the
 * bundle (the adapter imports dist/server.js at runtime, so the function
 * cannot start without it). The handler is createEdgeHandler's returned
 * (request) => Response.
 *
 * The default export MUST be a function: the Node runtime (nodejs24.x)
 * rejects the `{ fetch }` object the Cloudflare Workers convention uses at
 * boot - every deploy of the previous template answered 500
 * FUNCTION_INVOCATION_FAILED before the first request ran (BUG.md BUG-009).
 * One function serves both calling conventions:
 *
 *   - a web-standard Request in, Response out (edge runtimes and tests);
 *   - the classic (IncomingMessage, ServerResponse) pair, which is what the
 *     Node runtime hands a function: the pair is bridged into a Request, the
 *     edge handler answers, and the Response is written back onto res.
 *
 * The dist path goes through fileURLToPath, NOT URL.pathname: on Windows a
 * pathname carries the drive as `/C:/...` and the leading slash makes the
 * dynamic import resolve against the drive root instead of this directory.
 */
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createEdgeHandler } from '../src/cli/edge.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const handle = await createEdgeHandler(dist);

export default async function rosezm(a: unknown, b?: unknown): Promise<Response | undefined> {
  if (a instanceof Request) return handle(a);
  const req = a as IncomingMessage;
  const res = b as ServerResponse;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    init.body = Buffer.concat(chunks);
  }
  const out = await handle(new Request(url.href, init));
  res.statusCode = out.status;
  // The bytes are re-sent here, so the hop's own framing headers must not
  // ride along - Node sizes the body itself. set-cookie is a list header and
  // Headers.set would fold two cookies into one; write it verbatim.
  out.headers.forEach((v, k) => {
    if (k !== 'content-encoding' && k !== 'content-length' && k !== 'transfer-encoding') res.setHeader(k, v);
  });
  const setCookie = (out.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (setCookie?.length) res.setHeader('set-cookie', setCookie);
  res.end(Buffer.from(await out.arrayBuffer()));
  return undefined;
}

// The conditional-request validator a dynamic response answers with.
//
// A server-side cache key can name a representation perfectly and still hand
// the client the wrong answer, because the client does not compare keys - it
// compares validators. The prod server used to derive a non-HTML entry's
// validator from `raw.length` plus the cookie (BUG.md AM): an anonymous
// reader's cookie is the empty string, so the validator only moved when the
// byte count moved. Two equal-length representations with different bytes - a
// same-length typo fix, a re-rendered feed of the same size - therefore shared
// one validator, and every conditional request against the newer entry answered
// 304 with the older bytes: a false 304 that survives until the length changes.
//
// The rule that closes it is content-derived and cheap: hash what is about to
// go on the wire. sha1 is not a collision-resistant signature any more, but a
// validator only needs the property that a byte change flips it, and RFC 9110
// lets a weak validator (`W/"..."`) be answered with 200 whenever the client's
// copy is not byte-equivalent. sha1 over a render that already cost a route
// lookup and a serialization is noise on the budget.
//
// Ownership still belongs to the origin server: an app that publishes its own
// `ETag` keeps it. The framework only synthesizes one where the response has
// none, so an application-side validator (a database version stamp, a content
// hash of the pre-serialized row) is never silently replaced underneath a
// client that cached it.
import { createHash } from 'node:crypto';

/** A weak, content-derived validator for the exact bytes going on the wire. */
export function contentEtag(raw: Buffer): string {
  // The `-` prefix marks a CONTENT-derived tag (the handler's own bytes),
  // next to the file lane's `W/"size-mtime"` - the two shapes say on the wire
  // which exit answered. 's convention; the refactor that unified the
  // hash dropped the marker and the e2e suite caught it.
  return 'W/"-' + createHash('sha1').update(raw).digest('base64url').slice(0, 24) + '"';
}

/** The validator this response carries: the app's own if it published one,
 *  otherwise the hash of its body. Both the exit that answers the request and
 *  the cache entry that replays it must agree, or a hot replay would mint a
 *  validator the cold render never showed. */
export function responseEtag(response: { headers: Headers }, raw: Buffer): string {
  return response.headers.get('etag') ?? contentEtag(raw);
}

/** RFC 9110 §13.1.2: `If-None-Match` is a list, `*` matches any current
 *  representation, and the comparison is weak - the `W/` prefix is not part of
 *  the identity, so a client that echoed a strong tag still revalidates. */
export function ifNoneMatch(header: string | string[] | undefined | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.startsWith('W/') ? etag.slice(2) : etag;
  for (const part of (Array.isArray(header) ? header.join(',') : header).split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (token === '*') return true;
    if ((token.startsWith('W/') ? token.slice(2) : token) === bare) return true;
  }
  return false;
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification (§10).
 *
 * HMAC-SHA256 over the **raw** request body, compared in constant time. Raw
 * matters: re-serialising parsed JSON changes key order and whitespace, so a
 * signature computed over the original bytes would never match a signature
 * computed over `JSON.stringify(JSON.parse(body))`.
 */

const PREFIX = 'sha256=';

export function sign(rawBody: string, secret: string): string {
  return `${PREFIX}${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Constant-time comparison.
 *
 * A `===` here leaks the length of the matching prefix through timing, which is
 * enough to forge a signature one byte at a time. The length check before
 * `timingSafeEqual` is safe: digests are fixed-length, so a length mismatch
 * reveals only that the input was malformed.
 */
export function verify(rawBody: string, secret: string, provided: string | null): boolean {
  if (!provided) return false;

  const expected = sign(rawBody, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

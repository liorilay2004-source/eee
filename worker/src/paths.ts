/**
 * Removes every trailing "/" in one pass from the end.
 *
 * The obvious `s.replace(/\/+$/, "")` is quadratic on a long run of slashes that does not end the string: the engine
 * retries the run from every starting slash before the `$` fails. A request path of 16,000 slashes plus one letter took
 * about 216 ms that way, far over the Workers Free CPU budget of about 10 ms per request, and the path is chosen by the
 * client. This loop looks at each character at most once.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return end === s.length ? s : s.slice(0, end);
}

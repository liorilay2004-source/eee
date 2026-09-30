/**
 * Google Flights keeps the search the USER set up (airports, dates) in the page address: `tfs` is URL-safe base64 of a
 * protobuf message. This reads only that parameter, never the page, and never relies on the exact (undocumented)
 * schema: it walks every length-delimited field, keeps the strings that look like "YYYY-MM-DD" dates and three-letter
 * airport codes, and groups them per leg:
 *
 *   a leg  = a message holding a date string directly;
 *   from   = codes inside its field 13 (the order fast-flights and observed URLs use), to = codes inside field 14;
 *            when those fields are absent, the first and second place-bearing parts in order of appearance.
 *
 * Cities picked by name are stored as Freebase / Knowledge Graph ids ("/m/07qzv", "/g/11b6d..."), not codes: such a
 * side has no code, and its id is kept (fromIds / toIds) so the caller can tell a return leg and a change of cities
 * apart; the route itself then comes from the q parameter or the page title. Pure, bounded (input length, depth, field
 * count), never throws.
 */
(() => {
  "use strict";
  const EEE = /** @type {any} */ ((/** @type {any} */ (globalThis))[Symbol.for("eee.extension")] ??= {});
  if (EEE.tfs) return;

  const MAX_TFS_LEN = 4096;
  const MAX_DEPTH = 8;
  const MAX_FIELDS = 4000;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const IATA_RE = /^[A-Z]{3}$/;
  const PLACE_ID_RE = /^\/[mg]\/[0-9a-z_]{2,32}$/;
  const PRINTABLE = /^[\x20-\x7E\u00A0-\uFFFF]*$/;
  const FROM_FIELD = 13;
  const TO_FIELD = 14;

  /**
   * @param {string} s URL-safe (or standard) base64, padding optional
   * @returns {Uint8Array | null}
   */
  function base64UrlToBytes(s) {
    if (typeof s !== "string" || s.length === 0 || s.length > MAX_TFS_LEN) return null;
    if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) return null;
    let b64 = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    if (b64.length % 4 === 1) return null;
    while (b64.length % 4 !== 0) b64 += "=";
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  /**
   * @typedef {{ no: number, wt: number, value?: number, str?: string | null, children?: Field[] | null }} Field
   */

  /**
   * @param {Uint8Array} bytes
   * @param {number} pos
   * @param {number} end
   * @returns {[number, number] | null} [value, next position]
   */
  function readVarint(bytes, pos, end) {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= end) return null;
      const b = /** @type {number} */ (bytes[pos++]);
      value += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return [value, pos];
      scale *= 128;
    }
    return null;
  }

  const utf8 = new TextDecoder("utf-8", { fatal: true });

  /** @param {Uint8Array} payload */
  function asString(payload) {
    if (payload.length === 0 || payload.length > 256) return null;
    try {
      const s = utf8.decode(payload);
      return PRINTABLE.test(s) ? s : null;
    } catch {
      return null;
    }
  }

  /**
   * Fields of a message spanning bytes[start, end), or null when those bytes are not a well-formed message.
   * @param {Uint8Array} bytes
   * @param {number} start
   * @param {number} end
   * @param {number} depth
   * @param {{ left: number }} budget
   * @returns {Field[] | null}
   */
  function parseMessage(bytes, start, end, depth, budget) {
    /** @type {Field[]} */
    const fields = [];
    let pos = start;
    while (pos < end) {
      if (--budget.left < 0) return null;
      const tag = readVarint(bytes, pos, end);
      if (!tag) return null;
      pos = tag[1];
      const no = Math.floor(tag[0] / 8);
      const wt = tag[0] % 8;
      if (no < 1) return null;
      if (wt === 0) {
        const v = readVarint(bytes, pos, end);
        if (!v) return null;
        fields.push({ no, wt, value: v[0] });
        pos = v[1];
      } else if (wt === 1 || wt === 5) {
        const size = wt === 1 ? 8 : 4;
        if (pos + size > end) return null;
        fields.push({ no, wt });
        pos += size;
      } else if (wt === 2) {
        const len = readVarint(bytes, pos, end);
        if (!len) return null;
        pos = len[1];
        if (len[0] > end - pos) return null;
        const payload = bytes.subarray(pos, pos + len[0]);
        const str = asString(payload);
        const children = depth < MAX_DEPTH && payload.length > 0 ? parseMessage(payload, 0, payload.length, depth + 1, budget) : null;
        fields.push({ no, wt, str, children });
        pos += len[0];
      } else return null; // groups (3, 4) and the undefined 6, 7
    }
    return fields;
  }

  /**
   * Airport codes and city ids directly in these fields or one level inside them (the {1: kind, 2: "TLV"} message).
   * @param {readonly Field[]} fields
   * @returns {{ codes: string[], ids: string[] }}
   */
  function placesIn(fields) {
    /** @type {string[]} */
    const codes = [];
    /** @type {string[]} */
    const ids = [];
    /** @param {string | null | undefined} s */
    const take = (s) => {
      if (!s) return false;
      if (IATA_RE.test(s)) codes.push(s);
      else if (PLACE_ID_RE.test(s)) ids.push(s);
      else return false;
      return true;
    };
    for (const f of fields) {
      if (!take(f.str) && f.children) for (const g of f.children) take(g.str);
    }
    return { codes, ids };
  }

  /** @param {{ codes: string[], ids: string[] }} p */
  const hasPlace = (p) => p.codes.length > 0 || p.ids.length > 0;

  /**
   * @typedef {{ date: string, from: string[], to: string[], fromIds: string[], toIds: string[] }} Leg
   */

  /**
   * @param {readonly Field[]} message
   * @returns {Leg | null}
   */
  function legOf(message) {
    const dateField = message.find((f) => f.wt === 2 && typeof f.str === "string" && DATE_RE.test(f.str));
    if (!dateField) return null;
    let from = placesIn(message.filter((f) => f.no === FROM_FIELD && f.wt === 2));
    let to = placesIn(message.filter((f) => f.no === TO_FIELD && f.wt === 2));
    if (!hasPlace(from) && !hasPlace(to)) {
      // Unknown layout: the first and the second part that carries a code or a city id, in order.
      const parts = message.filter((f) => f !== dateField && f.wt === 2 && hasPlace(placesIn([f])));
      const none = { codes: [], ids: [] };
      from = parts[0] ? placesIn([parts[0]]) : none;
      to = parts[1] ? placesIn([parts[1]]) : none;
    }
    return { date: /** @type {string} */ (dateField.str), from: from.codes, to: to.codes, fromIds: from.ids, toIds: to.ids };
  }

  /**
   * Legs of a `tfs` value, in order. [] for anything unreadable.
   * @param {unknown} tfs
   * @returns {Leg[]}
   */
  function decodeLegs(tfs) {
    if (typeof tfs !== "string") return [];
    const bytes = base64UrlToBytes(tfs.trim());
    if (!bytes) return [];
    const root = parseMessage(bytes, 0, bytes.length, 0, { left: MAX_FIELDS });
    if (!root) return [];
    /** @type {Leg[]} */
    const legs = [];
    /** @param {readonly Field[]} message */
    const visit = (message) => {
      const leg = legOf(message);
      if (leg) {
        legs.push(leg); // a leg's own parts (segments of a chosen flight) are not legs of the trip
        return;
      }
      for (const f of message) if (f.children) visit(f.children);
    };
    visit(root);
    return legs;
  }

  EEE.tfs = Object.freeze({ MAX_TFS_LEN, base64UrlToBytes, parseMessage, decodeLegs });
})();

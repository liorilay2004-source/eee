/**
 * The price-alert channel: the Telegram Bot API, which is free (no plan, no card, no per-message price).
 *
 * Fail closed: without all three settings (TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET secrets, the TELEGRAM_BOT_USERNAME
 * var) the channel does not exist: no watch can be created, the webhook answers 404 and the scheduled job sends nothing.
 * Sending is one request per message, with a timeout and never a retry. The bot token sits in the request URL, so neither
 * the URL nor an upstream body is ever logged or stored.
 *
 * Why not the others: WhatsApp Business Platform bills per conversation/message (and needs a Meta business account with a
 * payment method), so it is not implemented. Email is possible later on a free tier (Cloudflare Email Workers, or a free
 * provider plan) behind a hard daily cap well below the allowance; see docs/CLOUDFLARE_SETUP.md.
 */

export const TELEGRAM_API = "https://api.telegram.org";
/** A message send must not hold the scheduled run: a slow API costs one alert, never the run. */
export const TELEGRAM_TIMEOUT_MS = 8_000;
/** Telegram's own limit for a text message. */
export const TELEGRAM_MAX_TEXT = 4096;
/** `start` parameter of a t.me deep link: 1-64 characters of A-Z, a-z, 0-9, _ and -. */
const START_PARAM = /^[A-Za-z0-9_-]{1,64}$/;
/** Bot usernames: 5-32 characters, letters, digits and underscores, ending in "bot" (any case). */
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
  botUsername: string;
}

const nonBlank = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** The channel's settings, or null when any is missing or malformed (then the channel is off). */
export function telegramConfig(env: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_BOT_USERNAME?: string }): TelegramConfig | null {
  const botToken = nonBlank(env.TELEGRAM_BOT_TOKEN);
  const webhookSecret = nonBlank(env.TELEGRAM_WEBHOOK_SECRET);
  const botUsername = nonBlank(env.TELEGRAM_BOT_USERNAME)?.replace(/^@/, "") ?? null;
  if (!botToken || !webhookSecret || !botUsername) return null;
  // Telegram's secret_token allows 1-256 characters of A-Z, a-z, 0-9, _ and -: anything else could never match a header.
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) return null;
  if (!BOT_USERNAME.test(botUsername) || !/bot$/i.test(botUsername)) return null;
  // A bot token is "<digits>:<35 characters>": a value with a slash or a space would change the request path.
  if (!/^\d{1,20}:[A-Za-z0-9_-]{20,64}$/.test(botToken)) return null;
  return { botToken, webhookSecret, botUsername };
}

/** https://t.me/<bot>?start=<param>: opening it and pressing Start sends "/start <param>" to the bot. */
export function botStartLink(botUsername: string, param: string): string {
  if (!START_PARAM.test(param)) throw new RangeError("botStartLink: invalid start parameter");
  return `https://t.me/${botUsername}?start=${param}`;
}

/**
 * Constant-time comparison of the webhook's secret header with the configured secret (both hashed first, so neither the
 * length nor a prefix leaks through timing).
 */
export async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (given === null) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

export type SendOutcome = "sent" | "blocked" | "failed";

/**
 * One sendMessage call, plain text (no parse mode: nothing in the text can turn into markup), link previews off. "blocked"
 * means the user blocked the bot or the chat is gone (HTTP 403, or 400 "chat not found"): the caller then forgets the chat.
 * Never throws and never retries.
 */
export async function sendTelegramMessage(fetchFn: typeof fetch, botToken: string, chatId: string, text: string): Promise<SendOutcome> {
  try {
    const res = await fetchFn(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, TELEGRAM_MAX_TEXT), link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (res.ok) return "sent";
    if (res.status === 403) return "blocked";
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { description?: unknown } | null;
      if (typeof body?.description === "string" && /chat not found|user is deactivated/i.test(body.description)) return "blocked";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

export interface IncomingMessage {
  /** Decimal text of the chat id (ids can exceed 32 bits). */
  chatId: string;
  text: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The text message of a private chat in an Update, or null for anything else (groups, channels, edits, stickers...). */
export function parseUpdate(update: unknown): IncomingMessage | null {
  if (!isRecord(update) || !isRecord(update.message)) return null;
  const msg = update.message;
  if (!isRecord(msg.chat) || msg.chat.type !== "private") return null;
  const id = msg.chat.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (typeof msg.text !== "string") return null;
  return { chatId: String(id), text: msg.text.slice(0, 512) };
}

/**
 * The reply to a webhook update, given as the webhook's own response body (a Bot API feature): no extra request, no
 * bot token needed to answer.
 */
export function webhookReply(chatId: string, text: string): Record<string, unknown> {
  return { method: "sendMessage", chat_id: chatId, text: text.slice(0, TELEGRAM_MAX_TEXT), link_preview_options: { is_disabled: true } };
}

export interface Command {
  name: string;
  arg: string;
}

/** "/start abc" -> { name: "start", arg: "abc" }; "/stop@MyBot" -> { name: "stop", arg: "" }; plain text -> null. */
export function parseCommand(text: string): Command | null {
  const m = /^\/([A-Za-z0-9_]{1,40})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: (m[1] as string).toLowerCase(), arg: (m[2] ?? "").trim() };
}

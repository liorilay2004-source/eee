/**
 * The service worker (public/sw.js) must never answer, and so never cache, an API request: prices must be live, and a
 * request carrying the private-use lock's key must go straight to the network. Runs the real sw.js against a stand-in `self`.
 */
import { describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

const PAGE = "https://eee-web-bly.pages.dev";
const API = "https://eee-api.liorilay2004.workers.dev";

type FetchListener = (event: { request: { method: string; url: string; mode: string; headers: Headers }; respondWith: (r: unknown) => void }) => void;

/** What the worker answered with (awaited by the tests, so a failing handler cannot hide as an unhandled rejection). */
const answers: unknown[] = [];

function loadServiceWorker(): FetchListener {
  const listeners = new Map<string, FetchListener>();
  const self = {
    location: { origin: PAGE },
    addEventListener: (type: string, listener: FetchListener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined), addAll: vi.fn(async () => undefined) };
  const caches = { open: vi.fn(async () => cache), match: vi.fn(async () => undefined), keys: vi.fn(async () => []), delete: vi.fn(async () => true) };
  const fetchFn = vi.fn(async () => new Response("<!doctype html>", { status: 200 }));
  new Function("self", "caches", "fetch", swSource)(self, caches, fetchFn);
  const onFetch = listeners.get("fetch");
  if (!onFetch) throw new Error("sw.js registers no fetch listener");
  return onFetch;
}

function handled(onFetch: FetchListener, url: string, method = "GET", mode = "cors", headers: Record<string, string> = {}): boolean {
  const respondWith = vi.fn((answer: unknown) => void answers.push(answer));
  onFetch({ request: { method, url, mode, headers: new Headers(headers) }, respondWith });
  return respondWith.mock.calls.length > 0;
}

describe("the service worker leaves the API alone", () => {
  it("never answers an API request, same-origin or the Worker's, with or without the key, any method", () => {
    const onFetch = loadServiceWorker();
    const auth = { Authorization: "Bearer Zq9vN3tXk2pL8sR4wY7eB1cD5fG0hJ6m" };
    for (const url of [`${API}/api/deals`, `${API}/api/auth/check`, `${PAGE}/api/deals`, `${PAGE}/api/auth/check`, `${PAGE}/api/search`]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        expect(handled(onFetch, url, method, "cors", auth), `${method} ${url}`).toBe(false);
        expect(handled(onFetch, url, method), `${method} ${url}`).toBe(false);
      }
    }
  });

  it("still serves the app shell (so the test would notice a listener that ignores everything)", async () => {
    const onFetch = loadServiceWorker();
    expect(handled(onFetch, `${PAGE}/`, "GET", "navigate")).toBe(true);
    expect(handled(onFetch, `${PAGE}/assets/index-abc123.js`)).toBe(true);
    for (const answer of await Promise.all(answers.splice(0))) expect(answer).toBeInstanceOf(Response);
  });

  it("never reads the key or the Authorization header", () => {
    expect(swSource).not.toMatch(/authorization|accessKey|localStorage/i);
  });
});

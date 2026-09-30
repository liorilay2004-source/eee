import type { ReactNode } from "react";
import { CircleAlert, Hourglass, RefreshCw, WifiOff } from "lucide-react";
import type { FailureNotice } from "../lib/failure";
import { useWaiting } from "../lib/hooks";

/**
 * A failed request, said plainly. The retry button waits for the server's Retry-After when there was one.
 * `headingId` lets the page move focus to the message.
 */
export function FailureBox({ notice, lines = [], retryAt, onRetry, headingId, compact, children }: {
  notice: FailureNotice; lines?: string[]; retryAt: number | null; onRetry?: () => void; headingId?: string; compact?: boolean; children?: ReactNode;
}) {
  const waiting = useWaiting(retryAt);
  const icon = /חיבור/.test(notice.title) ? <WifiOff size={22} aria-hidden="true" />
    : notice.retryAfterSec !== null || /מדי בקשות/.test(notice.title) ? <Hourglass size={22} aria-hidden="true" />
      : <CircleAlert size={22} aria-hidden="true" />;
  return <div className={`notice-box ${compact ? "is-compact" : ""}`}>
    <div className="notice-icon">{icon}</div>
    <div className="notice-copy">
      <h2 id={headingId} tabIndex={headingId ? -1 : undefined} className="notice-title">{notice.title}</h2>
      {notice.body && <p>{notice.body}</p>}
      {lines.length > 0 && <ul className="notice-lines">{lines.map((l) => <li key={l}>{l}</li>)}</ul>}
      {(notice.canRetry && onRetry) || children ? <div className="state-actions">
        {notice.canRetry && onRetry && <button type="button" className="btn btn-primary" onClick={onRetry} disabled={waiting}>
          <RefreshCw size={18} aria-hidden="true" />{waiting ? "אפשר לנסות שוב בקרוב" : "נסו שוב"}
        </button>}
        {children}
      </div> : null}
    </div>
  </div>;
}

export function LiveRegion({ text }: { text: string }) {
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{text}</div>;
}

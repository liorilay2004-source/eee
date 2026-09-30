import { useSyncExternalStore, type ReactNode } from "react";
import { LogOut } from "lucide-react";
import { PRODUCT_NAME } from "../config";
import { logout } from "../lib/access";
import { hasAccessKey, subscribeAccessKey } from "../lib/access-key";

export function PlaneMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="10" className="brand-mark-bg" />
    <path d="M24.5 7.5 8 14.2l5.6 2.2 2.2 5.6L24.5 7.5Z" className="brand-mark-plane" />
    <path d="m13.6 16.4 5.2-5.2" className="brand-mark-line" />
  </svg>;
}

export type NavPath = "/" | "/explore" | "/deals" | "/alerts";

const NAV: readonly [NavPath, string][] = [
  ["/", "חיפוש"],
  ["/explore", "לא יודע לאן?"],
  ["/deals", "מבצעים"],
  ["/alerts", "התראות"],
];

/** The app's sections. Plain links (full page loads): each page reads its own state from the URL or the device. */
export function SiteNav({ current }: { current: NavPath }) {
  return <nav className="site-nav" aria-label="אזורי האתר">
    <ul>
      {NAV.map(([href, label]) => <li key={href}>
        <a href={href} aria-current={href === current ? "page" : undefined}>{label}</a>
      </li>)}
    </ul>
  </nav>;
}

export function SiteHeader({ children, current }: { children?: ReactNode; current?: NavPath }) {
  return <>
    <header className="site-header">
      <a className="skip-link" href="#main">דילוג לתוכן</a>
      <a className="brand" href="/"><PlaneMark /><span className="brand-name">{PRODUCT_NAME}</span></a>
      {children}
    </header>
    {current && <SiteNav current={current} />}
  </>;
}

/** The private-use lock's "log out": shown only while an access key is stored on this device (lib/access-key.ts). */
export function AccessLogout() {
  const stored = useSyncExternalStore(subscribeAccessKey, hasAccessKey, hasAccessKey);
  if (!stored) return null;
  return <button type="button" className="link-button footer-logout" onClick={logout}>
    <LogOut size={16} aria-hidden="true" />יציאה (מחיקת המפתח מהמכשיר)
  </button>;
}

export function SiteFooter({ children }: { children?: ReactNode }) {
  return <footer className="site-footer">
    <nav aria-label="מידע ומדיניות" className="footer-links">
      <a href="/privacy">פרטיות</a>
      <a href="/terms">תנאי שימוש</a>
      <a href="/affiliate">גילוי נאות</a>
      <a href="/accessibility">נגישות</a>
    </nav>
    {children}
    <AccessLogout />
    <p className="footer-note">{PRODUCT_NAME} מחפש ומשווה מחירים ומפנה לאתרי הזמנה. אנחנו לא מוכרים כרטיסים. גרסת תצוגה מקדימה.</p>
  </footer>;
}

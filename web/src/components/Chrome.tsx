import type { ReactNode } from "react";
import { PRODUCT_NAME } from "../config";

export function PlaneMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="10" className="brand-mark-bg" />
    <path d="M24.5 7.5 8 14.2l5.6 2.2 2.2 5.6L24.5 7.5Z" className="brand-mark-plane" />
    <path d="m13.6 16.4 5.2-5.2" className="brand-mark-line" />
  </svg>;
}

export function SiteHeader({ children }: { children?: ReactNode }) {
  return <header className="site-header">
    <a className="skip-link" href="#main">דילוג לתוכן</a>
    <a className="brand" href="/"><PlaneMark /><span className="brand-name">{PRODUCT_NAME}</span></a>
    {children}
  </header>;
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
    <p className="footer-note">{PRODUCT_NAME} מחפש ומשווה מחירים ומפנה לאתרי הזמנה. אנחנו לא מוכרים כרטיסים. גרסת תצוגה מקדימה.</p>
  </footer>;
}

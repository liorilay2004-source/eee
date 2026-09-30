import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface Props {
  id: string;
  title: string;
  /** The chip that opened the sheet: the popover anchors to it and focus returns to it on close. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DESKTOP = "(min-width: 720px)";

/**
 * The panel's full height at `width` if nothing had to scroll: its chrome (header, footer, padding) plus the
 * body's whole content. Measured synchronously in a layout effect, before paint.
 */
function naturalHeight(node: HTMLDivElement | null, width: number): number {
  if (!node) return 640;
  const body = node.querySelector<HTMLElement>(".sheet-body");
  const previous = node.style.width;
  node.style.width = `${width}px`;
  const chrome = node.offsetHeight - (body?.clientHeight ?? 0);
  const content = body?.scrollHeight ?? 0;
  node.style.width = previous;
  return Math.ceil(chrome + content);
}

/**
 * One question at a time: a bottom sheet on phones, a popover under its chip on wider screens.
 * A modal dialog: focus is trapped inside, Escape and the backdrop close it, and focus returns to the chip.
 */
export function Sheet({ id, title, anchor, onClose, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number; width: number; maxHeight: number } | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useLayoutEffect(() => {
    const place = () => {
      const chip = anchor.current;
      if (!chip || !window.matchMedia(DESKTOP).matches) { setPosition(null); return; }
      const rect = chip.getBoundingClientRect();
      const vh = window.innerHeight;
      const width = Math.min(480, window.innerWidth - 32);
      const right = Math.min(Math.max(window.innerWidth - rect.right, 16), window.innerWidth - width - 16);
      const needed = naturalHeight(panel.current, width);
      const margin = 16;
      const gap = 10;
      const below = vh - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      let top: number;
      if (needed <= below) top = rect.bottom + gap; // under the chip
      else if (needed <= above) top = rect.top - gap - needed; // above the chip
      else top = Math.max(margin, Math.round((vh - Math.min(needed, vh - 2 * margin)) / 2)); // centred, scrolls inside
      setPosition({ top, right, width, maxHeight: vh - top - margin });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const returnTo = anchor.current;
    const node = panel.current;
    const preferred = node?.querySelector<HTMLElement>("[data-autofocus]");
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (preferred ?? first ?? node)?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      // Return focus to the chip that opened the sheet (after React commits the close).
      // StrictMode re-runs effects on a mounted sheet; only a real close (panel gone) moves focus.
      window.setTimeout(() => { if (!node?.isConnected) returnTo?.focus({ preventScroll: false }); }, 0);
    };
  }, [anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  return createPortal(
    <div className="sheet-layer">
      <div className="sheet-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        id={id}
        className={`sheet ${position ? "is-popover" : "is-bottom"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={position ? { top: position.top, right: position.right, width: position.width, maxHeight: position.maxHeight } : undefined}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="סגירה"><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { LoaderCircle, MapPin, Search } from "lucide-react";
import { findAirports } from "../api/client";
import type { AirportSuggestion } from "../api/contract";

interface Props {
  label: string;
  inputId: string;
  placeholder: string;
  onSelect: (code: string, label: string) => void;
  /** Describes the input, e.g. the question's error message. */
  describedBy?: string;
  autoFocus?: boolean;
}

function displayName(place: AirportSuggestion): string {
  if (place.kind === "airport") return place.airportNameHe || place.airportNameEn || place.airportCode || place.code;
  return place.nameHe || place.nameEn || place.code;
}

function placeCode(place: AirportSuggestion): string {
  return place.kind === "airport" ? (place.airportCode || place.code) : place.code;
}

/**
 * WAI-ARIA combobox (list autocomplete). The listbox is never a Tab stop; arrows move the active option,
 * Enter picks it, Escape closes the list (a second Escape closes the sheet), and focus leaving closes it.
 */
export function AirportCombobox({ label, inputId, placeholder, onSelect, describedBy, autoFocus }: Props) {
  const listId = useId();
  const statusId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState("");
  const [items, setItems] = useState<AirportSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2 || query === picked) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      findAirports(query, controller.signal)
        .then((found) => {
          setItems(found);
          setActive(-1);
          setOpen(found.length > 0);
          setStatus(found.length ? `${found.length} תוצאות. אפשר לבחור בעזרת החיצים.` : "לא מצאנו מקום בשם הזה. נסו שם אחר או קוד בן 3 אותיות.");
        })
        .catch((err: unknown) => {
          // A superseded lookup is never reported as an error, however the abort surfaced.
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
          setItems([]); setOpen(false);
          setStatus("החיפוש לא זמין כרגע. אפשר להקליד קוד שדה תעופה בן 3 אותיות, למשל ATH, ולהקיש Enter.");
        })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      // The aborted request never clears the spinner itself, and the next run may return early (short query).
      setBusy(false);
    };
  }, [text, picked]);

  const choose = (place: AirportSuggestion) => {
    const code = placeCode(place);
    const name = displayName(place);
    const shown = `${name} · ${code}`;
    setPicked(shown);
    setText(shown);
    setItems([]);
    setOpen(false);
    setActive(-1);
    setStatus(`נבחר: ${name}`);
    onSelect(code, name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const listOpen = open && items.length > 0;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      if (!listOpen) { setOpen(true); setActive(event.key === "ArrowDown" ? 0 : items.length - 1); return; }
      setActive((n) => event.key === "ArrowDown" ? (n + 1) % items.length : (n <= 0 ? items.length - 1 : n - 1));
      return;
    }
    if (event.key === "Enter") {
      if (listOpen) {
        event.preventDefault();
        choose(items[active >= 0 ? active : 0]);
        return;
      }
      const code = text.trim();
      if (/^[A-Za-z]{3}$/.test(code)) {
        event.preventDefault();
        const upper = code.toUpperCase();
        setPicked(upper); setText(upper); setStatus(`נבחר הקוד ${upper}`);
        onSelect(upper, "");
      }
      return;
    }
    if (event.key === "Escape" && listOpen) {
      // Close only the list; the sheet stays open until a second Escape.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!root.current?.contains(event.relatedTarget as Node | null)) { setOpen(false); setActive(-1); }
  };

  const listOpen = open && items.length > 0;
  return <div className="combo" ref={root} onBlur={onBlur}>
    <label className="combo-label" htmlFor={inputId}>{label}</label>
    <div className="combo-shell">
      <Search size={20} aria-hidden="true" className="combo-icon" />
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-activedescendant={listOpen && active >= 0 ? `${listId}-${active}` : undefined}
        aria-describedby={[statusId, describedBy].filter(Boolean).join(" ")}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        data-autofocus={autoFocus ? "" : undefined}
        value={text}
        placeholder={placeholder}
        onFocus={() => { if (items.length) setOpen(true); }}
        onChange={(event) => { setText(event.target.value); setPicked(""); setOpen(false); setActive(-1); if (event.target.value.trim().length < 2) { setItems([]); setStatus(""); } }}
        onKeyDown={onKeyDown}
      />
      {busy && <LoaderCircle size={18} className="spin combo-busy" aria-hidden="true" />}
    </div>
    <ul id={listId} className="combo-list" role="listbox" aria-label={`תוצאות עבור ${label}`} tabIndex={-1} hidden={!listOpen}>
      {items.map((place, index) => <li
        id={`${listId}-${index}`}
        key={`${place.code}-${place.airportCode ?? "city"}-${index}`}
        role="option"
        aria-selected={active === index}
        className={active === index ? "is-active" : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActive(index)}
        onClick={() => choose(place)}
      >
        <MapPin size={16} aria-hidden="true" className="combo-pin" />
        <span className="combo-main"><strong>{displayName(place)}</strong><small dir="ltr">{place.nameEn && place.nameEn !== displayName(place) ? `${place.nameEn} · ${place.countryCode}` : place.countryCode}</small></span>
        <span className="combo-code" dir="ltr">{placeCode(place)}</span>
      </li>)}
    </ul>
    <p id={statusId} className="combo-status" aria-live="polite">{status}</p>
  </div>;
}

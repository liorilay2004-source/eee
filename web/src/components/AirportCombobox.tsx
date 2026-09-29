import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MapPin } from "lucide-react";
import { findAirports } from "../api/client";
import type { AirportSuggestion } from "../api/contract";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  error?: string;
  inputId: string;
}

function displayName(place: AirportSuggestion): string {
  if (place.kind === "airport") return place.airportNameHe || place.airportNameEn || place.airportCode || place.code;
  return place.nameHe || place.nameEn || place.code;
}

export function AirportCombobox({ label, value, onChange, placeholder, error, inputId }: Props) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  const [selectedCode, setSelectedCode] = useState("");
  const [items, setItems] = useState<AirportSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);

  useEffect(() => {
    // Keep the display text in sync with restored URLs and explicit form resets.
    // eslint-disable-next-line react/set-state-in-effect
    if (value !== selectedCode) setText(value);
  }, [value, selectedCode]);

  useEffect(() => {
    const query = text.trim();
    if (query.length < 2 || (selectedCode && (query === selectedCode || query.endsWith(`· ${selectedCode}`)))) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      setLookupFailed(false);
      findAirports(query, controller.signal)
        .then((found) => { setItems(found); setOpen(true); setActive(-1); })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setItems([]); setLookupFailed(true); setOpen(false);
        })
        .finally(() => setBusy(false));
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [text, selectedCode]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, []);

  const choose = (place: AirportSuggestion) => {
    const code = place.kind === "airport" ? (place.airportCode || place.code) : place.code;
    setSelectedCode(code);
    setText(`${displayName(place)} · ${code}`);
    onChange(code);
    setOpen(false);
    setItems([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !items.length) {
      if (event.key === "Escape") setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((n) => (n + 1) % items.length); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((n) => (n <= 0 ? items.length - 1 : n - 1)); }
    if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(items[active]); }
    if (event.key === "Escape") setOpen(false);
  };

  return <div className="field place-field" ref={root}>
    <label className="field-label" htmlFor={inputId}>{label}</label>
    <div className={`input-shell place-shell ${error ? "has-error" : ""}`}>
      <MapPin size={18} aria-hidden="true" className="field-icon" />
      <input
        ref={input} id={inputId} role="combobox" aria-autocomplete="list" aria-expanded={open && items.length > 0}
        aria-controls={listId} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : `${inputId}-hint`}
        autoComplete="off" value={text} placeholder={placeholder}
        onFocus={() => { if (items.length) setOpen(true); }}
        onChange={(event) => { const next = event.target.value; setText(next); setSelectedCode(""); setItems([]); setOpen(false); setActive(-1); onChange(next); }}
        onKeyDown={onKeyDown}
      />
      {busy && <span className="input-spinner" aria-label="מחפשים" />}
      {open && items.length > 0 && <ul id={listId} className="suggestions" role="listbox" aria-label={`הצעות עבור ${label}`}>
        {items.map((place, index) => <li
          id={`${listId}-${index}`} key={`${place.code}-${place.airportCode ?? "city"}`} role="option"
          aria-selected={active === index} onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)} onClick={() => choose(place)}
        >
          <span className="suggestion-pin"><MapPin size={15} /></span>
          <span className="suggestion-main"><strong>{displayName(place)}</strong><small dir="ltr">{place.nameEn && place.nameEn !== displayName(place) ? place.nameEn : place.countryCode}</small></span>
          <span className="suggestion-code" dir="ltr">{place.kind === "airport" ? place.airportCode : place.code}</span>
        </li>)}
      </ul>}
    </div>
    {error && <span className="field-error" id={`${inputId}-error`}>{error}</span>}
    {!error && <span className="field-hint" id={`${inputId}-hint`}>{lookupFailed ? "אפשר להזין קוד IATA בן 3 אותיות, למשל TLV." : "עיר, שדה תעופה או קוד IATA"}</span>}
  </div>;
}

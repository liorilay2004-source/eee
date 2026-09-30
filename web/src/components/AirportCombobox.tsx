import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Check, Globe, LoaderCircle, MapPin, Search } from "lucide-react";
import { findAirports } from "../api/client";
import type { AirportSuggestion, CountryAirport, CountrySuggestion } from "../api/contract";
import { chooseOption, countryChips, countryPlaceName, mergeOptions, placeDisplayName, placeSearchCode, type ComboOption } from "../lib/suggest";

interface Props {
  label: string;
  inputId: string;
  placeholder: string;
  onSelect: (code: string, label: string) => void;
  /** Describes the input, e.g. the question's error message. */
  describedBy?: string;
  autoFocus?: boolean;
  /** Also offer countries ("יוון" -> Greece's airports). For the destination only; off by default. */
  countries?: boolean;
  /** The form's current value for this field, when it can also change outside the combobox (quick-pick buttons). */
  value?: string;
}


function optionKey(option: ComboOption, index: number): string {
  return option.type === "country"
    ? `country-${option.country.code}`
    : `${option.place.code}-${option.place.airportCode ?? "city"}-${index}`;
}

/** Row content for a country option. */
export function CountryOptionContent({ country }: { country: CountrySuggestion }) {
  const count = country.places.length;
  return <>
    <Globe size={16} aria-hidden="true" className="combo-pin" />
    <span className="combo-main"><strong>{country.nameHe}</strong><small>{count === 1 ? "מדינה · שדה תעופה אחד" : `מדינה · ${count} שדות תעופה`}{country.nameEn ? <> · <span dir="ltr">{country.nameEn}</span></> : null}</small></span>
    <span className="combo-code" dir="ltr">{country.places[0]?.code}</span>
  </>;
}

/** After a country is picked: every airport of that country as a chip, the one being searched pressed. */
export function CountryAirportChips({ country, selected, onPick }: { country: CountrySuggestion; selected: string; onPick: (place: CountryAirport) => void }) {
  if (country.places.length < 2) return null;
  return <div className="combo-country">
    <p className="q-help">שדות תעופה ב{country.nameHe}. אפשר להחליף:</p>
    <div className="choice-grid three" role="group" aria-label={`שדות תעופה ב${country.nameHe}`}>
      {country.places.map((place) => {
        const on = place.code === selected;
        return <button key={place.code} type="button" className={`choice ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => onPick(place)}>
          <span className="choice-main">{on && <Check size={16} aria-hidden="true" className="choice-check" />}{countryPlaceName(place)}</span>
          <span className="choice-sub"><span dir="ltr">{place.code}</span>{place.direct ? " · טיסות ישירות" : ""}</span>
        </button>;
      })}
    </div>
  </div>;
}

/**
 * WAI-ARIA combobox (list autocomplete). The listbox is never a Tab stop; arrows move the active option,
 * Enter picks it, Escape closes the list (a second Escape closes the sheet), and focus leaving closes it.
 */
export function AirportCombobox({ label, inputId, placeholder, onSelect, describedBy, autoFocus, countries: withCountries = false, value }: Props) {
  const listId = useId();
  const statusId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState("");
  const [items, setItems] = useState<ComboOption[]>([]);
  const [country, setCountry] = useState<CountrySuggestion | null>(null);
  const [countryPick, setCountryPick] = useState("");
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
        .then((lookup) => {
          const found = mergeOptions(lookup.results, withCountries ? lookup.countries : []);
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
  }, [text, picked, withCountries]);

  const settle = (code: string, name: string, statusText: string) => {
    const shown = `${name} · ${code}`;
    setPicked(shown);
    setText(shown);
    setItems([]);
    setOpen(false);
    setActive(-1);
    setStatus(statusText);
    onSelect(code, name);
  };

  const pickCountryAirport = (from: CountrySuggestion, place: CountryAirport) => {
    const name = countryPlaceName(place);
    setCountryPick(place.code);
    settle(place.code, name, `נבחר: ${name}, ${from.nameHe}`);
  };

  const choose = (option: ComboOption) => {
    const choice = chooseOption(option);
    if (!choice) return;
    setCountry(choice.country);
    setCountryPick(choice.countryPick);
    settle(choice.code, choice.name, choice.status);
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
  const chips = countryChips(country, countryPick, value);
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
        onChange={(event) => { setText(event.target.value); setPicked(""); setCountry(null); setCountryPick(""); setOpen(false); setActive(-1); if (event.target.value.trim().length < 2) { setItems([]); setStatus(""); } }}
        onKeyDown={onKeyDown}
      />
      {busy && <LoaderCircle size={18} className="spin combo-busy" aria-hidden="true" />}
    </div>
    {chips && <CountryAirportChips country={chips.country} selected={chips.selected} onPick={(place) => pickCountryAirport(chips.country, place)} />}
    <ul id={listId} className="combo-list" role="listbox" aria-label={`תוצאות עבור ${label}`} tabIndex={-1} hidden={!listOpen}>
      {items.map((option, index) => <li
        id={`${listId}-${index}`}
        key={optionKey(option, index)}
        role="option"
        aria-selected={active === index}
        className={active === index ? "is-active" : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActive(index)}
        onClick={() => choose(option)}
      >
        {option.type === "country" ? <CountryOptionContent country={option.country} /> : <PlaceOptionContent place={option.place} />}
      </li>)}
    </ul>
    <p id={statusId} className="combo-status" aria-live="polite">{status}</p>
  </div>;
}

function PlaceOptionContent({ place }: { place: AirportSuggestion }) {
  return <>
    <MapPin size={16} aria-hidden="true" className="combo-pin" />
    <span className="combo-main"><strong>{placeDisplayName(place)}</strong><small dir="ltr">{place.nameEn && place.nameEn !== placeDisplayName(place) ? `${place.nameEn} · ${place.countryCode}` : place.countryCode}</small></span>
    <span className="combo-code" dir="ltr">{placeSearchCode(place)}</span>
  </>;
}

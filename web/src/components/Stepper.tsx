import { Minus, Plus } from "lucide-react";

interface Props {
  label: string;
  detail?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Text read with the value, e.g. "לילות". */
  unit?: string;
}

/** Disabled ends use aria-disabled so keyboard focus is not lost when a limit is reached. */
export function Stepper({ label, detail, value, min, max, onChange, unit }: Props) {
  return <div className="stepper" role="group" aria-label={label}>
    <div className="stepper-copy"><span className="stepper-label">{label}</span>{detail && <small>{detail}</small>}</div>
    <div className="stepper-control">
      <button type="button" className="stepper-button" aria-label={`פחות ${label}`} aria-disabled={value <= min} onClick={() => { if (value > min) onChange(value - 1); }}><Minus size={18} aria-hidden="true" /></button>
      <output className="stepper-value" aria-live="polite"><span className="sr-only">{label}: </span>{value}{unit && <span className="sr-only"> {unit}</span>}</output>
      <button type="button" className="stepper-button" aria-label={`יותר ${label}`} aria-disabled={value >= max} onClick={() => { if (value < max) onChange(value + 1); }}><Plus size={18} aria-hidden="true" /></button>
    </div>
  </div>;
}

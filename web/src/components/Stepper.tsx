import { Minus, Plus } from "lucide-react";

interface Props {
  label: string;
  detail: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

export function Stepper({ label, detail, value, min, max, onChange }: Props) {
  return <div className="stepper-row">
    <div className="stepper-copy"><span>{label}</span><small>{detail}</small></div>
    <div className="stepper-control">
      <button type="button" className="stepper-button" aria-label={`הפחתת ${label}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}><Minus size={16} /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" className="stepper-button" aria-label={`הוספת ${label}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}><Plus size={16} /></button>
    </div>
  </div>;
}

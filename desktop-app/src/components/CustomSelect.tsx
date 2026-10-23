import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export type CustomSelectOption = string | { label: string; value: string };

type CustomSelectProps = {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  label?: string;
  ariaLabel?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
};

export function CustomSelect({ value, options, onChange, label, ariaLabel, id, className = "", disabled = false }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!selectRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const normalizedOptions = options.map((option) => typeof option === "string" ? { label: option, value: option } : option);
  const selected = normalizedOptions.find((option) => option.value === value);

  return <div className={`custom-select ${open ? "open" : ""} ${disabled ? "is-disabled" : ""} ${className}`.trim()} ref={selectRef}>
    {label && <span className="custom-select-label">{label}</span>}
    <button id={id} type="button" className="custom-select-trigger" aria-label={ariaLabel ?? label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? value}</span><ChevronDown size={15} />
    </button>
    {open && <div className="custom-select-options" role="listbox" aria-label={ariaLabel ?? label}>
      {normalizedOptions.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>{option.value === value && <Check size={14} />}
      </button>)}
    </div>}
  </div>;
}

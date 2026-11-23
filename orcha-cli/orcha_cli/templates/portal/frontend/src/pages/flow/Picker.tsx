/**
 * A dropdown in the Workflows style, in place of the browser's own menu: each option can carry a
 * hint line and a badge, the chosen one is ticked, and it works from the keyboard (arrows, Enter,
 * Escape, type to jump).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "./icons";

export interface PickOption { value: string; label: string; hint?: string; badge?: string; mono?: boolean }

export function Picker({ id, label, value, options, onChange, placeholder = "Choose…", help, icon }: {
  id: string; label: string; value: string; options: PickOption[]; onChange: (v: string) => void;
  placeholder?: string; help?: ReactNode; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useId();
  const chosen = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [active, open]);

  const pick = (o: PickOption) => { onChange(o.value); setOpen(false); };
  const key = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpen(true); return; }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (options[active]) pick(options[active]); }
    else if (e.key.length === 1) {
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div className="fl-field fl-pick" ref={box}>
      <label htmlFor={id}>{label}</label>
      <button id={id} type="button" className="fl-pick-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${uid}-list`}
        data-value={value} onClick={() => setOpen((o) => !o)} onKeyDown={key}>
        {icon ? <span className="fl-pick-icon">{icon}</span> : null}
        <span className={"fl-pick-value" + (chosen?.mono ? " fl-mono" : "") + (chosen ? "" : " fl-muted")}>{chosen?.label ?? placeholder}</span>
        {chosen?.badge ? <span className="fl-pick-badge">{chosen.badge}</span> : null}
        <ChevronDown size={14} aria-hidden="true" className="fl-pick-chev" />
      </button>
      {open ? (
        <ul id={`${uid}-list`} ref={list} className="fl-pick-list" role="listbox" aria-label={label} aria-activedescendant={`${uid}-${active}`} tabIndex={-1}>
          {options.length ? options.map((o, i) => (
            <li key={o.value || `none-${i}`} id={`${uid}-${i}`} data-i={i} role="option" aria-selected={o.value === value} data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
              <span className="fl-pick-check">{o.value === value ? <Check size={13} /> : null}</span>
              <span className="fl-pick-text">
                <span className={o.mono ? "fl-mono" : undefined}>{o.label}</span>
                {o.hint ? <small>{o.hint}</small> : null}
              </span>
              {o.badge ? <span className="fl-pick-badge">{o.badge}</span> : null}
            </li>
          )) : <li className="fl-pick-none" aria-disabled="true">Nothing to choose</li>}
        </ul>
      ) : null}
      {help ? <span className="fl-help">{help}</span> : null}
    </div>
  );
}

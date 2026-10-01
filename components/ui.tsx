"use client";
// Small building blocks shared across the app.
import clsx from "clsx";
import { ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function IconButton({
  label,
  onClick,
  children,
  className,
  active,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        active && "bg-hover text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx("flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl", width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// A popover that closes when you click outside it or press Escape.
export function Popover({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer so the click that opened it doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={clsx("absolute z-40 min-w-48 rounded-xl border border-line bg-surface p-1 shadow-xl", className)}>
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] hover:bg-hover",
        danger ? "text-danger" : "text-fg",
      )}
    >
      {icon && <span className="flex w-4 justify-center text-muted">{icon}</span>}
      <span className="flex-1">{children}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-45", checked ? "bg-accent" : "bg-line-strong")}
    >
      <span className={clsx("absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
        variant === "primary" && "bg-accent text-accent-fg hover:brightness-110",
        variant === "secondary" && "border border-line bg-surface text-fg hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-fg",
        variant === "danger" && "bg-danger text-white hover:brightness-110",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            "whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
            value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A small "more" toggle for a long explanation (closed until you open it).
export function Fold({ label, children, className, plain }: { label: string; children: ReactNode; className?: string; plain?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
        <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && <div className={plain ? "mt-2" : "mt-1 text-xs leading-relaxed text-muted"}>{children}</div>}
    </div>
  );
}

// A section you can fold away. It remembers whether you left it open (per section, in this browser).
export function FoldSection({
  id,
  title,
  icon,
  summary,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  summary?: ReactNode; // shown on the right while it's folded
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `fold:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {}
      return !o;
    });
  return (
    <section className="rounded-xl border border-line">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left hover:bg-hover">
        <ChevronRight size={14} className={clsx("shrink-0 text-muted transition-transform", open && "rotate-90")} />
        {icon && <span className="shrink-0 text-muted">{icon}</span>}
        <span className="shrink-0 text-[14px] font-semibold">{title}</span>
        {summary && !open && <span className="ml-auto min-w-0 truncate pl-3 text-xs text-muted">{summary}</span>}
      </button>
      {open && <div className="space-y-3 border-t border-line px-3.5 py-3">{children}</div>}
    </section>
  );
}

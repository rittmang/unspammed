import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTelegramBack } from './mini-app';

/** Keep the summary readable on phones; retain the full controls and data on demand. */
export function Disclosure({
  title,
  hint,
  children,
  className = '',
  desktopOpen = false,
  label,
  id,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  desktopOpen?: boolean;
  label?: string;
  id?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  const [open, setOpen] = useState(() => desktopOpen && !phone);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 650px)');
    const resize = () => {
      setPhone(media.matches);
      setOpen(desktopOpen && !media.matches);
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [desktopOpen]);
  useTelegramBack(() => {
    setOpen(false);
    ref.current?.querySelector('summary')?.focus({ preventScroll: true });
  }, open && phone);
  return (
    <details
      ref={ref}
      id={id}
      className={`disclosure ${className}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <span className="disclosure-copy">
          <strong>{title}</strong>
          {hint && <span className="disclosure-hint">{hint}</span>}
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}

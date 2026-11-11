import type { ReactNode } from 'react';

/** Building blocks of the admin page, so every tab looks the same. */

const ICONS = {
  overview: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  questions: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM9.5 8.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 14.5h.01',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  highlights: 'M15 10l5-3v10l-5-3zM3 6h12v12H3z',
  ai: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 3v4M21 5h-4M5 17v4M7 19H3',
  account: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  monitor: 'M2 4h20v13H2zM8 21h8M12 17v4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  camera: 'M23 7l-7 5 7 5zM1 5h15v14H1z',
  check: 'M20 6L9 17l-5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  play: 'M6 4l14 8-14 8z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  plus: 'M12 5v14M5 12h14',
  home: 'M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5',
  history: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3 2',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ui-page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </header>
  );
}

export type Level = 'ok' | 'warn' | 'bad' | 'off' | 'info';

export function Card({
  title,
  icon,
  level,
  actions,
  className = '',
  children,
}: {
  title?: ReactNode;
  icon?: IconName;
  /** Shown as a status label in the header. */
  level?: { level: Level; text: string };
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ui-card ${className}`}>
      {(title || level || actions) && (
        <header className="ui-card__header">
          <h2>
            {icon && <Icon name={icon} />}
            {title}
          </h2>
          <div className="ui-card__aside">
            {level && <Pill level={level.level}>{level.text}</Pill>}
            {actions}
          </div>
        </header>
      )}
      <div className="ui-card__body">{children}</div>
    </section>
  );
}

export function Pill({ level, children }: { level: Level; children: ReactNode }) {
  return (
    <span className={`ui-pill ui-pill--${level}`}>
      <span className="ui-pill__dot" />
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, level }: { label: string; value: ReactNode; hint?: ReactNode; level?: Level }) {
  return (
    <div className={`ui-stat${level ? ` ui-stat--${level}` : ''}`}>
      <span className="ui-stat__label">{label}</span>
      <span className="ui-stat__value">{value}</span>
      {hint && <span className="ui-stat__hint">{hint}</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="ui-empty">{children}</p>;
}

export function Notice({ level = 'bad', children }: { level?: Level; children: ReactNode }) {
  return <p className={`ui-notice ui-notice--${level}`}>{children}</p>;
}

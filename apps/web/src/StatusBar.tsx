import { useEffect, useState } from 'react';
import { formatClock, formatDutchDate, type HealthSummary } from '@uitkijk/shared';

/** Date, 24-hour clock and a subtle health dot. Messages appear only when something is wrong. */
export function StatusBar({ health }: { health: HealthSummary }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="status">
      {health.messages.length > 0 && <span className="status__message">{health.messages.join(' · ')}</span>}
      <span className={`status__dot status__dot--${health.level}`} title={health.level} />
      <span className="status__date">{formatDutchDate(now)}</span>
      <span className="status__clock">{formatClock(now)}</span>
    </div>
  );
}

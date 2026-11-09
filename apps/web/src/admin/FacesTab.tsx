import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { highlightTime } from '../highlights.tsx';
import { Card, Empty, Notice, PageHeader } from './ui.tsx';

interface Person {
  name: string;
  images: { file: string; time: number | null }[];
}

const imageUrl = (name: string, file: string) => `/api/admin/faces/library/${encodeURIComponent(name)}/${encodeURIComponent(file)}`;

/**
 * Frigate's face library per person. Frigate trusts every image here completely, so one photo of somebody else
 * makes it mix people up; administrators select such photos and remove them.
 */
export function FacesTab() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ available: boolean; people: Person[] }>('GET', '/api/admin/faces/library').then(
      (r) => (setAvailable(r.available), setPeople(r.people)),
      (err: Error) => (setAvailable(false), setPeople([]), setError(err.message)),
    );
  useEffect(() => void load(), []);

  const toggle = (file: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });

  const remove = async (name: string) => {
    setError(null);
    setBusy(true);
    try {
      await api('POST', `/api/admin/faces/library/${encodeURIComponent(name)}/delete`, { files: [...picked] });
      setPicked(new Set());
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Gezichten"
        description="De foto's waarmee Frigate gezichten herkent. Staat er een foto van iemand anders tussen, of een onscherpe, verwijder die dan: Frigate haalt de mensen anders door elkaar."
      />
      <div className="ui-stack">
        {error && <Notice>{error}</Notice>}
        {!people ? (
          <p className="ui-muted">Laden…</p>
        ) : !available ? (
          <Empty>Frigate's gezichtsherkenning is nu niet bereikbaar.</Empty>
        ) : people.length === 0 ? (
          <Empty>Nog niemand in de bibliotheek. Beantwoord "Wie is dit?"-vragen om die op te bouwen.</Empty>
        ) : (
          people.map((p) => {
            const isOpen = open === p.name;
            const count = isOpen ? p.images.filter((i) => picked.has(i.file)).length : 0;
            return (
              <Card
                key={p.name}
                title={`${p.name} (${p.images.length})`}
                icon="users"
                actions={
                  <button
                    className="ui-btn ui-btn--small ui-btn--ghost"
                    onClick={() => (setOpen(isOpen ? null : p.name), setPicked(new Set()))}
                  >
                    {isOpen ? 'Sluiten' : "Foto's bekijken"}
                  </button>
                }
              >
                {isOpen && (
                  <>
                    <p className="ui-muted">Nieuwste eerst. Klik op foto's die niet van {p.name.split(' ')[0]} zijn of te onscherp zijn.</p>
                    <div className="ui-faces ui-faces--pick">
                      {p.images.map((i) => (
                        <button
                          key={i.file}
                          type="button"
                          className={picked.has(i.file) ? 'ui-face ui-face--picked' : 'ui-face'}
                          aria-pressed={picked.has(i.file)}
                          title={i.time ? highlightTime(i.time) : i.file}
                          onClick={() => toggle(i.file)}
                        >
                          <img src={imageUrl(p.name, i.file)} alt={`Gezicht van ${p.name}`} loading="lazy" />
                        </button>
                      ))}
                    </div>
                    <div className="ui-actions">
                      <button className="ui-btn ui-btn--danger" disabled={!count || busy} onClick={() => void remove(p.name)}>
                        {count ? `${count} ${count === 1 ? 'foto' : "foto's"} verwijderen` : "Kies foto's om te verwijderen"}
                      </button>
                    </div>
                  </>
                )}
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}

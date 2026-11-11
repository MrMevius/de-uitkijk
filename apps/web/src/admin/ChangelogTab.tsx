import { Card, PageHeader, Pill } from './ui.tsx';
import { parseChangelog } from './changelog.ts';

const releases = parseChangelog(__CHANGELOG__);
const dateText = (iso: string) =>
  new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

/** Beheer → Change log: what changed per release, on main points (from CHANGELOG.md). */
export function ChangelogTab() {
  return (
    <>
      <PageHeader title="Change log" description={`Wat er per versie veranderd is, op hoofdlijnen en nieuwste eerst. Deze pagina hoort bij versie ${__APP_VERSION__}.`} />
      <div className="ui-stack">
        {releases.map((r) => (
          <Card
            key={r.version}
            title={`Versie ${r.version}`}
            actions={
              <>
                {r.version === __APP_VERSION__ && <Pill level="ok">Huidig</Pill>}
                <span className="ui-muted">{dateText(r.date)}</span>
              </>
            }
          >
            <ul className="ui-changelog">
              {r.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}

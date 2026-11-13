# Household register (since 0.22.0)

The raw household facts ([ai.md](ai.md#household-facts-since-080-automatic-since-0110)) are single lines that pile up: duplicates ("Rode auto, grotendeels verborgen is een Tesla Model 3 is van Jasper Mevius" and "Rode auto onder de carport is een Tesla model 3 …"), contradictions (a white Ford Fiesta and a white Ford Focus for the same owner) and a vague and a precise description of the same car. The register bundles them into structured entries: who is who, and whose vehicle is which. Operator plan of 2026-11-11.

## Contents

- **People:** name, role (the answer categories: bewoner, familie, bezoeker, buren, vaste hulp, bezorger of dienstverlener; empty when not known), relation (free text such as "vriendin van Jasper", only ever set by an administrator), other names ("Tini"), sources.
- **Vehicles:** kind (auto, bestelbus, motor, scooter, fiets), make, model, colour, plate, fixed features, owner (a person), usual place, sources.
- **Sightings** (computed, not stored): highlights of the last half year in which Frigate recognised the person's face or an administrator named them; for a vehicle, highlights where Frigate read its plate.

Everything lives in the application database (`household_*` tables). Each entry records its sources ("vraag 30", "feit 4"); a raw fact that is a source of an entry is shown as *verwerkt*.

## Bundling

Beheer → Huishouden → *Nu bundelen*, or automatically (since 0.28.0) at the moment set under *Automatisch bundelen*: off, every day or every week on a chosen day, at a chosen time (Europe/Amsterdam). The default is weekly on Sunday at 05:00, after the nightly database copy and the VM backup. The automatic run was planned for 0.23.0 but not built until 0.28.0; until then nothing was bundled unless an administrator clicked the button.

The scheduler checks every minute and stores the moment it handled (`household_meta`), so a restart neither runs twice nor skips a run. The first start and every change of the schedule count the moment that just passed as handled: no run right after a deployment or a change. A moment missed while the server was down is made up for within six hours, later it waits for the next one. A run already in progress delays the automatic one by a minute. Automatic runs show as *automatisch* (run by `systeem`). Like a manual run, they only make proposals.

One run:

1. **People, without AI.** Every answered "Wie is dit?" question with a name gives that person; the role given most often sets the role, the newest of those on a tie (since 0.32.0; before, the newest answer alone, so two answers "bezoeker" for Johan against nine "bewoner" proposed a change). Names in Frigate's face library without an answer are added without a role. A changed role becomes an update.
2. **Vehicles, with AI** (only when AI is on and there are facts). One Codex call without an image and with medium reasoning effort gets the register, the known people, all raw facts with their numbers and the proposals an administrator rejected before. It returns, in a strict schema, one item per new or changed vehicle (with the facts it rests on, optional existing vehicles it merges with) and questions about contradictions or doubts.
3. **Server checks.** Every item must cite existing facts. Make, model, colour, plate, features, place and owner must appear in those facts or already in the register (Dutch adjective forms compare equal: "rode"/"rood"); anything else is dropped, not guessed. A plate must appear in full. Fields an administrator set are never changed. The summary shown to the administrator is written by the server, not by the AI.
4. **Proposals.** The run replaces undecided proposals of the previous run. Rejected proposals and questions marked *Gezien* are not suggested again.

## Questions from the register (since 0.29.0)

The register asks what it is unsure about or misses, on the *Vragen* tab (kind *Huishouden*, at most three open at a time, the next one right after an answer). Goal: facts that are as complete and correct as possible.

| Question | When | Answer | Effect |
| --- | --- | --- | --- |
| Doubt ("Heeft Gideon een Fiesta of een Focus?") | A pending question proposal of the bundling | One of 2–4 options the AI wrote (each with the fact that then holds and the facts it replaces), or an own sentence | The fact is added (by the administrator, "vraag N"); the replaced facts are deleted (only facts the question cites; logged in the history); the proposal counts as seen |
| Make and model ("Welk merk en model is de zwarte hatchback van Noëlle Snippe?") | A vehicle (not a bicycle) without make or model | Make, model, optionally plate | Fields set and locked in the register; fact "De … van … is een Volkswagen up! met kenteken …" |
| Plate ("Wat is het kenteken van de grijze Peugeot 108 van Noëlle Snippe?") | Car, van, motorbike or scooter with make and model, no plate | Plate | Plate set and locked; fact "… heeft kenteken …". Frigate reads plates, so the vehicle is recognised for certain |
| Role ("Wie is Vera Snippe?") | A person without role | Bewoner, familie, vaste bezoeker, buren, vaste hulp, bezorger / dienst | Role set and locked; fact "Vera Snippe is een buur." |
| Same vehicle ("Zijn dit dezelfde auto van Noëlle Snippe?", since 0.32.0) | Two entries with the same plate, or the same owner, kind, make and model (not both with a plate) | Ja / Nee | Ja: merged into the one with a plate (else the oldest), keeping fields, locks and sources only the other had. Nee: both stay, not asked again. Logged in the history |

Order: doubts, same vehicle, make and model, roles, plates. *Weet ik niet* skips a question for good (its key is used once). A question whose subject changed meanwhile (filled in by hand, vehicle deleted, doubt gone after a new bundling) is withdrawn. Two minutes after the last answer the register is bundled again, so the new facts become proposals and new doubts questions.

The AI writes the options in the bundling call (schema field `options`: `label`, `fact`, `retire`); `retire` is limited to the facts the question cites. The first start of 0.29.0 bundles once more when pending doubts have no options yet. Since 0.29.1 an open household question is refreshed on every generator run, so a doubt asked while that bundling was still running gets its options when it is done.

Accepting a proposal applies it: a new vehicle's owner is matched to a person by name, other name or unique first name, or created without a role (for example "Tini", which an administrator can then merge into "Tineke Mevius"). Merged vehicles keep the fields only they knew. A proposal that no longer fits the register (a vehicle was deleted meanwhile) becomes stale. Questions change nothing by themselves; since 0.29.0 they are answerable on the *Vragen* tab (see above), *Gezien* on this tab only dismisses them.

## Vehicle answers (since 0.32.0)

An answer to "Van wie is deze auto?" goes into the register at once, without AI and without a proposal, when it is clear which vehicle it is: a plate in the description that is (one character from) a register plate, whose vehicle gets the owner when it has none; or the same owner, kind, make and model as a register vehicle. Otherwise, when the description has a make or a plate, it becomes a new vehicle with kind, make, model, colour, plate and the "met …" part as feature (moments such as "met open motorkap" left out); an owner not in the register is added without a role, so the role question follows. A known plate with another owner, and a vehicle without make or plate, are left to the bundling. The entry cites the question and the fact, so the prompt holds the register line instead of the raw fact. Two minutes later the register is bundled again. Before, such an answer only became a fact and waited for the next bundling and an administrator's ok, so the questions about make and plate and the plate matches came days later.

## Administrators' corrections

People and vehicles can be added, changed, merged (people) and deleted on the tab. A field an administrator sets is locked: later bundling never changes it. Every change is in the history on the tab.

## Use

In 0.22.0 the register was only shown and maintained; descriptions still used the raw facts. The plan to give the AI the register in 0.24.0 was not built then (0.24.0 became the change log page). Since 0.30.0 the description prompt holds the register plus the raw facts it does not hold yet, and the server matches plates Frigate read against the register's plates ([ai.md](ai.md#what-the-server-decides-since-0300)). A change to the register counts like a new fact: highlights described before it are described again before a vehicle question is asked about them. Links from highlights to the people and vehicles they show are not built yet.

## Privacy

The bundling sends the raw facts, names and roles to OpenAI through Codex once per run, under the same confinement as the descriptions ([ai.md](ai.md#confinement)). Relations are not sent to the bundling; since 0.30.0 they are part of every description prompt, with the rest of the register. The register never holds appearance, clothing or behaviour of people.

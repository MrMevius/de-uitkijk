# AI descriptions

Highlights get a short Dutch description written by an AI from one still image. The AI also judges whether the still shows a real event. Highlights it judges as noise leave the dashboard rotation; they stay in the archive, marked.

## Provider (operator decision, 2026-11-08)

- **Codex CLI with the owner's ChatGPT sign-in** (OAuth, device code), as preferred by AI-3. It is OpenAI's official client and needs no API key. Usage counts against the ChatGPT plan's limits; there is no paid fallback (AI-6).
- **Claude**: the owner currently has a Pro plan. The officially permitted programmatic route found so far (monthly API credits through a Console API key) needs Max, Ultra or Team. To be revisited later.
- Frigate's own GenAI stays off: it is configured with an OpenAI API key (paid).

## Model

`gpt-6-luna` by default (`UITKIJK_AI_MODEL`). Without `--model`, Codex uses the first model in its catalog (`gpt-6.1-sol`, a large "workhorse for coding"), which is more than one sentence about one image needs. On 2026-11-08 both models described the same real snapshots equally well. Luna was about 30% faster (2.8–3.0 s against 4.0 s), and OpenAI's catalog lists it as "fast and affordable … for easier tasks", so it uses less of the plan's limits. Reasoning effort is `low`. The catalog for the signed-in account is available with `codex debug models`.

## How it works

1. Only highlights that passed the rule-based selection (AI-1) are sent, oldest first and one at a time, every two minutes. At most 60 calls a day (Europe/Amsterdam day). Since 0.31.0 the count comes from the AI log, so a restart or deployment no longer resets it; Beheer → AI also shows the fact and household calls of the day, which have no share in the 60. Since 0.30.1 a highlight is described when it is selected within two days (the period the selection is recalculated over), not only within 24 hours: a highlight selected later, after feedback or a known neighbour, stayed without a description.
2. Input: the stored clean snapshot (converted to JPEG) plus camera name, time and Frigate's labels.
3. Since 0.20.0 only parked vehicles, with nobody at them and nothing happening, count as noise (`real_event` false): they kept becoming highlights once Frigate tracked cars. Since 0.20.3 a person Frigate reported is never noise, and when the group has a person on the representative camera, the still is taken where that person was seen best (the path point nearest their best box) instead of at Frigate's review thumbnail time, which can be a car's moment (2026-11-09: "a hatchback parked under the carport" while the driver got out and walked past it). Highlights of the last two days that were called noise despite a person were described once more. Plates Frigate read are part of the prompt, so the AI can name them in the vehicle description and match them with plates in household facts.
4. `codex exec` runs with a strict JSON output schema: `description` (max 120 characters), `real_event` (boolean), `vehicle` and `vehicle_known` (since 0.10.0; motor vehicles only in 0.13.x, bicycles and scooters again since 0.14.0 with type, colour, brand and fixed parts) and `person_marker` (since 0.13.0: a person is recognisable by work clothes, a logo or their own vehicle), and `vehicles` (since 0.18.0: every vehicle clearly in view, also parked ones, each with `known`). The answer is validated and flattened to one plain line.
   A highlight an administrator answered a question about is described again (since 0.13.0), with priority and regardless of its age, and with the answer in the prompt.
4. A failure is retried up to three times; after that the rule-based description stays. AI problems never affect live video, alerts or rule-based highlights (AI-7).
5. Status for administrators is on `/beheer`: calls today, the last success, the last error and how many are pending.

The same rules apply to every camera (AI-2). The worker runs only when `UITKIJK_AI=codex` is set in the runtime environment (AI-4: explicit owner authorisation). There is no use of another application's session cookies or undocumented endpoints (AI-5); the only interface is the published `codex` binary.

## Household facts (since 0.8.0; automatic since 0.11.0)

Facts such as "Rode Tesla Model 3 met kenteken XX-123-Y is van Jasper" are built automatically from the answers on the *Vragen* tab ([questions.md](questions.md)); there is no manual entry. There is no upper limit; each fact is at most 200 characters, one plain line.

- **Vehicle answers** become a fact directly, in the administrator's own words ("<AI's vehicle description, as corrected> is van <owner>").
- **Answers about people** go to a fact writer. Codex looks at the highlight's 4K still together with the answer and writes one fact based only on visible, stable features: a vehicle, a company van, a logo or uniform. Examples: "De PostNL-bezorger komt met een oranje-witte PostNL-bestelbus" or "Oma komt met een grijze Toyota Yaris". The prompt forbids faces, hair, build, age and ordinary clothing of private people, and snapshots of the moment ("stands next to a car"). A vehicle may only be named when make and model or the full plate are recognisable and it clearly belongs to the person (getting in or out, driving); merely standing next to it is not enough. When in doubt, no fact is written. Since 0.30.0 it also leaves out things people carry (a bag, suitcase, box, parcel, tools, a wheelie bin), in the prompt and with a server check; on 2026-11-11 it wrote "Roel Snippe (buur) gebruikt een blauwe ANNEKE-koffer", and Johan and Jasper carried the same case later. AI facts like that are removed once at the first start of 0.30.0 (logged in the register history). On 2026-11-08, a first version wrote situational facts ("staat bij een donkere auto met de achterklep open") and even tied a visitor to a car she only stood next to; after tightening the prompt, the same production still produced no fact for all three test answers. This is one call per answer, at most 30 a day (counted from the AI log since 0.31.0), with three attempts.
- **Merging.** An identical fact is not stored twice. A fact with the same plate replaces the older one, so the newest answer wins.
- **Source.** Each fact records where it came from ("mark (vraag 12)" or "AI (vraag 14)"). Wrong facts can be deleted under Beheer → Huishouden → *Losse feiten* (on the AI tab before 0.22.0).
- **Register.** Since 0.22.0 the facts are bundled into a structured household register of people and vehicles ([household.md](household.md)).
- **Prompt.** Every description request includes the household knowledge, plus names from Frigate's face recognition for that event, plus the administrator's answer about this highlight when there is one. Since 0.30.0 the knowledge is the register ([household.md](household.md)) instead of every raw fact: its people (name, role, other names) and vehicles (label, plate, stable features, usual place, owner), followed by the raw facts the register does not hold yet (new answers between two bundlings). Left out: a fact cited by a register entry or written by an administrator's answer to a register question that changed an entry; a car in the register or a fact without make, plate or distinct body ("zwarte compacte hatchback"); a second register entry with the same plate; feature and place parts that describe a moment ("grotendeels verborgen", "links in beeld"). On 2026-11-12 this took the prompt from 27 raw facts with duplicates, contradictions and moments to the register plus a handful of new facts.
- **Naming rule.** The prompt allows a name only when it follows from face recognition or the administrator's answer, or from a fact that visibly matches the picture (a legible plate, or a vehicle that matches exactly). It forbids guessing who someone is from appearance or clothing, and asks for a neutral description when in doubt. Since 0.14.0 names are first names only, and a vehicle that matches a fact names its owner ("Jasper fietst weg"), unless face recognition shows someone else.
- **Input image.** The AI receives the full-resolution (3840×2160) still from Frigate's recording at the alert's best frame (`/api/<camera>/recordings/<time>/snapshot.jpg`, about 1 MB) instead of the 640×360 detection snapshot. 0.8.0 used 1080p; 0.8.1 switched to 4K by operator decision, accepting more plan usage per description. On 2026-11-08 the nearest plate on *Achter het huis 1* measured about 58×29 pixels in 4K (about 29×14 in 1080p, about 10×5 in the detection stream). If Frigate cannot deliver the still, the stored snapshot is used.
- **Frigate's own plate recognition** was evaluated and not enabled: it only reads the detection stream (640×360 here), where plates are far below its minimum of about 1000 pixels of area. It would need a dedicated plate camera or a much more expensive detection resolution.
- **Privacy.** The facts (names, plates) are sent to OpenAI through Codex with every description. Facts change only new descriptions and highlights that are described again after an answer; other existing descriptions stay.

## What the server decides (since 0.30.0)

An analysis of 2026-11-12 found that answers made the system better at vehicles (about 63% recognised) but hardly at people (one highlight in three days named without an answer). The server now settles what it can know for sure, before and after the AI call (`apps/server/src/ai/knowledge.ts`):

- **Plates.** A plate Frigate read in the event (four characters or more with a digit, one misread character allowed) that belongs to a register vehicle goes into the prompt as a certainty ("Het kenteken Z-632-FL is gelezen: de lichtblauw Volkswagen E-UP van Tineke Mevius is in beeld."), and the vehicle of that make and model counts as known whatever the AI says. A plate in the AI's own vehicle description that is in the register or a fact makes that vehicle known, unless the register vehicle with that plate has another make or model (on 2026-11-11 the AI put Mark's Tesla plate on a Volkswagen up!). A plate while every register vehicle of that make and model has another plate makes it unknown: another car of the same type.
- **Vague cars.** A car without make, plate or distinct body (van, lettering, trailer), or one the AI calls unrecognisable, is never known. Before, "Zwarte compacte hatchback is van Noëlle" matched any black hatchback (9 times in three days), which lowered the score (× 0.4) and suppressed questions.
- **Face recognition.** The prompt asks for the recognised first name instead of "een persoon". When the AI still leaves it out, Frigate reported one person, recognised one name and the description starts with "Een persoon", the server puts the first name in. With an administrator's answer the answer wins. On 2026-11-10/11 four of six descriptions with a recognised face said "Een persoon …".
- **Once at the first start of 0.30.0** the vehicle judgements of the last two weeks are checked with these rules, without AI calls (27 changes on the copy of 2026-11-12, nearly all vague hatchbacks). The importer then recalculates the scores of the last two days.

## Learning meter (since 0.30.0)

Beheer → AI → *Leert het systeem?* shows per day (last 14) or per week (last 8), over highlights that are shown or answered about and not noise:

- **Personen zelf / via jou / onbekend.** Highlights with a person, plus events in which Frigate recognised a face (they count low and are usually no highlight; before 0.30.1 they were left out, so the meter showed 1 of 18 recognised faces in a week): named without an answer (Frigate recognised the face, or the AI named someone from the register), named by an administrator's answer, or neither. An answer without a name ("onbekend", "bezoeker", "onbekende fiets") counts as *onbekend*.
- **Voertuigen herkend.** Vehicles the AI saw clearly that are known (after the server's checks).
- **Vragen (beantwoord).** Questions about people, vehicles and the register asked in the period. *Vragen per highlight* above the table is for the last seven days.

Rising "zelf" and falling questions per highlight mean the answers pay off. Route: `GET /api/admin/learning` (administrators).

## AI log (since 0.23.0)

Beheer → **AI-log** (named *AI-gesprekken* in 0.23.0) shows every AI call of the last 14 days, newest first, filterable by purpose: *beschrijving* (highlight descriptions), *feit* (facts written from answers about people) and *huishouden* (the weekly household bundling). Each call shows the image the AI got (stored as a 640-px WebP, about 30 KB), the exact prompt, the raw answer (or the error), the required JSON schema, model, reasoning effort and duration. All calls go through one wrapper (`loggedCall` in `apps/server/src/ai/log.ts`) around the Codex call, so nothing is missed and logging never changes or breaks a call. The log lives in table `ai_calls` of the application database and is pruned to 14 days at every new call (about 60 calls a day, a few MB in total). Prompts contain household facts and names, so the routes are under `/api/admin/` (administrators only).

## Confinement

Codex is an agent with a shell tool that cannot be disabled. Each run is therefore confined:

- **Working directory:** an empty temporary directory.
- **Sandbox:** `--sandbox read-only`, so commands cannot write and have no network.
- **Configuration:** `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and browser/computer-use/apps/plugins off.
- **Environment:** only `PATH`, `HOME`, `CODEX_HOME` and `LANG`.
- **Output:** a strict output schema.
- **Prompt:** forbids commands and tells the model to ignore text in the image.

Residual risk: the process runs as the backend's user and could in theory read files the backend can read (for example the SQLite database with password hashes) if a manipulated image talked the model into it. The only way out is the 120-character description, which is shown to logged-in users. This is accepted as very low.

## Verification (2026-11-08)

The owner signed in with ChatGPT through the device code. On production, two real Frigate snapshots were described through Codex in 6.5 s and 4.8 s:

- "Een persoon loopt over de oprit.", real event;
- "Een persoon loopt op de achtergrond langs de heg.", real event.

AI was then enabled with `UITKIJK_AI=codex`.

## Operations

- **Sign in once:** `docker exec -it de-uitkijk-server-1 codex login --device-auth`, then open the shown URL and enter the code with the owner's ChatGPT account. The login is stored in `/data/codex` (data volume, mode 700).
- **Enable:** add `UITKIJK_AI=codex` to `/etc/de-uitkijk/runtime.env`; it takes effect with the next deployment. Enabled on production since 2026-11-08.
- **Disable:** remove the line (next deployment). Existing AI descriptions stay.
- **Revoke:** `docker exec de-uitkijk-server-1 codex logout`, or revoke the session in the ChatGPT account.

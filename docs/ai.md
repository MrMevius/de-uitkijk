# AI descriptions

Highlights get a short Dutch description written by an AI from one still image. The AI also judges whether the still shows a real event. Highlights it judges as noise leave the dashboard rotation; they stay in the archive, marked.

## Provider (operator decision, 2026-11-08)

- **Codex CLI with the owner's ChatGPT sign-in** (OAuth, device code), as preferred by AI-3. It is OpenAI's official client and needs no API key. Usage counts against the ChatGPT plan's limits; there is no paid fallback (AI-6).
- **Claude**: the owner currently has a Pro plan. The officially permitted programmatic route found so far (monthly API credits through a Console API key) needs Max, Ultra or Team. To be revisited later.
- Frigate's own GenAI stays off: it is configured with an OpenAI API key (paid).

## Model

`gpt-6-luna` by default (`UITKIJK_AI_MODEL`). Without `--model`, Codex uses the first model in its catalog (`gpt-6.1-sol`, a large "workhorse for coding"), which is more than one sentence about one image needs. On 2026-11-08 both models described the same real snapshots equally well. Luna was about 30% faster (2.8–3.0 s against 4.0 s), and OpenAI's catalog lists it as "fast and affordable … for easier tasks", so it uses less of the plan's limits. Reasoning effort is `low`. The catalog for the signed-in account is available with `codex debug models`.

## How it works

1. Only highlights that passed the rule-based selection (AI-1) are sent, oldest first and one at a time, every two minutes. At most 60 calls a day.
2. Input: the stored clean snapshot (converted to JPEG) plus camera name, time and Frigate's labels.
3. `codex exec` runs with a strict JSON output schema: `description` (max 120 characters) and `real_event` (boolean). The answer is validated and flattened to one plain line.
4. A failure is retried up to three times; after that the rule-based description stays. AI problems never affect live video, alerts or rule-based highlights (AI-7).
5. Status for administrators is on `/beheer`: calls today, the last success, the last error and how many are pending.

The same rules apply to every camera (AI-2). The worker runs only when `UITKIJK_AI=codex` is set in the runtime environment (AI-4: explicit owner authorisation). There is no use of another application's session cookies or undocumented endpoints (AI-5); the only interface is the published `codex` binary.

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

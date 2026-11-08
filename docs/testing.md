# Testing

## Automated tests

```bash
npm install
npm test            # Vitest: shared, server and web projects
npm run typecheck
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, the web build and the Docker image builds on every push and pull request.

| Area | File | Covers |
| --- | --- | --- |
| Focus state machine | `packages/shared/test/focus.test.ts` | Focus on alert; exact 15 s hold (boundary at 14.999/15.000 s); no hold restart on repeated reconciliation; reactivation cancels hold; independent holds per camera; several alerts per camera; shared order; custom hold. |
| Layout | `packages/shared/test/layout.test.ts` | 2x2 for four and 3x3 for nine; one, two and three-or-more focused cameras; determinism; **exhaustive**: every camera count 1–9 × every focus subset (1 022 layouts) checked for visibility, bounds, 16:9, no overlap, prominence and shared reading order. |
| Configuration, backoff, formatting, health | `packages/shared/test/misc.test.ts` | Four locations in order; nine-camera fixture keeps the same first four; more than nine rejected; invalid ids, stream names and duplicate Frigate mappings rejected; backoff growth, cap and floor; Dutch date and 24-hour clock in winter and summer time; health messages. |
| Scenarios | `apps/server/test/scenarios.test.ts` | Every fixture driven with fake timers: single alert, multiple alerts, expiration/reactivation, looping, camera disconnect/reconnect, alert source unavailable, streaming unavailable, nine cameras, unknown cameras ignored, scenario switching. |
| Frigate source | `apps/server/test/frigate.test.ts` | Review query (severity, window, cameras); open alert → focus; close → 15 s hold from observation; availability from `camera_fps`; down after three failures with alert release; bounded poll backoff; discovery mismatch logging; live configuration validation. |
| Login and access policy | `apps/server/test/auth.test.ts` | scrypt hashing; every API route except health, login and one-time links requires a session (an old LAN marker header grants nothing); secure cookie; sessions without expiry and cookie renewal; foreign Origin rejected; throttling per username (5) and client (10); invitation, single-use 72-hour links, password reset ends sessions; last-admin and self-delete protection; username/role validation. |
| Highlights | `apps/server/test/highlights.test.ts`, `apps/web/test/highlights.test.tsx` | Grouping across cameras; score factors (rarity, night, car, several cameras, known person); burst suppression and threshold; Dutch descriptions; feedback learning (adjustment mapping and cap, similar candidates lowered after 👎/deletion, 👎 out of the rotation); importer against a fake Frigate (activation boundary, settle time, representative camera, idempotency, catch-up, tombstones); rotation/archive API with session; clips with byte ranges and downloads through the cache; admin-only feedback and deletion; dashboard rotation order, new highlights first, pause during alerts and continue with the next. |
| AI descriptions | `apps/server/test/ai.test.ts` | Prompt rules; strict answer validation and flattening; Codex invocation confined (read-only sandbox, temporary cwd, no application environment, schema, image, disabled features) with a fake `codex` binary; worker order, noise leaves the rotation, retries then rule-based fallback, daily cap. |
| Frigate client | `apps/server/test/frigate-client.test.ts` | Against a local HTTPS server with a self-signed certificate: login, session cookie, re-login after 401, refusal of a different certificate, failed login, base-URL restriction, credentials file parsing. |
| Self-healing dashboard | `apps/web/test/self-healing.test.ts` | Time until 04:00 Amsterdam (also summer time); reload after a new release but not during an alert and not in a loop; nightly reload postponed during an alert. |
| Monitoring | `apps/server/test/monitoring.test.ts` | Camera picture probe (ok/failed, one camera at a time); detail endpoint open without login with version, cameras, highlights and AI; `/api/state` still needs a session. |
| Login page | `apps/web/test/account.test.tsx` | Login redirects only to same-site paths; server errors shown. |
| HTTP API | `apps/server/test/app.test.ts` | State without source URLs; dev scenario API (mock only); SSE delivers updates; go2rtc probe up/down/suppressed. |
| Dashboard | `apps/web/test/dashboard.test.tsx` | Four and nine tiles; names in shared order; no interactive controls; muted video; **focus change keeps the same `<video>` element**; health messages; offline tile; video hidden until live. |
| MSE player | `apps/web/test/mse-player.test.ts` | Offers only supported video codecs; no retry loop when MSE is unsupported; reconnect delays exactly 1, 2, 4, 8, 16, 30, 30, 30 s; stop halts retries; start timeout clears the video; go2rtc codec errors trigger a retry. |

## Fixtures

Camera sets: `config/cameras.json` (four locations) and `config/cameras-9.mock.json` (nine; the first four match).

Scenarios (`apps/server/src/mock/scenarios.ts`), selectable at <http://127.0.0.1:8080/dev> or with `UITKIJK_MOCK_SCENARIO`:

| Scenario | Timeline |
| --- | --- |
| `idle` | All cameras online, no alerts. |
| `single-alert` | Voordeur alert 2–12 s, hold until 27 s; loops every 40 s. |
| `multi-alert` | Oprit, Achter 1 (car) and Achter 2 start at 2/4/6 s and end at 12/16/20 s; loops every 50 s. |
| `expire-reactivate` | Voordeur 2–6 s; a new alert at 14 s cancels the hold; ends 18 s; hold expires 33 s; again 40–44 s; loops every 60 s. |
| `camera-disconnect` | Achter 1 offline 5–20 s. |
| `frigate-unavailable` | Oprit alert from 2 s; alert source down 6–30 s (focus released through hold); alert resumes at 30 s. |
| `streaming-unavailable` | Backend reports go2rtc down 3–25 s (simulated health only). |
| `nine-cameras` | Alerts on Voordeur, Mock 5 and Mock 9 (car). |
| `demo` | Loop of single, double and re-activated alerts over 120 s. |

## Video during a backend outage

Verified 2026-11-08 with Docker: a stream with a valid session connects; after `docker compose stop server` the same session still connects (cached login check), while an unknown session is refused.

## Manual checks

With `docker compose up --build`:

1. **Focus**: open the dashboard and `/dev`, run `single-alert`, `multi-alert` and `expire-reactivate`. Watch for 400 ms transitions, a red frame for active alerts, an amber frame during the hold, and the return to 2x2.
2. **Stream failure**: `docker compose stop go2rtc`. Every tile shows "Geen beeld" within about 6 s (no frozen frame), the health indicator turns red within 15 s, and retries back off to 30 s (DevTools → Network → WS). `docker compose start go2rtc`: tiles recover within one backoff interval.
3. **Backend failure**: `docker compose stop server`. Video keeps playing, the status shows "Server niet bereikbaar", and any focus is released after 15 s. A page reload still shows all tiles (cached camera list; static files come from the edge). `docker compose start server`: the status clears.
4. **Profiles**: `/?profile=shop` (larger overlays) and `/?profile=bedroom`.

## Nine-camera playback

Reproducible with mock streams:

```bash
UITKIJK_CAMERA_FILE=cameras-9.mock.json UITKIJK_MOCK_SCENARIO=nine-cameras docker compose up --build
```

Result on 2026-11-08 (headless Chromium 1248, 1920x1080, development VM): all nine tiles playing 1.2 s after navigation. About 40 frames per tile decoded in the first ~7 s, 0–1 dropped. Idle container memory: go2rtc 20 MiB, server 42 MiB, web 5 MiB. This validates client playback of nine concurrent MSE streams with **mock H.264 640x360 sources**. It does **not** validate nine real H.265 cameras; see [streaming.md](streaming.md#nine-cameras).

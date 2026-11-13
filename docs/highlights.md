# Highlights

Short clips of the most interesting events of the last 24 hours. They rotate on the dashboard in a tile of their own and stay browsable in the archive (`/archief`). Operator decisions (2026-11-08):

- the highlight gets an extra tile next to the live cameras;
- recognised household members count, but low;
- descriptions are rule-based first and are replaced by AI descriptions when enabled ([ai.md](ai.md)); Frigate's own GenAI stays off because it would use the paid OpenAI API.

## Data flow

```text
Frigate review API (alerts) ──every 60 s──► importer ──► SQLite (candidates, processed review ids, thumbnails)
Frigate events API (detection scores) ─────┘      │
Frigate clean snapshot ───────────────────────────┘
browser ──► /api/highlights/:id/clip.mp4 ──► clip cache (bounded, temporary) ◄── Frigate recording clip
```

- **Candidates (HL-1).** Frigate *alert* review items (not detections), imported once they have ended plus 60 s, so neighbouring alerts can be grouped.
- **Grouping (HL-2).** Alerts on any camera that start within 30 s after the previous one ended form one event. Since 0.34.0 a group waits while an alert that started before it ended (+30 s) is still running, at most 10 minutes after the group ended; before, it was imported without it, so one visit gave two highlights (46 of 353 candidates in the week to 2026-11-13). The representative camera is the one with the most confident detection (Frigate `top_score`), a person before anything else since 0.34.0 (a parked car at 0.9 won from a person at 0.8 on another camera); that camera's clip is shown. Frigate's `person-verified` (a recognised face) is stored as `person`.
- **Score (HL-3).** Rule-based, with no fixed camera weighting:

  | Factor | Effect |
  | --- | --- |
  | Rarity | `3 × 1 / (1 + alerts per day on this camera in this hour over the last 7 days)`, so a busy garden by day scores low and the same garden at night high. |
  | Night (23:00–06:00) | +1.5 |
  | Vehicle (since 0.20.0; before: car +1) | car +0.5, motorcycle or bicycle +0.75 (the highest counts once); someone at the vehicle (person in the same group) another +0.25 |
  | Several cameras | +0.75 per extra camera (max +1.5) |
  | Recognised person (Frigate sub label, e.g. face recognition) | × 0.4 |
  | Known from an answer or a fact (since 0.13.0): an administrator named a resident, visitor or vehicle owner, or the AI matched the vehicle to a household fact | × 0.4 (not on top of a recognised face). Since 0.34.0 a known vehicle only counts when there is no person nobody identified: "Een persoon loopt langs de rode Tesla" counted low (18 times in a week, 6 with a person) |

  Since 2026-11-09 Frigate tracks cars, bicycles, motorcycles, dogs and cats itself, and vehicles are alerts too; cars are common (also passing ones), so their weight went down. Parked cars that flicker in and out of detection are masked in Frigate (homelab `operations/server502-production.md`), and the AI calls parked vehicles without activity noise (see [ai.md](ai.md)). Review the weights after a few weeks of vehicle alerts.
- **Plates (since 0.20.0).** Plates Frigate's LPR read on the group's detections (`recognized_license_plate`) are stored with the candidate, passed to the AI and shown in "whose vehicle" questions. Since 0.31.0 one rule decides what counts as a plate, everywhere: four characters or more with a digit (Frigate once read "SCHUUR" from the shed). Before, the importer, the questions and the AI each had their own rule, and "SCHUUR" reached the AI.

- **Selection (HL-4).** A highlight needs a score of at least the threshold: 2.0 by default, adjustable by administrators since 0.15.0 (Beheer → Overzicht → Highlights, 1.0–5.0 in steps of 0.1, with a preview of how many highlights a value gives over the last 24 hours and the last week). The importer applies a new value to the last two days within a minute; borderline questions follow it (threshold to threshold + 0.6). Within 30 minutes on the same camera, only the best one is kept (no series of near-identical clips). Since 0.34.0 a highlight the AI judged noise or that got 👎 only holds back candidates with no other kind of object: a person after a parked car judged noise is selected (in the week to 2026-11-13, 31 candidates above the threshold were held back only by noise or 👎, among them a person and car on two cameras with score 3.9). A highlight with 👍 or an answer stays a highlight and keeps its place whatever its score, so an answer that makes it count low no longer lets the next clip of the same visit become a highlight; one that stays only because of an answer and is below the threshold is not shown on the TV. Selection is recalculated over the last two days; since 0.30.1 the highlights just before that window still hold back their neighbours in it. Before, the best of a series leaving the window let the next one be selected, and so on: on 2026-11-11 Achter 2 had 10 highlights in one hour where the rule gives 2. At the first start of 0.30.1 older highlights were put right once with the same rule (17 deselected); highlights with an answer or a 👍 stayed, and the three that stayed without a description got one. The dashboard rotates the best 15 of the last 24 hours. Tuned on seven days of real alerts (2026-11-01..08, 758 alerts): 6–14 highlights per day. On 2026-11-08, 149 candidates from 24 hours produced 17 highlights.
- **Clip (HL-5).** From 2 s before the representative alert to 2 s after it, at least 5 s and at most 30 s. A clip is available about 1–2 minutes after the event ends. Since 0.22.3 the clip starts where the person (seen best) appears, else at the representative detection, never before the alert, and always contains the moment of the AI still (until at least 5 s after it, also when Frigate kept following the person after the alert ended; fixed in 0.22.4): on 2026-11-11 a parked car opened an alert at 07:44 and the person walked by 75 s later, so the clip showed only the car while the question asked "Wie is dit?". Stored highlights whose clip missed the still were moved once at startup (32, 8 of them selected; three whose still came after the alert's end were corrected again in 0.22.4). The clip cache key includes the window, so a moved clip is fetched again.
- **Description (HL-6).** For example "Persoon bij Achter het huis 1, daarna Oprit / Pad, 's nachts", or with the recognised name.
- **Rotation (HL-7).** Since 0.15.0 up to five highlights are on screen at the same time, each on its own tile. Since 0.16.0 a tile shows the highlight's still at once, plays the clip once, muted, and then keeps the last frame (since 0.25.0: it jumps back to the most interesting moment, the AI still, and stays there; `stillOffset` in the highlight summary). Every *replay interval* (default 10 minutes, adjustable by administrators in Beheer → Overzicht → Highlights, 1–120 minutes; the dashboard reads it every minute) the tile plays again: the highlight that has been off screen longest and is not on another tile, or the same one in place (without loading it again) when all others are on screen. A highlight that arrives while all tiles are in use takes over the tile that started longest ago, at once. During an active alert the highlight tiles disappear; afterwards they fill again and play. A clip that fails to load or does not finish within its length plus 20 s is skipped for 10 minutes if another highlight can take its tile; otherwise the tile keeps showing the still.
- **Size (since 0.15.0).** The highlights sit in a column on the right (landscape) or a row at the bottom (portrait). The column holds five 16:9 tiles over the full height, at most a quarter of the screen width; at 1920×1080 a highlight tile is 366×206 px and the column takes 374 px, so the camera tiles stay about as large as with the single highlight of 0.12–0.14. A phone row holds as many tiles as fit at 150 px or more (two on a 390 px wide phone). Tile size does not change when fewer highlights are available; those are centred. Without highlights, or during an alert, the cameras use the full screen.
- **Storage (HL-9).** Metadata and one clean Frigate snapshot (WebP, about 20 KB) per candidate are stored in SQLite indefinitely. Video stays in Frigate, which keeps alert recordings for 100 days; older clips are no longer playable, but the archive entry and thumbnail remain. Since 0.20.3: when Frigate no longer has the snapshot of the best detection (it drops short tracked objects, such as parked cars flickering in and out of detection), the snapshot of another detection of the group is used, else a 640-px WebP made from the 4K recording frame. The importer reads the group's detections one by one (`/api/events/<id>`): Frigate's event list has no id filter, and an `ids` parameter is silently ignored (before 0.20.3 the importer got the latest events of all cameras and only found the right ones because they were recent). The clip cache (default 512 MB, `UITKIJK_CLIP_CACHE_MB`) only exists so browsers get byte ranges and a Safari-compatible file: ffmpeg rewraps without re-encoding (`-c copy -tag:v hvc1 -movflags +faststart`). It is evicted least-recently-used.
- **Archive (HL-10/11).**
  - Filters for a period (from and to, whole days in Europe/Amsterdam), camera and high relevance (score ≥ 3).
  - Search (since 0.27.0): every word must occur in the description (AI or rules), the administrator's answer, a name Frigate recognised, a vehicle the AI saw or a plate. A plate matches with or without dashes; a nickname from the household register also finds the full name ("Tini" → "Tineke Mevius"). Plain `LIKE`, case-insensitive for ASCII letters.
  - Administrators can mark a highlight good or bad (see *Learning from feedback*), also from the questions tab (since 0.27.0), and can list only highlights without a rating ("Nog niet beoordeeld"). Since 0.34.0 a highlight with 👍 stays in the archive also when it dropped out of the selection earlier.
  - Administrators can delete a highlight. Deletion keeps a tombstone, so it is never imported again.
- **Start and catch-up (HL-12).** The first start records an activation time, and nothing earlier is imported. A cursor plus the processed review ids catch up after an outage without duplicates.
- **Downloads (HL-13).** "Clip downloaden" (the highlight) and "Hele gebeurtenis" (the whole group from 5 s before to 5 s after, at most 10 minutes), both with the original audio.

## Learning from feedback (since 0.7.0)

- **👎 on a highlight** takes it out of the dashboard rotation at once; it stays in the archive.
- **Similar candidates are adjusted.** Each 👍 counts +1 and each 👎 or deletion −1 for its representative camera, time-of-day period (day 06–19, evening 19–23, night 23–06) and, since 0.34.0, kind (person, vehicle, other), over the last 90 days. Before, a 👎 on a cat also lowered a person at night on that camera. The total times 0.4, capped between −1.5 and +1.0, is added to the rule-based score of candidates with the same camera and period.
- **Takes effect within a minute.** Selection is recalculated over the last two days on every import cycle, so feedback changes the current rotation right away.
- **Visible:** the adjustment shows as "feedback ±x" among a highlight's reasons; the rule-based score is kept separately.

## API

| Route | Access |
| --- | --- |
| `GET /api/highlights/rotation` | logged in |
| `GET /api/highlights?from&to&camera&minScore&q&unrated&limit&offset` | logged in |
| `GET /api/highlights/:id/thumb.webp`, `/clip.mp4`, `/event.mp4` (`?download=1`) | logged in |
| `POST /api/admin/highlights/:id/feedback` `{value: 1 \| -1 \| null}`, `DELETE /api/admin/highlights/:id` | admin |

## Limits

- Selection is rule-based. Activity that is frequent at a given hour on a camera counts as normal by definition, and a cat or headlights at night can still score high. Use 👎 and delete to keep the archive clean.
- Frigate recognises faces only occasionally (14 of 758 alerts in the tuning week), so the "known person" factor rarely applies. Since 0.13.0 answers on the questions tab teach Frigate faces, which should raise this over time; the detection stream (640×360) remains the limit.
- Clips come from the 4K main recording (about 3 Mbit/s). Playback needs H.265 support, as for live video.

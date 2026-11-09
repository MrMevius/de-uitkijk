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
- **Grouping (HL-2).** Alerts on any camera that start within 30 s after the previous one ended form one event. The representative camera is the one with the most confident detection (Frigate `top_score`); that camera's clip is shown.
- **Score (HL-3).** Rule-based, with no fixed camera weighting:

  | Factor | Effect |
  | --- | --- |
  | Rarity | `3 × 1 / (1 + alerts per day on this camera in this hour over the last 7 days)`, so a busy garden by day scores low and the same garden at night high. |
  | Night (23:00–06:00) | +1.5 |
  | Car | +1 |
  | Several cameras | +0.75 per extra camera (max +1.5) |
  | Recognised person (Frigate sub label, e.g. face recognition) | × 0.4 |

- **Selection (HL-4).** A highlight needs a score of at least 2.0. Within 30 minutes on the same camera, only the best one is kept (no series of near-identical clips). The dashboard rotates the best 15 of the last 24 hours. Tuned on seven days of real alerts (2026-11-01..08, 758 alerts): 6–14 highlights per day. On 2026-11-08, 149 candidates from 24 hours produced 17 highlights.
- **Clip (HL-5).** From 2 s before the representative alert to 2 s after it, at least 5 s and at most 30 s. A clip is available about 1–2 minutes after the event ends.
- **Description (HL-6).** For example "Persoon bij Achter het huis 1, daarna Oprit / Pad, 's nachts", or with the recognised name.
- **Rotation (HL-7).** Clips play once each, muted, in score order. A newly arrived highlight plays next, and a single highlight replays. During an active alert the highlight tile disappears, and the next one follows afterwards. A clip that fails to load or does not finish within its length plus 20 s is hidden. It is skipped for 10 minutes while others play, and the next attempt comes after 30 s. Before 0.12.0, one failing highlight could leave the tile on "Highlight laden…" indefinitely.
- **Size (since 0.12.0).** The highlight sits in a strip beside the cameras (landscape: 22 % of the width on the right; portrait: 22 % of the height below). At 1920×1080 the camera tiles are 737 px wide and the highlight 414 px, with smaller text. Without a highlight, or during an alert, the cameras use the full screen.
- **Storage (HL-9).** Metadata and one clean Frigate snapshot (WebP, about 20 KB) per candidate are stored in SQLite indefinitely. Video stays in Frigate, which keeps alert recordings for 100 days; older clips are no longer playable, but the archive entry and thumbnail remain. The clip cache (default 512 MB, `UITKIJK_CLIP_CACHE_MB`) only exists so browsers get byte ranges and a Safari-compatible file: ffmpeg rewraps without re-encoding (`-c copy -tag:v hvc1 -movflags +faststart`). It is evicted least-recently-used.
- **Archive (HL-10/11).**
  - Filters for date, camera and high relevance (score ≥ 3).
  - Administrators can mark a highlight good or bad (see *Learning from feedback*).
  - Administrators can delete a highlight. Deletion keeps a tombstone, so it is never imported again.
- **Start and catch-up (HL-12).** The first start records an activation time, and nothing earlier is imported. A cursor plus the processed review ids catch up after an outage without duplicates.
- **Downloads (HL-13).** "Clip downloaden" (the highlight) and "Hele gebeurtenis" (the whole group from 5 s before to 5 s after, at most 10 minutes), both with the original audio.

## Learning from feedback (since 0.7.0)

- **👎 on a highlight** takes it out of the dashboard rotation at once; it stays in the archive.
- **Similar candidates are adjusted.** Each 👍 counts +1 and each 👎 or deletion −1 for its representative camera and time-of-day period (day 06–19, evening 19–23, night 23–06), over the last 90 days. The total times 0.4, capped between −1.5 and +1.0, is added to the rule-based score of candidates with the same camera and period.
- **Takes effect within a minute.** Selection is recalculated over the last two days on every import cycle, so feedback changes the current rotation right away.
- **Visible:** the adjustment shows as "feedback ±x" among a highlight's reasons; the rule-based score is kept separately.

## API

| Route | Access |
| --- | --- |
| `GET /api/highlights/rotation` | logged in |
| `GET /api/highlights?from&to&camera&minScore&limit&offset` | logged in |
| `GET /api/highlights/:id/thumb.webp`, `/clip.mp4`, `/event.mp4` (`?download=1`) | logged in |
| `POST /api/admin/highlights/:id/feedback` `{value: 1 \| -1 \| null}`, `DELETE /api/admin/highlights/:id` | admin |

## Limits

- Selection is rule-based. Activity that is frequent at a given hour on a camera counts as normal by definition, and a cat or headlights at night can still score high. Use 👎 and delete to keep the archive clean.
- Frigate recognises faces only occasionally (14 of 758 alerts in the tuning week), so the "known person" factor rarely applies.
- Clips come from the 4K main recording (about 3 Mbit/s). Playback needs H.265 support, as for live video.

# Questions and suggestions

The admin page has a **Vragen** tab, with a counter on the tab. The system asks there about what it does not know yet, and makes suggestions. A generator runs every 10 minutes. Every question has a key that is used only once, so nothing is asked twice, and only a few questions of each kind are open at a time.

| Kind | When | Answer | Effect |
| --- | --- | --- | --- |
| Persoon ("Wie is dit?") | Highlight of the last 7 days with a person, no face recognised by Frigate, judged a real event by the AI, not labelled yet; best first; at most 3 open | Bewoner / bezoeker / bezorger of dienst / onbekend, optional name | Label on the highlight ("Volgens beheer: …" in the archive) |
| Auto ("Van wie is deze auto?") | The AI described a vehicle in a highlight (colour, make, model, plate if legible) that matches no fact; one question per distinct vehicle; at most 3 open | Owner, with an editable description; or "onbekende auto" | New AI fact "<description> is van <owner>", label on the highlight |
| Highlight ("Was dit een goede highlight?") | Highlight of the last 3 days with a borderline score (2.0–2.6) and no feedback; at most 2 open | 👍 / 👎 | Feedback, which the selection learns from |
| Suggestie | At least 5 highlights the AI judged as noise for one camera and time of day in a week | Gezien | — (hint: lens, insects, IR reflection, alarm zone) |
| Melding | A camera without a picture for an hour; Codex apparently logged out; daily AI limit reached | Gezien | — (what to do) |

Questions about a highlight that is deleted are closed automatically. Handled questions stay visible as history.

The vehicle question needs two extra AI fields (since 0.10.0): `vehicle`, an exact description or empty, and `vehicle_known`, whether it matches a fact.

Not (yet) possible: teaching Frigate's face recognition from an answer. That requires writing to Frigate's face library with an admin account, while De Uitkijk deliberately reads Frigate as a viewer.

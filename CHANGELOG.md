# Change log

Op hoofdlijnen, nieuwste eerst. Wordt getoond op Beheer → Change log. Elke release krijgt hier een kopje
`## <versie> — <datum>` met een paar bullets; een test controleert dat de bovenste versie gelijk is aan `VERSION`.

## 0.28.1 — 2026-11-11

- Na het beantwoorden of overslaan van een vraag blijft de kaart staan met je antwoord, zodat je de highlight nog 👍/👎 kunt geven; "Sluiten" haalt hem weg.

## 0.28.0 — 2026-11-11

- Huishouden bundelt nu automatisch: uit, elke dag of elke week, op een dag en tijd die je zelf kiest (standaard zondag 05:00). De wekelijkse run stond al in de documentatie maar was nooit gebouwd.

## 0.27.0 — 2026-11-11

- Elke nacht een back-up van de database met alles wat het systeem geleerd heeft (30 dagen, 12 weken, 12 maanden); zichtbaar op Beheer → Overzicht.
- Nieuw blok Schermen op Beheer → Overzicht: welke tv's aan staan, welke versie ze draaien en of alle camera's beeld geven.
- Minder voertuigvragen: niet meer over auto's zonder merk of kenteken, grotendeels verborgen voertuigen en voertuigen die je al hebt benoemd (ook bij een net verkeerd gelezen kenteken).
- Geen "Wie is dit?" meer over piepkleine figuurtjes in de verte; de best zichtbare personen worden eerst gevraagd.
- Eén antwoord voor het hele bezoek: andere highlights van dezelfde persoon binnen een kwartier staan aangevinkt bij de vraag.
- 👍/👎 nu ook bij de vragen, en in het archief een filter "Nog niet beoordeeld".
- Zoeken in het archief op wie of wat (naam, bijnaam, pakket, merk, kenteken), met een periode van–tot.

## 0.26.0 — 2026-11-11

- Vloeiendere overgang naar focus: de camera met een alert schuift soepel naar voren met een gloed en een ring die op het kader inzoomt, de andere camera's volgen één voor één en worden gedimd.
- Het alertlabel springt in beeld met een pulserende stip; highlights komen na een alert zacht terug in beeld.

## 0.25.0 — 2026-11-11

- Na het afspelen blijft een highlight op de tv stilstaan op het interessantste moment (waar de persoon het best te zien is) in plaats van op het laatste beeld.

## 0.24.2 — 2026-11-11

- Bijnamen uit Huishouden tellen als dezelfde persoon: "Tini" wordt Tineke Mevius en krijgt geen eigen knop meer.
- Mensen uit het huishoudregister staan ook bij de snelknoppen.

## 0.24.1 — 2026-11-11

- Wijzigingen heet nu Change log en staat onderaan in het menu, net boven Naar dashboard.

## 0.24.0 — 2026-11-11

- Nieuwe pagina Beheer → Wijzigingen met dit overzicht; wordt bij elke update bijgewerkt.

## 0.23.1 — 2026-11-11

- Het tabblad AI-gesprekken heet nu AI-log.

## 0.23.0 — 2026-11-11

- Nieuwe pagina Beheer → AI-log: elke AI-aanroep van de afgelopen 14 dagen met beeld, letterlijke prompt en ruw antwoord.

## 0.22.5 — 2026-11-11

- Namen uit eerdere antwoorden (ook zonder geleerd gezicht, zoals buren en eigenaren van voertuigen) staan nu als snelknop bij de vragen.
- Een getypte voornaam wordt ook aan die namen gekoppeld ("roel" → "Roel Snippe").

## 0.22.4 — 2026-11-11

- De clip loopt door tot na het moment van het AI-beeld, ook als Frigate de persoon na het alert nog volgde.

## 0.22.3 — 2026-11-11

- De clip begint waar de persoon in beeld komt, niet waar een geparkeerde auto het alert startte.
- Bestaande highlights waarvan de clip de persoon miste, zijn eenmalig gecorrigeerd.

## 0.22.2 — 2026-11-11

- Kliko's, rolcontainers en kruiwagens tellen niet meer als voertuig; geen "Van wie is deze auto?" meer over een kliko.

## 0.22.1 — 2026-11-11

- Geen dubbele voertuigvraag meer na een antwoord: een highlight wordt eerst opnieuw beschreven met de nieuwste feiten.

## 0.22.0 — 2026-11-11

- Nieuwe pagina Beheer → Huishouden: wie is wie en welk voertuig van wie is, gebundeld uit feiten en antwoorden.

## 0.21.0 — 2026-11-10

- Meer antwoorden op "Wie is dit?": familie, buren, vaste hulp en voorbijganger.

## 0.20.3 — 2026-11-09

- Verbeteringen na de eindtest: juiste detecties per highlight, beter AI-beeld bij personen, thumbnail ook als Frigate de snapshot kwijt is.

## 0.20.2 — 2026-11-09

- Geen zijaanzichten meer als gezichtsfoto; Frigate bouwt zijn gezichtsmodel opnieuw op na verwijderen.

## 0.20.1 — 2026-11-09

- De gezichtenbibliotheek wordt altijd vers uit Frigate gelezen.

## 0.20.0 — 2026-11-09

- Geparkeerde voertuigen tellen als ruis; kentekens uit Frigate; nieuwe pagina Beheer → Gezichten.
- Alerts komen direct binnen via Frigate's websocket.

## 0.19.2 — 2026-11-09

- Een voertuig dat op de achtergrond geparkeerd staat, geeft de highlight geen label meer.

## 0.19.1 — 2026-11-09

- Gezichten leren wordt opnieuw geprobeerd als Frigate even niet beschikbaar is.

## 0.19.0 — 2026-11-09

- Gezichten worden ook uit de 4K-opname geleerd als Frigate zelf geen gezichtsfoto bewaarde.

## 0.18.3 — 2026-11-09

- Geen vraag over voertuigen waarvan merk en model niet te lezen zijn.

## 0.18.2 — 2026-11-09

- Beantwoorde highlights worden eerst opnieuw beschreven.

## 0.18.1 — 2026-11-09

- Geen vraag over voertuigen die de AI niet uit elkaar kan houden.

## 0.18.0 — 2026-11-09

- Vragen over elke onbekende persoon en elk onbekend voertuig, ook geparkeerde.

## 0.17.0 — 2026-11-09

- Nieuw uiterlijk van de beheerpagina.

## 0.16.0 — 2026-11-09

- Highlights spelen één keer en daarna elke tien minuten opnieuw (instelbaar).

## 0.15.1 — 2026-11-09

- Highlight-tegels blijven staan tot een andere highlight hun plek inneemt.

## 0.15.0 — 2026-11-09

- Vijf highlights tegelijk op de tv; drempel voor de selectie instelbaar.

## 0.14.0 — 2026-11-09

- Ook vragen over fietsen en scooters; één schrijfwijze per persoon.

## 0.13.1 — 2026-11-09

- De AI gebruikt jouw antwoord in de beschrijving ("Tineke loopt naar de container").

## 0.13.0 — 2026-11-09

- Leren van antwoorden: Frigate leert gezichten, highlights worden opnieuw beschreven, bekende mensen tellen minder zwaar.

## 0.12.0 — 2026-11-09

- Kleinere highlight naast de camera's; enkele foutjes opgelost.

## 0.11.1 — 2026-11-08

- Feiten alleen over vaste kenmerken, niet over één situatie.

## 0.11.0 — 2026-11-08

- Feiten voor de AI ontstaan automatisch uit beantwoorde vragen.

## 0.10.0 — 2026-11-08

- Nieuwe pagina Beheer → Vragen: het systeem vraagt wat het nog niet weet en doet suggesties.

## 0.9.0 — 2026-11-08

- De beheerpagina heeft tabbladen.

## 0.8.1 — 2026-11-08

- De AI kijkt naar een beeld uit de 4K-opname.

## 0.8.0 — 2026-11-08

- Feiten over het huishouden helpen de AI bij beschrijvingen.

## 0.7.0 — 2026-11-08

- Tv's herstellen zichzelf en laden na een update vanzelf opnieuw; monitoring per camera; highlights leren van 👍/👎.

## 0.6.0 — 2026-11-08

- Frigate wordt via een eigen account met inlog gelezen.

## 0.5.1 — 2026-11-08

- Lichter AI-model voor de beschrijvingen.

## 0.5.0 — 2026-11-08

- AI-beschrijvingen van highlights.

## 0.4.0 — 2026-11-08

- Highlights: de interessantste gebeurtenissen van de dag op de tv, en een archief.

## 0.3.1 — 2026-11-08

- Datumbalk vrij van de tegels op staande schermen.

## 0.3.0 — 2026-11-08

- Eén adres voor iedereen (uitkijk.mrmevius.nl) met inlog; sessies verlopen niet.

## 0.2.1 — 2026-11-08

- Live-status werkt via de publieke route; muiscursor zichtbaar zodra de muis beweegt.

## 0.2.0 — 2026-11-08

- Inloggen voor toegang van buiten het thuisnetwerk.

## 0.1.0 — 2026-11-08

- Eerste versie: live camerabeelden op de tv, met focus op camera's met een alert.

/** What kind of vehicle the AI described, for the question title and the label on the highlight. */
export type VehicleNoun = 'auto' | 'fiets' | 'scooter' | 'motor';

export function vehicleNoun(description: string): VehicleNoun {
  const d = description.toLowerCase();
  if (/motor(fiets)?\b|motorrijder/.test(d)) return 'motor';
  if (/scooter|brommer|snorfiets|bromfiets/.test(d)) return 'scooter';
  if (/fiets|bike|bicycle/.test(d)) return 'fiets';
  return 'auto';
}

/** Lower-case words only, so small differences in the AI's wording ask one question per vehicle. */
export const normalizeVehicle = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const BRANDS = [
  'alfa romeo', 'audi', 'bmw', 'byd', 'citroen', 'citroën', 'cupra', 'dacia', 'ds', 'fiat', 'ford', 'honda', 'hyundai', 'iveco', 'jaguar',
  'jeep', 'kia', 'land rover', 'lexus', 'lynk', 'mazda', 'mercedes-benz', 'mercedes', 'mg', 'mini', 'mitsubishi', 'nissan', 'opel',
  'peugeot', 'polestar', 'porsche', 'renault', 'seat', 'skoda', 'škoda', 'smart', 'subaru', 'suzuki', 'tesla', 'toyota', 'volkswagen',
  'vw', 'volvo', 'gazelle', 'batavus', 'sparta', 'cortina', 'vanmoof', 'stromer', 'cube', 'giant', 'trek', 'vespa', 'piaggio', 'yamaha',
  'kymco', 'sym', 'niu',
];
// Brands are plain words (letters, spaces, dashes): nothing to escape.
const BRAND = new RegExp(`(?<![\\p{L}])(${BRANDS.join('|')})(?![\\p{L}])\\s*([\\p{L}\\p{N}]+)?`, 'iu');
/** Dutch plates: three groups with dashes ("G-929-VD", "96-NBF-1"). */
const PLATE = /\b[A-Z0-9]{1,3}-[A-Z0-9]{2,3}-[A-Z0-9]{1,3}\b/gi;
/** Vehicles that are recognisable without a make: a van with ladders is not "a dark car". */
export const DISTINCT_BODY = /bestel|busje|bus\b|vrachtwagen|camper|caravan|aanhanger|tractor|trekker|pick-?up|taxi|politie|ambulance|logo|opschrift|reclame|belettering/i;

/** Make and model ("volkswagen up"), lower case, or null when the AI named no make. */
export function makeModel(description: string): string | null {
  const m = BRAND.exec(description);
  if (!m) return null;
  const brand = m[1]!.toLowerCase().replace('mercedes-benz', 'mercedes').replace(/^vw$/, 'volkswagen').replace('citroën', 'citroen').replace('škoda', 'skoda');
  const model = (m[2] ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return model ? `${brand} ${model}` : brand;
}

/**
 * A plate Frigate read that can be real: four characters or more with a digit, upper case without dashes or spaces.
 * Frigate once read "SCHUUR" from the shed; Dutch plates always have a digit. One rule everywhere since 0.31.0 (the
 * importer, the questions and the AI each had their own before).
 */
export const realPlates = (plates: string[]): string[] =>
  [...new Set(plates.map((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, '')))].filter((p) => p.length >= 4 && /\d/.test(p));

/** Plates in a description, upper case without dashes. */
export const platesIn = (description: string) => [...description.matchAll(PLATE)].map((m) => m[0].toUpperCase().replace(/-/g, ''));

/** One misread character apart (OCR and the AI confuse 0 and 9, B and 8): "G029VD" is "G929VD". */
export function platesClose(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (s.length === l.length) i++;
    j++;
  }
  return edits + (l.length - j) + (s.length - i) <= 1;
}

/**
 * A vehicle the owner already told about (since 0.27.0): a plate one character from a known plate, or the same make
 * and model as a known vehicle ("zwarte Volkswagen up!" after "donkere Volkswagen up! is van Noëlle"). The colour is
 * not compared: the AI calls the same car black, dark or dark grey depending on the light.
 */
export function knownVehicle(description: string, plates: string[], knownTexts: string[]): boolean {
  const ownPlates = [...new Set([...plates, ...platesIn(description)])];
  const own = makeModel(description);
  return knownTexts.some((text) => {
    if (ownPlates.some((p) => platesIn(text).some((k) => platesClose(p, k)))) return true;
    const known = makeModel(text);
    return own !== null && known !== null && own.includes(' ') && own === known;
  });
}

/** Never asked about: no owner to learn ("fiets" alone is too vague to recognise the bicycle later). */
export function askableVehicle(description: string, plates: string[] = []): boolean {
  if (/\b(step|skateboard|stoep|kinderwagen|rolstoel)\w*/i.test(description)) return false;
  // Things on wheels that are not vehicles (the AI listed two wheelie bins as vehicles on 2026-11-11).
  if (/(container|kliko|vuilnisbak|afvalbak|kruiwagen|bolderkar)/i.test(description)) return false;
  // The AI sometimes says itself that it cannot tell the vehicle apart ("merk en model niet duidelijk herkenbaar").
  // A plate that is not legible is fine when make and model are known ("grijze Volvo V60, kenteken niet leesbaar").
  if (/(merk|model)[^,.;]*\bniet\b|niet (goed |duidelijk )?(herkenbaar|te herkennen)|onherkenbaar|onduidelijk/i.test(description)) return false;
  // Mostly out of view: nothing to recognise it by next time (8 of 17 dismissed vehicle questions until 2026-11-11).
  if (/(deels|grotendeels|gedeeltelijk|half) (verborgen|zichtbaar|in beeld)|achter de|nauwelijks zichtbaar/i.test(description)) return false;
  // A car without make or plate ("donkere sedan", "grijze hatchback") looks like many others; vans, bicycles and
  // vehicles with lettering stay askable.
  if (vehicleNoun(description) === 'auto' && !makeModel(description) && !plates.length && !platesIn(description).length && !DISTINCT_BODY.test(description)) {
    return false;
  }
  return normalizeVehicle(description).split(' ').length >= 2;
}

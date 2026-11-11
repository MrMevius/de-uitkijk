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

/** Never asked about: no owner to learn ("fiets" alone is too vague to recognise the bicycle later). */
export function askableVehicle(description: string): boolean {
  if (/\b(step|skateboard|stoep|kinderwagen|rolstoel)\w*/i.test(description)) return false;
  // Things on wheels that are not vehicles (the AI listed two wheelie bins as vehicles on 2026-11-11).
  if (/(container|kliko|vuilnisbak|afvalbak|kruiwagen|bolderkar)/i.test(description)) return false;
  // The AI sometimes says itself that it cannot tell the vehicle apart ("merk en model niet duidelijk herkenbaar").
  // A plate that is not legible is fine when make and model are known ("grijze Volvo V60, kenteken niet leesbaar").
  if (/(merk|model)[^,.;]*\bniet\b|niet (goed |duidelijk )?(herkenbaar|te herkennen)|onherkenbaar|onduidelijk/i.test(description)) return false;
  return normalizeVehicle(description).split(' ').length >= 2;
}

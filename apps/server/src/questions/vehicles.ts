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
  return normalizeVehicle(description).split(' ').length >= 2;
}

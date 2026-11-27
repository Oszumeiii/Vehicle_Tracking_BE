/**
 * Brazilian plates of one vehicle: converting an old plate (LLLNNNN) to Mercosul (LLLNLNN)
 * turns the fifth character's digit d into the letter 'A'+d (ABC1234 -> ABC1C34).
 */

/** A 7-character plate's fifth letter A-J as its digit (ABC1C34 -> ABC1234). */
export function plateMercosul(text: string) {
  const plate = text.toUpperCase();
  return plate.length === 7 && plate[4] >= 'A' && plate[4] <= 'J'
    ? plate.slice(0, 4) + String.fromCharCode(plate.charCodeAt(4) - 17) + plate.slice(5)
    : plate;
}

/** Every spelling with the plate's plateMercosul(): as typed, and the other Brazilian format. */
export function plateTwins(plate: string) {
  if (plate.length !== 7) return [plate];
  const digit = plateMercosul(plate);
  const fifth = digit[4];
  if (fifth < '0' || fifth > '9') return [plate];
  return [
    digit,
    digit.slice(0, 4) + String.fromCharCode(fifth.charCodeAt(0) + 17) + digit.slice(5),
  ];
}

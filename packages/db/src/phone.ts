/**
 * A phone number as typed on the join form ("55 1234 5678", "+52 1 55…", "(312) 555-0101") → E.164, or undefined.
 * Without a "+", ten digits are Mexican and eleven starting with 1 are US/Canada; Mexico's old mobile "1" after +52
 * is dropped, so the same phone always gives the same number.
 */
export function normalizePhone(raw: string, defaultCountry = "52"): string | undefined {
  const plus = raw.trim().startsWith("+") || raw.trim().startsWith("00");
  let digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("00")) digits = digits.slice(2);
  if (!plus) {
    if (digits.length === 10) digits = defaultCountry + digits;
    else if (digits.length === 11 && digits.startsWith("1")) {
      // already +1 with its country code
    }    else if (!(digits.startsWith("52") && (digits.length === 12 || (digits.length === 13 && digits[2] === "1")))) return undefined;
  }
  if (digits.startsWith("521") && digits.length === 13) digits = `52${digits.slice(3)}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
}

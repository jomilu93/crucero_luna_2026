import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone.js";

describe("normalizePhone", () => {
  it("turns what people type into one E.164 number per phone", () => {
    expect(normalizePhone("55 1234 5678")).toBe("+525512345678");
    expect(normalizePhone("(55) 1234-5678")).toBe("+525512345678");
    expect(normalizePhone("+52 1 55 1234 5678")).toBe("+525512345678");
    expect(normalizePhone("5215512345678")).toBe("+525512345678");
    expect(normalizePhone("+52 55 1234 5678")).toBe("+525512345678");
    expect(normalizePhone("1 312 555 0101")).toBe("+13125550101");
    expect(normalizePhone("+1 (312) 555-0101")).toBe("+13125550101");
    expect(normalizePhone("0034 612 345 678")).toBe("+34612345678");
    expect(normalizePhone("312 555 0101", "1")).toBe("+13125550101");
    expect(normalizePhone("12345")).toBeUndefined();
    expect(normalizePhone("")).toBeUndefined();
  });
});

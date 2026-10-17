import { describe, expect, it } from "vitest";
import { addDays, dayBounds, inQuietHours, mx, prettyTime, shipDate, shipTime } from "./time.js";

describe("ship clock (fixed UTC-6)", () => {
  it("converts ship-local wall time to a UTC instant", () => {
    expect(mx("2026-12-31", "20:00")).toBe("2027-01-01T02:00:00.000Z");
  });
  it("round-trips date and time", () => {
    const iso = mx("2026-12-28", "07:00");
    expect(shipDate(iso)).toBe("2026-12-28");
    expect(shipTime(iso)).toBe("07:00");
  });
  it("formats friendly times", () => {
    expect(prettyTime(mx("2026-12-27", "07:00"))).toBe("7:00 am");
    expect(prettyTime(mx("2026-12-27", "20:30"), "en")).toBe("8:30 PM");
  });
  it("computes day bounds and day arithmetic across the new year", () => {
    const { from, to } = dayBounds("2026-12-31");
    expect(from).toBe("2026-12-31T06:00:00.000Z");
    expect(to).toBe("2027-01-01T06:00:00.000Z");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -6)).toBe("2026-12-26");
  });
  it("detects quiet hours that wrap midnight", () => {
    const q = { start: "22:00", end: "08:00" };
    expect(inQuietHours(mx("2026-12-27", "23:30"), q)).toBe(true);
    expect(inQuietHours(mx("2026-12-27", "07:59"), q)).toBe(true);
    expect(inQuietHours(mx("2026-12-27", "08:00"), q)).toBe(false);
    expect(inQuietHours(mx("2026-12-27", "15:00"), q)).toBe(false);
    expect(inQuietHours(mx("2026-12-27", "15:00"), undefined)).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(() => mx("2026-1-1", "07:00")).toThrow();
    expect(() => mx("2026-12-27", "7:00")).toThrow();
  });
});

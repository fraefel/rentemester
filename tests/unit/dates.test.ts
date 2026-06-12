// Tests: src/core/dates.ts
import { describe, expect, test } from "bun:test";
import { isValidIsoDate, addDays, diffDays, daysBetween, todayIsoDate, isoDateInTimeZone } from "../../src/core/dates";

describe("ISO date validation", () => {
  test("accepts real calendar dates including leap day", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-05-16")).toBe(true);
  });

  test("rejects impossible calendar dates even when the format matches", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2025-04-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-00")).toBe(false);
  });
});

describe("addDays", () => {
  test("adds days within a month", () => {
    expect(addDays("2026-05-16", 5)).toBe("2026-05-21");
  });

  test("crosses a year boundary", () => {
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
  });

  test("handles leap-year February", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
  });

  test("handles non-leap-year February", () => {
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
  });

  test("supports negative day offsets across a year boundary", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("diffDays", () => {
  test("returns signed difference (to - from)", () => {
    expect(diffDays("2026-05-16", "2026-05-21")).toBe(5);
  });

  test("returns a negative diff when toDate precedes fromDate", () => {
    expect(diffDays("2026-05-21", "2026-05-16")).toBe(-5);
  });

  test("counts across a year boundary", () => {
    expect(diffDays("2025-12-31", "2026-01-01")).toBe(1);
  });

  test("counts leap day in the span", () => {
    expect(diffDays("2024-02-28", "2024-03-01")).toBe(2);
    expect(diffDays("2025-02-28", "2025-03-01")).toBe(1);
  });

  test("is zero for identical dates", () => {
    expect(diffDays("2026-05-16", "2026-05-16")).toBe(0);
  });
});

describe("daysBetween", () => {
  test("returns the absolute distance regardless of order", () => {
    expect(daysBetween("2026-05-16", "2026-05-21")).toBe(5);
    expect(daysBetween("2026-05-21", "2026-05-16")).toBe(5);
  });

  test("counts across a year boundary and leap day", () => {
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });
});

describe("todayIsoDate", () => {
  test("honours the RENTEMESTER_TODAY override", () => {
    const previous = process.env.RENTEMESTER_TODAY;
    process.env.RENTEMESTER_TODAY = "2026-05-20";
    try {
      expect(todayIsoDate()).toBe("2026-05-20");
    } finally {
      if (previous === undefined) delete process.env.RENTEMESTER_TODAY;
      else process.env.RENTEMESTER_TODAY = previous;
    }
  });

  test("returns a valid ISO date when no override is set", () => {
    const previous = process.env.RENTEMESTER_TODAY;
    delete process.env.RENTEMESTER_TODAY;
    try {
      expect(isValidIsoDate(todayIsoDate())).toBe(true);
    } finally {
      if (previous !== undefined) process.env.RENTEMESTER_TODAY = previous;
    }
  });

  test("without override, today equals the Copenhagen calendar date, not the UTC one (KODE-11)", () => {
    const previous = process.env.RENTEMESTER_TODAY;
    delete process.env.RENTEMESTER_TODAY;
    try {
      expect(todayIsoDate()).toBe(isoDateInTimeZone(new Date(), "Europe/Copenhagen"));
    } finally {
      if (previous !== undefined) process.env.RENTEMESTER_TODAY = previous;
    }
  });
});

describe("isoDateInTimeZone (KODE-11 — 'i dag' i dansk tid, ikke UTC)", () => {
  test("just before UTC midnight in summer (CEST, UTC+2) Copenhagen is already on the next day", () => {
    expect(isoDateInTimeZone(new Date("2026-06-11T22:30:00Z"), "Europe/Copenhagen")).toBe("2026-06-12");
  });

  test("just before UTC midnight in winter (CET, UTC+1) Copenhagen is already on the next day", () => {
    expect(isoDateInTimeZone(new Date("2026-01-15T23:30:00Z"), "Europe/Copenhagen")).toBe("2026-01-16");
  });

  test("mid-day the Copenhagen date and the UTC date agree", () => {
    expect(isoDateInTimeZone(new Date("2026-06-11T10:00:00Z"), "Europe/Copenhagen")).toBe("2026-06-11");
  });

  test("crosses a year boundary on New Year's Eve", () => {
    expect(isoDateInTimeZone(new Date("2025-12-31T23:30:00Z"), "Europe/Copenhagen")).toBe("2026-01-01");
  });

  test("defaults to Europe/Copenhagen when no timezone is given", () => {
    expect(isoDateInTimeZone(new Date("2026-06-11T22:30:00Z"))).toBe("2026-06-12");
  });
});

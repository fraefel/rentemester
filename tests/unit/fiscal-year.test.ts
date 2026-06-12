// Tests: src/core/fiscal-year.ts
import { describe, expect, test } from "bun:test";
import { fiscalYearForDate, annualReportDeadline } from "../../src/core/fiscal-year";

describe("fiscal year helper", () => {
  test("derives start, end, and labels for offset fiscal years", () => {
    const fy = fiscalYearForDate("2026-07-15", 7, "span");
    expect(fy).toEqual({
      startYear: 2026,
      endYear: 2027,
      start: "2026-07-01",
      end: "2027-06-30",
      displayLabel: "2026/27",
      identifierLabel: "2026-27",
    });
  });
});

describe("annualReportDeadline (ÅRL § 138 — 6 måneder efter regnskabsårets udløb)", () => {
  test("calendar fiscal year: 31/12 files by 30/6 the following year", () => {
    expect(annualReportDeadline("2026-12-31")).toBe("2027-06-30");
  });

  test("offset fiscal year ending 30/6 files by 31/12 (end-of-month preserved)", () => {
    expect(annualReportDeadline("2027-06-30")).toBe("2027-12-31");
  });

  test("fiscal year ending 31/8 files by 28/2 (clamped into February)", () => {
    expect(annualReportDeadline("2026-08-31")).toBe("2027-02-28");
  });

  test("February clamp respects leap years", () => {
    expect(annualReportDeadline("2027-08-31")).toBe("2028-02-29");
  });

  test("rejects an invalid date", () => {
    expect(() => annualReportDeadline("2026-13-01")).toThrow();
  });
});

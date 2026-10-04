import { ageInDays, parsePostedDate, toDateOnlyIso } from './date.util';

describe('toDateOnlyIso', () => {
  it('round-trips a date-only string stably regardless of the local timezone', () => {
    // parsePostedDate builds its Date from LOCAL calendar fields
    // (new Date(year, month, day)) — mirror that construction here rather
    // than hardcoding a UTC timestamp, so this test's assertion holds no
    // matter which timezone the test runner is in (this environment happens
    // to run in IST / UTC+5:30, which is exactly the kind of "ahead of UTC"
    // zone that exposed the bug: toISOString() converts to UTC first, which
    // walks the date back by one calendar day).
    const parsed = parsePostedDate('2026-09-15');
    expect(parsed).not.toBeNull();

    expect(toDateOnlyIso(parsed!)).toBe('2026-09-15');
  });

  it('formats from local calendar fields, not from a UTC conversion', () => {
    // Constructed directly via local-field Date(), the same way
    // parsePostedDate does internally for an ISO-shaped date string.
    const localDate = new Date(2026, 0, 1); // Jan 1, 2026, local midnight
    expect(toDateOnlyIso(localDate)).toBe('2026-01-01');
  });

  it('zero-pads single-digit month and day', () => {
    const localDate = new Date(2026, 2, 5); // March 5, 2026
    expect(toDateOnlyIso(localDate)).toBe('2026-03-05');
  });
});

describe('ageInDays', () => {
  it('computes whole-day age between two local dates', () => {
    const posted = new Date(2026, 8, 10);
    const reference = new Date(2026, 8, 15);
    expect(ageInDays(posted, reference)).toBe(5);
  });
});

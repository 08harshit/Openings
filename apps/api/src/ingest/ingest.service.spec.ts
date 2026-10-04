import { isExcludedCompany } from './ingest.service';

describe('company exclusion filtering', () => {
  it('excludes a company matching an excluded name case-insensitively', () => {
    expect(isExcludedCompany('Razorpay', ['razorpay'])).toBe(true);
    expect(isExcludedCompany('razorpay', ['Razorpay'])).toBe(true);
    expect(isExcludedCompany('RAZORPAY', ['Razorpay'])).toBe(true);
  });

  it('does not exclude a company not on the list', () => {
    expect(isExcludedCompany('Zerodha', ['Razorpay'])).toBe(false);
  });

  it('treats an empty exclusion list as excluding nothing', () => {
    expect(isExcludedCompany('Razorpay', [])).toBe(false);
  });
});

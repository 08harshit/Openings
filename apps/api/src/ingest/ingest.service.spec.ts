import { describeEmptyProfileWarning, filterOutExcludedCompanies, isExcludedCompany } from './ingest.service';

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

describe('filterOutExcludedCompanies', () => {
  it('drops an already-known company matching an excluded name, not just newly discovered ones', () => {
    const companies = [{ name: 'Razorpay' }, { name: 'Zerodha' }];
    const kept = filterOutExcludedCompanies(companies, ['razorpay']);
    expect(kept.map((c) => c.name)).toEqual(['Zerodha']);
  });

  it('keeps every company when the exclusion list is empty', () => {
    const companies = [{ name: 'Razorpay' }, { name: 'Zerodha' }];
    expect(filterOutExcludedCompanies(companies, []).map((c) => c.name)).toEqual(['Razorpay', 'Zerodha']);
  });
});

describe('describeEmptyProfileWarning', () => {
  it('warns when target_roles is empty — an empty allow-list would silently reject every job', () => {
    const warning = describeEmptyProfileWarning({ target_roles: [], preferred_locations: ['india'] });
    expect(warning).toMatch(/target_roles/);
  });

  it('warns when preferred_locations is empty — an empty allow-list would silently reject every job', () => {
    const warning = describeEmptyProfileWarning({ target_roles: ['backend'], preferred_locations: [] });
    expect(warning).toMatch(/preferred_locations/);
  });

  it('returns null when both lists are populated', () => {
    expect(describeEmptyProfileWarning({ target_roles: ['backend'], preferred_locations: ['india'] })).toBeNull();
  });
});

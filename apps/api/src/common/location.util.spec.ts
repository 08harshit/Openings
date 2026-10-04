import { isIndiaOrRemote } from './location.util';

const PREFERRED_LOCATIONS = [
  'india',
  'bangalore', 'bengaluru', 'mumbai', 'bombay', 'delhi', 'new delhi', 'ncr',
  'gurgaon', 'gurugram', 'noida', 'pune', 'hyderabad', 'chennai', 'madras',
  'kolkata', 'calcutta', 'ahmedabad', 'kochi', 'cochin', 'coimbatore',
  'jaipur', 'chandigarh', 'indore', 'thane', 'navi mumbai',
  ' in)', '(in)', ', in',
  'remote', 'work from home', 'wfh', 'anywhere', 'distributed team', 'fully distributed',
];

describe('isIndiaOrRemote', () => {
  it('accepts a known Indian city', () => {
    expect(isIndiaOrRemote('Bangalore, India', PREFERRED_LOCATIONS)).toBe(true);
  });

  it('accepts a remote posting', () => {
    expect(isIndiaOrRemote('Fully Remote', PREFERRED_LOCATIONS)).toBe(true);
  });

  it('rejects a non-preferred location', () => {
    expect(isIndiaOrRemote('San Francisco, CA', PREFERRED_LOCATIONS)).toBe(false);
  });

  it('rejects "Remote (US only)" — a non-India-qualified remote posting', () => {
    expect(isIndiaOrRemote('Remote (US only)', PREFERRED_LOCATIONS)).toBe(false);
  });

  it('rejects an unknown/missing location', () => {
    expect(isIndiaOrRemote(null, PREFERRED_LOCATIONS)).toBe(false);
    expect(isIndiaOrRemote(undefined, PREFERRED_LOCATIONS)).toBe(false);
    expect(isIndiaOrRemote('', PREFERRED_LOCATIONS)).toBe(false);
  });

  it('rejects every location when preferredLocations is empty (no silent wildcard accept)', () => {
    expect(isIndiaOrRemote('Bangalore, India', [])).toBe(false);
    expect(isIndiaOrRemote('Remote', [])).toBe(false);
  });
});

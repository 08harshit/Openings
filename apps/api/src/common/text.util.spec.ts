import { containsWord } from './text.util';

describe('containsWord', () => {
  it('matches a whole word case-insensitively', () => {
    expect(containsWord('Senior Backend Engineer', 'backend')).toBe(true);
  });

  it('does not match inside a longer word', () => {
    expect(containsWord('Internal Tools Engineer', 'intern')).toBe(false);
  });

  it('does not match "swe" inside "Swedish"', () => {
    expect(containsWord('Account Development Representative (Swedish Speaking)', 'swe')).toBe(false);
  });

  it('never matches a blank marker', () => {
    expect(containsWord('Anything at all', '   ')).toBe(false);
    expect(containsWord('Anything at all', '')).toBe(false);
  });
});

import { applyFloor, orderByScore, selectTopN, type Rankable } from './select';

const key = (r: Rankable): Rankable => r;

describe('applyFloor', () => {
  it('keeps items at or above the floor', () => {
    const items = [{ score: 39 }, { score: 40 }, { score: 90 }];
    expect(applyFloor(items, 40)).toEqual([{ score: 40 }, { score: 90 }]);
  });
});

describe('orderByScore', () => {
  it('orders by score descending', () => {
    const items: Rankable[] = [
      { score: 50, postedDateIso: null, title: 'B' },
      { score: 90, postedDateIso: null, title: 'A' },
    ];
    expect(orderByScore(items, key).map((i) => i.score)).toEqual([90, 50]);
  });

  it('breaks score ties by fresher date, with missing dates last', () => {
    const items: Rankable[] = [
      { score: 70, postedDateIso: null, title: 'No date' },
      { score: 70, postedDateIso: '2026-09-01', title: 'Older' },
      { score: 70, postedDateIso: '2026-10-01', title: 'Newer' },
    ];
    expect(orderByScore(items, key).map((i) => i.title)).toEqual(['Newer', 'Older', 'No date']);
  });

  it('breaks remaining ties by title', () => {
    const items: Rankable[] = [
      { score: 70, postedDateIso: null, title: 'Zeta' },
      { score: 70, postedDateIso: null, title: 'Alpha' },
    ];
    expect(orderByScore(items, key).map((i) => i.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('does not mutate the input', () => {
    const items: Rankable[] = [
      { score: 10, postedDateIso: null, title: 'A' },
      { score: 20, postedDateIso: null, title: 'B' },
    ];
    orderByScore(items, key);
    expect(items[0].score).toBe(10);
  });
});

describe('selectTopN', () => {
  it('returns the best N', () => {
    const items: Rankable[] = [10, 80, 50, 90].map((score) => ({ score, postedDateIso: null, title: String(score) }));
    expect(selectTopN(items, 2, key).map((i) => i.score)).toEqual([90, 80]);
  });

  it('returns an empty list for N <= 0', () => {
    expect(selectTopN([{ score: 1, postedDateIso: null, title: 'x' }], 0, key)).toEqual([]);
  });
});

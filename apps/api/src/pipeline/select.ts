/** What ordering needs to know about any scored item. */
export interface Rankable {
  score: number;
  postedDateIso: string | null;
  title: string;
}

export function applyFloor<T extends { score: number }>(items: readonly T[], floor: number): T[] {
  return items.filter((item) => item.score >= floor);
}

/** Best score first; ties go to the fresher posting (missing dates last),
 * then alphabetical title, so ordering is stable across runs. */
export function orderByScore<T>(items: readonly T[], key: (item: T) => Rankable): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (kb.score !== ka.score) return kb.score - ka.score;
    const da = ka.postedDateIso ?? '';
    const db = kb.postedDateIso ?? '';
    if (da !== db) return db.localeCompare(da);
    return ka.title.localeCompare(kb.title);
  });
}

export function selectTopN<T>(items: readonly T[], n: number, key: (item: T) => Rankable): T[] {
  return orderByScore(items, key).slice(0, Math.max(0, n));
}

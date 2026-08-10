/*
 * Bundled-dictionary loader. Wraps the 386k-word list (public/assets/words.txt,
 * sourced from KnockBox.WordService/Data/full-dictionary.csv) in a Set for O(1)
 * validation plus a first-letter index used by bots and the chain rule.
 */

export class Dictionary {
  private readonly wordSet: Set<string>;
  private readonly byFirst = new Map<string, string[]>();

  constructor(words: Iterable<string>) {
    this.wordSet = words instanceof Set ? words : new Set(words);
    for (const w of this.wordSet) {
      if (w.length === 0) continue;
      const first = w[0];
      let bucket = this.byFirst.get(first);
      if (!bucket) {
        bucket = [];
        this.byFirst.set(first, bucket);
      }
      bucket.push(w);
    }
  }

  /** Fetch + parse the bundled word list. Browser-only (uses fetch). */
  static async load(url: string): Promise<Dictionary> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load dictionary: ${res.status}`);
    const text = await res.text();
    const words = text
      .split(/\r?\n/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 0);
    return new Dictionary(words);
  }

  get size(): number {
    return this.wordSet.size;
  }

  has(word: string): boolean {
    return this.wordSet.has(word.trim().toLowerCase());
  }

  /** All words beginning with `letter` (lowercased). Empty array if none. */
  wordsStartingWith(letter: string): readonly string[] {
    return this.byFirst.get(letter.toLowerCase()) ?? [];
  }

  /** Every word, in insertion (file) order. Used by `dictionaryWordPool` to build the
   *  length-bucketed view the Picker's Offer generator draws against — enumerating via
   *  `wordsStartingWith` over a-z would silently drop any non-alpha entry instead. */
  words(): Iterable<string> {
    return this.wordSet;
  }
}

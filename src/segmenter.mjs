export function segmenterImports(values) {
  return {
    new(locale, granularity) {
      let segmenter;
      try {
        segmenter = new Intl.Segmenter(values.get(locale) || undefined, {
          granularity: ["grapheme", "word", "sentence"][granularity],
        });
      } catch (error) {
        if (error instanceof RangeError) return 0;
        throw error;
      }
      return values.put(segmenter);
    },
    segment: (id, text) =>
      values.put(values.get(id).segment(values.get(text))[Symbol.iterator]()),
    text: (id) => values.put(values.get(id).segment),
    index: (id) => values.get(id).index,
    "word-like": (id) => {
      const word = values.get(id).isWordLike;
      return word === undefined ? 2 : +word;
    },
  };
}

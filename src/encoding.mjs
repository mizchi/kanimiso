export function encodingImports(values) {
  return {
    new(encoding) {
      let decoder;
      try {
        decoder = new TextDecoder(values.get(encoding), {
          fatal: true,
          ignoreBOM: true,
        });
      } catch (error) {
        if (error instanceof RangeError) return 0;
        throw error;
      }
      return values.put(decoder);
    },
    decode(id, ptr, len) {
      const input = new Uint8Array(
        values.memory().buffer,
        ptr >>> 0,
        len >>> 0,
      );
      let text;
      try {
        text = values.get(id).decode(input);
      } catch (error) {
        if (error instanceof TypeError) return 0;
        throw error;
      }
      return values.put(text);
    },
  };
}

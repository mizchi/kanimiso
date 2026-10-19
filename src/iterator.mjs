export function iteratorImports(values) {
  return {
    next(id) {
      try {
        const item = values.get(id).next();
        return item.done ? 0 : values.put(item.value);
      } catch (error) {
        values.take(id);
        throw error;
      }
    },
    close(id) {
      // Retire the root before calling user code, including a throwing return().
      values.take(id).return?.();
    },
  };
}

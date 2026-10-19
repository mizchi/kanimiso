export function createIO() {
  return {
    requests: [],
    defer(a, b) {
      this.requests.push([a, b]);
      return Promise.resolve((a + b) | 0);
    },
  };
}

export const add = (a, b) => Promise.resolve((a + b) | 0);

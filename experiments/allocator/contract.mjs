export const cases = [
  { id: 0, name: "boundary", rounds: 1, jobs: 1 },
  { id: 1, name: "pair_32", rounds: 256, jobs: 256 },
  { id: 2, name: "pair_1024", rounds: 256, jobs: 256 },
  { id: 3, name: "aligned_4096", rounds: 256, jobs: 256 },
  { id: 4, name: "burst_fifo", rounds: 8, jobs: 256 },
  { id: 5, name: "burst_lifo", rounds: 8, jobs: 256 },
  { id: 6, name: "grow_realloc", rounds: 8, jobs: 256 },
  { id: 7, name: "coalesce", rounds: 64, jobs: 256 },
  { id: 8, name: "realloc_same_word", rounds: 256, jobs: 256 },
];
export function expected(id, rounds, seed) {
  if (id === 0) return seed >>> 0;
  if (!Number.isInteger(id) || id < 1 || id > 8)
    throw Error("unknown workload");
  let sum = 0;
  const jobs = rounds * (id >= 4 && id <= 6 ? 32 : id === 7 ? 4 : 1);
  for (let i = 0; i < jobs; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    sum = (sum + (seed & 255)) >>> 0;
  }
  return sum;
}

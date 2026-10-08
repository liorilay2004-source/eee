import { expect, it } from "vitest";
import { runCollectionQueue } from "../src/collection-queue";

it("keeps browser concurrency at two and continues after failures", async () => {
  let active = 0, maximum = 0;
  const completed: number[] = [];
  await runCollectionQueue(Array.from({ length: 6 }, (_, i) => async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; completed.push(i);
    if (i === 1) throw new Error("source unavailable");
  }));
  expect(maximum).toBe(2);
  expect(completed.sort()).toEqual([0, 1, 2, 3, 4, 5]);
});

it("continues after a synchronous source failure", async () => {
  let reached = false;
  await runCollectionQueue([() => { throw new Error("failed"); }, async () => {}, async () => { reached = true; }]);
  expect(reached).toBe(true);
});

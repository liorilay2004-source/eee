/** Limit simultaneous browser collectors; a failed source must not prevent later sources. */
export async function runCollectionQueue(jobs: Array<() => Promise<unknown>>): Promise<void> {
  for (let offset = 0; offset < jobs.length; offset += 2) {
    await Promise.allSettled(jobs.slice(offset, offset + 2).map(job => Promise.resolve().then(job)));
  }
}

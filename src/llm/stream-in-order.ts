/**
 * Print each task's result as soon as it's ready, in declared order, but
 * without letting a slow task hold up faster ones behind it forever: if the
 * next-in-line task hasn't settled within `graceMs`, print whichever later
 * task is ready instead and come back for the skipped one once it settles.
 */
export async function streamInOrder(
  tasks: Array<() => Promise<string>>,
  graceMs: number,
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): Promise<void> {
  const n = tasks.length;
  const done: boolean[] = Array.from({ length: n }, () => false);
  const printed: boolean[] = Array.from({ length: n }, () => false);
  const text: (string | undefined)[] = Array.from({ length: n }, () => undefined);
  const settle = tasks.map((task, i) =>
    task().then(
      (value) => {
        text[i] = value;
        done[i] = true;
      },
      (error) => {
        text[i] = `Error: ${error instanceof Error ? error.message : String(error)}`;
        done[i] = true;
      },
    ),
  );
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const firstUnprinted = (): number => {
    for (let i = 0; i < n; i++) if (!printed[i]) return i;
    return -1;
  };
  const firstReadyFrom = (start: number): number => {
    for (let i = start; i < n; i++) if (!printed[i] && done[i]) return i;
    return -1;
  };
  const print = (i: number): void => {
    write(`\n${text[i]}\n`);
    printed[i] = true;
  };

  let remaining = n;
  while (remaining > 0) {
    const head = firstUnprinted();
    if (done[head]) {
      print(head);
      remaining--;
      continue;
    }
    await Promise.race([settle[head], delay(graceMs)]);
    if (done[head]) continue; // re-check on the next loop iteration
    const readyLater = firstReadyFrom(head + 1);
    if (readyLater !== -1) {
      print(readyLater);
      remaining--;
      continue;
    }
    // Nothing at all is ready yet — wait for whichever pending task finishes next.
    await Promise.race(settle.filter((_, i) => !printed[i]));
  }
}

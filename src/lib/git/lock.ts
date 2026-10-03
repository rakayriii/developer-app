const locks = new Map<string, Promise<void>>();
export async function withGitMutation<T>(repositoryRoot: string, operation: () => Promise<T>) {
  const previous = locks.get(repositoryRoot) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(repositoryRoot, current);
  await previous;
  try { return await operation(); } finally { release(); if (locks.get(repositoryRoot) === current) locks.delete(repositoryRoot); }
}

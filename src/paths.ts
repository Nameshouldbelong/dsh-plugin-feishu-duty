import path from 'node:path'

/** Resolve the plugin data dir to an absolute path: explicit config wins; else $DSH_HOME; else ~/.dsh. */
export function resolveDataDir(configured: string | undefined, env: { DSH_HOME?: string }, homeDir: string): string {
  if (configured !== undefined && configured.trim() !== '') return path.resolve(configured)
  const base = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : path.join(homeDir, '.dsh')
  return path.resolve(path.join(base, 'storages', 'feishu-duty'))
}

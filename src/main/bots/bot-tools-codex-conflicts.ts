// Codex adds a thread's server keys to the server it already loads under that name, and no thread
// key removes one. So a URL over a command, or a command over a URL, fails the whole thread
// ("url is not supported for stdio in `mcp_servers.<name>`"). These keep such a server out.
import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { isCodexAppServerRequestError } from '../codex/app-server/codex-app-server-request-error'
import type { CodexAppServerRpc } from '../codex/app-server/codex-app-server-session'
import type { BotToolServer } from '../../shared/bot-tools'

export type CodexServerKind = 'command' | 'url'

const CONFIG_READ_TIMEOUT_MS = 10_000
/** The key that says how a thread's server runs: a command (stdio) or a URL. */
const SERVER_KIND_KEY = /^mcp_servers\.([^.]+)\.(command|url)$/
/** Codex's refusal of a merged server; Codex 0.171 names stdio for both directions. */
const REFUSED_SERVER =
  /\bis not supported for (?:stdio|streamable_http)\s+in `mcp_servers\.([^`.]+)`/

/** The servers `threadConfig` adds, by name, with how each runs. */
export function codexServerKinds(
  threadConfig: Record<string, unknown>
): Map<string, CodexServerKind> {
  const kinds = new Map<string, CodexServerKind>()
  for (const key of Object.keys(threadConfig)) {
    const match = SERVER_KIND_KEY.exec(key)
    if (match) {
      kinds.set(match[1], match[2] === 'url' ? 'url' : 'command')
    }
  }
  return kinds
}

/** How each of `servers` runs, by name. */
export function codexServerKindsOf(
  servers: readonly BotToolServer[]
): Map<string, CodexServerKind> {
  return new Map(servers.map((server) => [server.name, 'url' in server ? 'url' : 'command']))
}

function loadedKind(server: unknown): CodexServerKind | null {
  if (!isPlainObject(server)) {
    return null
  }
  if (typeof server.command === 'string') {
    return 'command'
  }
  return typeof server.url === 'string' ? 'url' : null
}

/**
 * Of `added`, the servers Codex's loaded config at `cwd` has under the same name as the other kind.
 * It reads every layer Codex loads there (any config.toml form, a project's .codex/config.toml,
 * managed config, launch flags), which a read of the account config.toml can't see. None when the
 * config can't be read: the open below still catches a refusal.
 */
export async function codexRefusedServerNames(
  rpc: Pick<CodexAppServerRpc, 'request'>,
  cwd: string,
  added: ReadonlyMap<string, CodexServerKind>
): Promise<string[]> {
  if (added.size === 0) {
    return []
  }
  let answer: unknown
  try {
    answer = await rpc.request('config/read', { cwd }, { timeoutMs: CONFIG_READ_TIMEOUT_MS })
  } catch {
    return []
  }
  const config = isPlainObject(answer) ? answer.config : undefined
  const loaded = isPlainObject(config) ? config.mcp_servers : undefined
  if (!isPlainObject(loaded)) {
    return []
  }
  return [...added]
    .filter(([name, kind]) => {
      const own = loadedKind(loaded[name])
      return own !== null && own !== kind
    })
    .map(([name]) => name)
}

/**
 * `threadConfig` without the `names` servers' keys. A key turning one off stays (a read-only run
 * turns off every server Codex loads, the owner's same-named one too): it adds no server.
 */
export function withoutCodexServers(
  threadConfig: Record<string, unknown>,
  names: readonly string[]
): Record<string, unknown> {
  if (names.length === 0) {
    return threadConfig
  }
  const prefixes = names.map((name) => `mcp_servers.${name}.`)
  return Object.fromEntries(
    Object.entries(threadConfig).filter(
      ([key, value]) =>
        (key.endsWith('.enabled') && value === false) || !prefixes.some((at) => key.startsWith(at))
    )
  )
}

/**
 * `threadConfig` without the servers Codex would refuse. Such a server is left out and the loaded
 * one keeps the name; one of the same kind merges as before.
 */
export async function withoutCodexMcpConflicts(
  rpc: Pick<CodexAppServerRpc, 'request'>,
  cwd: string,
  threadConfig: Record<string, unknown>
): Promise<{ threadConfig: Record<string, unknown>; leftOut: string[] }> {
  const leftOut = await codexRefusedServerNames(rpc, cwd, codexServerKinds(threadConfig))
  return { threadConfig: withoutCodexServers(threadConfig, leftOut), leftOut }
}

/** The server `threadConfig` adds that Codex refused to open a thread with, if that is the error. */
export function codexRefusedThreadServer(
  error: unknown,
  threadConfig: Record<string, unknown>
): string | null {
  if (
    !isCodexAppServerRequestError(error) ||
    error.code !== -32600 ||
    (error.method !== 'thread/start' && error.method !== 'thread/resume')
  ) {
    return null
  }
  const text = error.providerDiagnostic?.text ?? error.message
  const name = REFUSED_SERVER.exec(text)?.[1] ?? REFUSED_SERVER.exec(error.message)?.[1]
  return name && codexServerKinds(threadConfig).has(name) ? name : null
}

/**
 * Opens with `threadConfig`, and again without a server each time Codex refuses one this config
 * adds. A config Codex loads only at open (a project trusted as the thread starts) slips past the
 * read before it. Bounded by the servers the config adds: each retry removes one. Codex refuses the
 * config before it opens anything, so a retry repeats no work.
 */
export async function openWithoutRefusedCodexServers<T>(
  threadConfig: Record<string, unknown> | undefined,
  open: (threadConfig: Record<string, unknown> | undefined) => Promise<T>
): Promise<{ opened: T; leftOut: string[] }> {
  const leftOut: string[] = []
  let config = threadConfig
  for (;;) {
    try {
      return { opened: await open(config), leftOut }
    } catch (error) {
      const name = config ? codexRefusedThreadServer(error, config) : null
      if (!config || !name) {
        throw error
      }
      leftOut.push(name)
      config = withoutCodexServers(config, [name])
    }
  }
}

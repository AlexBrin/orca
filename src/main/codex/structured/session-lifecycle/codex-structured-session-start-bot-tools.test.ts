import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { openCodexStructuredSession } from './codex-structured-session-start'

type Context = Parameters<typeof openCodexStructuredSession>[0]
type Call = { method: string; params: Record<string, unknown> | undefined }

const NOTION_URL = 'mcp_servers.notion.url'

const refusal = (method: string) => {
  const text =
    'failed to load configuration: url is not supported for stdio\nin `mcp_servers.notion`'
  return new CodexAppServerRequestError(
    method,
    -32600,
    `codex app-server ${method} failed: ${text}`,
    text
  )
}

/**
 * A Codex app-server whose config read shows `loaded` servers. `refuseUntilFitted`: the thread's
 * open refuses a remote notion, as Codex does when it loads a project's stdio notion only then.
 */
function codexAppServer(loaded: Record<string, unknown>, refuseUntilFitted = false) {
  const calls: Call[] = []
  let answerRead: () => void = () => {}
  let held = false
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'config/read') {
      // The first read waits for the test; any later one answers at once.
      if (!held) {
        held = true
        await new Promise<void>((resolve) => {
          answerRead = resolve
        })
      }
      return { config: { mcp_servers: loaded }, origins: {} }
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      const config = params?.config
      if (
        refuseUntilFitted &&
        typeof config === 'object' &&
        config !== null &&
        NOTION_URL in config
      ) {
        throw refusal(method)
      }
      const id = method === 'thread/resume' ? String(params?.threadId) : 'thread-new'
      return { thread: { id, turns: [] }, model: 'gpt', serviceTier: null }
    }
    return {}
  })
  const connection = {
    closed: false,
    request,
    notify: vi.fn(),
    respond: vi.fn(),
    respondWithError: vi.fn(),
    close: vi.fn(async () => true)
  }
  return { connection, calls, answerRead: () => answerRead() }
}

function context(
  connection: ReturnType<typeof codexAppServer>['connection'],
  resumeThreadId: string | null,
  extra: Record<string, unknown> = {}
) {
  const warn = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields an open reads
  const start = {
    input: { identity: { sessionId: 's1' }, fence: 1 },
    deps: { logger: { warn, error: vi.fn(), info: vi.fn() } },
    launch: {
      cwd: '/work',
      codexHome: '',
      resumeThreadId,
      visuals: { folder: '/scratch', skill: { skillsRoot: '/skills' } },
      threadConfig: { [NOTION_URL]: 'https://mcp.notion.com/mcp', web_search: 'live' },
      ...extra
    },
    account: undefined,
    sessions: new Map(),
    acquisitions: { assertCurrent: vi.fn(), deleteIfCurrent: vi.fn() },
    attempt: {
      acquisitionGeneration: 'g7',
      exitError: null,
      window: { appliedSettings: { observe: vi.fn() }, prompts: {}, drain: () => [] }
    },
    connection,
    translator: null,
    dispatchEchoes: {},
    subagentExecutions: {},
    setPrimaryThreadId: vi.fn(),
    forceCloseUnexpected: vi.fn()
  } as unknown as Context
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields an open reads
  const openInput = {
    sessionId: 's1',
    fence: 1,
    acquisitionGeneration: 'g7',
    signal: new AbortController().signal
  } as Parameters<typeof openCodexStructuredSession>[1]
  return { start, openInput, warn }
}

const openedWith = (calls: Call[]) =>
  calls.filter((call) => call.method === 'thread/start' || call.method === 'thread/resume')

describe('a native chat Codex start with a bot’s tools', () => {
  it('opens without a remote notion its loaded config runs as a command, reading the config once', async () => {
    const server = codexAppServer({ notion: { command: 'npx', args: ['-y', 'mcp-remote'] } })
    const { start, openInput, warn } = context(server.connection, null)
    const opening = openCodexStructuredSession(start, openInput)
    await vi.waitFor(() => expect(server.calls.map((call) => call.method)).toContain('config/read'))
    // Skill roots go in while the config read is still out.
    await vi.waitFor(() =>
      expect(server.calls.map((call) => call.method)).toContain('skills/extraRoots/set')
    )
    server.answerRead()
    await opening
    const reads = server.calls.filter((call) => call.method === 'config/read')
    const beforeOpen = server.calls.findIndex((call) => call.method === 'thread/start')
    expect(server.calls.slice(0, beforeOpen).filter((c) => c.method === 'config/read')).toEqual([
      { method: 'config/read', params: { cwd: '/work' } }
    ])
    expect(reads.length).toBeGreaterThanOrEqual(1)
    const [opened] = openedWith(server.calls)
    expect(opened.params?.config).not.toHaveProperty([NOTION_URL])
    expect(opened.params?.config).toMatchObject({ web_search: 'live' })
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ names: ['notion'] })
    )
  })

  it('opens again without notion when Codex refuses it only at the open', async () => {
    const server = codexAppServer({}, true)
    const { start, openInput, warn } = context(server.connection, null)
    const opening = openCodexStructuredSession(start, openInput)
    await vi.waitFor(() => expect(server.calls.map((call) => call.method)).toContain('config/read'))
    server.answerRead()
    await opening
    const opens = openedWith(server.calls)
    expect(opens).toHaveLength(2)
    expect(opens[0].params?.config).toHaveProperty([NOTION_URL])
    expect(opens[1].params?.config).not.toHaveProperty([NOTION_URL])
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ names: ['notion'] })
    )
  })

  it('starts in Full Access for a project trusted only as the thread opens', async () => {
    // The read sees no project layer yet; the open trusts it and loads its stdio notion.
    const server = codexAppServer({}, true)
    const fullAccess = {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user'
    }
    const { start, openInput } = context(server.connection, null, {
      permissionPolicy: fullAccess
    })
    const opening = openCodexStructuredSession(start, openInput)
    await vi.waitFor(() => expect(server.calls.map((call) => call.method)).toContain('config/read'))
    server.answerRead()
    await opening
    const opens = openedWith(server.calls)
    expect(opens).toHaveLength(2)
    for (const open of opens) {
      expect(open.params).toMatchObject(fullAccess)
    }
    expect(opens[1].params?.config).not.toHaveProperty([NOTION_URL])
    expect(start.setPrimaryThreadId).toHaveBeenCalledWith('thread-new')
  })

  it('turns a read-only run’s servers off alongside the skill roots, and keeps them off when opening again', async () => {
    const server = codexAppServer({ notion: { url: 'https://owner/mcp' } }, true)
    const { start, openInput } = context(server.connection, null, { readOnly: 'look-around' })
    const opening = openCodexStructuredSession(start, openInput)
    await vi.waitFor(() =>
      expect(server.calls.map((call) => call.method)).toContain('skills/extraRoots/set')
    )
    expect(server.calls.filter((call) => call.method === 'config/read')).toHaveLength(1)
    server.answerRead()
    await opening
    const opens = openedWith(server.calls)
    expect(opens).toHaveLength(2)
    expect(opens[0].params?.config).toMatchObject({ 'mcp_servers.notion.enabled': false })
    expect(opens[1].params?.config).not.toHaveProperty([NOTION_URL])
    expect(opens[1].params?.config).toMatchObject({ 'mcp_servers.notion.enabled': false })
  })

  it('resumes again without notion when Codex refuses it at the resume', async () => {
    const server = codexAppServer({}, true)
    const { start, openInput } = context(server.connection, 'thread-old')
    const opening = openCodexStructuredSession(start, openInput)
    await vi.waitFor(() => expect(server.calls.map((call) => call.method)).toContain('config/read'))
    server.answerRead()
    await opening
    const opens = openedWith(server.calls)
    expect(opens.map((call) => call.method)).toEqual(['thread/resume', 'thread/resume'])
    expect(opens[1].params).toMatchObject({ threadId: 'thread-old' })
    expect(opens[1].params?.config).not.toHaveProperty([NOTION_URL])
    expect(start.setPrimaryThreadId).toHaveBeenCalledWith('thread-old')
  })
})

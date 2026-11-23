import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import {
  commitBotToolOAuth,
  newBotToolCredentialId,
  useBotToolCredentialsRoot
} from './bot-tool-credentials'
import { addBotTool, botToolProblems, type BotToolsCli } from './bot-tools-host'
import { connectBotTool } from './bot-tools-sign-in'
import type * as SessionModule from '../codex/app-server/codex-app-server-session'

const session = vi.hoisted(() => {
  const state: {
    loaded: Record<string, unknown>
    invocations: { args: string[] }[]
    methods: string[]
  } = { loaded: {}, invocations: [], methods: [] }
  return state
})

vi.mock('../codex/app-server/codex-app-server-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  // A Codex app-server whose loaded config (every layer, `config/read`) has `session.loaded`.
  runCodexAppServerSession: vi.fn(
    async (invocation: { args: string[] }, body: (rpc: unknown) => Promise<unknown>) => {
      session.invocations.push(invocation)
      return await body({
        notify: vi.fn(),
        request: async (method: string) => {
          session.methods.push(method)
          if (method === 'config/read') {
            return { config: { mcp_servers: session.loaded } }
          }
          if (method === 'thread/start') {
            return { thread: { id: 'thread-1' } }
          }
          if (method === 'mcpServerStatus/list') {
            return { data: [{ name: 'linear', runtimeStatus: 'connected' }] }
          }
          return {}
        }
      })
    }
  )
}))

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  session.loaded = {}
  session.invocations.length = 0
  session.methods.length = 0
})
afterEach(() => {
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function codexBot(): BotToolsCli {
  const folder = tempDir('bot-folder-')
  return {
    botId: 'bot',
    folder,
    signInFolder: folder,
    otherBotFolders: [],
    agent: 'codex',
    command: 'codex',
    prefixArgs: [],
    env: {},
    // An account whose config.toml has no notion; Codex's loaded config does.
    accountHome: tempDir('codex-home-'),
    appServerArgs: ['-c', 'mcp_servers.notion.command="npx"']
  }
}

const NOTION = 'https://mcp.notion.com/mcp'
const taken = (name: string) => ({
  kind: 'failed',
  detail: expect.stringContaining(`Codex already has a tool named ${name}`)
})

describe('a Codex bot’s tools check', () => {
  it('fails a signed-in tool whose name Codex’s config runs as a command, without connecting it', async () => {
    useBotToolCredentialsRoot(tempDir('bot-tool-credentials-'))
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text, 'utf8'),
      decryptString: (cipher) => cipher.toString('utf8'),
      describeProtectionGap: () => null
    })
    const cli = codexBot()
    const id = newBotToolCredentialId()
    await addBotTool(
      cli,
      { name: 'notion', url: NOTION, transport: 'http', credential: id },
      new Map([[id, { url: NOTION, signIn: true as const }]])
    )
    commitBotToolOAuth(cli.folder, id, (current) => ({
      url: NOTION,
      grant: current!.grant + 1,
      record: { resource: NOTION, tokens: { access_token: 'access', token_type: 'bearer' } }
    }))
    session.loaded = { notion: { command: 'npx' } }

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion') })
    // Read the config only: no thread, so no server was started.
    expect(session.methods).toEqual(['config/read'])
    // Checked with the Codex Arguments a chat launches with.
    expect(session.invocations[0].args).toEqual([
      '-c',
      'mcp_servers.notion.command="npx"',
      'app-server'
    ])
  })

  it('checks the other tools in a thread without the left-out one', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    await addBotTool(cli, { name: 'linear', url: 'https://mcp.linear.app/mcp', transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }

    expect(await botToolProblems(cli)).toEqual({ notion: taken('notion') })
    expect(session.methods).toEqual(['config/read', 'thread/start', 'mcpServerStatus/list'])
  })
})

describe('a Codex bot tool’s sign-in', () => {
  it('says the name is taken, not that the check failed, when Codex’s config has it as a command', async () => {
    const cli = codexBot()
    await addBotTool(cli, { name: 'notion', url: NOTION, transport: 'http' })
    session.loaded = { notion: { command: 'npx' } }

    await expect(connectBotTool(cli.botId, 'notion', async () => cli)).rejects.toMatchObject({
      name: 'BotFailureError',
      data: { botFailure: expect.objectContaining({ code: 'toolNameTakenByCodexStdio' }) }
    })
    expect(session.methods).not.toContain('mcpServer/oauth/login')
  })
})

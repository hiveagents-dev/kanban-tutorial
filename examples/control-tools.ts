import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent, Runtime, createClaudeProvider, createCodexProvider, createClaudeControlRegistration, createCodexControlRegistration,
  type ApplicationTool, type ApplicationToolContext, type CodexTransportStarter,
} from 'hiveagents-runtime';

export interface ToolDemoOptions {
  /** mock consumes no model capacity; codex requires the user's existing local CLI authentication. */
  mode?: 'mock' | 'codex' | 'claude';
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const OUTPUT_SCHEMA = { type: 'object', properties: { category: { type: 'string', enum: ['operations'] }, written: { type: 'boolean', const: true } }, required: ['category', 'written'], additionalProperties: false };

/** Accept a complete JSON response or a single JSON code fence, never embedded snippets. */
export function parseDemoJsonText(text: string): unknown {
  if (text.length > 4096) throw new TypeError('Tool demo response exceeded its text limit');
  const fenced = /^\s*```json\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  return JSON.parse(fenced?.[1] ?? text) as unknown;
}

function tools(directory: string, count: (kind: 'read' | 'write') => void): ApplicationTool[] {
  const authorize = (input: unknown, context: ApplicationToolContext, expected: string): boolean => {
    const name = (input as { name?: unknown }).name;
    return !context.signal.aborted && context.deadline > Date.now() && context.scope.cwd === directory
      && context.scope.transport === 'control' && context.scope.authorityEpoch.length > 0 && name === expected;
  };
  return [{
    name: 'read_document', description: 'Read the single document.txt in this application temporary workspace.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', enum: ['document.txt'] } }, required: ['name'], additionalProperties: false },
    timeoutMs: 2000, maxOutputBytes: 4096,
    authorize: (input, context) => authorize(input, context, 'document.txt'),
    execute: async (_input, context) => { count('read'); return { text: await readFile(join(directory, 'document.txt'), { encoding: 'utf8', signal: context.signal }) }; },
  }, {
    name: 'write_summary', description: 'Write summary.json once, only in this application temporary workspace.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', enum: ['summary.json'] }, summary: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['name', 'summary'], additionalProperties: false },
    timeoutMs: 2000, maxOutputBytes: 100,
    authorize: (input, context) => authorize(input, context, 'summary.json'),
    execute: async (input, context) => {
      count('write');
      await writeFile(join(directory, 'summary.json'), JSON.stringify({ summary: (input as { summary: string }).summary }), { flag: 'wx', mode: 0o600, signal: context.signal });
      return { written: true };
    },
  }];
}

/** The real public Codex binding is driven by an in-memory transport fixture. */
const mockTransport: CodexTransportStarter = async hooks => ({
  close: async () => {},
  request: async method => {
    if (method !== 'turn/start') return { thread: { id: 'tool-demo-thread' } };
    const threadId = 'tool-demo-thread'; const turnId = 'tool-demo-turn';
    hooks.onNotification('turn/started', { threadId, turn: { id: turnId } });
    await hooks.onServerRequest('item/tool/call', { threadId, turnId, callId: 'read', tool: 'read_document', arguments: { name: 'document.txt' } }, 'read-rpc');
    await hooks.onServerRequest('item/tool/call', { threadId, turnId, callId: 'write', tool: 'write_summary', arguments: { name: 'summary.json', summary: 'Operations document reviewed.' } }, 'write-rpc');
    hooks.onNotification('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: '{"category":"operations","written":true}' } });
    hooks.onNotification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    return { turn: { id: turnId } };
  },
});

/** End-to-end public tools and structured output example; all file authority is application-owned. */
export async function runToolDemo(options: ToolDemoOptions = {}) {
  const mode = options.mode ?? 'mock';
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'oar-document-tools-')));
  let readCalls = 0; let writeCalls = 0;
  try {
    await writeFile(join(directory, 'document.txt'), 'Operations: employees must use the company VPN.', { mode: 0o600 });
    const provider = mode === 'claude' ? createClaudeProvider() : createCodexProvider();
    const fixtureAdapter = { id: 'codex' as const, detect: async () => ({ installed: true, version: '0.149.0' }), auth: async () => ({ authenticated: true, source: 'subscription' as const }), models: async () => [], execute: async () => { throw new Error('The fixture has no exec inference'); } };
    const runtime = new Runtime({ providers: [{ ...provider,
      ...(mode === 'mock' ? { exec: { ...provider.exec, adapter: fixtureAdapter, withTarget: () => fixtureAdapter } } : {}),
      control: mode === 'claude' ? createClaudeControlRegistration() : createCodexControlRegistration(mode === 'mock' ? { startTransport: mockTransport } : {}),
    }] });
    const agent = new Agent({ model: options.model ?? (mode === 'claude' ? 'claude/sonnet-4.6' : 'codex/gpt-5.2-codex'), cwd: directory,
      tools: tools(directory, kind => { if (kind === 'read') readCalls++; else writeCalls++; }),
      // Claude's native plan mode asks to exit planning before the write tool.
      // Default edit mode still brokers native tools; only the two captured MCP tools use their authorizers.
      permissions: { mode: mode === 'claude' ? 'edit' : 'analyze' }, providerOptions: { experimentalControl: true, experimentalApi: true },
    }, runtime);
    const session = await agent.openSession({ persistence: 'process' });
    try {
      const prefix = mode === 'claude' ? 'mcp__oar_application__' : '';
      const turn = await session.send(`Use ${prefix}read_document for document.txt. Then use ${prefix}write_summary once for summary.json with the exact summary "Operations document reviewed." Return only JSON {"category":"operations","written":true}. Use only these application tools.`,
        { ...(mode === 'claude' ? {} : { outputSchema: OUTPUT_SCHEMA }), timeoutMs: options.timeoutMs ?? 60_000, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      // Claude Query has no public per-turn outputFormat setter; the app owns this final text check.
      const output: unknown = mode === 'claude' ? parseDemoJsonText(turn.text) : turn.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)
        || (output as { category?: unknown }).category !== 'operations' || (output as { written?: unknown }).written !== true
        || Object.keys(output).length !== 2) throw new TypeError('Tool demo final output failed application validation');
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as { summary: string };
      return { mode, session: turn.session, output, readCalls, writeCalls, summary: summary.summary };
    } finally { await session.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

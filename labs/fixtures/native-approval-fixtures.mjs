// These doubles emit native protocol requests. They never execute provider tools.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Runtime, createClaudeControlRegistration, createCodexControlRegistration } from 'hiveagents-runtime';

export function approvalFixture(provider, workspace, target, scenario) {
  const settlement = [];
  let abortNative;
  const stub = {
    id: provider,
    detect: async () => ({
      installed: true, path: fileURLToPath(import.meta.url), realpath: fileURLToPath(import.meta.url),
      version: provider === 'claude' ? '2.1.228' : '0.153.4',
    }),
    auth: async () => ({ authenticated: true, source: 'subscription' }),
    models: async () => [],
    execute: async () => { throw new Error('The approval fixtures must never run exec'); },
  };
  const control = provider === 'claude' ? createClaudeControlRegistration({
    sdkVersion: '0.3.252',
    sdk: {
      query({ prompt, options }) {
        return Object.assign((async function* () {
          for await (const _message of prompt) {
            const cancellation = new AbortController();
            abortNative = () => cancellation.abort();
            yield { type: 'system', subtype: 'init', session_id: 'tutorial-claude' };
            const verdict = await options.canUseTool('Read', { file_path: target }, { signal: cancellation.signal });
            settlement.push(verdict.behavior);
            if (verdict.behavior === 'allow') assert.equal(verdict.updatedInput.file_path, target);
            yield { type: 'result', subtype: 'success', session_id: 'tutorial-claude', result: 'Fixture terminado.' };
          }
        })(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {} });
      },
    },
  }) : createCodexControlRegistration({
    startTransport: async hooks => {
      const threadId = 'tutorial-codex';
      return {
        async request(method, params) {
          if (method === 'thread/start') {
            assert.equal(params.sandbox, 'read-only');
            assert.equal(params.approvalPolicy, 'on-request');
            return { thread: { id: threadId } };
          }
          if (method === 'turn/start') {
            const turnId = 'tutorial-codex-turn';
            const notify = (name, body) => hooks.onNotification(name, { threadId, ...body });
            const isCommand = scenario === 'decline-command';
            const method = isCommand ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval';
            const request = { threadId, turnId, itemId: 'fixture-action',
              ...(isCommand ? { command: 'cat ficha.txt', cwd: workspace } : { grantRoot: workspace }) };
            queueMicrotask(() => {
              notify('turn/started', { turn: { id: turnId } });
              void hooks.onServerRequest(method, request, 7)
                .then(verdict => settlement.push(verdict.decision), error => settlement.push(error.code))
                .then(() => {
                  notify('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', text: 'Fixture terminado.' } });
                  notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
                });
            });
            return { turn: { id: turnId } };
          }
          return {};
        },
        async close() {},
      };
    },
  });
  return {
    runtime: new Runtime({ adapters: [stub], controlAdapters: [control] }),
    settlement,
    cancelClaudeRequest() { abortNative(); },
  };
}

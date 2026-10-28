import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentInput } from '../../lib/agent-input.js';

test('automation refuses shells, stale screens, approvals, startup and a process exiting before write', () => {
  const writes = [];
  const entry = { pty: { write: data => writes.push(data) } };
  let kinds = ['codex'], screen = { current: true, lines: ['› Ask Codex to do anything'] };
  const send = createAgentInput({ resolveTerminalRef: () => ({ id: 'one', entry }),
    terminalAgent: () => kinds.length > 1 ? kinds.shift() : kinds[0], readTerminalScreen: () => screen });
  for (const kind of ['', null]) { kinds = [kind]; assert.throws(() => send('one', 'message'), /쉘/); }
  kinds = ['codex'];
  for (const lines of [['Hooks need review', '1. Review hooks'], ['Resuming session…', '›'], ['› 작성 중'], ['Would you like to run?', '1. Yes'], ['$ shell']]) {
    screen = { current: true, lines }; assert.throws(() => send('one', 'message'), /입력 가능한/);
  }
  screen = { current: false, lines: ['›'] }; assert.throws(() => send('one', 'message'), /현재 AI 화면/);
  screen = { current: true, lines: ['›'] }; kinds = ['codex', '']; assert.throws(() => send('one', 'message'), /직전/);
  kinds = ['codex']; entry.restarting = true; assert.throws(() => send('one', 'message'), /재시작/);
  entry.restarting = false; entry.conversationHeld = true; assert.throws(() => send('one', 'message'), /보호/);
  entry.conversationHeld = false; send('one', 'accepted');
  assert.deepEqual(writes, ['accepted']);
});

test('explicit key API accepts approval selection keys but cannot disguise text or enter startup screens', () => {
  const writes = [];
  let lines = ['Do you want to proceed?', '❯ 1. Yes', 'Esc to cancel'];
  const send = createAgentInput({ resolveTerminalRef: () => ({ id: 'one', entry: { pty: { write: data => writes.push(data) } } }),
    terminalAgent: () => 'claude', readTerminalScreen: () => ({ current: true, lines }) });
  assert.throws(() => send('one', '작업 지시\r'), /입력 가능한/);
  assert.throws(() => send('one', '작업 지시\r', { controls: true }), /입력 가능한/);
  send('one', '\r', { controls: true });
  lines = ['Starting session', '❯'];
  assert.throws(() => send('one', '\r', { controls: true }), /입력 가능한/);
  lines = ['Goal paused', '›'];
  assert.throws(() => send('one', '\r', { controls: true }), /입력 가능한/);
  assert.deepEqual(writes, ['\r']);
});

test('jcode running messages require an empty live composer and preserve drafts, approvals and conversation protection', () => {
  const writes = [], footer = '~ merge/dev-rpa ~57 ?136 ↑1 196k/1.0M ▰▰▱▱▱▱▱▱▱▱ 20% OAuth OpenAI GPT-6.1 Sol xhigh';
  const entry = { pty: { write: data => writes.push(data) } };
  let lines = ['running batch', '41… 󰌘', footer], current = true;
  const send = createAgentInput({ resolveTerminalRef: () => ({ id: 'one', entry }), terminalAgent: () => 'jcode',
    readTerminalScreen: () => ({ current, lines }) });
  send('one', 'peer message');
  for (const blocked of [['41… typed draft 󰌘', footer], ['41… 󰌘', 'second draft line', footer], ['permission required', '41… 󰌘', footer], ['Do you want to proceed?', '1. Yes', '41… 󰌘', footer], ['▸ GPT-6.1 current', '↑↓ choose · Enter select · Esc cancel', '41… 󰌘', footer]]) {
    lines = blocked; assert.throws(() => send('one', 'must not overwrite'), /입력 가능한/);
  }
  lines = ['41… 󰌘', footer];
  current = false; assert.throws(() => send('one', 'stale'), /현재 AI 화면/);
  current = true; entry.conversationHeld = true; assert.throws(() => send('one', 'held'), /보호/);
  assert.deepEqual(writes, ['peer message']);
});

import { workerScreenState } from './board-workers.js';

// Used by automation and peer messages, never by the user's own terminal keyboard.
export function createAgentInput({ resolveTerminalRef, terminalAgent, readTerminalScreen }) {
  return (termId, data, { controls = false, resume = false } = {}) => {
    const found = resolveTerminalRef(termId);
    const reject = message => { throw Object.assign(new Error(message), { code: 'AGENT_NOT_READY' }); };
    if (!found || found.entry.conversationHeld || found.entry.restarting) reject('세션이 보호 또는 재시작 중입니다. 자동 입력을 전달하지 않았습니다.');
    const agent = terminalAgent(found.entry);
    if (!agent) reject('실행 중인 AI를 확인하지 못했습니다. 쉘에는 자동 입력을 전달하지 않습니다.');
    const screen = readTerminalScreen(found.id, 80, true);
    const state = workerScreenState(screen, agent);
    if (!screen?.current) reject('현재 AI 화면을 확인하지 못해 입력을 보류했습니다.');
    // The existing explicit key API is distinct from peer messages. Permit only
    // actual keys in recognized AI screens, never arbitrary text with enter:false.
    const keys = controls && /^(?:[\r\t\x03\x04\x1a\x7f1-9yn ]|\x1b(?:\[[ABCD])?){1,8}$/.test(data)
      && ['idle', 'busy', 'approval'].includes(state);
    const resumeCommand = resume && state === 'paused'
      && ['\x1b[200~/goal resume\x1b[201~', '\r'].includes(data);
    if (!keys && !resumeCommand && (controls || resume || (state !== 'idle' && !(state === 'busy' && workerScreenState(screen, agent, { inspectComposer: true }) === 'idle')))) {
      reject('AI가 입력 가능한 상태가 아닙니다. 승인·초기화·작성 중인 입력을 확인하세요.');
    }
    if (found.entry.conversationHeld || found.entry.restarting || terminalAgent(found.entry) !== agent) reject('입력 직전 AI 상태가 변경돼 전달을 취소했습니다.');
    found.entry.pty.write(data);
  };
}

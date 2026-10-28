// Source session options evaluated with inert child_process adapters. Corrected
// plans retain argv boundaries instead of reproducing the legacy shell injection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../lib/session-control.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');
const wslSource = readFileSync(new URL('../../lib/wsl-utils.js', import.meta.url), 'utf8');
const wslPattern = wslSource.match(/^const WSL_RE = .*;$/m)?.[0];
const wslParse = wslSource.match(/export function parseWslPath\(projectPath\) \{[\s\S]*?\n\}/)?.[0];
const toWin = wslSource.match(/export function toWinPath\(p\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(wslPattern && wslParse && toWin, 'original WSL helpers are present');
const clean = value => JSON.parse(JSON.stringify(value));
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const shellCommand = (path, args, keepOpen) => `cd -- ${quote(path)} && claude${args.map(arg => ` ${quote(arg)}`).join('')}${keepOpen ? '; exec bash' : ''}`;
const appleString = value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

export function original(input) {
  const sourceLaunchers = [];
  const logical = [];
  const context = vm.createContext({
    IS_WIN: input.platform === 'windows',
    IS_MAC: input.platform === 'mac',
    spawn: (program, args, options) => {
      sourceLaunchers.push({ program, args, options });
      return { on: () => {}, unref: () => {} };
    },
    recordLogical: args => logical.push(args),
  });
  const api = vm.runInContext(`${wslPattern}\n${wslParse}\n${toWin}\n${source}
    const sourceLaunch = launchClaude;
    launchClaude = (project, args) => { recordLogical(args); return sourceLaunch(project, args); };
    ({ startSession, resumeSession });`.replace(/^export /gm, ''), context, { timeout: 1000 });
  let expected;
  try {
    const value = input.resume
      ? api.resumeSession(input.project, input.options.sessionId)
      : api.startSession(input.project, input.options);
    assert.equal(logical.length, 1);
    const claudeArgs = logical[0];
    let launchers;
    if (input.platform === 'windows') {
      assert.equal(sourceLaunchers[0].program, 'cmd');
      assert.deepEqual(Array.from(sourceLaunchers[0].args.slice(0, 3)), ['/c', 'start', 'wt']);
      // WT splits OS argv on unescaped semicolons, then unescapes '\;'.
      // https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/Commandline.cpp
      launchers = [{ program: 'wt', args: sourceLaunchers[0].args.slice(3)
        .map(arg => typeof arg === 'string' ? arg.replace(/;/g, '\\;') : arg) }];
    } else if (input.platform === 'mac') {
      launchers = [{ program: 'osascript', args: ['-e', `tell application "Terminal"\n  activate\n  do script "${appleString(shellCommand(input.project.path, claudeArgs, false))}"\nend tell`] }];
    } else {
      launchers = [['gnome-terminal', '--'], ['konsole', '-e'], ['xterm', '-e']]
        .map(([program, separator]) => ({ program, args: [separator, 'bash', '-c', shellCommand(input.project.path, claudeArgs, true)] }));
    }
    expected = { value, claudeArgs, launchers };
  } catch (error) {
    expected = { error: error.message };
  }
  return clean({ input, expected, sourceLaunchers, corrected: input.platform === 'windows'
    ? 'Direct wt argv removes cmd expansion; escape WT semicolon delimiters; missing executable is an error.'
    : input.platform === 'mac'
      ? 'Quote each shell argument and escape the enclosing AppleScript string.'
      : 'Direct terminal argv with one quoted shell command; missing executables are errors.' });
}

export const fixtures = [];
const project = { id: 'fixture', name: '작업 세션😀', path: '/fixture/a project' };
function fixture(name, options, extra = {}) {
  for (const platform of ['windows', 'mac', 'linux']) {
    fixtures.push({ name: `${name}/${platform}`, ...original({ project, options, resume: false, platform, ...extra }) });
  }
}
for (const [name, options] of [
  ['default', {}],
  ['continue', { resume: true }],
  ['continue-truthy', { resume: 'yes' }],
  ['continue-false', { resume: false }],
  ['all-options', { resume: true, model: 'opus', prompt: '진행 확인해 줘' }],
  ['no-permission-flags', { permissionMode: 'bypassPermissions', dangerouslySkipPermissions: true, approvalPreset: 'full', settings: '/ignored' }],
  ['null-options', null],
  ['primitive-options', 'opus'],
]) fixture(name, options);
for (const model of ['haiku', 'sonnet', 'opus', 'Opus', ' opus ', 'claude-opus-4-6', '--dangerously-skip-permissions', '', null, 7, true, {}, ['opus']]) {
  fixture(`model-${JSON.stringify(model)}`, { model });
}
for (const [name, prompt] of [
  ['empty', ''], ['false', false], ['null', null], ['number', 12], ['zero', 0], ['true', true], ['array', ['one']], ['object', {}],
  ['spaces', 'one two  three'], ['apostrophe', "one 'two' three"], ['backslash', 'a\\b\\ c'], ['tab', 'a\tb'],
  ['metacharacters', 'before &|<>^;`$(){}\r\n" after'], ['option-looking', '--model opus --dangerously-skip-permissions'],
  ['unicode', '한글😀\ud800\udc00\ud800'], ['limit-499', 'a'.repeat(499)], ['limit-500', 'a'.repeat(500)],
  ['limit-501', 'a'.repeat(501)], ['split-surrogate', 'a'.repeat(499) + '😀z'],
  ['limit-after-filter', '&'.repeat(500) + 'a'.repeat(501)],
]) fixture(`prompt-${name}`, { prompt });
for (const sessionId of ['', 'abcdef', 'ABCDEF', '0123456789', 'abcd-1234-ABCD', '-', '---', 'oc:abcdef', 'claude:abcdef', ' abc ', 'abc\n', 'abc\r\n', 'abc\r', 'abc\u2028', 'abc\u2029', 'abc;whoami', 'abc\"', null, 123, 0, true, {}, ['abc']]) {
  fixture(`resume-${JSON.stringify(sessionId)}`, { sessionId }, { resume: true });
}
fixture('resume-missing', {}, { resume: true });
for (const [name, path] of [
  ['native-windows', 'C:/Users/fixture/a project'],
  ['windows-backslash', 'C:\\Users\\fixture\\a project'],
  ['wsl-dollar', '//wsl$/Ubuntu/home/fixture/a project'],
  ['wsl-localhost', '//wsl.localhost/Debian/home/fixture'],
  ['wsl-backslash', '\\\\wsl$\\Ubuntu\\home\\fixture'],
  ['wsl-case', '//WSL.LOCALHOST/Ubuntu/home/fixture'],
  ['wsl-root', '//wsl$/Ubuntu/'],
  ['wsl-no-path', '//wsl$/Ubuntu'],
  ['wsl-empty-distro', '//wsl$//home'],
  ['wsl-dollar-localhost', '//wsl$localhost/Debian/home'],
  ['wsl-dot', '//wsl./Debian/home'],
  ['wsl-line-terminator', '//wsl$/Ubuntu/home\nignored'],
  ['wsl-delimiter-distro', '//wsl$/Ubuntu; split-pane cmd/home'],
  ['wsl-delimiter-path', '//wsl$/Ubuntu/home/fixture; split-pane cmd'],
  ['windows-delimiter-path', 'C:/fixture; split-pane cmd/\\;literal'],
  ['quoted-path', '/fixture/a \' ; $(touch NEVER) " \\ path'],
  ['control-path', '/fixture/tab\there\nnext\rline'],
  ['option-path', '-option-path'],
  ['unicode-path', '/fixture/한글😀\ud800'],
]) fixture(`path-${name}`, { model: 'sonnet', prompt: "one 'two' three" }, { project: { ...project, path } });
for (const name of ['a &|<>^;`$(){}\r\n" b', 'a'.repeat(501), 'a'.repeat(499) + '😀', '', null, 7]) {
  fixture(`title-${JSON.stringify(name).slice(0, 24)}`, {}, { project: { ...project, name } });
}
fixture('missing-project-id', {}, { project: { name: 'fixture', path: '/fixture' } });

if (process.argv.includes('--emit')) process.stdout.write(JSON.stringify(fixtures, null, 2) + '\n');

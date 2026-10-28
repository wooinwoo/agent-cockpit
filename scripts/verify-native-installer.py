#!/usr/bin/python3
"""Exercise an extracted Linux package with a private display, HOME and port."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--xvfb', type=Path, required=True)
parser.add_argument('--node', type=Path, required=True)
args = parser.parse_args()
config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
package = ROOT / f'src-tauri/target/release/bundle/deb/{config["productName"]}_{config["version"]}_amd64.deb'
assert os.getuid() != 0, 'Read-only installation must be checked as an unprivileged user'
directory = Path(tempfile.mkdtemp(prefix='cockpit-deb-'))
checks, apps, logs, managers = [], [], [], []
display = None
failure = None
cleanup_verified = False
report_path = ROOT / 'docs/_local/native-installer-verification.json'
screenshot = ROOT / 'docs/_local/native-installer-desktop.png'


def check(condition, label):
    assert condition, label
    checks.append(label)


def run(*command, **kwargs):
    return subprocess.check_output(command, text=True, timeout=30, **kwargs)


def until(read, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = read()
        if result:
            return result
        time.sleep(0.1)
    raise RuntimeError(f'Timed out: {label}')


def children(pid):
    path = Path(f'/proc/{pid}/task/{pid}/children')
    return [int(value) for value in path.read_text().split()] if path.exists() else []


def alive(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z'
    except FileNotFoundError:
        return False


def stop_app(app):
    if app.poll() is None:
        for pid in children(app.pid):
            try:
                command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            except FileNotFoundError:
                continue
            if command[0] == os.fsencode(backend) and b'--managed' in command:
                managers.append(pid)
                os.kill(pid, signal.SIGTERM)
                until(lambda: not alive(pid), 'owned manager shutdown', 20)
        # Each test GUI owns a new process group; shared servers are outside it.
        os.killpg(app.pid, signal.SIGTERM)
        app.wait(timeout=10)


try:
    installed = directory / 'installed'
    run('/usr/bin/dpkg-deb', '--extract', str(package), str(installed))
    resource = installed / 'usr/lib' / config['productName']
    backend = resource / 'cockpit-server'
    executable = installed / 'usr/bin/cockpit'
    files = {str(path.relative_to(installed)): path for path in installed.rglob('*') if path.is_file()}
    dependencies = run('/usr/bin/dpkg-deb', '-f', str(package), 'Depends')
    check(all(value in dependencies for value in ['tmux', 'git', 'nodejs (>= 18)', 'libwebkit2gtk-4.1-0']), 'Package declares native runtime and CLI dependencies')
    check(backend.read_bytes()[:4] == b'\x7fELF' and os.access(backend, os.X_OK), 'Package contains an executable native server')
    check((resource / 'index.html').read_bytes() == (ROOT / 'index.html').read_bytes(), 'Package preserves the existing UI HTML')
    check(any(name.endswith('.woff2') for name in files), 'Package includes nested font assets')
    check(not any('/node_modules/' in name or name.endswith('/server.js') or name.endswith('/.cockpit-token') for name in files), 'Package excludes the Node backend and local credentials')
    tracked = set(run('/usr/bin/git', '-C', str(ROOT), 'ls-files', '--', 'workflows').splitlines())
    check({str(path.relative_to(resource)) for path in (resource / 'workflows').glob('*.json')} == tracked, 'Package includes exactly the tracked workflow templates')
    for name in ['cockpit-session', 'cockpit-board', 'cockpit-history']:
        check(os.access(installed / 'usr/bin' / name, os.X_OK), f'Package installs executable {name}')
    before = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    for path in files.values():
        path.chmod(0o555 if os.access(path, os.X_OK) else 0o444)
    for path in sorted(installed.rglob('*'), reverse=True):
        if path.is_dir():
            path.chmod(0o555)
    installed.chmod(0o555)
    home, node_bin = directory / 'home', directory / 'node-bin'
    home.mkdir(mode=0o700)
    node_bin.mkdir()
    (node_bin / 'node').symlink_to(args.node)
    for name in ['runtime', 'cache', 'config', 'data']:
        (home / name).mkdir(mode=0o700)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env = {'PATH': f'{installed}/usr/bin:{node_bin}:/usr/bin:/bin', 'HOME': str(home),
           'TMPDIR': str(directory), 'TMUX_TMPDIR': str(directory),
           'XDG_RUNTIME_DIR': str(home / 'runtime'), 'XDG_CACHE_HOME': str(home / 'cache'),
           'XDG_CONFIG_HOME': str(home / 'config'), 'XDG_DATA_HOME': str(home / 'data'),
           'COCKPIT_WINDOWS_HOME': str(home), 'COCKPIT_PORT': str(port), 'COCKPIT_BIND': '127.0.0.1',
           'COCKPIT_DURABLE_TERMINALS': '0', 'COCKPIT_PREVIEW_BACKGROUND_AGENTS': '0',
           'COCKPIT_PREVIEW_NETWORK_JSON': '[]', 'GDK_BACKEND': 'x11', 'LANG': 'C.UTF-8',
           'WEBKIT_DISABLE_COMPOSITING_MODE': '1'}
    display_env = {**env, 'LD_LIBRARY_PATH': str(args.xvfb.parent.parent / 'lib/x86_64-linux-gnu')}
    display_log = (directory / 'display.log').open('w')
    logs.append(display_log)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp', '-nolisten', 'unix', '-ac'], env=display_env, stdout=subprocess.PIPE, stderr=display_log, text=True)
    assert select.select([display.stdout], [], [], 10)[0], 'Private display did not become ready'
    display_number = display.stdout.readline().strip()
    assert display_number.isdigit(), 'Private display returned an invalid identifier'
    env['DISPLAY'] = f':{display_number}'
    base = f'http://127.0.0.1:{port}'

    def api(path, method='GET', value=None):
        body = None if value is None else json.dumps(value).encode()
        request = urllib.request.Request(base + path, data=body, method=method, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def ready(app, webview=False):
        assert app.poll() is None, f'Packaged desktop exited: {app.returncode}'
        try:
            health = api('/api/health')
            return health if not webview or health.get('sseClients', 0) > 0 else False
        except (OSError, urllib.error.URLError):
            return False

    def start():
        log = (directory / f'desktop-{len(apps)}.log').open('w')
        logs.append(log)
        app = subprocess.Popen([str(executable)], env=env, cwd=home, stdout=log, stderr=log, start_new_session=True)
        apps.append(app)
        until(lambda: ready(app), 'packaged desktop server startup')
        return app

    first = start()
    check(api('/api/migration/status')['runtime'] == 'rust', 'Extracted desktop starts its packaged Rust backend')
    check(api('/api/projects') == [] and api('/api/health')['terminals'] == 0, 'Private HOME imports no real projects or terminals')
    until(lambda: ready(first, True), 'webview subscribes to packaged server')
    check('Cockpit' in run('/usr/bin/xwininfo', '-root', '-tree', env=env), 'Desktop creates a visible Cockpit window on the private display')
    check(json.loads(run('cockpit-board', 'list', env=env))['mode'] == 'api', 'Packaged board CLI reaches the private server')
    run('cockpit-session', 'list', env=env)
    checks.append('Packaged session CLI runs without host-installed helpers')
    added = json.loads(run('cockpit-board', 'task', 'add', 'Installer fixture checklist', env=env))['result']['task']
    check(any(task['id'] == added['id'] for task in api('/api/board')['tasks']), 'Packaged checklist CLI persists a task')
    note = api('/api/notes', 'POST', {'title': 'Installer fixture', 'content': 'Retained after desktop restart'})
    state = home / '.local/share/cockpit'
    token = (state / '.cockpit-token').read_bytes()
    check((state / 'desktop-state/notes' / f'{note["id"]}.json').exists(), 'Desktop writes notes outside the read-only installation')
    shared = start()
    until(lambda: ready(shared) and api('/api/health').get('sseClients', 0) >= 2, 'second desktop webview shares the server')
    check(not any(b'--managed' in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') for pid in children(shared.pid)), 'Second desktop reuses the existing server without spawning another manager')
    stop_app(shared)
    check(ready(first) is not False, 'Closing the second test process preserves the first desktop server')
    run('/usr/bin/python3', '-c', '''import gi, sys, time
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk
window = Gdk.get_default_root_window()
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    pixels = Gdk.pixbuf_get_from_window(window, 0, 0, window.get_width(), window.get_height())
    if len(set(pixels.get_pixels())) > 16:
        pixels.savev(sys.argv[1], "png", [], [])
        break
    time.sleep(0.1)
else:
    raise RuntimeError("The packaged desktop still shows a blank frame")
''', str(screenshot), env=env)
    checks.append('Private display captures a nonblank software-rendered desktop')
    snapshot = directory / 'snapshot.json'
    snapshot.write_text(json.dumps({'schemaVersion': 1, 'savedAt': 0, 'board': {'supervisors': [], 'tasks': []}, 'sessionState': {'terminals': []}, 'projects': {'projects': []}}))
    run('cockpit-history', str(snapshot), str(directory / 'exported'), env=env)
    check((directory / 'exported/session-state.json').exists(), 'Packaged history CLI exports a synthetic recovery snapshot')
    stop_app(first)
    restarted = start()
    check((state / '.cockpit-token').read_bytes() == token, 'Desktop restart retains the original token')
    check(api(f'/api/notes/{note["id"]}')['content'] == 'Retained after desktop restart', 'Desktop restart retains the note')
    check(any(task['id'] == added['id'] for task in api('/api/board')['tasks']), 'Desktop restart retains the checklist task')
    stop_app(restarted)
    check(before == {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}, 'Runtime leaves packaged file contents unchanged')
except BaseException as error:
    failure = f'{type(error).__name__}: {error}'
finally:
    try:
        for app in reversed(apps):
            stop_app(app)
        if display is not None and display.poll() is None:
            display.terminate()
            display.wait(timeout=10)
        for log in logs:
            log.close()
        assert all(not alive(pid) for pid in managers), 'Owned manager remains alive'
        cleanup_verified = True
        if failure is None:
            for path in directory.rglob('*'):
                if path.is_dir():
                    path.chmod(0o700)
            shutil.rmtree(directory)
    except BaseException as error:
        failure = failure or f'Cleanup: {error}'
    report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'status': 'failed' if failure else 'passed', 'checks': checks,
              'packageSha256': hashlib.sha256(package.read_bytes()).hexdigest(),
              'cleanupVerified': cleanup_verified, 'screenshot': str(screenshot),
              'limits': ['Extracted package run; system package installation and tray Quit click were not exercised']}
    if failure:
        report.update(error=failure, preservedFixture=str(directory))
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
if failure:
    raise SystemExit(1)

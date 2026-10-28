import { mkdir, readFile, writeFile, stat, realpath, symlink, unlink, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const UPLOAD_LIMIT = 10 * 1024 * 1024;
const PREVIEW_LIMIT = 2 * 1024 * 1024;

async function raw(base, path, contentType, body) {
  const response = await fetch(base + path, {
    method: 'POST', headers: contentType ? { 'content-type': contentType } : {}, body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

function multipart(parts, boundary = 'cockpit-private-boundary') {
  return Buffer.concat([
    ...parts.flatMap(({ name = 'file', filename, bytes = Buffer.alloc(0), headers = '' }) => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n${headers}\r\n`),
      bytes, Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

export async function verifySystemFileChecks({ fixture, sandbox, rustUrl, request, check }) {
  // Node resolves upload roots at startup. Require the existing isolated TMPDIR
  // rather than ever writing into the user's shared /tmp upload directories.
  check(await realpath(fixture.env.TMPDIR), await realpath(fixture.directory), 'Node upload TMPDIR stays private');
  const bases = [fixture.url, rustUrl];
  const roots = [fixture.directory, sandbox];
  const project = { id: 'system-file-fixture', name: 'System File Fixture', path: join(fixture.directory, 'system-file-project') };
  const created = [];
  const uploads = [];
  const query = path => `/api/file?path=${encodeURIComponent(path)}`;
  const compare = async (path, expectedStatus = 200) => {
    const responses = await Promise.all(bases.map(base => request(base, path)));
    check(responses.map(response => response.status), [expectedStatus, expectedStatus], `File preview status: ${path}`);
    check(responses[1].data, responses[0].data, 'File preview matches original Node');
    return responses[0].data;
  };
  const upload = async (path, contentType, bytes, expectedStatus = 200, expectedBytes = bytes, extension) => {
    const results = await Promise.all(bases.map(base => raw(base, path, contentType, bytes)));
    for (let index = 0; index < results.length; index++) {
      const response = results[index];
      check(response.status, expectedStatus, `Upload status ${path} for ${index ? 'Rust' : 'Node'}`);
      if (response.status !== 200) continue;
      uploads.push(response.data.path);
      const folder = path === '/api/upload-image' ? 'cockpit-paste' : 'cockpit-uploads';
      check(await realpath(dirname(response.data.path)), await realpath(join(roots[index], folder)), 'Upload stays inside private runtime directory');
      const savedName = basename(response.data.path);
      check((path === '/api/upload-image' ? /^paste-\d+-[a-f0-9]{8}\.(png|jpg)$/ : /^img-[a-z0-9]+-[a-f0-9]{6}\.(png|jpg|jpeg|gif|webp|svg)$/).test(savedName), true, 'Upload uses generated filename');
      if (extension) check(savedName.endsWith(`.${extension}`), true, 'Upload extension follows original contract');
      check(await readFile(response.data.path), expectedBytes, 'Uploaded bytes preserved exactly');
      if (path === '/api/uploads') {
        check(response.data.name, savedName, 'Multipart response exposes generated basename');
        check(response.data.size, expectedBytes.length, 'Multipart response size is the extracted payload size');
      }
      if (index === 1) check((await stat(response.data.path)).mode & 0o777, 0o600, 'Native upload permissions are private');
    }
    if (expectedStatus === 200) {
      const normalize = data => path === '/api/upload-image' ? { ...data, path: 'PATH' } : { ...data, path: 'PATH', name: 'NAME' };
      check(normalize(results[1].data), normalize(results[0].data), 'Upload response shape matches Node');
      check(results[1].data.path === results[0].data.path, false, 'Uploads never share a destination across runtimes');
    } else {
      check(results[1].data, results[0].data, 'Upload error matches original Node');
    }
    return results;
  };
  try {
    await mkdir(join(project.path, 'nested'), { recursive: true });
    for (const base of bases) {
      const response = await request(base, '/api/projects', { method: 'POST', body: project });
      if (response.status === 201) created.push({ base, id: response.data.id });
      check(response.status, 201, 'Register private file-preview project');
      check(response.data.id, project.id, 'File-preview project ID is stable');
    }
    const text = join(project.path, '한글 😀.txt');
    const bytes = Buffer.concat([Buffer.from('한글 😀\r\n'), Buffer.from([0, 0xff, 0xc3, 0x28])]);
    await writeFile(text, bytes);
    const preview = await compare(query(text));
    check(preview.content, bytes.toString('utf8'), 'File preview uses UTF-8 replacement decoding');
    check(preview.size, bytes.length, 'File preview size counts bytes');
    await compare(query(join(project.path, 'nested') + '/../한글 😀.txt'));
    await compare('/api/file', 400);
    await compare('/api/file?path=', 400);
    await compare(query(join(project.path, 'missing.txt')), 404);
    await compare(query(project.path), 404);
    const outside = join(fixture.directory, 'system-file-outside');
    await mkdir(join(outside, 'sub'), { recursive: true });
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'outside private fixture');
    await compare(query(sentinel), 403);
    await compare(query(project.path + '/../system-file-outside/sentinel.txt'), 403);
    await compare(query(project.path + '/missing/../../system-file-outside/sentinel.txt'), 403);
    await compare(query(project.path + '-sibling/secret.txt'), 403);
    const large = join(project.path, 'limit.bin');
    await writeFile(large, Buffer.alloc(PREVIEW_LIMIT, 97));
    await compare(query(large));
    await writeFile(large, Buffer.alloc(PREVIEW_LIMIT + 1, 97));
    await compare(query(large), 413);
    const insideLink = join(project.path, 'inside-link.txt');
    await symlink(text, insideLink);
    await compare(query(insideLink));
    const escape = join(project.path, 'outside-link.txt');
    await symlink(sentinel, escape);
    check((await request(rustUrl, query(escape))).status, 403, 'Native preview rejects canonical symlink escape');
    // The original lexical validator permits this private sentinel. Native
    // containment intentionally fixes that behavior instead of copying it.
    check((await request(fixture.url, query(escape))).data.content, 'outside private fixture', 'Node oracle exposes the historical lexical-only guard');
    const directoryLink = join(project.path, 'directory-link');
    await symlink(join(outside, 'sub'), directoryLink, 'dir');
    check((await request(rustUrl, query(`${directoryLink}/../sentinel.txt`))).status, 403, 'Symlink followed by parent traversal cannot bypass canonical guard');

    await upload('/api/upload-image', 'image/png', Buffer.alloc(0), 400);
    for (const [type, extension] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['IMAGE/PNG', 'jpg'], ['', 'jpg']]) {
      await upload('/api/upload-image', type, bytes, 200, bytes, extension);
    }
    await upload('/api/upload-image', 'image/png', Buffer.alloc(UPLOAD_LIMIT, 1), 200, Buffer.alloc(UPLOAD_LIMIT, 1), 'png');
    await upload('/api/upload-image', 'image/png', Buffer.alloc(UPLOAD_LIMIT + 1), 413);
    await upload('/api/uploads', 'image/png', bytes, 400);
    await upload('/api/uploads', 'multipart/form-data', bytes, 400);
    await upload('/api/uploads', 'multipart/form-data; boundary=""', bytes, 400);
    await upload('/api/uploads', 'Multipart/form-data; boundary=abc', bytes, 400);
    await upload('/api/uploads', 'multipart/form-data; boundary=abc', Buffer.from('--abc--\r\n'), 400);
    const boundary = 'cockpit-private-boundary';
    const contentType = `multipart/form-data; boundary="${boundary}"`;
    const payload = Buffer.from([0, 255, 13, 10, 195, 40]);
    for (const extension of ['png', 'JPG', 'jpeg', 'gif', 'webp', 'svg']) {
      await upload('/api/uploads', contentType, multipart([{ filename: `../../한글.${extension}`, bytes: payload }]), 200, payload, extension.toLowerCase());
    }
    await upload('/api/uploads', contentType, multipart([{ name: 'description', bytes: Buffer.from('ignored') }, { filename: 'first.png', bytes: payload }, { filename: 'second.jpg', bytes: Buffer.from('ignored') }]), 200, payload, 'png');
    await upload('/api/uploads', contentType, multipart([{ filename: 'empty.png' }]), 200, Buffer.alloc(0), 'png');
    for (const filename of ['file.exe', 'file.', 'file.txt', 'file.png123456789', 'file.bad-ext', '']) {
      await upload('/api/uploads', contentType, multipart([{ filename, bytes: payload }]), 400);
    }
    const framing = multipart([{ filename: 'limit.png' }]).length;
    const exact = Buffer.alloc(UPLOAD_LIMIT - framing, 3);
    await upload('/api/uploads', contentType, multipart([{ filename: 'limit.png', bytes: exact }]), 200, exact, 'png');
    await upload('/api/uploads', contentType, multipart([{ filename: 'limit.png', bytes: Buffer.alloc(UPLOAD_LIMIT) }]), 413);

    for (const folder of ['cockpit-paste', 'cockpit-uploads']) {
      const destination = join(sandbox, folder);
      const backup = destination + '-fixture-backup';
      await rename(destination, backup);
      try {
        await symlink(outside, destination, 'dir');
        const endpoint = folder === 'cockpit-paste' ? '/api/upload-image' : '/api/uploads';
        const response = await raw(rustUrl, endpoint, folder === 'cockpit-paste' ? 'image/png' : contentType, folder === 'cockpit-paste' ? payload : multipart([{ filename: 'safe.png', bytes: payload }]));
        check(response.status, 500, 'Native upload refuses a symlinked storage directory');
        check(await readFile(sentinel, 'utf8'), 'outside private fixture', 'Failed upload never overwrites an outside target');
      } finally {
        await unlink(destination);
        await rename(backup, destination);
      }
    }
  } finally {
    for (const path of uploads) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const { base, id } of created) {
      check((await request(base, `/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })).status, 200, 'Remove file-preview project registration');
    }
  }
}

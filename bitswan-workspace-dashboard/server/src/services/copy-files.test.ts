import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  deleteCopyFile,
  readCopyFile,
  searchCopyFiles,
  statCopyFile,
  writeCopyFile,
} from './copy-files.js';

/**
 * Regression tests for #126: symlinks planted inside a copy must not
 * let reads/stats/searches/writes escape the copy, while plain files
 * (and symlinks that stay inside the copy) keep working.
 *
 * Layout built in a temp dir:
 *
 *   tmp/
 *     secret.txt                    <- outside every copy
 *     secretdir/inner.txt           <- outside every copy
 *     ws/copies/a/
 *       hello.txt                   <- normal file
 *       sub/nested.txt              <- normal nested file
 *       inside-link.txt             -> hello.txt        (stays inside)
 *       evil-file.txt               -> ../../../secret.txt
 *       evil-dir                    -> ../../../secretdir
 *     ws-link                       -> ws (workspace root via symlink)
 */
describe('copy-files symlink containment (#126)', () => {
  let tmp: string;
  let workspaceRoot: string;
  let workspaceRootViaLink: string;
  const copy = 'a';

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-files-126-'));
    workspaceRoot = path.join(tmp, 'ws');
    const copyDir = path.join(workspaceRoot, 'copies', copy);
    await fs.mkdir(path.join(copyDir, 'sub'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'secretdir'), { recursive: true });

    await fs.writeFile(path.join(tmp, 'secret.txt'), 'TOPSECRET outside\n');
    await fs.writeFile(path.join(tmp, 'secretdir', 'inner.txt'), 'TOPSECRET inner\n');
    await fs.writeFile(path.join(copyDir, 'hello.txt'), 'hello inside\n');
    await fs.writeFile(path.join(copyDir, 'sub', 'nested.txt'), 'nested inside\n');

    await fs.symlink(path.join(tmp, 'secret.txt'), path.join(copyDir, 'evil-file.txt'));
    await fs.symlink(path.join(tmp, 'secretdir'), path.join(copyDir, 'evil-dir'));
    await fs.symlink(path.join(copyDir, 'hello.txt'), path.join(copyDir, 'inside-link.txt'));

    workspaceRootViaLink = path.join(tmp, 'ws-link');
    await fs.symlink(workspaceRoot, workspaceRootViaLink);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('readCopyFile still reads a normal file', async () => {
    const r = await readCopyFile({ copy, path: 'hello.txt', workspaceRoot });
    assert.ok('content' in r, `expected content, got ${JSON.stringify(r)}`);
    assert.equal(r.content, 'hello inside\n');
  });

  it('readCopyFile works when the workspace root is reached via a symlink', async () => {
    const r = await readCopyFile({
      copy,
      path: 'hello.txt',
      workspaceRoot: workspaceRootViaLink,
    });
    assert.ok('content' in r, `expected content, got ${JSON.stringify(r)}`);
    assert.equal(r.content, 'hello inside\n');
  });

  it('readCopyFile follows a symlink that stays inside the copy', async () => {
    const r = await readCopyFile({ copy, path: 'inside-link.txt', workspaceRoot });
    assert.ok('content' in r, `expected content, got ${JSON.stringify(r)}`);
    assert.equal(r.content, 'hello inside\n');
  });

  it('readCopyFile refuses a symlinked file pointing outside the copy', async () => {
    const r = await readCopyFile({ copy, path: 'evil-file.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
  });

  it('readCopyFile refuses a path through a symlinked directory', async () => {
    const r = await readCopyFile({ copy, path: 'evil-dir/inner.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
  });

  it('readCopyFile still refuses lexical ../ escapes', async () => {
    const r = await readCopyFile({ copy, path: '../../secret.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
  });

  it('readCopyFile reports a genuinely missing file as not-found', async () => {
    const r = await readCopyFile({ copy, path: 'no/such/file.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
  });

  it('statCopyFile still stats a normal file', async () => {
    const r = await statCopyFile({ copy, path: 'sub/nested.txt', workspaceRoot });
    assert.ok('abs' in r, `expected stat, got ${JSON.stringify(r)}`);
    assert.equal(r.name, 'nested.txt');
    assert.equal(r.size, 'nested inside\n'.length);
  });

  it('statCopyFile refuses a symlinked file pointing outside the copy', async () => {
    const r = await statCopyFile({ copy, path: 'evil-file.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
  });

  it('statCopyFile refuses a path through a symlinked directory', async () => {
    const r = await statCopyFile({ copy, path: 'evil-dir/inner.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
  });

  it('searchCopyFiles finds content in normal files', async () => {
    const r = await searchCopyFiles({ copy, workspaceRoot, query: 'nested inside' });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]?.path, 'sub/nested.txt');
  });

  it('searchCopyFiles does not follow file symlinks out of the copy', async () => {
    const r = await searchCopyFiles({ copy, workspaceRoot, query: 'TOPSECRET' });
    assert.deepEqual(r, { matches: [], truncated: false });
  });

  it('searchCopyFiles refuses a scope that is a symlink out of the copy', async () => {
    const r = await searchCopyFiles({
      copy,
      workspaceRoot,
      query: 'TOPSECRET',
      scope: 'evil-dir',
    });
    assert.deepEqual(r, { matches: [], truncated: false });
  });

  it('writeCopyFile refuses to write through a symlinked directory', async () => {
    const r = await writeCopyFile({
      copy,
      path: 'evil-dir/pwned.txt',
      workspaceRoot,
      content: 'pwned',
    });
    assert.deepEqual(r, { error: 'not-found' });
    await assert.rejects(fs.access(path.join(tmp, 'secretdir', 'pwned.txt')));
  });

  it('writeCopyFile refuses to write to a symlinked file pointing outside', async () => {
    const r = await writeCopyFile({
      copy,
      path: 'evil-file.txt',
      workspaceRoot,
      content: 'pwned',
    });
    assert.deepEqual(r, { error: 'not-found' });
    assert.equal(
      await fs.readFile(path.join(tmp, 'secret.txt'), 'utf8'),
      'TOPSECRET outside\n',
    );
  });

  it('writeCopyFile still writes normal files', async () => {
    const r = await writeCopyFile({
      copy,
      path: 'sub/new.txt',
      workspaceRoot,
      content: 'brand new\n',
    });
    assert.ok('ok' in r, `expected ok, got ${JSON.stringify(r)}`);
    const read = await readCopyFile({ copy, path: 'sub/new.txt', workspaceRoot });
    assert.ok('content' in read);
    assert.equal(read.content, 'brand new\n');
  });

  it('deleteCopyFile refuses to delete through a symlinked directory', async () => {
    const r = await deleteCopyFile({ copy, path: 'evil-dir/inner.txt', workspaceRoot });
    assert.deepEqual(r, { error: 'not-found' });
    await fs.access(path.join(tmp, 'secretdir', 'inner.txt')); // still there
  });

  it('deleteCopyFile still deletes normal files', async () => {
    const r = await deleteCopyFile({ copy, path: 'sub/new.txt', workspaceRoot });
    assert.deepEqual(r, { ok: true });
  });
});

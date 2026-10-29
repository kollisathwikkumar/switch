const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.env.TRACEMIND_NATIVE_PATH) throw new Error('TRACEMIND_NATIVE_PATH is required');
const native = require(process.env.TRACEMIND_NATIVE_PATH);
test('directory handle remains confined after a pathname is replaced with a symlink', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-openat-'));
  let root = -1,
    child = -1;
  try {
    fs.mkdirSync(path.join(parent, 'project'));
    fs.mkdirSync(path.join(parent, 'outside'));
    fs.mkdirSync(path.join(parent, 'project', 'src'));
    fs.writeFileSync(path.join(parent, 'project', 'src', 'inside'), 'x');
    fs.writeFileSync(path.join(parent, 'outside', 'secret'), 'x');
    root = native.openRoot(path.join(parent, 'project'));
    fs.renameSync(path.join(parent, 'project'), path.join(parent, 'old'));
    fs.symlinkSync(path.join(parent, 'outside'), path.join(parent, 'project'));
    child = native.openDirectory(root, Buffer.from('src'));
    assert.deepEqual(native.list(child, 10).names.map(String), ['inside']);
    assert.throws(() => native.openDirectory(root, Buffer.from('../outside')));
  } finally {
    if (child >= 0) fs.closeSync(child);
    if (root >= 0) fs.closeSync(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test('rejects a symlink swapped into a directory after enumeration', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-openat-'));
  let root = -1;
  try {
    fs.mkdirSync(path.join(parent, 'src'));
    fs.mkdirSync(path.join(parent, 'outside'));
    root = native.openRoot(parent);
    assert(native.list(root, 10).names.some((x) => x.toString() === 'src'));
    fs.renameSync(path.join(parent, 'src'), path.join(parent, 'old'));
    fs.symlinkSync(path.join(parent, 'outside'), path.join(parent, 'src'));
    assert.throws(() => native.openDirectory(root, Buffer.from('src')));
  } finally {
    if (root >= 0) fs.closeSync(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test('bounds enumeration and reports truncation', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-openat-'));
  let root = -1;
  try {
    fs.writeFileSync(path.join(parent, 'a'), 'a');
    fs.writeFileSync(path.join(parent, 'b'), 'b');
    root = native.openRoot(parent);
    const result = native.list(root, 1);
    assert.equal(result.names.length, 1);
    assert.equal(result.complete, false);
  } finally {
    if (root >= 0) fs.closeSync(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test('opens only regular files under the parent and rejects symlinks and directories', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-openat-'));
  let root = -1,
    file = -1;
  try {
    fs.writeFileSync(path.join(parent, 'a'), 'content');
    fs.mkdirSync(path.join(parent, 'dir'));
    fs.symlinkSync(path.join(parent, 'a'), path.join(parent, 'link'));
    root = native.openRoot(parent);
    file = native.openFile(root, Buffer.from('a'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'content');
    assert.throws(() => native.openFile(root, Buffer.from('link')));
    assert.throws(() => native.openFile(root, Buffer.from('dir')));
    assert.throws(() => native.openFile(root, Buffer.from('a\0b')));
  } finally {
    if (file >= 0) fs.closeSync(file);
    if (root >= 0) fs.closeSync(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test('each listing starts at the beginning without changing the parent handle cursor', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-openat-'));
  let root = -1;
  try {
    fs.writeFileSync(path.join(parent, 'a'), 'a');
    fs.writeFileSync(path.join(parent, 'b'), 'b');
    root = native.openRoot(parent);
    const first = native.list(root, 10).names.map(String).sort();
    const second = native.list(root, 10).names.map(String).sort();
    assert.deepEqual(second, first);
    assert.equal(second.length, 2);
  } finally {
    if (root >= 0) fs.closeSync(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
test('exposes stable native identities and closes owned handles through the native API', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-identity-'));
  let root = -1;
  try {
    root = native.openRoot(parent);
    assert.match(native.identity(root), /^\d{1,40}:\d{1,40}$/);
    native.close(root);
    root = -1;
    assert.throws(() => native.identity(-1));
  } finally {
    if (root >= 0) native.close(root);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

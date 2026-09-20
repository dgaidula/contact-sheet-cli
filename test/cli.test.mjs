import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { escapeHtml, parseColumnArg, relHref, buildRows, sortRows, renderHtml } from '../contact-sheet-cli.mjs';

const CLI = new URL('../contact-sheet-cli.mjs', import.meta.url).pathname;
const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

// ---- minimal 1x1 PNG encoder (test fixtures) --------------------------------
// Adapted from the encoder in lineart-rich-black/test/cli.test.mjs.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function makePng(r, g, b) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const raw = Buffer.from([0, r, g, b]); // filter byte + 1 pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(file, r = 10, g = 20, b = 30) {
  writeFileSync(file, makePng(r, g, b));
}

function tmpDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ---- unit tests: pure helpers -------------------------------------------------

test('parseColumnArg: plain dir uses basename as label', () => {
  assert.deepEqual(parseColumnArg('foo/bar/baz'), { label: 'baz', dir: 'foo/bar/baz' });
});

test('parseColumnArg: Label=dir splits on first =', () => {
  assert.deepEqual(parseColumnArg('Original=foo/bar'), { label: 'Original', dir: 'foo/bar' });
});

test('escapeHtml escapes the five reserved characters we care about', () => {
  assert.equal(escapeHtml('<a href="x">&y</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;');
});

test('relHref percent-encodes segments but keeps "/" literal', () => {
  const href = relHref('/out/sheet.html', '/out/images/a b#1.png');
  assert.equal(href, 'images/a%20b%231.png');
});

test('buildRows: suffix variants (incl. multi-level) fold into the base row with a caption', () => {
  const columns = [
    {
      files: [
        { name: 'name.png', full: '/a/name.png', ext: 'png', stem: 'name', mtime: 1 },
        { name: 'name-alt.png', full: '/a/name-alt.png', ext: 'png', stem: 'name-alt', mtime: 2 },
        { name: 'other.png', full: '/a/other.png', ext: 'png', stem: 'other', mtime: 3 },
      ],
    },
    {
      files: [
        { name: 'name-gemini-bg.jpg', full: '/b/name-gemini-bg.jpg', ext: 'jpg', stem: 'name-gemini-bg', mtime: 4 },
      ],
    },
  ];
  const rows = buildRows(columns);
  assert.equal(rows.length, 2); // "name" and "other" are rows; "name-alt"/"name-gemini-bg" fold in
  const nameRow = rows.find((r) => r.label === 'name');
  assert.ok(nameRow);
  assert.equal(nameRow.cells[0].length, 2); // name.png + name-alt.png
  assert.equal(nameRow.cells[0].find((f) => f.stem === 'name').caption, null);
  assert.equal(nameRow.cells[0].find((f) => f.stem === 'name-alt').caption, 'alt');
  assert.equal(nameRow.cells[1].length, 1);
  assert.equal(nameRow.cells[1][0].caption, 'gemini-bg'); // full suffix chain, not just "bg"
});

test('buildRows: case-insensitive stem matching merges across columns', () => {
  const columns = [
    { files: [{ name: 'Photo1.png', full: '/a/Photo1.png', ext: 'png', stem: 'Photo1', mtime: 1 }] },
    { files: [{ name: 'photo1.jpg', full: '/b/photo1.jpg', ext: 'jpg', stem: 'photo1', mtime: 2 }] },
  ];
  const rows = buildRows(columns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cells[0].length, 1);
  assert.equal(rows[0].cells[1].length, 1);
});

test('buildRows: a variant with no shorter root anywhere becomes its own row', () => {
  const columns = [
    { files: [{ name: 'name-alt.png', full: '/a/name-alt.png', ext: 'png', stem: 'name-alt', mtime: 1 }] },
  ];
  const rows = buildRows(columns);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'name-alt');
  assert.equal(rows[0].cells[0][0].caption, null);
});

test('sortRows: name sort is case-insensitive alphabetical; mtime sort uses earliest match', () => {
  const rows = [
    { key: 'b', label: 'Banana', cells: [], mtimes: [], mtime: 5 },
    { key: 'a', label: 'apple', cells: [], mtimes: [], mtime: 9 },
  ];
  assert.deepEqual(sortRows(rows, 'name').map((r) => r.label), ['apple', 'Banana']);
  assert.deepEqual(sortRows(rows, 'mtime').map((r) => r.label), ['Banana', 'apple']);
});

// ---- CLI / integration tests --------------------------------------------------

test('CLI: builds a sheet with grouped variants, missing placeholders, and counts', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    const orig = path.join(root, 'orig');
    const proc = path.join(root, 'proc');
    mkdirSync(orig);
    mkdirSync(proc);
    writePng(path.join(orig, 'shot1.png'));
    writePng(path.join(orig, 'shot2.png'));
    writePng(path.join(proc, 'shot1.png'));
    writePng(path.join(proc, 'shot1-alt.png'));
    writePng(path.join(proc, 'shot3.png'));

    const out = path.join(root, 'sheet.html');
    const log = run('--out', out, 'Original=' + orig, 'Processed=' + proc);
    assert.match(log, /3 row\(s\), 2 column\(s\), 5 file\(s\), 2 missing cell\(s\)/);

    const html = readFileSync(out, 'utf8');
    assert.match(html, /rowhead">shot1</);
    assert.match(html, /rowhead">shot2</);
    assert.match(html, /rowhead">shot3</);
    assert.match(html, /class="caption">alt</); // shot1-alt grouped under shot1's row
    assert.equal((html.match(/class="cell missing"/g) || []).length, 2); // shot2/proc, shot3/orig
    assert.match(html, /2 missing cell/);
    assert.match(html, /generated \d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: relative image paths are correct when --out lives in a different directory', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    const orig = path.join(root, 'batch', 'orig');
    mkdirSync(orig, { recursive: true });
    writePng(path.join(orig, 'a.png'));

    const out = path.join(root, 'reports', 'nested', 'sheet.html');
    run('--out', out, orig);

    const html = readFileSync(out, 'utf8');
    assert.match(html, /src="\.\.\/\.\.\/batch\/orig\/a\.png"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: Label=dir syntax names the column header', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    const dir = path.join(root, 'weirdly-named-dir-x9');
    mkdirSync(dir);
    writePng(path.join(dir, 'a.png'));

    const out = path.join(root, 'sheet.html');
    run('--out', out, 'Nice Label=' + dir);

    const html = readFileSync(out, 'utf8');
    assert.match(html, /<th>Nice Label<\/th>/);
    assert.doesNotMatch(html, /<th>weirdly-named-dir-x9<\/th>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: TIFF renders as a filename link, not <img>', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    const dir = path.join(root, 'scans');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'page1.tif'), Buffer.from([0x49, 0x49, 0x2a, 0x00])); // fake, extension is all that matters

    const out = path.join(root, 'sheet.html');
    run('--out', out, dir);

    const html = readFileSync(out, 'utf8');
    assert.match(html, /<a class="filelink" href="scans\/page1\.tif"[^>]*>page1\.tif<\/a>/);
    assert.doesNotMatch(html, /<img[^>]*page1\.tif/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: exits non-zero when a directory does not exist', () => {
  assert.throws(() => run('/no/such/directory/xyz'));
  try {
    run('/no/such/directory/xyz');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stderr.toString(), /directory not found/);
  }
});

test('CLI: exits non-zero when no images are found', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    try {
      run(root);
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(e.stderr.toString(), /no images found/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: exits non-zero and prints usage when no directories are given', () => {
  try {
    run();
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(e.stdout.toString(), /Usage:/);
  }
});

test('CLI: --help prints only the contiguous header comment, exits 0', () => {
  const out = run('--help');
  assert.match(out, /^contact-sheet-cli: build a self-contained HTML contact sheet/);
  assert.match(out, /Usage:/);
  assert.doesNotMatch(out, /^---- /m); // internal section-comment banners must not leak
});

test('CLI: rejects an unknown --sort value', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    writePng(path.join(root, 'a.png'));
    try {
      run('--sort', 'bogus', root);
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(e.stderr.toString(), /--sort must be/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--exclude skips matching files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-'));
  try {
    const col = path.join(dir, 'art');
    mkdirSync(col);
    writePng(path.join(col, 'a.png'));
    writePng(path.join(col, 'a-compound-whites.png'));
    const out = path.join(dir, 'sheet.html');
    run('--exclude=-compound-whites', '--out', out, col);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /a\.png/);
    assert.doesNotMatch(html, /compound-whites/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderHtml: --link turns each row label into an anchor built from the {stem} template', () => {
  const rows = [{ label: 'A', cells: [[], []] }, { label: 'b c', cells: [[], []] }];
  const columns = [{ label: 'x', dir: 'x' }, { label: 'y', dir: 'y' }];
  const html = renderHtml({ title: 't', columns, rows, outPath: 'sheet.html', generatedAt: 'now', link: '../pages/{stem}/index.html' });
  assert.match(html, /<th class="rowhead"><a href="\.\.\/pages\/A\/index\.html">A<\/a><\/th>/);
  assert.match(html, /href="\.\.\/pages\/b%20c\/index\.html">b c<\/a>/);
  const plain = renderHtml({ title: 't', columns, rows, outPath: 'sheet.html', generatedAt: 'now' });
  assert.doesNotMatch(plain, /rowhead"><a /);
});

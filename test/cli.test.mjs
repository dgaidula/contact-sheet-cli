import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  escapeHtml, parseColumnArg, relHref, buildRows, sortRows, renderHtml,
  parseTiles, parsePaper, isEstimated, itemsFromManifest, itemsFromList, naturalCompare,
  planPages, rangeText, renderPagesHtml, imText, thumbName,
} from '../contact-sheet-cli.mjs';

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

// ---- review pages (`pages`): unit tests ---------------------------------------

const item = (name, fields = {}) => ({
  path: `/photos/${name}`, name, ext: path.extname(name).slice(1), seq: null, date: null,
  estimated: false, label: null, section: null, ...fields,
});

test('parseTiles: CxR within 1-20, anything else is null', () => {
  assert.deepEqual(parseTiles('6x6'), { cols: 6, rows: 6 });
  assert.deepEqual(parseTiles('4X5'), { cols: 4, rows: 5 });
  for (const bad of ['6', '0x3', '21x2', '6x6x6', 'axb', '']) assert.equal(parseTiles(bad), null, bad);
});

test('parsePaper: size then orientation, landscape by default; exact CSS lengths', () => {
  assert.deepEqual(parsePaper('letter landscape'), {
    name: 'letter', orientation: 'landscape', widthIn: 11, heightIn: 8.5, cssWidth: '11in', cssHeight: '8.5in',
  });
  const a4 = parsePaper('A4 portrait');
  assert.equal(a4.cssWidth, '210mm');
  assert.equal(a4.cssHeight, '297mm');
  assert.equal(parsePaper('a4').orientation, 'landscape');
  for (const bad of ['letterish', 'a4 sideways', 'a4 portrait extra', '']) assert.equal(parsePaper(bad), null, bad);
});

test('isEstimated: the contract date.estimated flag, or a guessed dateSrc', () => {
  assert.equal(isEstimated({ date: { label: '1984', estimated: true } }), true);
  assert.equal(isEstimated({ date: { label: '1984-06-02', estimated: false } }), false);
  assert.equal(isEstimated({ dateLabel: '1971', dateSrc: 'archival-caption' }), true);
  assert.equal(isEstimated({ dateLabel: '1971', dateSrc: 'file-mtime' }), true);
  assert.equal(isEstimated({ dateLabel: '1971-05-02', dateSrc: 'exif' }), false);
  assert.equal(isEstimated({}), false);
});

test('itemsFromManifest: contract rows and flat rows, sections by key, path-less rows skipped', () => {
  const text = [
    JSON.stringify({ id: 'a', kind: 'still', paths: ['/x/a.jpg', '/y/a-copy.jpg'], category: 'picks',
      date: { iso: '2004-05-28T10:00:00', label: '2004-05-28', estimated: true } }),
    '',
    JSON.stringify({ path: 'rel/b.jpg', seq: '009', dateLabel: '1984', dateSrc: 'exif', group: { groupId: 'g1' } }),
    JSON.stringify({ kind: 'range', fileId: 'f', in: 1, out: 2 }),
    JSON.stringify({ paths: ['/x/c.jpg'], date: { iso: '1999-01-02T00:00:00', estimated: false } }),
  ].join('\n');
  const { items, skipped } = itemsFromManifest(text, { baseDir: '/base' });
  assert.equal(skipped, 1);
  assert.deepEqual(items.map((it) => it.path), ['/x/a.jpg', '/base/rel/b.jpg', '/x/c.jpg']);
  assert.deepEqual(items.map((it) => it.date), ['2004-05-28', '1984', '1999-01-02']); // label, flat label, iso fallback
  assert.deepEqual(items.map((it) => it.estimated), [true, false, false]);
  assert.deepEqual(items.map((it) => it.seq), [null, '009', null]);
  assert.deepEqual(items.map((it) => it.section), ['picks', null, null]);
  const byGroup = itemsFromManifest(text, { baseDir: '/base', sectionKey: 'group.groupId' }).items;
  assert.deepEqual(byGroup.map((it) => it.section), [null, 'g1', null]);
});

test('itemsFromManifest: a line that is not JSON is a usage error naming the line', () => {
  assert.throws(() => itemsFromManifest('{"path":"a.jpg"}\nnot json\n'), (e) => e.exitCode === 2 && /line 2/.test(e.message));
});

test('itemsFromList: path, then optional tab-separated label and section; comments skipped', () => {
  const text = '# picks for round 2\n\nimgs/a.jpg\n/abs/b.jpg\t1984 ≈\nimgs/c.jpg\t\tMaybe\r\n';
  const items = itemsFromList(text, '/lists');
  assert.deepEqual(items.map((it) => it.path), ['/lists/imgs/a.jpg', '/abs/b.jpg', '/lists/imgs/c.jpg']);
  assert.deepEqual(items.map((it) => it.label), [null, '1984 ≈', null]);
  assert.deepEqual(items.map((it) => it.section), [null, null, 'Maybe']);
});

test('naturalCompare: numbers in names sort by value, case-insensitively', () => {
  assert.deepEqual(['IMG_10.jpg', 'img_2.jpg', 'IMG_1.jpg'].sort(naturalCompare), ['IMG_1.jpg', 'img_2.jpg', 'IMG_10.jpg']);
});

test('planPages: without seq, input order and one running number across every section', () => {
  const items = [
    item('a.jpg', { section: 'Picks' }), item('b.jpg', { section: 'Maybe' }),
    item('c.jpg', { section: 'Picks' }), item('d.jpg', { section: 'Maybe' }),
  ];
  const plan = planPages(items, { perPage: 36 });
  assert.equal(plan.bySeq, false);
  assert.deepEqual(plan.sections, ['Picks', 'Maybe']); // first appearance
  assert.deepEqual(plan.pages.map((p) => p.tiles.map((t) => `${t.num}:${t.name}`)), [
    ['001:a.jpg', '002:c.jpg'], ['003:b.jpg', '004:d.jpg'],
  ]);
});

test('planPages: when every item has seq, order by it (numeric-aware) and show it as given', () => {
  const items = [item('c.jpg', { seq: '010' }), item('a.jpg', { seq: '009' }), item('b.jpg', { seq: '9a' })];
  const plan = planPages(items, { perPage: 36 });
  assert.equal(plan.bySeq, true);
  assert.deepEqual(plan.pages[0].tiles.map((t) => t.num), ['009', '9a', '010']);
  const numeric = planPages([item('x.jpg', { seq: 12 }), item('y.jpg', { seq: 4 })], { perPage: 36 });
  assert.deepEqual(numeric.pages[0].tiles.map((t) => t.num), ['004', '012']);
});

test('planPages: if any item lacks seq, numbers are positional and the order is kept', () => {
  const plan = planPages([item('a.jpg', { seq: '050' }), item('b.jpg')], { perPage: 36 });
  assert.equal(plan.bySeq, false);
  assert.deepEqual(plan.pages[0].tiles.map((t) => `${t.num}:${t.name}`), ['001:a.jpg', '002:b.jpg']);
});

test('planPages: pages hold perPage tiles, and each section starts a new page', () => {
  const items = [
    ...['1', '2', '3', '4', '5'].map((n) => item(`p${n}.jpg`, { section: 'Picks' })),
    item('m1.jpg', { section: 'Maybe' }), item('m2.jpg', { section: 'Maybe' }),
  ];
  const plan = planPages(items, { perPage: 4 });
  assert.deepEqual(plan.pages.map((p) => [p.section, p.tiles.length, p.from, p.to, p.total, p.number, p.of]), [
    ['Picks', 4, 1, 4, 5, 1, 3],
    ['Picks', 1, 5, 5, 5, 2, 3],
    ['Maybe', 2, 1, 2, 2, 3, 3],
  ]);
  assert.deepEqual(plan.pages.map(rangeText), ['1–4 of 5', '5 of 5', '1–2 of 2']);
});

test('planPages: tile text is the date, else the list label, else the file name; ≈ only on an estimated date', () => {
  const plan = planPages([
    item('a.jpg', { date: '1984', estimated: true }),
    item('b.jpg', { date: '1985-02-03' }),
    item('c.jpg', { label: 'from the 1970s box', estimated: true }),
    item('d.jpg'),
  ], { perPage: 36 });
  assert.deepEqual(plan.pages[0].tiles.map((t) => [t.text, t.approx]), [
    ['1984', true], ['1985-02-03', false], ['from the 1970s box', false], ['d.jpg', false],
  ]);
});

test('imText: neutralises ImageMagick %-escapes, backslashes and a leading @', () => {
  assert.equal(imText('100% done'), '100%% done');
  assert.equal(imText('a\\nb'), 'a\\\\nb');
  assert.equal(imText('@/etc/passwd'), '\\@/etc/passwd');
  assert.equal(imText('009  1984 ≈'), '009  1984 ≈');
});

test('thumbName: same stem from two folders never collides', () => {
  assert.notEqual(thumbName('/a/IMG_0001.JPG'), thumbName('/b/IMG_0001.JPG'));
  assert.match(thumbName('/a/IMG 0001.JPG'), /^IMG_0001-[0-9a-f]{8}\.jpg$/);
});

test('renderPagesHtml: masthead, eyebrow only on a titled section, missing and non-browser tiles', () => {
  const plan = planPages([
    item('a.jpg', { date: '1984', estimated: true }),
    item('scan.tif', { section: 'Scans' }),
    item('gone.jpg', { section: 'Scans' }),
  ], { perPage: 4 });
  plan.pages[1].tiles[1].missing = true;
  const html = renderPagesHtml({
    title: 'Round <2>', plan, paper: parsePaper('letter landscape'), tiles: { cols: 2, rows: 2 },
    outPath: '/photos/review/sheet.html', generatedAt: '2026-10-08 09:00',
  });
  assert.equal((html.match(/<section class="page">/g) || []).length, 2);
  assert.match(html, /@page \{ size: 11in 8\.5in; margin: 0; \}/);
  assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /<h1>Round &lt;2&gt;<\/h1><\/div><p class="range">1 of 1<\/p>/); // untitled: no eyebrow
  assert.match(html, /<p class="eyebrow">Round &lt;2&gt;<\/p><h1>Scans<\/h1><\/div><p class="range">1–2 of 2<\/p>/);
  assert.match(html, /<img src="\.\.\/a\.jpg" data-full="\.\.\/a\.jpg"/);
  assert.match(html, /<span class="num">001<\/span><span class="text">1984 <span class="approx" title="estimated date">≈<\/span>/);
  assert.match(html, /<p class="note"><a href="\.\.\/scan\.tif">scan\.tif<\/a><\/p>/); // TIFF: a link, not an <img>
  assert.match(html, /<p class="note">missing<br>gone\.jpg<\/p>/);
  assert.match(html, /page 2 of 2/);
});

// ---- review pages (`pages`): CLI tests -----------------------------------------

const runPages = (args, opts = {}) =>
  spawnSync(process.execPath, [CLI, 'pages', ...args], { encoding: 'utf8', ...opts });
const hasMagick = !(spawnSync('magick', ['-version']).error?.code === 'ENOENT');
const hasThumbTool = (process.platform === 'darwin' && !spawnSync('sips', ['--version']).error) || hasMagick;
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const pages = (html) => html.split('<section class="page">').slice(1);

// A three-section manifest: picks, then two maybe groups, interleaved in the
// file, with contract date blocks (some estimated) and one flat legacy row.
function threeSectionFixture(root) {
  const photos = path.join(root, 'photos');
  mkdirSync(photos);
  const rows = [];
  const add = (n, category, date, extra = {}) => {
    const file = path.join(photos, `IMG_${n}.png`);
    writePng(file, n * 10, 40, 90);
    rows.push({ id: `id${n}`, kind: 'still', paths: [file], category, date, ...extra });
  };
  add(1, 'Picks', { label: '1971-05-02', estimated: false });
  add(2, 'Picks', { label: '1972', estimated: true });
  add(3, 'Maybe — is it them?', { label: '1980-01-01', estimated: false });
  add(4, 'Picks', { label: '1975-07-04', estimated: false });
  add(5, 'Maybe — include it?', { label: '1990', estimated: true });
  add(6, 'Maybe — is it them?', { label: 'undated', estimated: false });
  rows.push({ kind: 'range', fileId: 'v', in: 1, out: 3 });
  const manifest = path.join(root, 'manifest.jsonl');
  writeFileSync(manifest, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { photos, manifest };
}

test('CLI pages: a three-section manifest gives one page per section, numbered across the sheet', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const { manifest } = threeSectionFixture(root);
    const out = path.join(root, 'sheet.html');
    const r = runPages([manifest, '--out', out, '--title', 'Round 1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /6 image\(s\), 3 section\(s\), 3 page\(s\) of 6x6, 0 missing file\(s\)/);
    assert.match(r.stderr, /skipped 1 manifest row\(s\) with no image path/);
    const sheet = pages(readFileSync(out, 'utf8'));
    assert.equal(sheet.length, 3);
    assert.match(sheet[0], /<h1>Picks<\/h1>[\s\S]*1–3 of 3/);
    assert.match(sheet[1], /<h1>Maybe — is it them\?<\/h1>[\s\S]*1–2 of 2/);
    assert.match(sheet[2], /<h1>Maybe — include it\?<\/h1>[\s\S]*1 of 1/);
    const nums = (pg) => [...pg.matchAll(/class="num">(\d+)</g)].map((m) => m[1]);
    assert.deepEqual(sheet.map(nums), [['001', '002', '003'], ['004', '005'], ['006']]);
    assert.match(sheet[0], /IMG_4\.png[\s\S]*class="num">003<\/span><span class="text">1975-07-04<\/span>/);
    assert.match(sheet[0], /class="num">002<\/span><span class="text">1972 <span class="approx"/);
    assert.match(sheet[2], /class="num">006<\/span><span class="text">1990 <span class="approx"/);
    assert.equal((readFileSync(out, 'utf8').match(/class="approx"/g) || []).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: --tiles sets the page size; a section breaks into pages of N tiles', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const dir = path.join(root, 'shots');
    mkdirSync(dir);
    for (let i = 1; i <= 9; i++) writePng(path.join(dir, `s${i}.png`));
    const out = path.join(root, 'sheet.html');
    const r = runPages([dir, '--tiles', '2x2', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const sheet = pages(readFileSync(out, 'utf8'));
    assert.deepEqual(sheet.map((pg) => (pg.match(/<figure class="tile">/g) || []).length), [4, 4, 1]);
    assert.deepEqual(sheet.map((pg) => pg.match(/class="range">([^<]*)</)[1]), ['1–4 of 9', '5–8 of 9', '9 of 9']);
    assert.match(sheet[2], /page 3 of 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: a directory is read flat, in natural filename order, titled by its name', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const dir = path.join(root, 'commencement');
    mkdirSync(dir);
    for (const n of ['IMG_10.png', 'IMG_2.png', 'img_1.png']) writePng(path.join(dir, n));
    writeFileSync(path.join(dir, 'notes.txt'), 'not an image');
    mkdirSync(path.join(dir, 'nested'));
    writePng(path.join(dir, 'nested', 'IMG_0.png'));
    const out = path.join(root, 'sheet.html');
    const r = runPages([dir, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /<title>commencement<\/title>/);
    const shown = [...html.matchAll(/alt="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    assert.deepEqual(shown, ['img_1.png', 'IMG_2.png', 'IMG_10.png']);
    assert.deepEqual([...html.matchAll(/class="text">([^<]+)</g)].map((m) => m[1]), ['img_1.png', 'IMG_2.png', 'IMG_10.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: a list file with label and section columns; paths resolve from the list, hrefs from --out', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const imgs = path.join(root, 'job', 'imgs');
    mkdirSync(imgs, { recursive: true });
    writePng(path.join(imgs, 'a b.png'));
    writePng(path.join(imgs, 'c.png'));
    writePng(path.join(imgs, 'd.png'));
    const list = path.join(root, 'job', 'round2.txt');
    writeFileSync(list, '# round 2\nimgs/a b.png\tWedding, 1984\tPicks\nimgs/c.png\t\tMaybe\nimgs/d.png\tlate addition\tPicks\n');
    const out = path.join(root, 'reports', 'nested', 'sheet.html');
    const r = runPages([list, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /<title>round2<\/title>/);
    const sheet = pages(html);
    assert.equal(sheet.length, 2);
    assert.match(sheet[0], /<h1>Picks<\/h1>/);
    assert.match(sheet[0], /src="\.\.\/\.\.\/job\/imgs\/a%20b\.png"/);
    assert.match(sheet[0], /class="num">001<\/span><span class="text">Wedding, 1984<\/span>/);
    assert.match(sheet[0], /class="num">002<\/span><span class="text">late addition<\/span>/);
    assert.match(sheet[1], /<h1>Maybe<\/h1>[\s\S]*class="num">003<\/span><span class="text">c\.png<\/span>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: a missing image keeps its number, shows as missing, and exits 1', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    writePng(path.join(root, 'here.png'));
    const list = path.join(root, 'list.txt');
    writeFileSync(list, 'here.png\ngone.png\n');
    const out = path.join(root, 'sheet.html');
    const r = runPages([list, '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing: 002 .*gone\.png/);
    assert.match(r.stdout, /1 missing file\(s\)/);
    assert.match(readFileSync(out, 'utf8'), /<p class="note">missing<br>gone\.png<\/p><\/div><figcaption><span class="num">002</);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: usage errors exit 2 and write nothing', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    writePng(path.join(root, 'a.png'));
    const out = path.join(root, 'sheet.html');
    for (const args of [[root, '--tiles', '6by6'], [root, '--page', 'postcard'], [], [root, root], [root, '--bogus'], [path.join(root, 'nope')]]) {
      const r = runPages([...args, '--out', out]);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '');
    }
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: --pdf without ImageMagick on PATH exits 3 with a clear message and writes nothing', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const { manifest } = threeSectionFixture(root);
    const emptyBin = path.join(root, 'empty-bin');
    mkdirSync(emptyBin);
    const out = path.join(root, 'sheet.html');
    const r = runPages([manifest, '--out', out, '--pdf', path.join(root, 'sheet.pdf')], { env: { ...process.env, PATH: emptyBin } });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /--pdf needs ImageMagick 7 \(the "magick" command\) on PATH/);
    assert.match(r.stderr, /print the HTML to PDF from a browser/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(path.join(root, 'sheet.pdf')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: --pdf with ImageMagick writes one PDF page per sheet page; sources untouched', { skip: !hasMagick && 'magick not on PATH' }, () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const { photos, manifest } = threeSectionFixture(root);
    const before = readdirSync(photos).map((f) => sha(path.join(photos, f)));
    const pdf = path.join(root, 'out', 'sheet.pdf');
    const r = runPages([manifest, '--out', path.join(root, 'sheet.html'), '--pdf', pdf, '--title', '100% @home']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote .*sheet\.pdf/);
    const bytes = readFileSync(pdf);
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal((bytes.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length, 3);
    assert.deepEqual(readdirSync(photos).map((f) => sha(path.join(photos, f))), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: --thumbs writes downscaled copies and shows them; the full image stays the zoom target', { skip: !hasThumbTool && 'neither sips nor magick available' }, () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const { photos, manifest } = threeSectionFixture(root);
    const before = readdirSync(photos).map((f) => sha(path.join(photos, f)));
    const out = path.join(root, 'review', 'sheet.html');
    const thumbs = path.join(root, 'review', 'thumbs');
    const r = runPages([manifest, '--out', out, '--thumbs', thumbs]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /thumbnails: 6 made, 0 reused/);
    assert.equal(readdirSync(thumbs).filter((f) => f.endsWith('.jpg')).length, 6);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /<img src="thumbs\/IMG_1-[0-9a-f]{8}\.jpg" data-full="\.\.\/photos\/IMG_1\.png"/);
    assert.deepEqual(readdirSync(photos).map((f) => sha(path.join(photos, f))), before);
    assert.deepEqual(readdirSync(photos).sort(), ['IMG_1.png', 'IMG_2.png', 'IMG_3.png', 'IMG_4.png', 'IMG_5.png', 'IMG_6.png']);
    const again = runPages([manifest, '--out', out, '--thumbs', thumbs]);
    assert.match(again.stdout, /thumbnails: 0 made, 6 reused/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI pages: --thumbs refuses a folder that holds source images', () => {
  const root = tmpDir('contact-sheet-pages-');
  try {
    const { photos, manifest } = threeSectionFixture(root);
    const r = runPages([manifest, '--out', path.join(root, 'sheet.html'), '--thumbs', photos]);
    if (!hasThumbTool) return assert.equal(r.status, 3);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--thumbs must not be a folder that holds source images/);
    assert.equal(readdirSync(photos).length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: a column directory called pages/ still builds the grid sheet', () => {
  const root = tmpDir('contact-sheet-cli-');
  try {
    mkdirSync(path.join(root, 'pages'));
    writePng(path.join(root, 'pages', 'a.png'));
    const out = path.join(root, 'sheet.html');
    execFileSync(process.execPath, [CLI, '--out', out, 'pages/'], { cwd: root, encoding: 'utf8' });
    assert.match(readFileSync(out, 'utf8'), /<th>pages<\/th>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

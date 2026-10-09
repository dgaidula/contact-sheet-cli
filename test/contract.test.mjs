// The mjs-tool/2 contract for `pages`: the runtime fence byte-identical to the
// skeleton's, four output modes from one item list, the dry-run gate, each
// verdict on its own, exit codes 0/1/2/3, next, no prompt without a TTY, the
// overwrite guard, --help, --version and a symlinked entry; and the grid mode
// kept off the contract. Black-box through the CLI, like test/cli.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_URL = new URL('../contact-sheet-cli.mjs', import.meta.url);
const TOOL = fileURLToPath(TOOL_URL);
const REPO = path.dirname(TOOL);
// sha256 of the runtime v2 fence in mjs-tool-skeleton 0.2.0 (skeleton/tool.mjs)
const FENCE_SHA256 = '6a9adf060d5c2752be29efef343cba94ef2062ddc34752a0366eb3d2e28590ef';
const MARK = '// ---- mjs-tool runtime v2 (do not edit; replace wholesale) ----';
const fenceOf = (text) => text.slice(text.indexOf(MARK));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const VERSION = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
// A 1x1 RGB PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');
const hasMagick = !spawnSync('magick', ['-version']).error;
const hasThumbTool = (process.platform === 'darwin' && !spawnSync('sips', ['--version']).error) || hasMagick;

// Run `pages`; with --json, the parsed report is r.json.
function pages(args, opts = {}) {
  const r = spawnSync(process.execPath, [TOOL, 'pages', ...args], { encoding: 'utf8', ...opts });
  if (args.includes('--json') && r.stdout) r.json = JSON.parse(r.stdout);
  return r;
}

function tmp(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'csc-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A review job: `photos` images (the first in Picks, the rest in Maybe), then
// `missing` rows whose file is not there, then any extra rows.
function makeJob(t, { photos = 1, missing = 0, rows = [] } = {}) {
  const root = tmp(t);
  const dir = path.join(root, 'photos');
  mkdirSync(dir);
  const lines = [];
  for (let i = 1; i <= photos; i++) {
    const file = path.join(dir, `p${i}.png`);
    writeFileSync(file, PNG);
    lines.push({ id: `p${i}`, kind: 'still', paths: [file], category: i === 1 ? 'Picks' : 'Maybe' });
  }
  for (let i = 1; i <= missing; i++) lines.push({ id: `gone${i}`, kind: 'still', paths: [path.join(dir, `gone${i}.png`)], category: 'Picks' });
  lines.push(...rows);
  const manifest = path.join(root, 'picks.jsonl');
  writeFileSync(manifest, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, dir, manifest, out: path.join(root, 'review', 'sheet.html') };
}

const outputs = (r) => r.json.items.filter((it) => it.data?.output);

test('the runtime fence is byte-identical to the skeleton’s, and ends the file', () => {
  const fence = fenceOf(readFileSync(TOOL, 'utf8'));
  assert.ok(fence.trimEnd().endsWith('// ---- end mjs-tool runtime v2 ----'), 'the fence ends the file');
  assert.equal(sha(fence), FENCE_SHA256);
  const skeleton = path.join(REPO, '..', 'mjs-tool-skeleton', 'skeleton', 'tool.mjs');
  if (existsSync(skeleton)) assert.equal(fence, fenceOf(readFileSync(skeleton, 'utf8')));
});

test('zero runtime dependencies: none declared, and only node: builtins imported', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[key], undefined, key);
  const specifiers = [...readFileSync(TOOL, 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 5);
  assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:')), []);
});

test('pages --help prints the header; --version the package version; a symlinked entry runs and advises through its link', (t) => {
  const help = pages(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^contact-sheet-cli: build a self-contained HTML contact sheet/);
  assert.match(help.stdout, /pages is a DRY RUN by default/);
  assert.doesNotMatch(help.stdout, /^---- |^import /m);
  assert.equal(pages(['-h']).stdout, help.stdout);
  assert.equal(pages(['--version']).stdout, `contact-sheet-cli ${VERSION}\n`);

  const j = makeJob(t);
  const link = path.join(j.root, 'contact-sheet-cli');
  symlinkSync(TOOL, link);
  const viaLink = spawnSync(process.execPath, [link, 'pages', '--version'], { encoding: 'utf8' });
  assert.equal(viaLink.stdout, `contact-sheet-cli ${VERSION}\n`);
  const dry = spawnSync(process.execPath, [link, 'pages', j.manifest, '--out', j.out, '--json'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).next.argv[1], link);
});

test('every mode renders the same items: --json, --brief, --quiet and human', (t) => {
  const j = makeJob(t, { photos: 2, missing: 1, rows: [{ id: 'v@1-2', kind: 'range', paths: ['v.mov'] }] });
  const args = [j.manifest, '--out', j.out];
  const { json: o, status } = pages([...args, '--json']);
  assert.equal(status, 1);
  assert.deepEqual(Object.keys(o), ['tool', 'version', 'contract', 'command', 'effect', 'exit', 'items', 'summary', 'next']);
  assert.deepEqual([o.tool, o.version, o.contract, o.command, o.effect, o.exit], ['contact-sheet-cli', VERSION, 'mjs-tool/2', 'pages', 'dry-run', 1]);
  for (const it of o.items) assert.deepEqual(Object.keys(it), ['path', 'name', 'verdict', 'summary', 'reason', 'changed', 'data']);
  assert.deepEqual(o.items.map((it) => [it.verdict, it.name]), [['skip', 'v@1-2'], ['warn', 'gone1.png'], ['ok', j.out]]);
  assert.deepEqual(o.summary, { ok: 1, warn: 1, skip: 1, refuse: 0, fail: 0 });

  const brief = pages([...args, '--brief']).stdout.trimEnd().split('\n');
  assert.equal(brief.length, o.items.length + 2, 'one line per item, then summary and next');
  o.items.forEach((it, k) => {
    assert.ok(brief[k].includes(it.summary) && brief[k].includes(it.name), brief[k]);
    if (it.verdict !== 'ok') assert.ok(brief[k].endsWith(`  (${it.reason})`), brief[k]);
  });
  assert.equal(brief.at(-2), 'summary: ok=1 warn=1 skip=1 refuse=0 fail=0  (dry run: pass --go to apply)');
  assert.equal(brief.at(-1), 'next: ask  (dry run: review 1 missing image before --go: gone1.png)');
  assert.deepEqual(pages([...args, '--quiet']).stdout.trimEnd().split('\n'), brief.slice(-2));

  const human = pages(args).stdout;
  for (const it of o.items) assert.ok(human.includes(it.name) && human.includes(it.summary), it.name);
  assert.match(human.trimEnd().split('\n').at(-1), /^next: your call: \S+ \S+ pages .* --go {2}\(dry run: review 1 missing image/);
});

test('a dry run writes nothing; --go writes exactly the outputs it previewed, and leaves the sources alone', (t) => {
  const j = makeJob(t, { photos: 3 });
  const pdf = path.join(j.root, 'review', 'sheet.pdf');
  const thumbs = path.join(j.root, 'review', 'thumbs');
  const args = [j.manifest, '--out', j.out, ...(hasMagick ? ['--pdf', pdf] : []), ...(hasThumbTool ? ['--thumbs', thumbs] : [])];
  const listing = () => readdirSync(j.root, { recursive: true }).sort();
  const before = listing();
  const sources = readdirSync(j.dir).map((f) => sha(readFileSync(path.join(j.dir, f))));

  const dry = pages([...args, '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.json.effect, 'dry-run');
  assert.deepEqual(listing(), before, 'the dry run wrote nothing');
  assert.ok(dry.json.items.every((it) => !it.changed));

  const go = pages([...args, '--json', '--go']);
  assert.equal(go.status, 0, go.stderr);
  assert.equal(go.json.effect, 'applied');
  const shape = (r) => outputs(r).map((it) => [it.data.output, it.path, it.verdict]);
  assert.deepEqual(shape(go), shape(dry), 'the same outputs, in the same order');
  for (const it of outputs(go)) {
    assert.equal(it.changed, true, it.name);
    assert.ok(existsSync(it.path), it.name);
  }
  if (hasThumbTool) {
    const [d, g] = [dry, go].map((r) => outputs(r).find((it) => it.data.output === 'thumbs').data);
    assert.deepEqual([d.make, d.reuse], [3, 0]);
    assert.deepEqual([g.made, g.reused, g.failed], [3, 0, 0], 'the prediction matched what --go did');
  }
  assert.deepEqual(readdirSync(j.dir).map((f) => sha(readFileSync(path.join(j.dir, f)))), sources);
  assert.equal(listing().filter((f) => f.includes('.tmp')).length, 0, 'no temp file left behind');
});

test('next: a clean dry run asks a person with its own command plus --go; obeying it from next.cwd writes, and then next is done', (t) => {
  const j = makeJob(t, { photos: 2 });
  const args = ['picks.jsonl', '--out', 'review/sheet.html', '--json'];
  const dry = pages(args, { cwd: j.root });
  assert.equal(dry.status, 0, dry.stderr);
  const { next } = dry.json;
  assert.deepEqual([next.action, next.who, next.afterSeconds], ['ask', 'human', null]);
  assert.deepEqual(next.argv, [process.execPath, TOOL, 'pages', ...args, '--go']);
  assert.equal(next.why, 'dry run clean: would write review/sheet.html');
  assert.equal(realpathSync(next.cwd), realpathSync(j.root));
  assert.equal(existsSync(j.out), false);
  const obeyed = spawnSync(next.argv[0], next.argv.slice(1), { cwd: next.cwd, encoding: 'utf8' });
  assert.equal(obeyed.status, 0, obeyed.stderr);
  assert.ok(existsSync(j.out));
  assert.deepEqual(JSON.parse(obeyed.stdout).next, { action: 'done', who: 'agent', argv: null, afterSeconds: null, why: 'wrote review/sheet.html', cwd: next.cwd });
});

test('exit codes: 0 when the only findings are skips; 1 when a warn, a refuse or a fail stands alone', (t) => {
  const skipOnly = makeJob(t, { rows: [{ id: 'v@1-2', kind: 'range', paths: ['v.mov'] }] });
  const skip = pages([skipOnly.manifest, '--out', skipOnly.out, '--json']);
  assert.equal(skip.status, 0);
  assert.deepEqual(skip.json.summary, { ok: 1, warn: 0, skip: 1, refuse: 0, fail: 0 });
  assert.equal(skip.json.next.action, 'ask');

  const warnOnly = makeJob(t, { missing: 1 });
  const warn = pages([warnOnly.manifest, '--out', warnOnly.out, '--json']);
  assert.equal(warn.status, 1);
  assert.deepEqual(warn.json.summary, { ok: 1, warn: 1, skip: 0, refuse: 0, fail: 0 });
  assert.equal(warn.json.next.argv.at(-1), '--go', 'a missing image is the reviewer’s call, with --go on offer');

  const refuseOnly = makeJob(t);
  mkdirSync(path.dirname(refuseOnly.out));
  writeFileSync(refuseOnly.out, 'my notes\n');
  const refuse = pages([refuseOnly.manifest, '--out', refuseOnly.out, '--json']);
  assert.equal(refuse.status, 1);
  assert.deepEqual(refuse.json.summary, { ok: 0, warn: 0, skip: 0, refuse: 1, fail: 0 });
  assert.deepEqual([refuse.json.next.action, refuse.json.next.argv], ['ask', null], 'the remedy is another --out, not --go');

  const failOnly = makeJob(t);
  writeFileSync(failOnly.manifest, '{"path":"a.png"}\nnot json\n');
  const fail = pages([failOnly.manifest, '--out', failOnly.out, '--json', '--go']);
  assert.equal(fail.status, 1);
  assert.deepEqual(fail.json.summary, { ok: 0, warn: 0, skip: 1, refuse: 0, fail: 1 });
  assert.deepEqual(fail.json.items.map((it) => [it.verdict, it.summary]), [['fail', 'not a valid manifest'], ['skip', 'not written']]);
  assert.equal(fail.json.items[0].reason, 'manifest line 2 is not valid JSON');
  assert.equal(fail.json.next.action, 'stop');
  assert.equal(existsSync(failOnly.out), false);
});

test('exit 2 for a usage error and 3 when --pdf has no magick: nothing on stdout, nothing written, even with --go', (t) => {
  const j = makeJob(t);
  for (const extra of [['--bogus'], ['--tiles', '6by6'], ['--page', 'postcard'], ['--sort', 'name'], ['--json', '--quiet'], ['--json', '--brief'], ['--pdf', j.out], [j.manifest]]) {
    const r = pages([j.manifest, '--out', j.out, '--go', ...extra]);
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^error: .*\nrun `contact-sheet-cli --help` for usage\n$/);
  }
  assert.equal(pages(['--go']).status, 2);
  assert.equal(pages([path.join(j.root, 'nope.jsonl'), '--go']).status, 2);
  const emptyBin = path.join(j.root, 'empty-bin');
  mkdirSync(emptyBin);
  const r = pages([j.manifest, '--out', j.out, '--pdf', path.join(j.root, 'x.pdf'), '--go', '--json'], { env: { ...process.env, PATH: emptyBin } });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--pdf needs ImageMagick 7/);
  assert.equal(existsSync(path.dirname(j.out)), false);
});

test('--go replaces only what this tool wrote: anything else at --out or --pdf is refused and left byte for byte', (t) => {
  const j = makeJob(t);
  mkdirSync(path.dirname(j.out));
  writeFileSync(j.out, '<html>notes</html>\n');
  const go = pages([j.manifest, '--out', j.out, '--go', '--json']);
  assert.equal(go.status, 1);
  const [html] = outputs(go);
  assert.deepEqual([html.verdict, html.summary, html.changed], ['refuse', 'not written: another file is there', false]);
  assert.equal(readFileSync(j.out, 'utf8'), '<html>notes</html>\n');
  assert.deepEqual([go.json.next.action, go.json.next.argv], ['ask', null]);

  const own = path.join(j.root, 'own.html');
  assert.equal(pages([j.manifest, '--out', own, '--go']).status, 0);
  const again = pages([j.manifest, '--out', own, '--go', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(outputs(again)[0].summary, 'replaced with 1 page, 1 image');

  if (!hasMagick) return t.diagnostic('magick not on PATH: the PDF half is not checked');
  const notes = path.join(j.root, 'notes.pdf');
  writeFileSync(notes, '%PDF-1.4 someone else\n');
  const pdf = pages([j.manifest, '--out', own, '--pdf', notes, '--go', '--json']);
  assert.equal(pdf.status, 1);
  assert.deepEqual(outputs(pdf).map((it) => [it.data.output, it.verdict]), [['html', 'ok'], ['pdf', 'refuse']], 'the HTML is still written');
  assert.equal(readFileSync(notes, 'utf8'), '%PDF-1.4 someone else\n');
  const ownPdf = path.join(j.root, 'own.pdf');
  assert.equal(pages([j.manifest, '--out', own, '--pdf', ownPdf, '--go']).status, 0);
  const twice = pages([j.manifest, '--out', own, '--pdf', ownPdf, '--go', '--json']);
  assert.equal(outputs(twice)[1].summary, 'replaced with 1 PDF page');
});

test('an output location that cannot be written is refused in the dry run, before any --go', (t) => {
  const j = makeJob(t);
  const file = path.join(j.root, 'file.txt');
  writeFileSync(file, 'x');
  const refusal = (out) => {
    const r = pages([j.manifest, '--out', out, '--json']);
    assert.equal(r.status, 1, r.stderr);
    return outputs(r)[0].data.refused;
  };
  assert.equal(refusal(path.join(file, 'sheet.html')), 'a file is in the way');
  assert.equal(refusal(j.dir), 'a folder is in the way');
  const dangling = path.join(j.root, 'dangling.html');
  symlinkSync(path.join(j.root, 'nowhere', 'x.html'), dangling);
  assert.equal(refusal(dangling), 'a dangling symlink');
  if (hasThumbTool) {
    const r = pages([j.manifest, '--out', j.out, '--thumbs', file, '--json']);
    assert.equal(outputs(r)[0].data.refused, 'a file is in the way');
  }
  if (process.getuid?.() === 0) return t.diagnostic('running as root: the not-writable case is not checked');
  const locked = path.join(j.root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  try {
    assert.equal(refusal(path.join(locked, 'sheet.html')), 'folder not writable');
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('--thumbs never writes beside a source: the photos folder is refused by identity, through a symlink or another letter case', { skip: !hasThumbTool && 'neither sips nor magick available' }, (t) => {
  const j = makeJob(t);
  const link = path.join(j.root, 'photos-link');
  symlinkSync(j.dir, link);
  const variants = [link];
  const upper = path.join(j.root, 'PHOTOS');
  if (existsSync(upper)) variants.push(upper); // a case-insensitive volume, like macOS's default
  else t.diagnostic('case-sensitive volume: the letter-case variant is not checked');
  for (const thumbs of variants) {
    const r = pages([j.manifest, '--out', j.out, '--thumbs', thumbs, '--go']);
    assert.equal(r.status, 2, `${thumbs}: ${r.stderr}`);
    assert.match(r.stderr, /--thumbs must not be a folder that holds source images/);
  }
  assert.deepEqual(readdirSync(j.dir), ['p1.png']);
});

test('no prompt without a TTY: a --go run with an open, silent stdin finishes on its own', async (t) => {
  const j = makeJob(t);
  const child = spawn(process.execPath, [TOOL, 'pages', j.manifest, '--out', j.out, '--go', '--brief'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('the run waited on stdin')); }, 15000);
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
  assert.ok(existsSync(j.out));
});

test('no images: refused, every output listed as not written, and next asks with no command', (t) => {
  const root = tmp(t);
  const empty = path.join(root, 'empty');
  mkdirSync(empty);
  const out = path.join(root, 'sheet.html');
  const r = pages([empty, '--out', out, '--go', '--json']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.items.map((it) => [it.verdict, it.summary]), [['refuse', 'no images found'], ['skip', 'not written']]);
  assert.deepEqual([r.json.next.action, r.json.next.argv], ['ask', null]);
  assert.match(r.json.next.why, /^no images found in .*empty: no png, jpg/);
  assert.equal(existsSync(out), false);
});

test('a thumbnail that fails under --go is a warn on its tile, and the sheet shows the original', { skip: !hasThumbTool && 'neither sips nor magick available' }, (t) => {
  const j = makeJob(t);
  const bad = path.join(j.dir, 'bad.png');
  writeFileSync(bad, 'not a png at all');
  writeFileSync(j.manifest, readFileSync(j.manifest, 'utf8') + JSON.stringify({ id: 'bad', paths: [bad] }) + '\n');
  const thumbs = path.join(j.root, 'review', 'thumbs');
  const r = pages([j.manifest, '--out', j.out, '--thumbs', thumbs, '--go', '--json']);
  assert.equal(r.status, 1, r.stderr);
  const warned = r.json.items.filter((it) => it.verdict === 'warn');
  assert.deepEqual(warned.map((it) => [it.name, it.summary, it.data.num]), [['bad.png', 'tile 002 thumbnail failed: original shown', '002']]);
  assert.match(readFileSync(j.out, 'utf8'), /<img src="\.\.\/photos\/bad\.png"/);
  assert.equal(r.json.next.action, 'done');
  assert.match(r.json.next.why, /; report 1 failed thumbnail: bad\.png$/);
});

test('a write that fails under --go is a fail item, the outputs before it stand, and next stops', (t) => {
  const j = makeJob(t);
  // A stub magick: answers the -version probe, fails every real run.
  const bin = path.join(j.root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'magick'), '#!/bin/sh\n[ "$1" = "-version" ] && exit 0\necho "stub magick refuses" >&2\nexit 1\n', { mode: 0o755 });
  const pdf = path.join(j.root, 'review', 'sheet.pdf');
  const r = pages([j.manifest, '--out', j.out, '--pdf', pdf, '--go', '--json'], { env: { ...process.env, PATH: `${bin}:/bin` } });
  assert.equal(r.status, 1, r.stderr);
  const [html, p] = outputs(r);
  assert.deepEqual([html.verdict, html.changed], ['ok', true]);
  assert.deepEqual([p.verdict, p.summary, p.changed], ['fail', 'write failed', false]);
  assert.match(p.reason, /^magick failed on page 1: stub magick refuses$/);
  assert.equal(existsSync(pdf), false);
  assert.deepEqual(readdirSync(path.dirname(pdf)).filter((f) => f.includes('.tmp')), []);
  assert.equal(r.json.next.action, 'stop');
});

test('the grid mode stays off the contract: an unknown flag is Node’s own crash and exit 1, not the runtime’s exit 3', (t) => {
  const root = tmp(t);
  const r = spawnSync(process.execPath, [TOOL, '--bogus', root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  assert.match(r.stderr, /\n {4}at /, 'a stack trace');
  assert.doesNotMatch(r.stderr, /^error: /m);
});

test('verdict(): an item no rule covers throws, so it can never pass as ok', async () => {
  const { verdict } = await import(TOOL_URL);
  assert.equal(typeof verdict, 'function');
  assert.throws(() => verdict({ kind: 'tile' }), /no rule for a tile item/);
  assert.throws(() => verdict({ kind: 'mystery' }), /no rule for a mystery item/);
  assert.equal(verdict({ kind: 'output' }), 'ok');
  assert.equal(verdict({ kind: 'output', refused: true, error: 'x' }), 'fail');
});

test('the grid answers --version and -h, as the header documents, with exit 0; after -- they are names again', (t) => {
  const root = tmp(t);
  const grid = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: root });
  for (const args of [['--version'], ['--version', root]]) {
    const r = grid(args);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, `contact-sheet-cli ${VERSION}\n`, ''], args.join(' '));
  }
  const h = grid(['-h']);
  assert.deepEqual([h.status, h.stdout, h.stderr], [0, grid(['--help']).stdout, '']);
  assert.match(h.stdout, /^contact-sheet-cli: build a self-contained HTML contact sheet/);
  const named = grid(['--', '--version']);
  assert.deepEqual([named.status, named.stderr], [1, 'directory not found: --version\n']);
  assert.deepEqual(readdirSync(root), []);
});

test('--thumbs naming the same path as --out or --pdf is a usage error up front, in the dry run as under --go', (t) => {
  const j = makeJob(t);
  const pdf = path.join(j.root, 'sheet.pdf');
  for (const [extra, message] of [[['--thumbs', j.out], '--out and --thumbs'], [['--pdf', pdf, '--thumbs', pdf], '--pdf and --thumbs']]) {
    for (const go of [[], ['--go']]) {
      const r = pages([j.manifest, '--out', j.out, ...extra, ...go]);
      assert.equal(r.status, 2, `${[...extra, ...go].join(' ')}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^error: ${message} name the same path\n`));
    }
  }
  assert.equal(existsSync(path.dirname(j.out)), false);
  assert.equal(existsSync(pdf), false);
});

test('--thumbs is refused for the real folder behind a symlinked source, and for a video row’s folder', { skip: !hasThumbTool && 'neither sips nor magick available' }, (t) => {
  const j = makeJob(t);
  const real = path.join(j.root, 'real');
  mkdirSync(real);
  writeFileSync(path.join(real, 'r.png'), PNG);
  symlinkSync(path.join(real, 'r.png'), path.join(j.dir, 'r.png'));
  const videos = path.join(j.root, 'videos');
  mkdirSync(videos);
  writeFileSync(path.join(videos, 'clip.mov'), 'not an image');
  const rows = [{ id: 'r', paths: [path.join(j.dir, 'r.png')] }, { id: 'v@1-2', kind: 'range', paths: [path.join(videos, 'clip.mov')] }];
  writeFileSync(j.manifest, readFileSync(j.manifest, 'utf8') + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [thumbs, holds] of [[real, 'r.png'], [videos, 'clip.mov']]) {
    const r = pages([j.manifest, '--out', j.out, '--thumbs', thumbs, '--go']);
    assert.equal(r.status, 2, `${thumbs}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--thumbs must not be a folder that holds source images \\(.* holds ${holds.replace('.', '\\.')}\\)`));
  }
  assert.deepEqual(readdirSync(real), ['r.png']);
  assert.deepEqual(readdirSync(videos), ['clip.mov']);
});

test('a refused output does not stop the others: the thumbnails refused, the sheet after them still written', { skip: !hasThumbTool && 'neither sips nor magick available' }, (t) => {
  const j = makeJob(t);
  const file = path.join(j.root, 'file.txt');
  writeFileSync(file, 'x');
  const r = pages([j.manifest, '--out', j.out, '--thumbs', file, '--go', '--json']);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(outputs(r).map((it) => [it.data.output, it.verdict, it.changed]), [['thumbs', 'refuse', false], ['html', 'ok', true]]);
  assert.ok(existsSync(j.out));
});

test('--go re-checks each output just before writing it: a thumbnail that lands on --out is not overwritten', { skip: !hasThumbTool && 'neither sips nor magick available' }, async (t) => {
  const { thumbName } = await import(TOOL_URL);
  const j = makeJob(t);
  const thumbs = path.join(j.root, 'thumbs');
  const out = path.join(thumbs, thumbName(path.join(j.dir, 'p1.png')));
  const r = pages([j.manifest, '--out', out, '--thumbs', thumbs, '--go', '--json']);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(outputs(r).map((it) => [it.data.output, it.verdict, it.data.refused ?? null]), [['thumbs', 'ok', null], ['html', 'refuse', 'another file is there']]);
  assert.deepEqual([...readFileSync(out).subarray(0, 2)], [0xff, 0xd8], 'the thumbnail is still a JPEG');
});

test('a replaced sheet is a new file renamed into place, and keeps the mode of the one it replaces', (t) => {
  const j = makeJob(t);
  assert.equal(pages([j.manifest, '--out', j.out, '--go']).status, 0);
  chmodSync(j.out, 0o640);
  const before = statSync(j.out).ino;
  const again = pages([j.manifest, '--out', j.out, '--go']);
  assert.equal(again.status, 0, again.stderr);
  assert.notEqual(statSync(j.out).ino, before, 'renamed into place, not rewritten where it was');
  assert.equal(statSync(j.out).mode & 0o777, 0o640);
});

test('the PDF goes to a temp name of its own, random and created before magick writes it, and is titled by its target', (t) => {
  const j = makeJob(t);
  // A stub magick: logs its arguments, notes whether its output already exists
  // as a plain file, and writes a stand-in output.
  const bin = path.join(j.root, 'bin');
  mkdirSync(bin);
  const log = path.join(j.root, 'magick.log');
  writeFileSync(path.join(bin, 'magick'), [
    '#!/bin/sh',
    '[ "$1" = "-version" ] && exit 0',
    'for a; do last=$a; done',
    `printf '%s\\n' "$@" >> '${log}'`,
    `if [ -f "$last" ] && [ ! -L "$last" ]; then echo "reserved: $last" >> '${log}'; fi`,
    'echo "%PDF-1.4 stub" > "$last"',
    '',
  ].join('\n'), { mode: 0o755 });
  const pdf = path.join(j.root, 'review', 'sheet.pdf');
  const r = pages([j.manifest, '--out', j.out, '--pdf', pdf, '--go', '--json'], { env: { ...process.env, PATH: `${bin}:/bin` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(log, 'utf8').split('\n');
  const temp = lines.find((l) => l.endsWith('.tmp.pdf'));
  assert.equal(path.dirname(temp), path.dirname(pdf), 'beside its target');
  assert.match(path.basename(temp), /^\.sheet\.pdf\.[0-9a-f]{12}\.tmp\.pdf$/, 'a random name, not the process id');
  assert.ok(lines.includes(`reserved: ${temp}`), 'created, exclusively, before magick writes it');
  assert.ok(lines.includes('pdf:Title=sheet'), 'titled by the target, not the temp name');
  assert.equal(readFileSync(pdf, 'utf8'), '%PDF-1.4 stub\n');
  assert.deepEqual(readdirSync(path.dirname(pdf)).filter((f) => f.includes('.tmp')), []);
});

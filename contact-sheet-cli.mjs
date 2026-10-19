#!/usr/bin/env node
// contact-sheet-cli: build a self-contained HTML contact sheet for reviewing an
// image-processing batch, columns of folders, rows matched by filename.
//
// Point it at two or more directories from the same batch run (originals,
// intermediate passes, final output) and it lays out one HTML page: each
// directory becomes a column, each distinct filename becomes a row, so you
// can eyeball "before vs after" side by side without opening a single file.
//
// Rows are matched by filename STEM (basename minus extension), compared
// case-insensitively. A stem that is itself a suffixed variant of a shorter
// stem present elsewhere in the batch (e.g. "name-alt.png", "name-gemini-
// bg.jpg" next to "name.png") is folded into that shorter stem's row instead
// of becoming its own row — the rule is: stem S is a variant of stem T if S
// equals T, or S starts with T + "-". A row's cell can therefore hold more
// than one file per column; each is stacked with its suffix as a small
// caption. Rows are the union of stems across every column; a directory
// missing a given row gets a visible "—" placeholder cell.
//
// Directories are flat (not recursed) — each is one column of files. Accepted
// extensions: png jpg jpeg webp gif svg tif tiff. Browsers cannot render TIFF
// in <img>, so those cells are a filename link instead.
//
// The output is one HTML file with everything inlined: no external requests,
// ever. Images are embedded by relative path (computed from --out's
// location), so the HTML and the source directories must keep their relative
// position if you move things around. A few lines of vanilla inline JS drive
// the click-to-zoom overlay; there are no dependencies, build step, or
// external assets.
//
// Usage:
//   contact-sheet-cli original/ processed/ final/
//   contact-sheet-cli --out review/sheet.html original/ processed/
//   contact-sheet-cli --title "Batch 12" --sort mtime orig/ "Final=out/pass3/"
//   contact-sheet-cli "Before=in/" "After=out/"     # Label=dir renames a column
//   contact-sheet-cli --link "../pages/{stem}/index.html" 1440/ 390/
//                                                 # row labels link to a page per stem
//
// --link <template>: make each row label an <a> to a URL built from the
// template, with {stem} replaced by the row's stem (URL-encoded). Relative
// templates resolve from the sheet's own location, like image paths do.
// Use it when every row has a real artefact behind the thumbnails — a built
// page, a PDF, a source file — so a reviewer can open it from the sheet.
//
// Review pages:
//   contact-sheet-cli pages <manifest.jsonl | list.txt | dir> [options] [--go]
//   contact-sheet-cli pages picks.jsonl --title "Slideshow, round 2" --pdf round2.pdf --go
//   contact-sheet-cli pages photos/ --tiles 5x4 --page "a4 portrait" --thumbs thumbs/ --go
//
// A second mode, for review rounds rather than batch comparison: an ordered
// list of images laid out as numbered, fixed-size printable pages, so a
// reviewer can answer "drop 009 and 019". Each section starts on a new page;
// each page heads itself "37-72 of 93". Print the HTML to PDF from a browser,
// or pass --pdf to have ImageMagick write one. "pages" must come first; a
// column directory that is really called pages is passed as ./pages.
//
// pages is a DRY RUN by default: it reads the input, plans the sheet, reports
// what it would write, and writes nothing. --go writes the HTML, and the PDF
// and the thumbnails when they are asked for.
//
//   manifest  JSONL, one row per image.
//             Image: paths[0], or path. Video rows hold a video, never
//             shown: a frame row shows its still (group.copy, from the
//             manifest's folder) or is skipped; a range row is skipped.
//             Number: seq, else its position.
//             Date: dateLabel, or date.label. A date is marked "≈" when
//             date.estimated is true, or when dateSrc starts with file,
//             estimated, undated or archival. Section: the --sections field.
//             Order: --sort date, else by seq when every row has one,
//             else manifest order.
//   list      One path per line, with optional tab-separated label and
//             section columns. Blank lines and # comments are skipped.
//   dir       Its images (flat, not recursed), in natural filename order.
//
//   --out <file>      HTML to write (default contact-pages.html)
//   --pdf <file>      also write a PDF; needs ImageMagick ("magick") on PATH
//   --tiles <CxR>     columns x rows per page (default 6x6)
//   --page "<size>"   letter, legal, tabloid, a4 or a3, then portrait or
//                     landscape (default "letter landscape")
//   --title "<text>"  sheet title (default: the input's name)
//   --sections <key>  manifest field naming each row's section; dotted for a
//                     nested one, like group.groupId (default category)
//   --sort date       order by date.iso (else a dated dateLabel/date.label),
//                     undated rows last; numbers then run in that order,
//                     even when every row has a seq
//   --keepers         only rows whose group.keeper is true, and rows with
//                     no group block
//   --thumbs <dir>    write downscaled JPEG copies there (sips, else magick)
//                     and show those; source images are never modified
//   --go              write the outputs (default is a dry run)
//   --brief, --json, --quiet   output mode (below)
//   --help, -h        print this header
//   --version         print "contact-sheet-cli <version>"
//   --cheat           print a short card of common invocations in tldr page format
//                     and exit 0, printing nothing else; top level, so
//                     "contact-sheet-cli --cheat". It cannot be combined with
//                     --brief, --json or --quiet.
//
// Paths in a manifest or list resolve from that file's own folder.
//
// pages output follows the mjs-tool/2 contract (the grid mode above is not on
// it yet). Every mode renders the same items: one per manifest row that is not
// drawn, one per tile with a finding, then one per output (thumbnails, HTML,
// PDF), in the order --go writes them.
//   (default)   human    a block per item.
//   --brief              one line per item: <glyph> <verdict> <summary> <name>,
//                        with a parenthesised reason whenever the verdict is
//                        not ok; then a summary line.
//   --json               { tool, version, contract, command, effect, exit,
//                          items, summary, next } on stdout, nothing else.
//   --quiet              the summary line only.
//   Every text mode ends with one `next:` line, the advice on the next step. A
//   clean dry run is a person's call: `ask`, with the same command plus --go.
//   --json cannot be combined with --brief or --quiet.
//
// Verdicts: ok = an output written, or one --go would write. warn = a tile
// whose image file is missing (drawn as a placeholder) or whose thumbnail
// failed (the original is shown). skip = a row not drawn (a video row, a row
// with no image, a non-keeper under --keepers), thumbnails already up to
// date, or an output not written because there was nothing to draw. refuse =
// an output --go will not write (a file pages did not write is in the
// way, or its folder cannot be written), or no images to lay out. fail = an
// input that cannot be read, or a write that failed.
//
// --go replaces an existing --out or --pdf only when pages wrote it (the
// HTML's generator tag, the PDF's Creator). Anything else in the way is
// refused, and the other outputs are still written.
//
// Exit codes for pages: 0 all items ok (skips are not failures); 1 partial:
// a tile warned, an output was refused, or something failed; 2 usage error,
// nothing written; 3 a tool that --pdf or --thumbs needs (magick; sips or
// magick) is not on PATH, or an internal error. The grid mode keeps its own
// codes (1 for most errors).

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { lstatSync, accessSync, chmodSync, openSync, readSync, fstatSync, closeSync, constants as fsConstants } from 'node:fs';
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir, availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ACCEPTED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'tif', 'tiff']);
const NO_IMG_EXT = new Set(['tif', 'tiff']); // browsers can't <img> these

// ---- small utils ------------------------------------------------------------

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "Label=dir" -> { label, dir }; plain "dir" -> label is the basename.
export function parseColumnArg(arg) {
  const eq = arg.indexOf('=');
  if (eq > 0) {
    return { label: arg.slice(0, eq), dir: arg.slice(eq + 1) };
  }
  const base = path.basename(path.resolve(arg));
  return { label: base || arg, dir: arg };
}

// Relative href from the output HTML's directory to a source file, with each
// path segment percent-encoded (so spaces/#/? in filenames survive as an
// href/src attribute) while the "/" separators stay literal.
export function relHref(outPath, fileFull) {
  const rel = path.relative(path.dirname(path.resolve(outPath)), path.resolve(fileFull));
  return rel.split(path.sep).map(encodeURIComponent).join('/');
}

function compareStems(a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
}

// ---- scanning ---------------------------------------------------------------

function scanDir(dir, exclude = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (exclude.some((pat) => e.name.includes(pat))) continue;
    const ext = path.extname(e.name).slice(1).toLowerCase();
    if (!ACCEPTED_EXT.has(ext)) continue;
    const full = path.join(dir, e.name);
    const stat = statSync(full);
    files.push({
      name: e.name,
      full,
      ext,
      stem: path.basename(e.name, path.extname(e.name)),
      mtime: stat.mtimeMs,
    });
  }
  return files;
}

// ---- row grouping -----------------------------------------------------------
//
// Rows are the "root" stems: a stem with no shorter stem T (present anywhere
// in the batch) such that stem === T + "-" + suffix. Everything else is a
// suffixed variant that gets folded into its (possibly multi-level) root's
// row, with the full suffix chain kept as its caption.

export function buildRows(columns) {
  const allStemsLower = new Set();
  for (const col of columns) for (const f of col.files) allStemsLower.add(f.stem.toLowerCase());

  const parentCache = new Map();
  function findParent(stemLower) {
    if (parentCache.has(stemLower)) return parentCache.get(stemLower);
    let best = null;
    for (const other of allStemsLower) {
      if (other === stemLower) continue;
      if (stemLower.startsWith(other + '-') && (best === null || other.length > best.length)) best = other;
    }
    parentCache.set(stemLower, best);
    return best;
  }
  function findRoot(stemLower) {
    let cur = stemLower;
    for (let i = 0; i < allStemsLower.size + 1; i++) {
      const p = findParent(cur);
      if (p === null) return cur;
      cur = p;
    }
    return cur; // unreachable in practice; parent strings strictly shrink
  }

  const rowMap = new Map(); // rootLower -> row
  columns.forEach((col, colIndex) => {
    for (const file of col.files) {
      const stemLower = file.stem.toLowerCase();
      const parent = findParent(stemLower);
      const rootLower = findRoot(stemLower);
      let row = rowMap.get(rootLower);
      if (!row) {
        row = { key: rootLower, label: file.stem, cells: columns.map(() => []), mtimes: [] };
        rowMap.set(rootLower, row);
      }
      if (parent === null) row.label = file.stem; // canonical (unsuffixed) casing
      const caption = parent === null ? null : file.stem.slice(rootLower.length + 1);
      row.cells[colIndex].push({ ...file, caption });
      row.mtimes.push(file.mtime);
    }
  });

  return [...rowMap.values()].map((row) => ({
    ...row,
    mtime: Math.min(...row.mtimes),
  }));
}

export function sortRows(rows, sortBy) {
  const sorted = [...rows];
  if (sortBy === 'mtime') {
    sorted.sort((a, b) => a.mtime - b.mtime || compareStems(a.label, b.label));
  } else {
    sorted.sort((a, b) => compareStems(a.label, b.label));
  }
  return sorted;
}

// ---- HTML rendering -----------------------------------------------------------

function renderItem(match, outPath) {
  const href = relHref(outPath, match.full);
  const caption = match.caption
    ? `<div class="caption">${escapeHtml(match.caption)}</div>`
    : '';
  if (NO_IMG_EXT.has(match.ext)) {
    return (
      `<div class="item file-item">` +
      `<a class="filelink" href="${href}" target="_blank" rel="noopener">${escapeHtml(match.name)}</a>` +
      caption +
      `</div>`
    );
  }
  return (
    `<div class="item">` +
    `<img loading="lazy" src="${href}" data-full="${href}" alt="${escapeHtml(match.name)}">` +
    caption +
    `</div>`
  );
}

function renderCell(matches, outPath) {
  if (matches.length === 0) {
    return `<td class="cell missing"><span class="placeholder">&mdash;</span></td>`;
  }
  return `<td class="cell">${matches.map((m) => renderItem(m, outPath)).join('')}</td>`;
}

export function renderHtml({ title, columns, rows, outPath, generatedAt, link }) {
  const filesPerColumn = columns.map((_, i) => rows.reduce((n, r) => n + r.cells[i].length, 0));
  const missingCount = rows.reduce(
    (n, r) => n + r.cells.filter((c) => c.length === 0).length,
    0,
  );

  const theadCols = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const bodyRows = rows
    .map(
      (row) =>
        `<tr><th class="rowhead">${link ? `<a href="${escapeHtml(link.replace(/\{stem\}/g, encodeURIComponent(row.label)))}">${escapeHtml(row.label)}</a>` : escapeHtml(row.label)}</th>` +
        row.cells.map((cell) => renderCell(cell, outPath)).join('') +
        `</tr>`,
    )
    .join('\n');

  const columnSummary = columns
    .map((c, i) => `${escapeHtml(c.label)}: ${filesPerColumn[i]} file${filesPerColumn[i] === 1 ? '' : 's'}`)
    .join(' &middot; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b6b6b;
  --border: #dfdfdf;
  --header-bg: #f4f4f4;
  --missing-bg: #fff4f4;
  --link: #0a5cc7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e8e8e8;
    --muted: #9a9a9a;
    --border: #33363c;
    --header-bg: #1e2126;
    --missing-bg: #2a1c1c;
    --link: #6fb2ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--fg);
}
header.topbar {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
header.topbar h1 { margin: 0; font-size: 1.25rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 100%; }
thead th {
  position: sticky;
  top: 0;
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  padding: 0.6rem 0.8rem;
  text-align: left;
  font-size: 0.85rem;
  white-space: nowrap;
  z-index: 1;
}
th.rowhead {
  background: var(--header-bg);
  font-weight: 600;
  font-size: 0.85rem;
  word-break: break-word;
  max-width: 12rem;
  vertical-align: top;
  position: sticky;
  left: 0;
  z-index: 1;
}
td.cell {
  border: 1px solid var(--border);
  padding: 0.5rem;
  vertical-align: top;
  min-width: 12rem;
}
td.cell.missing { background: var(--missing-bg); text-align: center; vertical-align: middle; }
.placeholder { color: var(--muted); font-size: 1.4rem; }
.item { display: inline-block; margin: 0 0.4rem 0.4rem 0; text-align: center; vertical-align: top; }
.item img {
  display: block;
  max-width: 220px;
  max-height: 220px;
  width: auto;
  height: auto;
  object-fit: contain;
  cursor: zoom-in;
  border: 1px solid var(--border);
  background: var(--header-bg);
}
.item .caption { font-size: 0.72rem; color: var(--muted); margin-top: 0.2rem; max-width: 220px; word-break: break-word; }
.filelink { color: var(--link); font-size: 0.85rem; word-break: break-all; }
.file-item { padding: 0.6rem; border: 1px dashed var(--border); border-radius: 4px; }
footer {
  padding: 1rem 1.25rem;
  color: var(--muted);
  font-size: 0.8rem;
  border-top: 1px solid var(--border);
}
.lightbox {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.lightbox.open { display: flex; }
.lightbox img { max-width: 95vw; max-height: 95vh; object-fit: contain; }
#lightbox-close {
  position: fixed;
  top: 1rem;
  right: 1.5rem;
  font-size: 2rem;
  line-height: 1;
  color: #fff;
  background: transparent;
  border: none;
  cursor: pointer;
}
@media print {
  .lightbox, #lightbox-close { display: none !important; }
  header.topbar, thead th, th.rowhead { position: static; }
  tr, .item { break-inside: avoid; }
  .item img { max-width: 160px; max-height: 160px; cursor: default; }
}
</style>
</head>
<body>
<header class="topbar"><h1>${escapeHtml(title)}</h1></header>
<div class="table-wrap">
<table>
<thead><tr><th class="rowhead">&nbsp;</th>${theadCols}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>
</div>
<footer>
${rows.length} row${rows.length === 1 ? '' : 's'} &middot; ${columnSummary} &middot;
${missingCount} missing cell${missingCount === 1 ? '' : 's'} &middot; generated ${escapeHtml(generatedAt)}
</footer>
<div id="lightbox" class="lightbox">
<button id="lightbox-close" aria-label="Close">&times;</button>
<img id="lightbox-img" src="" alt="">
</div>
<script>
(function () {
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lightbox-img');
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-full]');
    if (t) { lbImg.src = t.getAttribute('data-full'); lb.classList.add('open'); return; }
    if (e.target === lb || e.target.id === 'lightbox-close') {
      lb.classList.remove('open');
      lbImg.src = '';
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { lb.classList.remove('open'); lbImg.src = ''; }
  });
})();
</script>
</body>
</html>
`;
}

// ---- review pages (`contact-sheet-cli pages`) --------------------------------
//
// An ordered list of images laid out as numbered, fixed-size printable pages.
// The readers turn an input into items; planPages() orders, sections, numbers
// and pages them; both renderers (the HTML, and the optional ImageMagick PDF)
// draw from that one plan, so the two can never disagree about which photo
// is 009. The readers and planPages() are pure and unit-tested.

const BROWSER_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif']);
const THUMB_EDGE = 640; // px, long edge of a --thumbs copy
const PDF_DPI = 150;
// ImageMagick cannot resolve "Helvetica" by name; this path exists on macOS.
const PDF_FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
// What marks an output as this tool's own, so --go replaces it and nothing
// else: a generator tag in the HTML's head, and the PDF's Creator, which
// ImageMagick stores as UTF-16BE with a byte-order mark, in hex.
const SHEET_MARK = '<meta name="generator" content="contact-sheet-cli pages">';
const PDF_CREATOR = 'contact-sheet-cli pages';
const PDF_MARK = Buffer.from(`\ufeff${PDF_CREATOR}`, 'utf16le').swap16().toString('hex').toUpperCase();

// Paper sizes (portrait) in inches, with the CSS lengths that state them exactly.
export const PAPER = {
  letter: { w: 8.5, h: 11, css: ['8.5in', '11in'] },
  legal: { w: 8.5, h: 14, css: ['8.5in', '14in'] },
  tabloid: { w: 11, h: 17, css: ['11in', '17in'] },
  a4: { w: 210 / 25.4, h: 297 / 25.4, css: ['210mm', '297mm'] },
  a3: { w: 297 / 25.4, h: 420 / 25.4, css: ['297mm', '420mm'] },
};

// "6x6" -> { cols, rows }; null when it isn't one.
export function parseTiles(spec) {
  const m = /^(\d{1,2})x(\d{1,2})$/i.exec(String(spec).trim());
  if (!m) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols < 1 || rows < 1 || cols > 20 || rows > 20) return null;
  return { cols, rows };
}

// "letter landscape", "a4 portrait", "A4" (landscape by default) -> page
// geometry; null when it isn't one.
export function parsePaper(spec) {
  const [name, orientation = 'landscape', ...rest] = String(spec).toLowerCase().trim().split(/[\s-]+/);
  const paper = PAPER[name];
  if (!paper || rest.length > 0 || !['portrait', 'landscape'].includes(orientation)) return null;
  const land = orientation === 'landscape';
  return {
    name,
    orientation,
    widthIn: land ? paper.h : paper.w,
    heightIn: land ? paper.w : paper.h,
    cssWidth: paper.css[land ? 1 : 0],
    cssHeight: paper.css[land ? 0 : 1],
  };
}

// The "≈" rule: the photo tools' date block says so (date.estimated), or a
// flat manifest's dateSrc names a guessed source (the rule the hand-built
// review sheets used).
export function isEstimated(row) {
  if (row.date && typeof row.date === 'object' && row.date.estimated === true) return true;
  return typeof row.dateSrc === 'string' && /^(file|estimated|undated|archival)/.test(row.dateSrc);
}

function valueAt(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function sectionName(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function makeItem(full, fields = {}) {
  return {
    path: full,
    name: path.basename(full),
    ext: path.extname(full).slice(1).toLowerCase(),
    seq: fields.seq ?? null,
    date: fields.date ?? null,
    estimated: fields.estimated ?? false,
    label: fields.label ?? null,
    section: fields.section ?? null,
    sortDate: fields.sortDate ?? null,
    keeper: fields.keeper ?? null,
  };
}

// A date as a sortable key: "YYYY[-MM[-DD[THH:MM[:SS]]]]" from the start of
// an ISO string or a label; null for "undated" or anything else. A year-only
// label sorts at July 1 and a month-only one at mid-month, as photo-date-fix
// places such hints, so neither leads its era.
export function dateKey(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?)?)?(?![\d])/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, time] = m;
  return `${y}-${mo ?? '07'}-${d ?? (mo ? '15' : '01')}${time ? `T${time}` : ''}`;
}

// A manifest line that cannot be read: the run reports it as a fail item.
function lineError(line, message) {
  return Object.assign(new Error(`manifest line ${line} ${message}`), { line });
}

// Manifest JSONL -> { items, skipped, ranges, frames, skippedRows, videos }. A row
// with no image path is counted in `skipped`, not drawn. Video rows carry the
// video in `paths`, never an image: a range row is skipped (and counted in
// `ranges` too); a frame row shows its extracted still, `group.copy`
// (relative to the manifest's folder), or without one is skipped (and counted
// in `frames`). `skippedRows` names each skipped row: its line, its id, and
// why (range, frame, or none: no image path). `videos` lists every video row's
// paths[0], resolved, since its folder holds a source too.
export function itemsFromManifest(text, { baseDir = '.', sectionKey = 'category' } = {}) {
  const items = [];
  const skippedRows = [];
  const videos = [];
  let skipped = 0;
  let ranges = 0;
  let frames = 0;
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw lineError(i + 1, 'is not valid JSON');
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw lineError(i + 1, 'is not a JSON object');
    }
    const group = row.group && typeof row.group === 'object' ? row.group : null;
    if ((row.kind === 'range' || row.kind === 'frame') && Array.isArray(row.paths) && typeof row.paths[0] === 'string') {
      videos.push(path.resolve(baseDir, row.paths[0]));
    }
    const file = row.kind === 'range' ? null
      : row.kind === 'frame' ? (typeof group?.copy === 'string' && group.copy !== '' ? group.copy : null)
      : Array.isArray(row.paths) && typeof row.paths[0] === 'string' ? row.paths[0]
      : typeof row.path === 'string' ? row.path : null;
    if (!file) {
      skipped++;
      if (row.kind === 'range') ranges++;
      if (row.kind === 'frame') frames++;
      skippedRows.push({
        line: i + 1,
        id: typeof row.id === 'string' && row.id !== '' ? row.id : null,
        why: row.kind === 'range' || row.kind === 'frame' ? row.kind : 'none',
      });
      return;
    }
    const block = row.date && typeof row.date === 'object' ? row.date : null;
    const date = row.dateLabel ?? block?.label ?? (typeof block?.iso === 'string' ? block.iso.slice(0, 10) : null);
    const seq = typeof row.seq === 'number' || (typeof row.seq === 'string' && row.seq.trim() !== '') ? row.seq : null;
    items.push(makeItem(path.resolve(baseDir, file), {
      seq,
      date: date === null || date === undefined || date === '' ? null : String(date),
      estimated: isEstimated(row),
      section: sectionName(valueAt(row, sectionKey)),
      sortDate: dateKey(block?.iso) ?? dateKey(row.dateLabel ?? block?.label),
      keeper: group ? group.keeper === true : null,
    }));
  });
  return { items, skipped, ranges, frames, skippedRows, videos };
}

// List file -> items: one path per line, then optional tab-separated label
// and section columns. Blank lines and # comments are skipped.
export function itemsFromList(text, baseDir = '.') {
  const items = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const [file, label, section] = line.split('\t').map((s) => s.trim());
    if (!file) continue;
    items.push(makeItem(path.resolve(baseDir, file), { label: label || null, section: section || null }));
  }
  return items;
}

// "IMG_2" before "IMG_10", case-insensitively; a plain code-point tiebreak
// keeps the order total.
export function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

// Directory -> items: its accepted images, flat, in natural filename order.
export function itemsFromDir(dir) {
  return scanDir(dir)
    .map((f) => f.name)
    .sort(naturalCompare)
    .map((name) => makeItem(path.resolve(dir, name)));
}

const hasSeq = (item) => item.seq !== null && item.seq !== undefined && item.seq !== '';

// Filter, order, section, number and page the items.
// - Filter: keepers (--keepers) keeps items whose group says keeper, and
//   items with no group at all; `dropped` counts the rest, and `left` lists
//   them in input order.
// - Order: sort 'date' (--sort date) by sortDate, undated last, otherwise
//   stable; else by seq when every item has one (numeric-aware); else as given.
// - Sections: in order of first appearance; each starts on a new page.
// - Numbers: the seq itself (a numeric seq zero-padded) when ordered by seq,
//   else a running count across the whole sheet, so one number names one photo.
// - Pages: perPage tiles each; a page knows its place in its section
//   (from/to/total) and in the sheet (number/of).
export function planPages(allItems, { perPage, sort = null, keepers = false }) {
  const items = keepers ? allItems.filter((it) => it.keeper !== false) : allItems;
  const byDate = sort === 'date';
  const bySeq = !byDate && items.length > 0 && items.every(hasSeq);
  const ordered = items.map((item, index) => ({ item, index }));
  if (byDate) {
    const key = (it) => it.sortDate ?? null;
    ordered.sort((a, b) => {
      const ka = key(a.item);
      const kb = key(b.item);
      if (ka === null || kb === null) return (ka === null) - (kb === null) || a.index - b.index;
      return (ka < kb ? -1 : ka > kb ? 1 : 0) || a.index - b.index;
    });
  } else if (bySeq) {
    ordered.sort((a, b) => String(a.item.seq).localeCompare(String(b.item.seq), 'en', { numeric: true }) || a.index - b.index);
  }
  const sections = new Map(); // section name (null = untitled) -> items
  for (const { item } of ordered) {
    if (!sections.has(item.section)) sections.set(item.section, []);
    sections.get(item.section).push(item);
  }
  const digits = (n) => String(n).length;
  const numericSeqs = bySeq ? items.filter((it) => typeof it.seq === 'number') : [];
  const width = Math.max(3, digits(items.length), ...numericSeqs.map((it) => digits(it.seq)));
  let running = 0;
  const pages = [];
  for (const [section, list] of sections) {
    const tiles = list.map((item) => ({
      ...item,
      num: !bySeq ? String(++running).padStart(width, '0')
        : typeof item.seq === 'number' ? String(item.seq).padStart(width, '0') : item.seq,
      text: item.date ?? item.label ?? item.name,
      approx: item.date !== null && item.estimated,
    }));
    for (let i = 0; i < tiles.length; i += perPage) {
      pages.push({
        section,
        tiles: tiles.slice(i, i + perPage),
        from: i + 1,
        to: Math.min(i + perPage, tiles.length),
        total: tiles.length,
      });
    }
  }
  pages.forEach((page, i) => {
    page.number = i + 1;
    page.of = pages.length;
  });
  const left = keepers ? allItems.filter((it) => it.keeper === false) : [];
  return { pages, count: items.length, dropped: allItems.length - items.length, left, sections: [...sections.keys()], bySeq };
}

export function rangeText(page) {
  return page.from === page.to ? `${page.from} of ${page.total}` : `${page.from}–${page.to} of ${page.total}`;
}

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderTile(tile, outPath) {
  const caption =
    `<figcaption><span class="num">${escapeHtml(tile.num)}</span>` +
    `<span class="text">${escapeHtml(tile.text)}${tile.approx ? ' <span class="approx" title="estimated date">≈</span>' : ''}</span>` +
    `</figcaption>`;
  let frame;
  if (tile.missing) {
    frame = `<div class="frame"><p class="note">missing<br>${escapeHtml(tile.name)}</p></div>`;
  } else {
    const shown = tile.src ?? tile.path;
    if (BROWSER_EXT.has(path.extname(shown).slice(1).toLowerCase())) {
      const full = BROWSER_EXT.has(tile.ext) ? tile.path : shown;
      frame =
        `<div class="frame"><img src="${relHref(outPath, shown)}" data-full="${relHref(outPath, full)}" ` +
        `alt="${escapeHtml(tile.name)}"></div>`;
    } else {
      frame = `<div class="frame"><p class="note"><a href="${relHref(outPath, tile.path)}">${escapeHtml(tile.name)}</a></p></div>`;
    }
  }
  return `<figure class="tile">${frame}${caption}</figure>`;
}

// Print-styled HTML: every page a fixed-size sheet of paper. Sizes are in
// page inches (--in), scaled to the window on screen and exact in print, so
// the browser's Print > Save as PDF gives the same pages.
export function renderPagesHtml({ title, plan, paper, tiles, outPath, generatedAt }) {
  const pages = plan.pages
    .map((page) => {
      const head = page.section === null
        ? `<h1>${escapeHtml(title)}</h1>`
        : `<p class="eyebrow">${escapeHtml(title)}</p><h1>${escapeHtml(page.section)}</h1>`;
      return (
        `<section class="page">\n` +
        `<header class="masthead"><div>${head}</div><p class="range">${rangeText(page)}</p></header>\n` +
        `<div class="tiles">\n${page.tiles.map((t) => renderTile(t, outPath)).join('\n')}\n</div>\n` +
        `<footer class="foot"><span>generated ${escapeHtml(generatedAt)}</span><span>page ${page.number} of ${page.of}</span></footer>\n` +
        `</section>`
      );
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${SHEET_MARK}
<title>${escapeHtml(title)}</title>
<style>
@page { size: ${paper.cssWidth} ${paper.cssHeight}; margin: 0; }
:root {
  color-scheme: light dark;
  --desk: #e2e2e0;
  --paper: #ffffff;
  --ink: #1a1a1a;
  --muted: #6b6b6b;
  --rule: #a3a3a3;
  --ground: #efefed;
  --sans: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: "Berkeley Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --desk: #0c0d0e;
    --paper: #1a1b1d;
    --ink: #e8e8e8;
    --muted: #9b9b9b;
    --rule: #56585c;
    --ground: #242528;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--desk); color: var(--ink); font-family: var(--sans); }
main { container-type: inline-size; width: min(100% - 32px, ${paper.cssWidth}); margin: 16px auto; }
.page {
  --in: calc(100cqw / ${paper.widthIn});
  display: flex;
  flex-direction: column;
  width: 100cqw;
  height: calc(${paper.heightIn} * var(--in));
  margin-bottom: calc(0.25 * var(--in));
  padding: calc(0.4 * var(--in)) calc(0.4 * var(--in)) calc(0.28 * var(--in));
  overflow: hidden;
  background: var(--paper);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.18);
}
.masthead {
  display: flex;
  flex: none;
  align-items: flex-end;
  justify-content: space-between;
  gap: calc(0.2 * var(--in));
  height: calc(0.46 * var(--in));
  padding-bottom: calc(0.05 * var(--in));
  border-bottom: 1px solid var(--rule);
}
.masthead > div { min-width: 0; }
.eyebrow {
  margin: 0 0 calc(0.04 * var(--in));
  font-size: calc(0.085 * var(--in));
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
h1 {
  margin: 0;
  font-size: calc(0.2 * var(--in));
  font-weight: 600;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.range { margin: 0; font-family: var(--mono); font-size: calc(0.11 * var(--in)); line-height: 1.1; color: var(--muted); white-space: nowrap; }
.tiles {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(${tiles.cols}, minmax(0, 1fr));
  grid-template-rows: repeat(${tiles.rows}, minmax(0, 1fr));
  gap: calc(0.1 * var(--in));
  margin-top: calc(0.14 * var(--in));
}
.tile { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin: 0; }
.frame { position: relative; flex: 1; min-height: 0; background: var(--ground); }
.frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; cursor: zoom-in; }
.note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 6%;
  text-align: center;
  font-family: var(--mono);
  font-size: calc(0.075 * var(--in));
  color: var(--muted);
  overflow-wrap: anywhere;
}
.note a { color: inherit; }
figcaption {
  margin-top: calc(0.03 * var(--in));
  font-family: var(--mono);
  font-size: calc(0.085 * var(--in));
  line-height: 1.2;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.num { font-weight: 700; }
.text { margin-left: 0.7em; color: var(--muted); }
.foot {
  display: flex;
  flex: none;
  justify-content: space-between;
  margin-top: calc(0.1 * var(--in));
  font-family: var(--mono);
  font-size: calc(0.07 * var(--in));
  color: var(--muted);
}
.lightbox {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.lightbox.open { display: flex; }
.lightbox img { max-width: 95vw; max-height: 95vh; object-fit: contain; }
#lightbox-close {
  position: fixed;
  top: 1rem;
  right: 1.5rem;
  font-size: 2rem;
  line-height: 1;
  color: #fff;
  background: transparent;
  border: none;
  cursor: pointer;
}
@media print {
  :root { --paper: #ffffff; --ink: #000000; --muted: #555555; --rule: #999999; --ground: #efefed; }
  body { background: #ffffff; }
  main { width: auto; margin: 0; }
  .page { margin: 0; box-shadow: none; break-after: page; }
  .page:last-of-type { break-after: auto; }
  .frame { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .frame img { cursor: default; }
  .lightbox, #lightbox-close { display: none !important; }
}
</style>
</head>
<body>
<main>
${pages}
</main>
<div id="lightbox" class="lightbox">
<button id="lightbox-close" aria-label="Close">&times;</button>
<img id="lightbox-img" src="" alt="">
</div>
<script>
(function () {
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lightbox-img');
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-full]');
    if (t) { lbImg.src = t.getAttribute('data-full'); lb.classList.add('open'); return; }
    if (e.target === lb || e.target.id === 'lightbox-close') {
      lb.classList.remove('open');
      lbImg.src = '';
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { lb.classList.remove('open'); lbImg.src = ''; }
  });
})();
</script>
</body>
</html>
`;
}

// ---- optional helpers: --thumbs (sips or magick) and --pdf (magick) -----------

function hasCommand(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

// A thumbnail's name: the source stem plus a hash of its full path, so two
// IMG_0001.JPG from different folders never collide.
export function thumbName(full) {
  const stem = path.basename(full, path.extname(full)).replace(/[^\w.-]+/g, '_').slice(0, 60);
  return `${stem}-${createHash('sha1').update(full).digest('hex').slice(0, 8)}.jpg`;
}

function runFile(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => resolve({ error, stderr: String(stderr) }));
  });
}

// A temp file beside `target` with a random name, created empty and
// exclusively (`wx`), so it was not there before and no symlink sits at it:
// the caller owns it, and removes it. When the create fails, nothing was
// created, so there is nothing of the caller's to remove.
function reserveTemp(target, suffix) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}${suffix}`);
  closeSync(openSync(tmp, 'wx'));
  return tmp;
}

// Downscaled JPEG copies in `dir`, reused while newer than their source; sets
// tile.src on success. Sources are only ever read.
async function makeThumbs(tiles, dir, tool) {
  const jobs = tiles.filter((t) => !t.missing && t.ext !== 'svg');
  const tally = { made: 0, reused: 0, failed: [] };
  if (jobs.length === 0) return tally; // nothing to make: no folder either
  mkdirSync(dir, { recursive: true });
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const tile = jobs[index];
      const dest = path.join(dir, thumbName(tile.path));
      if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(tile.path).mtimeMs) {
        tile.src = dest;
        tally.reused++;
        continue;
      }
      let tmp;
      try {
        tmp = reserveTemp(dest, '.tmp.jpg');
      } catch (e) {
        tally.failed.push({ tile, reason: `cannot create a temp file: ${e.message}`.slice(0, 200) });
        continue;
      }
      const args = tool === 'sips'
        ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(THUMB_EDGE), tile.path, '--out', tmp]
        : [`${imPath(tile.path)}[0]`, '-auto-orient', '-thumbnail', `${THUMB_EDGE}x${THUMB_EDGE}>`, '-quality', '82', imPath(tmp)];
      const { error, stderr } = await runFile(tool, args);
      if (error || !existsSync(tmp) || statSync(tmp).size === 0) {
        rmSync(tmp, { force: true });
        const reason = stderr.trim().split('\n').pop() || error?.message || 'no output';
        tally.failed.push({ tile, reason: reason.slice(0, 200) });
        continue;
      }
      renameSync(tmp, dest);
      tile.src = dest;
      tally.made++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), jobs.length) }, worker));
  return tally;
}

// ImageMagick reads % escapes, a leading @ (take the text from a file) and
// backslash escapes in -label and -annotate text; neutralise all three.
export function imText(s) {
  const t = String(s).replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return t.startsWith('@') ? `\\${t}` : t;
}

// ImageMagick also expands % escapes in file names, read and written (so
// `pct%d.png` reads `pct0.png`, and `r%d.pdf` writes `r0.pdf`); `%%` is a
// literal %. Every path handed to magick goes through this. The paths are
// absolute, so none starts with `@` or `-`.
export function imPath(p) {
  return String(p).replace(/%/g, '%%');
}

function fitText(s, maxChars) {
  return s.length > maxChars ? `${s.slice(0, Math.max(1, maxChars - 1))}…` : s;
}

// Pixel geometry of one PDF page at PDF_DPI, mirroring the HTML's inches.
export function pdfLayout(paper, tiles) {
  const px = (inches) => Math.round(inches * PDF_DPI);
  const W = px(paper.widthIn);
  const H = px(paper.heightIn);
  const margin = px(0.4);
  const bottom = px(0.28);
  const ruleY = margin + px(0.46);
  const tilesY = ruleY + px(0.14);
  const footSize = px(0.07);
  const areaW = W - 2 * margin;
  const areaH = H - bottom - footSize - px(0.1) - tilesY;
  const gap = px(0.1); // one gutter, as in the HTML
  const labelSize = px(0.085);
  const labelGap = px(0.03);
  const cellW = Math.floor((areaW - (tiles.cols - 1) * gap) / tiles.cols);
  const cellH = Math.floor((areaH - (tiles.rows - 1) * gap) / tiles.rows);
  const frameH = cellH - labelGap - Math.ceil(labelSize * 1.2);
  const titleSize = px(0.2);
  const eyebrowSize = px(0.085);
  const rangeSize = px(0.11);
  const titleY = ruleY - px(0.05) - Math.round(titleSize * 1.1);
  return {
    W, H, margin, bottom, ruleY, tilesY, areaW, gap, labelSize, labelGap, cellW, cellH, frameH, footSize,
    titleSize, titleY, eyebrowSize, eyebrowY: titleY - px(0.04) - Math.round(eyebrowSize * 1.2),
    rangeSize, rangeY: ruleY - px(0.05) - Math.round(rangeSize * 1.1),
  };
}

const signed = (n) => (n < 0 ? String(Math.round(n)) : `+${Math.round(n)}`);

function magick(args, what) {
  try {
    execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const detail = String(e.stderr ?? '').trim().split('\n').slice(-3).join(' | ') || e.message;
    throw new Error(`magick failed ${what}: ${detail}`);
  }
}

// The same plan as the HTML, drawn by ImageMagick: each page is one magick
// run that fits every photo onto a toned frame at its grid position, labels
// it, adds the masthead and footer; then all pages join into one PDF at the
// paper's size, its Creator this tool's mark. The PDF's Title is `docTitle`
// (by default pdfPath's name, as ImageMagick would give it), so a temp file
// renamed into place carries the final name.
export function renderPagesPdf({ title, plan, paper, tiles, pdfPath, generatedAt, docTitle = path.basename(pdfPath, path.extname(pdfPath)) }) {
  const L = pdfLayout(paper, tiles);
  const ground = '#efefed';
  const font = existsSync(PDF_FONT) ? ['-font', PDF_FONT] : [];
  const labelChars = Math.max(4, Math.floor(L.cellW / (L.labelSize * 0.56)));
  const headChars = Math.max(8, Math.floor((L.areaW * 0.72) / (L.titleSize * 0.55)));
  const work = mkdtempSync(path.join(tmpdir(), 'contact-sheet-pdf-'));
  try {
    const pageFiles = plan.pages.map((page) => {
      const frame = `${L.cellW}x${L.frameH}`;
      const tileArgs = page.tiles.flatMap((t, k) => {
        const x = L.margin + (k % tiles.cols) * (L.cellW + L.gap);
        const y = L.tilesY + Math.floor(k / tiles.cols) * (L.cellH + L.gap);
        // An SVG is never handed to ImageMagick, which would follow the file's
        // own <image> references and draw whatever they point at into the PDF.
        const svg = !t.missing && t.ext === 'svg';
        const image = t.missing || svg
          ? [`xc:${ground}[${frame}!]`]
          : ['(', `${imPath(t.src ?? t.path)}[0]`, '-auto-orient', '-thumbnail', frame,
            '-background', ground, '-gravity', 'center', '-extent', frame, ')'];
        const label = t.missing ? `${t.num}  missing` : `${t.num}  ${t.text}${t.approx ? ' ≈' : ''}`;
        const note = svg ? ['-gravity', 'North', '-annotate', `${signed(x + L.cellW / 2 - L.W / 2)}${signed(y + L.frameH / 2 - L.labelSize / 2)}`,
          imText(fitText('SVG — not drawn in PDF', labelChars))] : [];
        return [
          ...image, '-gravity', 'NorthWest', '-geometry', `+${x}+${y}`, '-composite', ...note,
          '-gravity', 'North', '-annotate', `${signed(x + L.cellW / 2 - L.W / 2)}${signed(y + L.frameH + L.labelGap)}`,
          imText(fitText(label, labelChars)),
        ];
      });

      const eyebrow = page.section === null ? [] : [
        '-pointsize', String(L.eyebrowSize), '-kerning', String(Math.round(L.eyebrowSize * 0.1)), '-fill', '#6b6b6b',
        '-annotate', `+${L.margin}+${L.eyebrowY}`, imText(fitText(title.toUpperCase(), headChars * 2)), '-kerning', '0',
      ];
      const pageJpg = path.join(work, `page-${String(page.number).padStart(4, '0')}.jpg`);
      magick([
        '-define', `jpeg:size=${L.cellW * 2}x${L.frameH * 2}`,
        '-size', `${L.W}x${L.H}`, 'xc:white', '+size', ...font, '-gravity', 'NorthWest',
        ...eyebrow,
        '-pointsize', String(L.titleSize), '-fill', '#1a1a1a',
        '-annotate', `+${L.margin}+${L.titleY}`, imText(fitText(page.section ?? title, headChars)),
        '-gravity', 'NorthEast', '-pointsize', String(L.rangeSize), '-fill', '#6b6b6b',
        '-annotate', `+${L.margin}+${L.rangeY}`, imText(rangeText(page)),
        '-gravity', 'NorthWest', '-stroke', '#a3a3a3', '-strokewidth', '1',
        '-draw', `line ${L.margin},${L.ruleY} ${L.W - L.margin},${L.ruleY}`, '+stroke',
        '-pointsize', String(L.labelSize), '-fill', '#1a1a1a',
        ...tileArgs,
        '-pointsize', String(L.footSize), '-fill', '#6b6b6b',
        '-gravity', 'SouthWest', '-annotate', `+${L.margin}+${L.bottom}`, imText(`generated ${generatedAt}`),
        '-gravity', 'SouthEast', '-annotate', `+${L.margin}+${L.bottom}`, imText(`page ${page.number} of ${page.of}`),
        '-units', 'PixelsPerInch', '-density', String(PDF_DPI), '-quality', '88', imPath(pageJpg),
      ], `on page ${page.number}`);
      return pageJpg;
    });
    magick([
      '-units', 'PixelsPerInch', '-density', String(PDF_DPI), ...pageFiles.map(imPath), '-compress', 'jpeg', '-quality', '88',
      '-define', `pdf:Creator=${PDF_CREATOR}`, '-define', `pdf:Title=${docTitle}`, imPath(pdfPath),
    ], 'writing the PDF');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- pages CLI ------------------------------------------------------------------
//
// `pages` is on the mjs-tool/2 contract (the runtime block at the bottom of
// the file): every mode renders one item list, and it is a dry run unless
// --go. The items run in the order of the work: rows not drawn, then tiles
// with a finding, then the outputs, in the order --go writes them.

// Facts on an item -> its verdict, the single source of truth. Pure. Each
// kind of item has an explicit rule, and a combination with none throws, so a
// new kind of finding can never pass as ok.
function verdict(item) {
  if (item.error) return 'fail';
  if (item.refused) return 'refuse';
  if (item.kind === 'tile' && (item.missing || item.thumbFailed)) return 'warn';
  if (item.kind === 'row' && item.notDrawn) return 'skip';
  if (item.kind === 'output') return item.notWritten || item.upToDate ? 'skip' : 'ok';
  throw new Error(`verdict(): no rule for a ${item.kind} item with these facts`);
}

// The first and last `bytes` of a file, as latin1 text.
function fileEnds(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(bytes, size);
    const read = (position) => {
      const buf = Buffer.alloc(n);
      return buf.subarray(0, readSync(fd, buf, 0, n, position)).toString('latin1');
    };
    return { head: read(0), tail: read(size - n) };
  } finally {
    closeSync(fd);
  }
}

// An existing output is this tool's own when it carries the mark.
const isOwnSheet = (file) => fileEnds(file, 4096).head.includes(SHEET_MARK);
function isOwnPdf(file) {
  const { head, tail } = fileEnds(file, 256 * 1024);
  return head.startsWith('%PDF-') && tail.includes(PDF_MARK);
}

function writable(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Where an output may go, checked in the plan (so the dry run shows it) and
// again just before --go writes it. Returns { target, replaces }, or
// { refuse, detail } in a few words and in full. A symlink is followed, so a
// link keeps pointing where it did. Refused: a dangling symlink, a folder or
// any other non-file in the way, a file pages did not write (`isOwn`; `what`
// names the kind in the refusal), or a folder that cannot be written. With
// `folder`, the output is a directory (the thumbnails), and must be one where
// it exists.
function checkOutput(file, { isOwn = () => false, what = 'file', folder = false } = {}) {
  const abs = path.resolve(file);
  const no = (refuse, detail) => ({ refuse, detail });
  let target = abs;
  let st = null;
  try {
    st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      try {
        target = realpathSync(abs);
        st = statSync(target);
      } catch {
        return no('a dangling symlink', `${file} is a symlink to nothing`);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return no('cannot check it', `cannot check ${file}: ${e.message}`);
    st = null;
  }
  if (st && folder) {
    if (!st.isDirectory()) return no('a file is in the way', `${file} is a file, not a folder`);
    return writable(target) ? { target, replaces: false } : no('folder not writable', `${file} is not writable`);
  }
  if (st) {
    if (!st.isFile()) return no(st.isDirectory() ? 'a folder is in the way' : 'not a regular file', `${file} is ${st.isDirectory() ? 'a folder' : 'not a regular file'}`);
    let own;
    try {
      own = isOwn(target);
    } catch (e) {
      return no('cannot read it', `cannot read ${file}: ${e.message}`);
    }
    if (!own) return no('another file is there', `${file} is there, and it is not a ${what} pages wrote`);
    return writable(path.dirname(target)) ? { target, replaces: true } : no('folder not writable', `the folder of ${file} is not writable`);
  }
  // Not there yet: the nearest existing ancestor must be a folder that can be written.
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    let s;
    try {
      s = lstatSync(dir);
      if (s.isSymbolicLink()) s = statSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      return no('cannot check it', `cannot check ${dir}: ${e.message}`);
    }
    if (!s.isDirectory()) return no('a file is in the way', `${dir} is a file, not a folder`);
    return writable(dir) ? { target, replaces: false } : no('folder not writable', `${dir} is not writable`);
  }
}

// What --thumbs would do, by makeThumbs()'s own rule (a copy is reused while
// it is newer than its source), without doing it.
function predictThumbs(tiles, dir) {
  const plan = { make: 0, reuse: 0 };
  for (const t of tiles) {
    if (t.missing || t.ext === 'svg') continue;
    const dest = path.join(dir, thumbName(t.path));
    if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(t.path).mtimeMs) plan.reuse++;
    else plan.make++;
  }
  return plan;
}

// Give a temp file an existing target's mode, so a replaced output keeps it.
function keepMode(tmp, target) {
  try {
    chmodSync(tmp, statSync(target).mode & 0o7777);
  } catch {
    // a new output keeps the default mode
  }
}

// Write a file whole or not at all: a temp file beside the target, then a
// rename over it.
function writeAtomic(target, text) {
  const tmp = reserveTemp(target, '.tmp');
  try {
    writeFileSync(tmp, text, { flag: 'r+' });
    keepMode(tmp, target);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Read the input into images (and, for a manifest, the rows it skipped).
// Throws on an unreadable file or a broken manifest line.
function readPagesInput(input, st, sectionKey) {
  if (st.isDirectory()) return { kind: 'dir', images: itemsFromDir(input), skippedRows: [], videos: [] };
  const text = readFileSync(input, 'utf8').replace(/^\uFEFF/, ''); // a byte-order mark, as some editors save
  const baseDir = path.dirname(path.resolve(input));
  if (/\.(jsonl|ndjson)$/i.test(input) || text.trimStart().startsWith('{')) {
    const { items, skippedRows, videos } = itemsFromManifest(text, { baseDir, sectionKey });
    return { kind: 'manifest', images: items, skippedRows, videos };
  }
  return { kind: 'list', images: itemsFromList(text, baseDir), skippedRows: [], videos: [] };
}

// The plan's sections, for the HTML item: each one's first and last number,
// how many images, and its first and last page.
function sectionSpans(plan) {
  const spans = new Map();
  for (const page of plan.pages) {
    let s = spans.get(page.section);
    if (!s) spans.set(page.section, (s = { name: page.section, from: page.tiles[0].num, to: null, images: 0, pages: [page.number, page.number] }));
    s.to = page.tiles.at(-1).num;
    s.images += page.tiles.length;
    s.pages[1] = page.number;
  }
  return [...spans.values()];
}

function spanText(s) {
  const nums = s.from === s.to ? s.from : `${s.from}–${s.to}`;
  const pages = s.pages[0] === s.pages[1] ? `page ${s.pages[0]}` : `pages ${s.pages[0]}–${s.pages[1]}`;
  return `${s.name === null ? '' : `${s.name}: `}${nums}, ${count(s.images, 'image')}, ${pages}`;
}

// The tile findings, named the way the advice names them.
function findingsPhrase(items) {
  const missing = items.filter((it) => it.missing).length;
  const thumbs = items.filter((it) => it.thumbFailed).length;
  return [missing && count(missing, 'missing image'), thumbs && count(thumbs, 'failed thumbnail')].filter(Boolean).join(' and ');
}

const ROW_WHY = {
  range: ['video range row: not drawn', 'a range row holds video, which is never drawn as a tile'],
  frame: ['video frame with no still: not drawn', 'a frame row is drawn from its group.copy still, and this one has none'],
  none: ['no image path: not drawn', 'the row names no image (paths[0] or path)'],
};

// One item from its facts: the verdict comes from verdict(), nowhere else.
function makeReportItem(fields) {
  const item = { reason: '', changed: false, data: null, ...fields };
  item.verdict = verdict(item);
  return item;
}

async function pagesMain(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        out: { type: 'string', default: 'contact-pages.html' },
        pdf: { type: 'string' },
        tiles: { type: 'string', default: '6x6' },
        page: { type: 'string', default: 'letter landscape' },
        title: { type: 'string' },
        sections: { type: 'string', default: 'category' },
        thumbs: { type: 'string' },
        sort: { type: 'string' },
        keepers: { type: 'boolean', default: false },
        go: { type: 'boolean' },
        brief: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch (e) {
    usageError(e.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(helpText());
    return;
  }
  if (values.version) {
    console.log(`${TOOL_NAME} ${readVersion()}`);
    return;
  }
  const mode = outputMode(values);
  if (positionals.length !== 1) usageError('pages takes one input: a manifest (.jsonl), a list file, or a directory');
  const tiles = parseTiles(values.tiles);
  if (!tiles) usageError(`--tiles must be columns x rows, 1 to 20 each, like 6x6; got "${values.tiles}"`);
  const paper = parsePaper(values.page);
  if (!paper) usageError(`--page must be letter, legal, tabloid, a4 or a3, then optionally portrait or landscape; got "${values.page}"`);
  if (values.sort !== undefined && values.sort !== 'date') usageError(`--sort must be "date", got "${values.sort}"`);
  // One file for two outputs: compared as a case-insensitive volume would.
  const same = (a, b) => path.resolve(a).normalize('NFC').toLowerCase() === path.resolve(b).normalize('NFC').toLowerCase();
  if (values.pdf !== undefined && same(values.pdf, values.out)) usageError('--out and --pdf name the same file');
  if (values.thumbs !== undefined && same(values.thumbs, values.out)) usageError('--out and --thumbs name the same path');
  if (values.thumbs !== undefined && values.pdf !== undefined && same(values.thumbs, values.pdf)) usageError('--pdf and --thumbs name the same path');
  const input = positionals[0];
  let st;
  try {
    st = statSync(input);
  } catch {
    usageError(`input not found: ${input}`);
  }

  // The tools --pdf and --thumbs need, before anything is read or written.
  if (values.pdf !== undefined && !hasCommand('magick', ['-version'])) {
    environmentError(
      '--pdf needs ImageMagick 7 (the "magick" command) on PATH, and it was not found. ' +
      'Install it (macOS: brew install imagemagick), or leave out --pdf and print the HTML to PDF from a browser.');
  }
  let thumbTool = null;
  if (values.thumbs !== undefined) {
    thumbTool = process.platform === 'darwin' && hasCommand('sips', ['--version']) ? 'sips'
      : hasCommand('magick', ['-version']) ? 'magick' : null;
    if (!thumbTool) environmentError('--thumbs needs sips (macOS) or ImageMagick ("magick") on PATH, and neither was found.');
  }

  const go = !!values.go;
  const effect = effectFor('pages', go);
  const runArgv = process.argv.slice(2);
  const finish = (items) => {
    const next = nextAction({ command: 'pages', items, effect, state: null, argv: runArgv });
    return report({ command: 'pages', effect, items, next, mode, argv: runArgv });
  };

  // The outputs, in the order --go writes them: the thumbnails first, since
  // both the HTML and the PDF show them.
  const outputs = [
    values.thumbs !== undefined && { output: 'thumbs', file: values.thumbs, flag: '--thumbs' },
    { output: 'html', file: values.out, flag: '--out' },
    values.pdf !== undefined && { output: 'pdf', file: values.pdf, flag: '--pdf' },
  ].filter(Boolean);
  const outputItem = (o, fields) => makeReportItem({
    kind: 'output', path: o.check?.target ?? path.resolve(o.file), name: o.file, ...fields,
    data: { output: o.output, path: o.check?.target ?? path.resolve(o.file), ...fields.data },
  });
  const notWritten = (why) => outputs.map((o) => outputItem(o, { notWritten: true, summary: 'not written', reason: why }));
  const refusedItem = (o) => {
    const remedy = `choose another ${o.flag}${{ 'another file is there': ', or move that file away', 'folder not writable': ', or make the folder writable' }[o.check.refuse] ?? ''}`;
    return outputItem(o, {
      refused: true, summary: `${go ? 'not written' : 'will not write'}: ${o.check.refuse}`,
      reason: `${o.check.detail}; ${remedy}`, remedy, data: { refused: o.check.refuse },
    });
  };

  // Read the input. One that cannot be read is a fail item, and nothing is written.
  let read;
  try {
    read = readPagesInput(input, st, values.sections);
  } catch (e) {
    const item = makeReportItem({
      kind: 'input', error: e.message, path: path.resolve(input), name: input,
      summary: e.line ? 'not a valid manifest' : 'cannot read the input', reason: e.message,
      data: { path: path.resolve(input), line: e.line ?? null },
    });
    return finish([item, ...notWritten('the input could not be read')]);
  }
  if (values.thumbs !== undefined) {
    // Folders compared by identity (device and inode), not by name, so a
    // symlink, another letter case or /tmp for /private/tmp cannot hide one.
    // A source's folder is the one it is named in and, for a symlinked file,
    // the one its real file is in; video rows' videos count as sources.
    const identity = (dir) => {
      try {
        const s = statSync(dir);
        return `${s.dev}:${s.ino}`;
      } catch {
        return `missing:${path.resolve(dir)}`;
      }
    };
    const thumbsId = identity(values.thumbs);
    const seen = new Map();
    const held = (file) => {
      const dir = path.dirname(file);
      if (!seen.has(dir)) seen.set(dir, identity(dir));
      return seen.get(dir) === thumbsId;
    };
    let clash = null;
    for (const file of [...read.images.map((it) => it.path), ...read.videos]) {
      let real = null;
      try {
        real = realpathSync(file);
      } catch {
        // a missing file has no real folder beyond its own
      }
      clash = held(file) ? file : real !== null && held(real) ? real : null;
      if (clash) break;
    }
    if (clash) usageError(`--thumbs must not be a folder that holds source images (${values.thumbs} holds ${path.basename(clash)})`);
  }

  // Rows that are not drawn: video rows and rows with no image, then the
  // rows --keepers leaves out.
  const rows = read.skippedRows.map((row) => {
    const [summary, reason] = ROW_WHY[row.why];
    return makeReportItem({ kind: 'row', notDrawn: true, path: null, name: row.id ?? `line ${row.line}`, summary, reason, data: { line: row.line, id: row.id, why: row.why } });
  });
  const plan = planPages(read.images, { perPage: tiles.cols * tiles.rows, sort: values.sort ?? null, keepers: values.keepers });
  for (const it of plan.left) {
    rows.push(makeReportItem({
      kind: 'row', notDrawn: true, path: it.path, name: it.name, summary: 'not a group keeper: left out',
      reason: '--keepers shows only rows whose group.keeper is true, and rows with no group', data: { path: it.path },
    }));
  }
  if (plan.count === 0) {
    const none = read.images.length === 0;
    const item = makeReportItem({
      kind: 'input', refused: true, path: path.resolve(input), name: input,
      summary: none ? 'no images found' : 'no keeper rows',
      reason: none
        ? { dir: 'no png, jpg, jpeg, webp, gif, svg, tif or tiff file directly inside it', manifest: 'no row names an image', list: 'it lists no files' }[read.kind]
        : `--keepers left out all ${plan.dropped} of its rows`,
      data: { path: path.resolve(input), images: read.images.length, keepers: values.keepers },
    });
    return finish([...rows, item, ...notWritten('there are no images to lay out')]);
  }

  // Tiles with a finding, in sheet order: a missing file now, a failed
  // thumbnail once --go has tried to make it.
  const allTiles = plan.pages.flatMap((page) => page.tiles.map((t) => Object.assign(t, { page: page.number })));
  allTiles.forEach((t, i) => Object.assign(t, { index: i, missing: !existsSync(t.path) }));
  const tileItem = (t, fields) => makeReportItem({
    kind: 'tile', path: t.path, name: t.name, index: t.index, ...fields,
    data: { num: t.num, page: t.page, section: t.section, path: t.path },
  });
  const findings = allTiles.filter((t) => t.missing).map((t) => tileItem(t, {
    missing: true, summary: `tile ${t.num} missing: placeholder`,
    reason: `no file at ${t.path}; a placeholder takes its place on the sheet`,
  }));

  const spans = sectionSpans(plan);
  const sheet = {
    images: plan.count, sections: plan.sections.filter((s) => s !== null).length, pages: plan.pages.length,
    tiles: `${tiles.cols}x${tiles.rows}`, paper: `${paper.name} ${paper.orientation}`, missing: findings.length,
    numbering: plan.bySeq ? 'seq' : 'running', spans,
  };
  const sheetLines = [
    `${count(sheet.images, 'image')}, ${count(sheet.sections, 'section')}, ${count(sheet.pages, 'page')} of ${sheet.tiles}, ${sheet.paper}`,
    ...spans.map(spanText),
  ];
  const pagesText = `${count(sheet.pages, 'page')}, ${count(sheet.images, 'image')}`;
  const pdfText = count(sheet.pages, 'PDF page');
  const checkOne = (o) => checkOutput(o.file, o.output === 'thumbs' ? { folder: true }
    : o.output === 'html' ? { isOwn: isOwnSheet, what: 'sheet' } : { isOwn: isOwnPdf, what: 'PDF' });
  for (const o of outputs) o.check = checkOne(o);

  if (!go) {
    const outs = outputs.map((o) => {
      if (o.check.refuse) return refusedItem(o);
      const verb = o.check.replaces ? 'would replace with' : 'would write';
      if (o.output === 'html') return outputItem(o, { summary: `${verb} ${pagesText}`, lines: sheetLines, data: { replaces: o.check.replaces, ...sheet } });
      if (o.output === 'pdf') {
        return outputItem(o, { summary: `${verb} ${pdfText}`, lines: [`${pdfText} at ${PDF_DPI} dpi, ${sheet.paper}, drawn with magick`], data: { replaces: o.check.replaces, pages: sheet.pages } });
      }
      const p = predictThumbs(allTiles, o.check.target);
      const data = { tool: thumbTool, make: p.make, reuse: p.reuse };
      if (p.make > 0) {
        return outputItem(o, { summary: `would make ${count(p.make, 'thumbnail')}, reuse ${p.reuse}`, lines: [`${THUMB_EDGE} px on the long edge, with ${thumbTool}`], data });
      }
      return p.reuse > 0
        ? outputItem(o, { upToDate: true, summary: `${count(p.reuse, 'thumbnail')} up to date`, reason: 'each copy is newer than its source', data })
        : outputItem(o, { notWritten: true, summary: 'no thumbnails to make', reason: 'no tile needs one: missing files and SVGs are shown as they are', data });
    });
    return finish([...rows, ...findings, ...outs]);
  }

  // --go: each output re-checked just before it is written. A refused one is
  // left alone and the rest are still written; after a write fails, the rest
  // are not attempted.
  const title = values.title ?? path.basename(path.resolve(input), st.isDirectory() ? '' : path.extname(input));
  const generatedAt = localStamp(new Date());
  const outs = [];
  let failed = null;
  for (const o of outputs) {
    if (failed) {
      outs.push(outputItem(o, { notWritten: true, summary: 'not attempted', reason: `${failed} failed first` }));
      continue;
    }
    o.check = checkOne(o);
    if (o.check.refuse) {
      outs.push(refusedItem(o));
      continue;
    }
    const verb = o.check.replaces ? 'replaced with' : 'wrote';
    try {
      if (o.output === 'thumbs') {
        const t = await makeThumbs(allTiles, o.check.target, thumbTool);
        for (const f of t.failed) {
          findings.push(tileItem(f.tile, { thumbFailed: true, summary: `tile ${f.tile.num} thumbnail failed: original shown`, reason: `${thumbTool}: ${f.reason}` }));
        }
        const data = { tool: thumbTool, made: t.made, reused: t.reused, failed: t.failed.length };
        if (t.made > 0) {
          outs.push(outputItem(o, { changed: true, summary: `made ${count(t.made, 'thumbnail')}, reused ${t.reused}${t.failed.length ? `, ${t.failed.length} failed` : ''}`, data }));
        } else if (t.failed.length) {
          outs.push(outputItem(o, { notWritten: true, summary: 'no thumbnails made', reason: `${count(t.failed.length, 'thumbnail')} failed (see their tiles)${t.reused ? `; ${t.reused} reused` : ''}`, data }));
        } else if (t.reused > 0) {
          outs.push(outputItem(o, { upToDate: true, summary: `${count(t.reused, 'thumbnail')} up to date`, reason: 'each copy is newer than its source', data }));
        } else {
          outs.push(outputItem(o, { notWritten: true, summary: 'no thumbnails to make', reason: 'no tile needs one: missing files and SVGs are shown as they are', data }));
        }
      } else if (o.output === 'html') {
        mkdirSync(path.dirname(o.check.target), { recursive: true });
        writeAtomic(o.check.target, renderPagesHtml({ title, plan, paper, tiles, outPath: values.out, generatedAt }));
        outs.push(outputItem(o, { changed: true, summary: `${verb} ${pagesText}`, lines: sheetLines, data: { replaces: o.check.replaces, ...sheet } }));
      } else {
        const target = o.check.target;
        mkdirSync(path.dirname(target), { recursive: true });
        const tmp = reserveTemp(target, '.tmp.pdf');
        try {
          renderPagesPdf({ title, plan, paper, tiles, pdfPath: tmp, generatedAt, docTitle: path.basename(target, path.extname(target)) });
          keepMode(tmp, target);
          renameSync(tmp, target);
        } finally {
          rmSync(tmp, { force: true });
        }
        outs.push(outputItem(o, { changed: true, summary: `${verb} ${pdfText}`, lines: [`${pdfText} at ${PDF_DPI} dpi, ${sheet.paper}`], data: { replaces: o.check.replaces, pages: sheet.pages } }));
      }
    } catch (e) {
      failed = o.file;
      outs.push(outputItem(o, { error: e.message, summary: 'write failed', reason: e.message }));
    }
  }
  findings.sort((a, b) => a.index - b.index);
  return finish([...rows, ...findings, ...outs]);
}

// ---- grid CLI (not on the contract yet) --------------------------------------

async function gridMain() {
  const { values, positionals } = parseArgs({
    options: {
      exclude: { type: 'string', multiple: true },
      out: { type: 'string', default: 'contact-sheet.html' },
      title: { type: 'string' },
      sort: { type: 'string', default: 'name' },
      link: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    const header = [];
    for (const l of lines.slice(1)) { // skip shebang, stop at first code line
      if (!l.startsWith('//')) break;
      header.push(l.slice(3));
    }
    console.log(header.join('\n'));
    process.exit(positionals.length === 0 && !values.help ? 1 : 0);
  }

  if (values.sort !== 'name' && values.sort !== 'mtime') {
    console.error(`--sort must be "name" or "mtime", got "${values.sort}"`);
    process.exit(1);
  }

  const columnArgs = positionals.map(parseColumnArg);
  const errors = [];
  for (const { dir } of columnArgs) {
    let st;
    try {
      st = statSync(dir);
    } catch {
      errors.push(`directory not found: ${dir}`);
      continue;
    }
    if (!st.isDirectory()) errors.push(`not a directory: ${dir}`);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }

  const exclude = values.exclude ?? [];
  const columns = columnArgs.map(({ label, dir }) => ({ label, dir, files: scanDir(dir, exclude) }));
  const totalFiles = columns.reduce((n, c) => n + c.files.length, 0);
  if (totalFiles === 0) {
    console.error('no images found (accepted: png jpg jpeg webp gif svg tif tiff)');
    process.exit(1);
  }

  const rows = sortRows(buildRows(columns), values.sort);
  const title = values.title ?? `Proof Sheet: ${columns.map((c) => c.label).join(' / ')}`;
  const generatedAt = new Date().toISOString();

  if (values.link !== undefined && !values.link.includes('{stem}')) {
    console.error('--link template must contain {stem}');
    process.exit(2);
  }
  const html = renderHtml({ title, columns, rows, outPath: values.out, generatedAt, link: values.link });
  mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  writeFileSync(values.out, html);

  const missingCount = rows.reduce((n, r) => n + r.cells.filter((c) => c.length === 0).length, 0);
  console.log(`${rows.length} row(s), ${columns.length} column(s), ${totalFiles} file(s), ${missingCount} missing cell(s)`);
  console.log(`wrote ${values.out}`);
}

// ---- contract hooks (the runtime block at the bottom relies on these) ----------

// pages writes files, so it mutates behind --go. The grid mode is not on the
// contract yet and never reaches report().
const MUTATING_COMMANDS = new Set(['pages']);
// No command is pre-approved for an unattended --go: a clean dry run is a
// person's call.
const AUTO_RUN_COMMANDS = new Set();
// pages has no override flag and no alias of --go.
const EXTRA_OVERRIDE_FLAGS = [];
const GO_ALIASES = [];

// The next-action policy, the single source of `next`. Pure: it reads the
// finished items. It starts from the runtime's defaultNextAction(), so a
// failure stops and a command that carried an override flag keeps the
// default's ask. Past that, the advice names the real finding: no images to
// lay out, or an output that will not be written, is a person's call with no
// command, since the remedy is another input or path, not --go; a clean dry
// run is a person's call with the same command plus --go; missing images and
// failed thumbnails are named in the dry run's ask and in the applied run's
// done.
function nextAction(run) {
  const next = defaultNextAction(run);
  const { items, effect, argv } = run;
  if (next.action === 'stop' || argv.some(isOverrideFlag)) return next;
  const nothing = items.find((it) => it.kind === 'input' && it.refused);
  if (nothing) return nextStep('ask', `${nothing.summary} in ${clipText(String(nothing.name), 80)}: ${nothing.reason}`);
  const refused = items.filter((it) => it.kind === 'output' && it.refused);
  if (refused.length) {
    const verb = effect === 'applied' ? 'not written' : 'will not write';
    return nextStep('ask', refused.length === 1
      ? `${verb}: ${listNames(refused)} (${refused[0].data.refused}); ${refused[0].remedy}`
      : `${verb}: ${listNames(refused)}; each line says why, and what to change`);
  }
  const warned = items.filter((it) => it.verdict === 'warn');
  const what = findingsPhrase(warned);
  if (effect === 'dry-run') {
    const writes = items.filter((it) => it.kind === 'output' && it.verdict === 'ok');
    const why = warned.length ? `dry run: review ${what} before --go: ${listNames(warned)}` : `dry run clean: would write ${listNames(writes)}`;
    return nextStep(next.action, why, { argv: next.argv });
  }
  const wrote = items.filter((it) => it.kind === 'output' && it.changed);
  const done = wrote.length ? `wrote ${listNames(wrote)}` : 'nothing written';
  return nextStep('done', warned.length ? `${done}; report ${what}: ${listNames(warned)}` : done);
}

const CHEAT = `# contact-sheet-cli

> Build a self-contained HTML contact sheet from folders of images, one column per folder and one row per filename.
> Its \`pages\` mode lays out numbered, printable review pages.
> More information: contact-sheet-cli --help.

- Compare two folders side by side in contact-sheet.html:

\`contact-sheet-cli {{path/to/original}} {{path/to/processed}}\`

- Label the columns and choose the output file:

\`contact-sheet-cli "Original={{path/to/original}}" "Optimized={{path/to/optimized}}" --out {{path/to/contact-sheet.html}}\`

- Simulate numbered review pages from a manifest:

\`contact-sheet-cli pages {{path/to/manifest.jsonl}} --title {{title}}\`

- Write the review pages and a PDF:

\`contact-sheet-cli pages {{path/to/manifest.jsonl}} --title {{title}} --pdf {{path/to/review.pdf}} --go\``;

// ---- CLI ------------------------------------------------------------------
//
// `pages` is on the contract. The grid is not yet, so on its path the
// runtime's crash handlers come off and a crash stays Node's own, a stack
// trace and exit 1, as in 1.2.0: whatever escapes is rethrown outside the
// runtime's promise chain, which would otherwise turn it into one `error:`
// line and exit 3. The promise that never settles keeps the runtime from
// exiting 0 before the rethrow lands. The header documents --version and -h
// for both modes; the grid's parser knows neither and crashed on them, so they
// are answered here (before any `--`), and every other argv reaches gridMain().
// --cheat is answered the same way, after them, and only at the top level;
// --help is answered with -h, so it wins over --cheat in either order.
async function main() {
  if (process.argv[2] === 'pages') return pagesMain(process.argv.slice(3));
  const gridArgs = process.argv.slice(2);
  const flags = gridArgs.includes('--') ? gridArgs.slice(0, gridArgs.indexOf('--')) : gridArgs;
  if (flags.includes('--version')) return void console.log(`${TOOL_NAME} ${readVersion()}`);
  if (flags.includes('-h') || flags.includes('--help')) return void console.log(helpText());
  if (flags.includes('--cheat')) {
    for (const mode of ['brief', 'json', 'quiet']) {
      if (flags.includes(`--${mode}`)) usageError(`--cheat and --${mode} cannot be combined`);
    }
    return void console.log(CHEAT);
  }
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  try {
    return await gridMain();
  } catch (e) {
    setImmediate(() => { throw e; });
    return new Promise(() => {});
  }
}

export { verdict, nextAction };

// ---- mjs-tool runtime v2 (do not edit; replace wholesale) ----
// The shared machinery of contract mjs-tool/2, byte-identical in every tool
// built from mjs-tool-skeleton. It carries its own imports (namespaced, so they
// never collide with the tool's); its other top-level names are unprefixed, so
// a tool keeps no copies of them. The tool supplies, outside this block:
// MUTATING_COMMANDS, AUTO_RUN_COMMANDS, EXTRA_OVERRIDE_FLAGS, GO_ALIASES,
// main(), and a nextAction() policy whose result it hands to report(); the
// block checks their shapes as it loads. To move a tool to a later contract,
// swap this whole block.

import * as runtimeFs from 'node:fs';
import * as runtimePath from 'node:path';
import * as runtimeUrl from 'node:url';

const CONTRACT = 'mjs-tool/2';

// The realpath of this script, so a symlinked (npm-linked) invocation still
// reports the right name/version and finds its own header for --help.
const SCRIPT_PATH = (() => {
  const self = runtimeUrl.fileURLToPath(import.meta.url);
  try { return runtimeFs.realpathSync(self); } catch { return self; }
})();
const TOOL_NAME = runtimePath.basename(SCRIPT_PATH).replace(/\.mjs$/, '');

// The directory the run started in (next.cwd), read once as the module loads,
// so a run that removes its own working directory still reports. If it was
// gone before the start, the shell's $PWD stands in (or / without one).
const START_CWD = (() => {
  try { return process.cwd(); } catch {
    const pwd = process.env.PWD;
    return pwd && runtimePath.isAbsolute(pwd) ? pwd : '/';
  }
})();

// -- verdicts: symbols, counts, exit code

const GLYPH = { ok: '✓', warn: '⚠', skip: '•', refuse: '⊘', fail: '✗' };
function glyph(v) { return GLYPH[v] || '?'; }

function summarize(items) {
  const s = { ok: 0, warn: 0, skip: 0, refuse: 0, fail: 0 };
  for (const it of items) if (it.verdict in s) s[it.verdict] += 1;
  return s;
}

// 0 all ok (skips are not failures), 1 partial. The other two codes exit
// through usageError() (2), environmentError() and the entry guard (3).
function exitCodeFor(items) {
  const s = summarize(items);
  return s.warn || s.refuse || s.fail ? 1 : 0;
}

// -- effect: what this run was allowed to do to the world. An applied run may
// still change nothing (every item refused); the items' `changed` says what did.

function effectFor(command, go) {
  if (!MUTATING_COMMANDS.has(command)) return 'read-only';
  return go ? 'applied' : 'dry-run';
}

// -- next: the advice on the next step

// Who takes each action, derived and never chosen: run, wait and done are the
// agent's; ask and stop hand the run to a person.
const NEXT_WHO = { done: 'agent', run: 'agent', wait: 'agent', ask: 'human', stop: 'human' };
const NEXT_ACTIONS = Object.keys(NEXT_WHO);
const NEXT_KEYS = ['action', 'who', 'argv', 'afterSeconds', 'why', 'cwd'];
// Rule 4: the advice never contradicts the exit code, which stays authoritative.
// Exit 0 allows ask: a clean run can still end at a person's decision.
const ACTIONS_FOR_EXIT = { 0: ['done', 'run', 'wait', 'ask'], 1: NEXT_ACTIONS, 2: ['stop'], 3: ['stop'] };
// Rule 2: a flag that confirms or overrides a gate never appears in next.argv.
// Long flags match case-insensitively: the built-in classes by prefix (so
// --yes-really and --forced), --allow and the tool's EXTRA_OVERRIDE_FLAGS
// exactly, with or without =value. An EXTRA_OVERRIDE_FLAGS entry may also be a
// bare word, which blocks that verb. --no-yes and --iamdan are not listed:
// parseArgs rejects them as unknown options, so no run could carry them.
const OVERRIDE_FLAGS = ['--allow'];
const OVERRIDE_PREFIXES = ['--yes', '--force', '--assume-yes', '--allow-', '--i-am-'];

function isOverrideFlag(token) {
  const t = String(token);
  const lower = t.toLowerCase();
  const isFlag = (f) => lower === f || lower.startsWith(`${f}=`);
  if (OVERRIDE_FLAGS.some(isFlag) || OVERRIDE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (/^-[A-Za-z]*[yY][A-Za-z]*$/.test(t)) return true; // -y or -Y (the short --yes), alone or grouped
  return EXTRA_OVERRIDE_FLAGS.some((f) => (/^-[A-Za-z]$/.test(f)
    ? new RegExp(`^-[A-Za-z]*${f[1]}[A-Za-z]*$`).test(t) // a declared short flag, alone or grouped
    : isFlag(String(f).toLowerCase())));
}

// A --go alias the tool declares in GO_ALIASES, matched as a declared override
// flag is: a long one in any case, with or without =value; a short one alone or
// grouped. Aliases are input only: advice spells --go, which the checks read.
function isGoAlias(token) {
  const t = String(token);
  const low = t.toLowerCase();
  return GO_ALIASES.some((f) => (/^-[A-Za-z]$/.test(f)
    ? new RegExp(`^-[A-Za-z]*${f[1]}[A-Za-z]*$`).test(t)
    : low === f.toLowerCase() || low.startsWith(`${f.toLowerCase()}=`)));
}

// A next object with the fixed field set. `who` follows from the action and
// `cwd` is START_CWD, so neither is an option. `why` is escaped (a filename in
// it cannot break the line) and clipped, here rather than refused by the
// guard, which runs after the work is done.
function nextStep(action, why, options = {}) {
  const { argv = null, afterSeconds = null, ...rest } = options;
  if (Object.keys(rest).length) {
    throw new Error(`nextStep() takes argv and afterSeconds only, not ${Object.keys(rest).join(', ')}: who and cwd are derived`);
  }
  const line = typeof why === 'string' ? clipText(printable(why), 200) : why;
  return { action, who: NEXT_WHO[action] ?? null, argv, afterSeconds, why: line, cwd: START_CWD };
}

// The head of every re-run argv: this node, then this script as invoked, made
// absolute but not realpath'd (an npm-linked bin stays its bin path). Running
// the script through node needs no executable bit and no PATH lookup.
function selfArgv() {
  return [process.execPath, __entry === SCRIPT_PATH ? runtimePath.resolve(process.argv[1]) : SCRIPT_PATH];
}

// This tool's own command line again, as an argv array, with flags inserted
// before any `--` (after it they would be positionals).
function rerunArgv(argv, ...extra) {
  const end = argv.indexOf('--');
  return end < 0 ? [...selfArgv(), ...argv, ...extra] : [...selfArgv(), ...argv.slice(0, end), ...extra, ...argv.slice(end)];
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// At most `max` characters of text, then … if any were cut.
function clipText(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

// Names for `why` (which nextStep() escapes): each clipped to 80 characters,
// at most `max` of them within about 120, then a count of the rest, so the
// count survives the clip on the whole.
function listNames(items, max = 3) {
  const names = [];
  let length = 0;
  for (const it of items) {
    const name = clipText(String(it.name), 80);
    if (names.length === max || (names.length && length + name.length > 120)) break;
    names.push(name);
    length += name.length + 2;
  }
  const rest = items.length - names.length;
  return rest ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

// The generic policy (rule 3). A tool's nextAction() starts here and adds what
// only it knows. Pure: reads the command, the items, the effect and the argv.
function defaultNextAction({ command, items, effect, argv }) {
  const s = summarize(items);
  const findings = s.warn + s.refuse + s.fail;
  if (s.fail) {
    return nextStep('stop', `failed: ${listNames(items.filter((it) => it.verdict === 'fail'))}`);
  }
  if (effect === 'read-only') {
    return nextStep('done', findings ? `read-only: report the ${count(findings, 'finding')}` : 'read-only: nothing to apply');
  }
  if (effect === 'dry-run') {
    if (argv.some(isOverrideFlag)) {
      return nextStep('ask', 'the command carried an override flag, which next never repeats; a person decides');
    }
    if (s.warn || s.refuse) {
      return nextStep('ask', `dry run: review the ${count(s.warn + s.refuse, 'finding')} before --go`, { argv: rerunArgv(argv, '--go') });
    }
    if (!s.ok) return nextStep('done', 'dry run: nothing would change');
    // A clean dry run goes on to --go unattended only for a command the tool
    // has pre-approved in AUTO_RUN_COMMANDS; for any other it is a person's call.
    const action = AUTO_RUN_COMMANDS.has(command) ? 'run' : 'ask';
    return nextStep(action, `dry run clean: ${count(s.ok, 'item')} would change`, { argv: rerunArgv(argv, '--go') });
  }
  const changed = items.filter((it) => it.changed).length;
  return nextStep('done', findings
    ? `applied: ${changed} changed; report the ${count(findings, 'finding')}`
    : `applied: ${changed} changed`);
}

// Rules 2 and 4 (and the fixed shape), enforced on every `next` before it is
// rendered. A violation throws, and the run exits 3: a tool cannot ship advice
// that walks an agent past a gate, and its tests meet the violation first.
// `current` is the run the advice follows: its effect, and the argv it handed
// nextAction(). report() passes it, so a run goes to --go only on what that
// run just previewed; without it, no run may carry --go.
function assertSafeNext(next, exit, current = {}) {
  const unsafe = (why) => { throw new Error(`unsafe next: ${why}`); };
  if (next === null) return;
  if (!next || typeof next !== 'object' || Array.isArray(next)) unsafe('nextAction() must return a next object or null');
  const keys = Object.keys(next);
  if (keys.length !== NEXT_KEYS.length || !NEXT_KEYS.every((k) => keys.includes(k))) {
    unsafe(`the fields are exactly ${NEXT_KEYS.join(', ')}`);
  }
  const { action, who, argv, afterSeconds, why, cwd } = next;
  if (!NEXT_ACTIONS.includes(action)) unsafe(`unknown action ${printable(JSON.stringify(action))}`);
  if (who !== NEXT_WHO[action]) unsafe(`who is ${NEXT_WHO[action]} for ${action}, never chosen`);
  if (argv !== null && !(Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string'))) {
    unsafe('argv is a non-empty array of strings, or null');
  }
  if ((action === 'run' || action === 'wait') && argv === null) unsafe(`${action} needs an argv`);
  if ((action === 'done' || action === 'stop') && argv !== null) unsafe(`${action} carries no argv`);
  // run, wait and any ask argv re-enter this tool and its own gates; a handoff
  // to another tool is done, with the next step in the runbook.
  const head = selfArgv();
  if (argv !== null && (argv[0] !== head[0] || argv[1] !== head[1])) {
    unsafe(`${action} re-invokes this tool: argv starts with ${printable(head.join(' '))}`);
  }
  const flag = (argv || []).find(isOverrideFlag);
  if (flag !== undefined) unsafe(`argv carries the override flag ${printable(flag)}; a step that needs one is ask`);
  const alias = (argv || []).find(isGoAlias);
  if (alias !== undefined) unsafe(`argv carries ${printable(alias)}, a --go alias in GO_ALIASES; advice spells --go`);
  if (action === 'run' && argv.slice(2).some((a) => a === '--go' || a.startsWith('--go='))) {
    // Advice goes straight to --go only on what this run just previewed: the
    // dry run's own argv with --go added, as rerunArgv(argv, '--go') builds it.
    // A step into another command, or after a run that was no dry run, is a
    // read-only or dry-run step, with no --go.
    if (current.effect !== 'dry-run') {
      unsafe(`run carries --go only straight after a dry run of the same command; this run was ${printable(current.effect ?? 'not given')}`);
    }
    const expected = Array.isArray(current.argv) ? rerunArgv(current.argv, '--go') : [];
    if (argv.length !== expected.length || argv.some((a, i) => a !== expected[i])) {
      unsafe("run carries --go only on the command just previewed: that dry run's argv with --go added, as rerunArgv(argv, '--go') builds it; a step into another command carries no --go");
    }
  }
  if (action === 'wait') {
    // wait re-polls, so it never mutates: no --go, and no mutating command,
    // matched as the same words in a row (command names may be phrases).
    const rest = argv.slice(2);
    if (rest.some((a) => a === '--go' || a.startsWith('--go='))) unsafe('wait never carries --go');
    const has = (words) => rest.some((_, i) => words.every((w, j) => rest[i + j] === w));
    const mutating = [...MUTATING_COMMANDS].find((c) => has(String(c).split(' ')));
    if (mutating !== undefined) unsafe(`wait never runs the mutating command ${printable(mutating)}`);
  }
  if (action === 'wait' ? !(Number.isInteger(afterSeconds) && afterSeconds > 0) : afterSeconds !== null) {
    unsafe('afterSeconds is a positive integer for wait, and null otherwise');
  }
  if (typeof why !== 'string' || !why.trim() || CONTROL_CHARS.test(why)) {
    unsafe('why is one non-empty line, with no control characters');
  }
  if (cwd !== START_CWD) unsafe('cwd is the working directory the run started in');
  if (!(ACTIONS_FOR_EXIT[exit] || []).includes(action)) unsafe(`action ${action} contradicts exit ${exit}`);
}

// Characters that could break, rewrite, reorder or hide part of a line of text
// output: C0 controls but TAB, DEL, C1 controls, the Unicode line and paragraph
// separators, and the bidi embedding, override and isolate controls. Item text
// is data, and styling is the renderer's: a tool puts no ANSI colour in it.
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function escapeControl(c) {
  const code = c.charCodeAt(0);
  return { '\n': '\\n', '\r': '\\r' }[c]
    ?? (code < 0x80 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`);
}

// A control character inside $'...': one past ASCII as its UTF-8 bytes (\xHH
// each), not \uXXXX, which bash 3.2 (macOS's /bin/sh and /bin/bash) does not
// decode; bash 4+ and zsh read \xHH too.
function escapeShell(c) {
  return c.charCodeAt(0) < 0x80 ? escapeControl(c)
    : [...Buffer.from(c, 'utf8')].map((b) => `\\x${b.toString(16)}`).join('');
}

// Text for a text-mode line: control characters shown as escapes, so an item
// is always one line and nothing in it can pose as another line. TAB passes.
function printable(text) {
  return String(text).replace(new RegExp(CONTROL_CHARS, 'g'), escapeControl);
}

// POSIX single-quoting, only where a token needs it; a token holding a control
// character is ANSI-C quoted ($'...') instead, so the line stays one line.
function shellQuote(token) {
  if (CONTROL_CHARS.test(token)) {
    return `$'${token.replace(/[\\']/g, (c) => `\\${c}`).replace(new RegExp(CONTROL_CHARS, 'g'), escapeShell)}'`;
  }
  return /^[A-Za-z0-9_\/.,:@%+-][A-Za-z0-9_\/.,:=@%+-]*$/.test(token) ? token : `'${token.split("'").join("'\\''")}'`;
}

// The text form of `next`, the last line of every text mode, and always exactly
// one line. A command is printed only where its reader may take it: run and
// wait always, led by `cd <cwd> &&` so the line runs as pasted from any
// directory; ask only for a person, in the default human mode, which says
// "your call" (--brief and --quiet print a bare ask, so an agent is never
// handed a command at a halt); done and stop never. argv is quoted for
// reading; --json carries the exact array, with cwd beside it.
function nextLine(next, mode) {
  const command = next.argv ? ` ${next.argv.map(shellQuote).join(' ')}` : '';
  const why = `  (${printable(next.why)})`;
  const here = `cd ${shellQuote(next.cwd)} &&`;
  if (next.action === 'run') return `next: run ${here}${command}${why}`;
  if (next.action === 'wait') return `next: wait ${next.afterSeconds}s ${here}${command}${why}`;
  if (next.action === 'ask' && mode === 'human') return `next: your call${command && `:${command}`}${why}`;
  return `next: ${next.action}${why}`;
}

// -- rendering (one item shape -> every mode)

const VERDICT_WIDTH = 6; // longest verdict word ("refuse")
const SUMMARY_WIDTH = 38; // brief-mode column alignment (fits the longest shipped summary)

function summaryLine(s, effect) {
  const base = `summary: ok=${s.ok} warn=${s.warn} skip=${s.skip} refuse=${s.refuse} fail=${s.fail}`;
  return effect === 'dry-run' ? `${base}  (dry run: pass --go to apply)` : base;
}

// One line per item. The parenthesised reason appears only for a non-ok verdict.
function briefLine(item) {
  const showReason = item.verdict !== 'ok' && item.reason;
  return `${glyph(item.verdict)} ${item.verdict.padEnd(VERDICT_WIDTH)} ${printable(item.summary).padEnd(SUMMARY_WIDTH)} ${printable(item.name)}`
    + (showReason ? `  (${printable(item.reason)})` : '');
}

// The stable per-item JSON shape (top-level keys fixed; tool-specific facts go
// under `data`).
function jsonItem(item) {
  return {
    path: item.path,
    name: item.name,
    verdict: item.verdict,
    summary: item.summary,
    reason: item.reason || '',
    changed: !!item.changed,
    data: item.data || null,
  };
}

// The exit code of the report once written: a late error keeps it.
let reportedExit = null;

// The only writer of stdout, and the end of the run. Renders one run in the
// chosen mode from the one item list; when the tool runs as a command, the
// process then exits with exactly the code the report carries, once stdout has
// flushed (a bare process.exit() cuts a large report off mid-pipe; a pipe
// takes 64 KiB at a time on macOS), so an open handle cannot hold the run
// open. Returns the exit code. `next` passes assertSafeNext() before a byte is
// written; `state` (a status snapshot) is optional and appears in --json only.
// `argv` is the argv the tool handed nextAction(), normalised as it normalised
// it; left out, it is this process's own.
function report({ command, effect, items, next, state = null, mode, argv = process.argv.slice(2) }) {
  const summary = summarize(items);
  const exit = exitCodeFor(items);
  assertSafeNext(next, exit, { effect, argv });

  const emit = (text) => {
    reportedExit = exit;
    process.stdout.write(text, () => { if (__isMain) process.exit(exit); });
    return exit;
  };

  if (mode === 'json') {
    const out = { tool: TOOL_NAME, version: readVersion(), contract: CONTRACT, command, effect, exit };
    if (state !== null) out.state = state;
    Object.assign(out, { items: items.map(jsonItem), summary, next });
    return emit(`${JSON.stringify(out, null, 2)}\n`);
  }

  const lines = [];
  if (mode === 'brief') {
    for (const it of items) lines.push(briefLine(it));
  } else if (mode === 'human') {
    for (const it of items) {
      lines.push(`${glyph(it.verdict)} ${printable(it.name)}`, `    ${printable(it.summary)}`);
      for (const line of it.lines || []) lines.push(`    ${printable(line)}`);
      if (it.reason) lines.push(`    ${it.verdict === 'ok' ? 'note' : it.verdict}: ${printable(it.reason)}`);
    }
    lines.push('');
  }
  lines.push(summaryLine(summary, effect));
  if (next) lines.push(nextLine(next, mode));
  return emit(`${lines.join('\n')}\n`);
}

// -- modes, errors, help, version

// The output mode from the parsed flags. --json combines with neither --brief
// nor --quiet (a usage error); --brief wins over --quiet.
function outputMode(values) {
  for (const other of ['brief', 'quiet']) {
    if (values.json && values[other]) usageError(`--${other} and --json cannot be combined`);
  }
  return values.json ? 'json' : values.brief ? 'brief' : values.quiet ? 'quiet' : 'human';
}

// Diagnostics go to stderr; stdout stays empty on both. These two may exit at
// once: they run before report(), so there is no stdout left to flush.
function usageError(message) {
  console.error(`error: ${message}`);
  console.error(`run \`${TOOL_NAME} --help\` for usage`);
  process.exit(2);
}

function environmentError(message) {
  console.error(`error: ${message}`);
  process.exit(3);
}

// Read the leading comment block of THIS file as help text (contact-sheet-cli
// pattern): skip the shebang, take the contiguous `//` lines, strip the `// `.
function helpText() {
  const lines = runtimeFs.readFileSync(SCRIPT_PATH, 'utf8').split('\n');
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith('//')) break;
    out.push(l.slice(3));
  }
  return out.join('\n');
}

function readVersion() {
  let dir = runtimePath.dirname(SCRIPT_PATH);
  for (let i = 0; i < 20; i += 1) {
    const p = runtimePath.join(dir, 'package.json');
    if (runtimeFs.existsSync(p)) {
      try { return JSON.parse(runtimeFs.readFileSync(p, 'utf8')).version || '0.0.0'; }
      catch { return '0.0.0'; }
    }
    const parent = runtimePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

// Exit with `code` once stdout has flushed: process.exit() alone drops what a
// pipe has not yet taken, and waiting for the event loop to empty lets any
// open handle hold the run open.
function exitAfterFlush(code) {
  process.stdout.write('', () => process.exit(code));
}

// The hooks a tool declares above this block, checked as the module loads, so
// a missing or misshapen one fails by name (exit 3) instead of mid-run.
const HOOK_ERROR = (() => {
  const hooks = [
    ['MUTATING_COMMANDS', 'a Set of command names', () => MUTATING_COMMANDS instanceof Set],
    ['AUTO_RUN_COMMANDS', 'a Set of command names (empty for none)', () => AUTO_RUN_COMMANDS instanceof Set],
    ['EXTRA_OVERRIDE_FLAGS', 'an array of strings (empty for none)',
      () => Array.isArray(EXTRA_OVERRIDE_FLAGS) && EXTRA_OVERRIDE_FLAGS.every((f) => typeof f === 'string')],
    ['GO_ALIASES', 'an array of strings (empty for none)',
      () => Array.isArray(GO_ALIASES) && GO_ALIASES.every((f) => typeof f === 'string')],
    ['nextAction', 'a function', () => typeof nextAction === 'function'],
    ['main', 'a function', () => typeof main === 'function'],
  ];
  const wrong = hooks.filter(([, , ok]) => { try { return !ok(); } catch { return true; } });
  return wrong.length
    ? `contract ${CONTRACT}: declare ${wrong.map(([name, shape]) => `${name} as ${shape}`).join('; ')}, above the runtime block`
    : null;
})();

// Entry-point guard, the last statement of the file. Resolve symlinks first: an
// npm-linked bin is a symlink, so process.argv[1] is the link path while
// import.meta.url is the real path, and the naive guard silently skips main()
// (exit 0, no output). realpath both sides to compare. An exception escaping
// main(), or thrown from a timer, a floating promise or a stream with no
// 'error' handler before the report is written, exits 3: the run could not
// complete, which is not a partial result (1). One thrown after the report is
// still printed, but the run exits with the code the report gave, which nothing
// may contradict. A main() that returns without a report exits once stdout has
// flushed. An error while the module loads (a syntax error, a top-level use of
// a fence name above the fence) happens before this runs, and Node exits 1.
const __entry = process.argv[1]
  ? (() => { try { return runtimeFs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })()
  : null;
const __isMain = !!__entry && import.meta.url === runtimeUrl.pathToFileURL(__entry).href;
if (__isMain) {
  const fatal = (e) => {
    console.error(`error: ${e?.message ?? e}`);
    if (reportedExit === null) process.exit(3);
    exitAfterFlush(reportedExit);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  if (HOOK_ERROR) fatal(new Error(HOOK_ERROR));
  else Promise.resolve().then(main).then(() => { if (reportedExit === null) exitAfterFlush(process.exitCode ?? 0); }, fatal);
} else if (HOOK_ERROR) {
  throw new Error(HOOK_ERROR);
}
// ---- end mjs-tool runtime v2 ----

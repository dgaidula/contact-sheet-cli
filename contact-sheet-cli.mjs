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
//   contact-sheet-cli pages <manifest.jsonl | list.txt | dir> [options]
//   contact-sheet-cli pages picks.jsonl --title "Slideshow, round 2" --pdf round2.pdf
//   contact-sheet-cli pages photos/ --tiles 5x4 --page "a4 portrait" --thumbs thumbs/
//
// A second mode, for review rounds rather than batch comparison: an ordered
// list of images laid out as numbered, fixed-size printable pages, so a
// reviewer can answer "drop 009 and 019". Each section starts on a new page;
// each page heads itself "37-72 of 93". Print the HTML to PDF from a browser,
// or pass --pdf to have ImageMagick write one. "pages" must come first; a
// column directory that is really called pages is passed as ./pages.
//
//   manifest  JSONL, one row per image (the photo tools' shared manifest).
//             Image: paths[0], or path. Number: seq, else its position.
//             Date: dateLabel, or date.label. A date is marked "≈" when
//             date.estimated is true, or when dateSrc starts with file,
//             estimated, undated or archival. Section: the --sections field.
//             Order: by seq when every row has one, else manifest order.
//   list      One path per line, with optional tab-separated label and
//             section columns. Blank lines and # comments are skipped.
//   dir       Its images (flat, not recursed), in natural filename order.
//
//   --out <file>      HTML to write (default contact-sheet.html)
//   --pdf <file>      also write a PDF; needs ImageMagick ("magick") on PATH
//   --tiles <CxR>     columns x rows per page (default 6x6)
//   --page "<size>"   letter, legal, tabloid, a4 or a3, then portrait or
//                     landscape (default "letter landscape")
//   --title "<text>"  sheet title (default: the input's name)
//   --sections <key>  manifest field naming each row's section; dotted for a
//                     nested one, like group.groupId (default category)
//   --thumbs <dir>    write downscaled JPEG copies there (sips, else magick)
//                     and show those; source images are never modified
//
// Paths in a manifest or list resolve from that file's own folder. Exit codes
// for pages: 0 written; 1 written but some image files were missing, or no
// images found; 2 usage error; 3 a needed tool (magick, sips) is missing or
// failed.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Paper sizes (portrait) in inches, with the CSS lengths that state them exactly.
export const PAPER = {
  letter: { w: 8.5, h: 11, css: ['8.5in', '11in'] },
  legal: { w: 8.5, h: 14, css: ['8.5in', '14in'] },
  tabloid: { w: 11, h: 17, css: ['11in', '17in'] },
  a4: { w: 210 / 25.4, h: 297 / 25.4, css: ['210mm', '297mm'] },
  a3: { w: 297 / 25.4, h: 420 / 25.4, css: ['297mm', '420mm'] },
};

function exitError(code, message) {
  const e = new Error(message);
  e.exitCode = code;
  return e;
}

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
  };
}

// Manifest JSONL -> { items, skipped }. A row with no image path (a video
// range row, say) is counted in `skipped`, not drawn.
export function itemsFromManifest(text, { baseDir = '.', sectionKey = 'category' } = {}) {
  const items = [];
  let skipped = 0;
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw exitError(2, `manifest line ${i + 1} is not valid JSON`);
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw exitError(2, `manifest line ${i + 1} is not a JSON object`);
    }
    const file = Array.isArray(row.paths) && typeof row.paths[0] === 'string' ? row.paths[0]
      : typeof row.path === 'string' ? row.path : null;
    if (!file) {
      skipped++;
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
    }));
  });
  return { items, skipped };
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

// Order, section, number and page the items.
// - Order: by seq when every item has one (numeric-aware), else as given.
// - Sections: in order of first appearance; each starts on a new page.
// - Numbers: the seq itself (a numeric seq zero-padded), else a running
//   count across the whole sheet, so one number names one photo.
// - Pages: perPage tiles each; a page knows its place in its section
//   (from/to/total) and in the sheet (number/of).
export function planPages(items, { perPage }) {
  const bySeq = items.length > 0 && items.every(hasSeq);
  const ordered = items.map((item, index) => ({ item, index }));
  if (bySeq) {
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
  return { pages, count: items.length, sections: [...sections.keys()], bySeq };
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

// Downscaled JPEG copies in `dir`, reused while newer than their source; sets
// tile.src on success. Sources are only ever read.
async function makeThumbs(tiles, dir, tool) {
  mkdirSync(dir, { recursive: true });
  const jobs = tiles.filter((t) => !t.missing && t.ext !== 'svg');
  const report = { made: 0, reused: 0, failed: [] };
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const tile = jobs[index];
      const dest = path.join(dir, thumbName(tile.path));
      if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(tile.path).mtimeMs) {
        tile.src = dest;
        report.reused++;
        continue;
      }
      const tmp = path.join(dir, `.${path.basename(dest, '.jpg')}.${process.pid}-${index}.tmp.jpg`);
      const args = tool === 'sips'
        ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(THUMB_EDGE), tile.path, '--out', tmp]
        : [`${tile.path}[0]`, '-auto-orient', '-thumbnail', `${THUMB_EDGE}x${THUMB_EDGE}>`, '-quality', '82', tmp];
      const { error, stderr } = await runFile(tool, args);
      if (error || !existsSync(tmp)) {
        rmSync(tmp, { force: true });
        const reason = stderr.trim().split('\n').pop() || error?.message || 'no output';
        report.failed.push({ tile, reason: reason.slice(0, 200) });
        continue;
      }
      renameSync(tmp, dest);
      tile.src = dest;
      report.made++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), jobs.length) }, worker));
  return report;
}

// ImageMagick reads % escapes, a leading @ (take the text from a file) and
// backslash escapes in -label and -annotate text; neutralise all three.
export function imText(s) {
  const t = String(s).replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return t.startsWith('@') ? `\\${t}` : t;
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
    throw exitError(3, `magick failed ${what}: ${detail}`);
  }
}

// The same plan as the HTML, drawn by ImageMagick: each page is one magick
// run that fits every photo onto a toned frame at its grid position, labels
// it, adds the masthead and footer; then all pages join into one PDF at the
// paper's size.
export function renderPagesPdf({ title, plan, paper, tiles, pdfPath, generatedAt }) {
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
        const image = t.missing
          ? [`xc:${ground}[${frame}!]`]
          : ['(', `${t.src ?? t.path}[0]`, '-auto-orient', '-thumbnail', frame,
            '-background', ground, '-gravity', 'center', '-extent', frame, ')'];
        const label = t.missing ? `${t.num}  missing` : `${t.num}  ${t.text}${t.approx ? ' ≈' : ''}`;
        return [
          ...image, '-gravity', 'NorthWest', '-geometry', `+${x}+${y}`, '-composite',
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
        '-units', 'PixelsPerInch', '-density', String(PDF_DPI), '-quality', '88', pageJpg,
      ], `on page ${page.number}`);
      return pageJpg;
    });
    magick(['-units', 'PixelsPerInch', '-density', String(PDF_DPI), ...pageFiles, '-compress', 'jpeg', '-quality', '88', pdfPath], 'writing the PDF');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- pages CLI ------------------------------------------------------------------

function helpText() {
  const header = [];
  for (const l of readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1)) {
    if (!l.startsWith('//')) break;
    header.push(l.slice(3));
  }
  return header.join('\n');
}

async function pagesCli(argv) {
  try {
    process.exitCode = await pagesMain(argv);
  } catch (e) {
    if (e.exitCode) {
      console.error(e.message);
      process.exitCode = e.exitCode;
    } else if (String(e.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(e.message);
      process.exitCode = 2;
    } else {
      console.error(e.stack || String(e));
      process.exitCode = 3;
    }
  }
}

async function pagesMain(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: 'contact-sheet.html' },
      pdf: { type: 'string' },
      tiles: { type: 'string', default: '6x6' },
      page: { type: 'string', default: 'letter landscape' },
      title: { type: 'string' },
      sections: { type: 'string', default: 'category' },
      thumbs: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(helpText());
    return 0;
  }
  if (positionals.length !== 1) {
    throw exitError(2, 'pages takes one input: a manifest (.jsonl), a list file, or a directory (see --help)');
  }
  const tiles = parseTiles(values.tiles);
  if (!tiles) throw exitError(2, `--tiles must be columns x rows, 1 to 20 each, like 6x6; got "${values.tiles}"`);
  const paper = parsePaper(values.page);
  if (!paper) {
    throw exitError(2, `--page must be letter, legal, tabloid, a4 or a3, then optionally portrait or landscape; got "${values.page}"`);
  }

  // Read the input; anything wrong with it is a usage error, and nothing has
  // been written yet.
  const input = positionals[0];
  let st;
  try {
    st = statSync(input);
  } catch {
    throw exitError(2, `input not found: ${input}`);
  }
  let items;
  let skipped = 0;
  if (st.isDirectory()) {
    items = itemsFromDir(input);
  } else {
    const text = readFileSync(input, 'utf8');
    const baseDir = path.dirname(path.resolve(input));
    if (/\.(jsonl|ndjson)$/i.test(input) || text.trimStart().startsWith('{')) {
      ({ items, skipped } = itemsFromManifest(text, { baseDir, sectionKey: values.sections }));
    } else {
      items = itemsFromList(text, baseDir);
    }
  }
  if (items.length === 0) {
    console.error(`no images found in ${input}${st.isDirectory() ? ' (accepted: png jpg jpeg webp gif svg tif tiff)' : ''}`);
    return 1;
  }

  // Then the optional tools, still before anything is written.
  if (values.pdf !== undefined && !hasCommand('magick', ['-version'])) {
    throw exitError(3,
      '--pdf needs ImageMagick 7 (the "magick" command) on PATH, and it was not found. ' +
      'Install it (macOS: brew install imagemagick), or leave out --pdf and print the HTML to PDF from a browser.');
  }
  let thumbTool = null;
  if (values.thumbs !== undefined) {
    thumbTool = process.platform === 'darwin' && hasCommand('sips', ['--version']) ? 'sips'
      : hasCommand('magick', ['-version']) ? 'magick' : null;
    if (!thumbTool) throw exitError(3, '--thumbs needs sips (macOS) or ImageMagick ("magick") on PATH, and neither was found.');
    const thumbsDir = path.resolve(values.thumbs);
    const clash = items.find((it) => path.dirname(it.path) === thumbsDir);
    if (clash) throw exitError(2, `--thumbs must not be a folder that holds source images (${values.thumbs} holds ${clash.name})`);
  }

  const plan = planPages(items, { perPage: tiles.cols * tiles.rows });
  const allTiles = plan.pages.flatMap((p) => p.tiles);
  for (const t of allTiles) t.missing = !existsSync(t.path);
  const missing = allTiles.filter((t) => t.missing);
  const thumbs = thumbTool ? await makeThumbs(allTiles, values.thumbs, thumbTool) : null;

  const title = values.title ?? path.basename(path.resolve(input), st.isDirectory() ? '' : path.extname(input));
  const generatedAt = localStamp(new Date());
  mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  writeFileSync(values.out, renderPagesHtml({ title, plan, paper, tiles, outPath: values.out, generatedAt }));
  if (values.pdf !== undefined) {
    mkdirSync(path.dirname(path.resolve(values.pdf)), { recursive: true });
    renderPagesPdf({ title, plan, paper, tiles, pdfPath: values.pdf, generatedAt });
  }

  for (const t of missing) console.error(`missing: ${t.num} ${t.path}`);
  for (const f of thumbs?.failed ?? []) console.error(`thumbnail failed, showing the original: ${f.tile.num} ${f.tile.path} (${f.reason})`);
  if (skipped > 0) console.error(`skipped ${skipped} manifest row(s) with no image path`);
  const named = plan.sections.filter((s) => s !== null).length;
  console.log(`${plan.count} image(s), ${named} section(s), ${plan.pages.length} page(s) of ${tiles.cols}x${tiles.rows}, ${missing.length} missing file(s)`);
  if (thumbs) console.log(`thumbnails: ${thumbs.made} made, ${thumbs.reused} reused, in ${values.thumbs}`);
  console.log(`wrote ${values.out}`);
  if (values.pdf !== undefined) console.log(`wrote ${values.pdf}`);
  return missing.length > 0 || (thumbs?.failed.length ?? 0) > 0 ? 1 : 0;
}

// ---- CLI ------------------------------------------------------------------

async function main() {
  if (process.argv[2] === 'pages') return pagesCli(process.argv.slice(3));
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

// Entry-point guard. Resolve symlinks first: an npm-linked bin is a symlink in
// /usr/local/bin, so argv[1] is the link path while import.meta.url is the real
// path, and a plain comparison silently skips main() (exit 0, no output —
// found by a claude-ops battery arm 2026-09-06).
const __entry = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })() : null;
if (__entry && import.meta.url === pathToFileURL(__entry).href) await main();

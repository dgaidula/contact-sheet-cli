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

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
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

// ---- CLI ------------------------------------------------------------------

async function main() {
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

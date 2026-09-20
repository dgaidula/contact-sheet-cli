# contact-sheet-cli

Build a single self-contained HTML contact sheet for reviewing an
image-processing batch: each directory you pass becomes a column, each
filename becomes a row, so you can eyeball original vs processed vs final
side by side instead of flipping between Finder windows.

Point it at the same batch run at two or more stages — say, raw exports,
an AI redraw pass, and the finished vector — and it lines everything up by
filename so a bad frame or a bungled conversion jumps out immediately.

## Install

```sh
# run without installing
npx contact-sheet-cli original/ processed/

# or install globally
npm install -g contact-sheet-cli
contact-sheet-cli original/ processed/
```

Requires Node 20+. Zero dependencies — the whole tool is one `.mjs` file.

## Quick start

```sh
contact-sheet-cli original/ redrawn/ vectorized/
```

Writes `contact-sheet.html` in the current directory (override with `--out`) —
open it in any browser, no server needed. Each row is a filename (matched by
stem, case-insensitively); each column is one of the directories you passed,
in the order given.

```sh
# a typical 3-column review: source photos, an AI touch-up pass, the final export
contact-sheet-cli "Original=photos/" "Touched up=out/gemini/" "Final=out/vector/"
```

`Label=dir` renames a column's header; a bare directory just uses its
basename.

## How matching works

Rows are keyed by filename **stem** (basename minus extension). A file whose
stem is a *suffixed variant* of a shorter stem seen anywhere in the batch —
`name-alt.png`, `name-gemini-bg.jpg` next to `name.png` — is folded into that
shorter stem's row instead of becoming a row of its own. Each match in a cell
is stacked with its suffix shown as a small caption, so a row can hold, say,
the primary export plus an alternate crop plus a background-removed variant,
all in one cell per column.

A stem with no shorter root anywhere in the batch is just its own row — there
has to be *something* shorter to fold into.

Rows are the union of stems across every column. If a directory is missing a
file for a given row, that cell renders a visible `—` placeholder instead of
silently collapsing the grid.

## Options

| flag | default | meaning |
|---|---|---|
| `--out <file>` | `contact-sheet.html` | output HTML path (parent dirs are created as needed) |
| `--title "<text>"` | auto (column labels) | page `<h1>` / `<title>` |
| `--sort name\|mtime` | `name` | row order: alphabetical, or by each row's earliest matched file's mtime |
| `--help` | | print usage |

## What it accepts

`.png .jpg .jpeg .webp .gif .svg .tif .tiff` — anything else in a directory
is ignored. Browsers can't render TIFF in an `<img>`, so those cells render
as a filename link instead of a broken thumbnail.

Each directory is read flat (not recursed): one folder is one column of
files sitting directly inside it.

## The output file

One HTML file, everything inlined — no external requests, no CDN, no build
step. Images are embedded by relative path computed from where `--out`
lands, so the HTML and the source directories need to keep their relative
position if you move things around later (that's the tradeoff for "just one
file, works forever, no server").

- Sticky header row and sticky row-label column, so long/wide sheets stay
  orientable while scrolling.
- Click any thumbnail for a full-size overlay (Escape or the × closes it —
  a few lines of vanilla inline JS, no libraries).
- Light/dark styling via `prefers-color-scheme` — no toggle needed, it just
  matches the OS.
- Print-friendly: the overlay and sticky positioning drop out under
  `@media print`, and rows avoid breaking across a page.
- Footer reports row count, files per column, and how many cells came up
  missing, plus a generation timestamp.

Exits non-zero if a directory doesn't exist, isn't a directory, or if no
accepted image files turn up across every directory given.

## Works great with

- [svg-color-rinse](https://github.com/dgaidula/svg-color-rinse) — clean up
  the SVG column before it goes in the sheet.
- [gemini-vectorize](https://github.com/dgaidula/gemini-vectorize) — the
  batch pipeline whose stages (`photos/` → redraw → vectorize) are exactly
  the kind of multi-column run this tool is for reviewing.

## Development

```sh
npm test      # node --test — builds tiny fixture PNGs on the fly, no install needed
```

## License

MIT

# contact-sheet-cli

Build a single self-contained HTML contact sheet for reviewing an
image-processing batch: each directory you pass becomes a column, each
filename becomes a row, so you can eyeball original vs processed vs final
side by side instead of flipping between Finder windows.

Point it at the same batch run at two or more stages — say, raw exports,
an AI redraw pass, and the finished vector — and it lines everything up by
filename so a bad frame or a bungled conversion jumps out immediately.

It also makes numbered, paged review sheets for print: see
[Review pages](#review-pages).

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

## Review pages

```sh
contact-sheet-cli pages picks.jsonl --title "Slideshow, round 2"
contact-sheet-cli pages picks.jsonl --pdf round2.pdf --thumbs thumbs/
contact-sheet-cli pages scans/ --tiles 5x4 --page "a4 portrait"
```

The grid above compares the stages of one batch. `pages` is for a different
job: a review round over an ordered selection — the picks first, then each
group of maybes — where the reviewer answers in numbers (“drop 009 and 019”).
It lays the images out as fixed-size printable pages: a grid of tiles per
page, every tile labelled with its number and date, each section starting on
a new page, and each page headed with its section and its place in it
(“37–72 of 93”). Open the HTML and print it to PDF, or pass `--pdf` to have
ImageMagick write the PDF directly.

`pages` must come first. (A column directory that is really called `pages`
is passed to the grid as `./pages` or `pages/`.)

### What it reads

One input, of three kinds. Paths in a manifest or a list resolve from that
file’s own folder.

**A manifest:** JSONL, one JSON object per line.

| tile shows | read from |
|---|---|
| the image | `paths[0]`, else `path` |
| its number | `seq`, when every row has one; otherwise its place in the sheet |
| its date | `dateLabel`, else `date.label`, else the day of `date.iso` |
| “≈” after the date | `date.estimated` is `true`, or `dateSrc` starts with `file`, `estimated`, `undated` or `archival` |
| its section | the field `--sections` names (default `category`); dotted for a nested one, like `group.groupId` |

Rows are ordered by `seq` when every row has one, otherwise kept in manifest
order; sections appear in the order of their first row. A row with no image
path (a video range, say) is skipped and counted.

**A list file:** one path per line, optionally followed by a tab and a label,
then a tab and a section. Blank lines and `#` comments are skipped.

```
# round 2
scans/1971-graduation.jpg	1971 ≈	Picks
scans/IMG_0412.JPG	2004-05-28	Picks
scans/IMG_0413.JPG		Maybe
```

**A directory:** its images, read flat, in natural filename order (`IMG_2`
before `IMG_10`).

A tile’s number is the review handle, so one number names one photo across
the whole sheet: the manifest’s own `seq`, or else a running count, padded to
three digits, that carries on from section to section. Beside it goes the
date; a list label when there is no date; the file name when there is
neither.

### Options

| flag | default | meaning |
|---|---|---|
| `--out <file>` | `contact-sheet.html` | HTML to write |
| `--pdf <file>` | | also write a PDF (needs ImageMagick) |
| `--tiles <CxR>` | `6x6` | columns × rows per page, 1 to 20 each |
| `--page "<size>"` | `letter landscape` | `letter`, `legal`, `tabloid`, `a4` or `a3`, then `portrait` or `landscape` |
| `--title "<text>"` | the input’s name | sheet title, over every page |
| `--sections <key>` | `category` | the manifest field that names each row’s section |
| `--thumbs <dir>` | | make downscaled copies there and show those |

### The PDF

The HTML needs nothing else: it sets the paper size with `@page` and draws
its own margins, so printing it to PDF (in Chrome: Print, then Save as PDF)
gives one PDF page per sheet page, with no browser header or footer. That is
checked in Chrome; another browser may want the paper size and margins set in
its print dialog. On screen the pages scale to the window, in light or dark.

`--pdf` writes the PDF directly, drawing the same pages with ImageMagick 7
(`magick`) at 150 dpi. It is optional, never a requirement: without `magick`
on your `PATH` the run stops before writing anything and says so. On macOS
the labels are set in Arial from `/System/Library/Fonts/Supplemental/` —
ImageMagick can’t find Helvetica by name — and elsewhere in ImageMagick’s
default font.

### Thumbnails

By default the sheet shows the images themselves, by relative path, like the
grid. For a sheet of a few hundred photos, `--thumbs <dir>` makes downscaled
JPEG copies (640 px on the long edge, with `sips` on macOS, otherwise
`magick`) and shows those; clicking a tile still opens the full image when the
browser can show it. A copy is reused on the next run while it is newer than
its source, so the second review round is quick. A TIFF, which a browser
can’t show, gets a viewable thumbnail too.

Source images are only ever read. `--thumbs` refuses a folder that holds
source images.

### Exit codes

`0` the sheet was written · `1` it was written, but some image files were
missing or a thumbnail failed (each is named on stderr), or no images were
found · `2` usage error, and nothing was written · `3` a tool it needs
(`magick`, `sips`) is missing or failed.

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

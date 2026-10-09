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
contact-sheet-cli pages picks.jsonl --title "Slideshow, round 2"          # dry run: what it would write
contact-sheet-cli pages picks.jsonl --title "Slideshow, round 2" --go     # write it
contact-sheet-cli pages picks.jsonl --pdf round2.pdf --thumbs thumbs/ --go
contact-sheet-cli pages scans/ --tiles 5x4 --page "a4 portrait" --go
contact-sheet-cli pages keepers/manifest.jsonl --sort date --keepers --go
```

`pages` is a dry run until you pass `--go`: it reads the input, plans the
sheet, and reports what it would write, without writing anything. See
[Dry run, then `--go`](#dry-run-then---go).

`pages` needs contact-sheet-cli 1.3.0 or later (`npm install -g contact-sheet-cli@latest`).

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
| the image | `paths[0]`, else `path`; for a video frame row, its still (`group.copy`) |
| its number | `seq`, when every row has one and `--sort date` isn’t given; otherwise its place in the sheet |
| its date | `dateLabel`, else `date.label`, else the day of `date.iso` |
| “≈” after the date | `date.estimated` is `true`, or `dateSrc` starts with `file`, `estimated`, `undated` or `archival` |
| its section | the field `--sections` names (default `category`); dotted for a nested one, like `group.groupId` |

Rows are kept in manifest order, or ordered by `seq` when every row has one.
`--sort date` orders them by date instead, and wins over `seq`: by
`date.iso`, else by `dateLabel` or `date.label` when it is a date (a year
alone sorts at July 1, a month alone at the 15th); undated rows go last, in
manifest order, and equal dates keep their manifest order. `--keepers` shows
only the rows whose `group.keeper` is `true`, plus rows with no `group` at
all, and reports each row it leaves out. Sections appear in the order of their
first row.

Video rows hold the video in `paths`, and a video is never drawn as a tile.
A frame row shows the still extracted from it, `group.copy` (near-dupe-pick
`video-stills`), resolved from the manifest’s folder; without one it is
skipped. A range row is always skipped. Each skipped row, like any row with
no image path, is reported by its `id` (or its line), with the reason.

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
| `--sort date` | | order by date, undated last (see above); wins over `seq` |
| `--keepers` | | only `group.keeper` rows, and rows with no `group` |
| `--thumbs <dir>` | | make downscaled copies there and show those |
| `--go` | | write the outputs; without it, a dry run |
| `--brief`, `--json`, `--quiet` | | output mode (see below) |
| `--version` | | print the version |

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
source images, however it is named: through a symlink, or in another letter
case.

### Dry run, then `--go`

`pages` follows the contract of
[mjs-tool-skeleton](https://github.com/dgaidula/mjs-tool-skeleton)
(`mjs-tool/2`), so a person and an agent read the same report. The grid
above is not on it yet.

Without `--go`, a run is a dry run. It reads the input, plans every page,
checks where each output would go, and reports what it would write. It
writes nothing: no HTML, no PDF, no thumbnail folder. With `--go` it writes
them, in this order: thumbnails, HTML, PDF.

The report is one list of items, one line each in `--brief`:

```
• skip   video range row: not drawn             clip@1-3  (a range row holds video, which is never drawn as a tile)
⚠ warn   tile 004 missing: placeholder          IMG_7.jpg  (no file at /photos/IMG_7.jpg; a placeholder takes its place on the sheet)
✓ ok     would make 5 thumbnails, reuse 0       review/thumbs
✓ ok     would write 3 pages, 6 images          review/sheet.html
summary: ok=2 warn=1 skip=1 refuse=0 fail=0  (dry run: pass --go to apply)
next: ask  (dry run: review 1 missing image before --go: IMG_7.jpg)
```

- **`skip`:** a row that is not drawn (a video row, a row with no image, a
  non-keeper under `--keepers`), thumbnails already up to date, or an output
  not written because there was nothing to draw.

- **`warn`:** a tile whose image file is missing, drawn as a placeholder
  that keeps its number; or, under `--go`, a tile whose thumbnail failed, so
  the sheet shows the original.

- **`refuse`:** an output that `--go` will not write, or no images to lay out.

- **`fail`:** an input that cannot be read (a manifest line that is not JSON,
  say), or a write that failed (`magick` could not draw the PDF). Outputs
  after a failed one are not attempted.

`--json` prints the same report as one object (`tool`, `version`,
`contract`, `command`, `effect`, `exit`, `items`, `summary`, `next`); the
HTML item’s `data` holds the plan, with each section’s first and last
number and its pages. `--quiet` prints the summary line alone. The default
output is a block per item, for a person at a terminal.

Every report ends with a `next:` line, the tool’s advice. A clean dry run is
a person’s call: in the default output it reads `next: your call:`, then the
same command with `--go` added. When there is nothing to draw, or an output
cannot be written, the advice names the problem and offers no command,
because the fix is another input or path, not `--go`.

**What `--go` will replace.** An existing `--out` or `--pdf` is replaced only
when this tool wrote it: every sheet carries
`<meta name="generator" content="contact-sheet-cli pages">`, and every PDF
has `contact-sheet-cli pages` as its Creator. Anything else there is refused
and left as it was, and the other outputs are still written. So is a folder
or a dangling symlink in the way, or a folder that cannot be written; the
dry run shows each one before `--go` is ever run. A sheet made by an earlier
build of `pages` has no generator tag, so move it away once. Files are
written to a temporary name beside the target and then renamed, so an
interrupted run never leaves half a sheet.

`--go` acts on the inputs as they are when it runs, not as they were in the
dry run: a file that went missing in between is reported then.

### Exit codes

`0` every item is `ok` or `skip` · `1` a tile warned, an output was refused,
or something failed: the report says which · `2` usage error, and nothing
was written · `3` a tool that `--pdf` or `--thumbs` needs (`magick`; `sips`
or `magick`) is not on your `PATH`, checked before anything is read or
written. On `2` and `3` stdout is empty and the reason is on stderr.

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

MIT © Danniel T. Gaidula

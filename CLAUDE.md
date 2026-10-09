# contact-sheet-cli — agent guide

Zero-dependency Node 20+ CLI: turns N directories into one self-contained
HTML contact sheet (columns = directories, rows = filename stems) for
eyeballing an image-processing batch. One file: `contact-sheet-cli.mjs`.

Since 1.3.0 it has a second mode, `contact-sheet-cli pages <input>`: an
ordered list of images as numbered, fixed-size printable review pages. See
“The `pages` mode” below; the two modes share only the small utilities
(`escapeHtml`, `relHref`, `scanDir`) and the mjs-tool runtime fence at the
bottom of the file, whose entry guard starts both. Only `pages` reports
through the fence: it is on the `mjs-tool/2` contract, and the grid is not
yet (see “The contract, for `pages` only”).

## Driving `contact-sheet-cli pages` from an agent session

This covers `pages` only. The grid mode prints one line of counts and
`wrote <file>`, with its own exit codes; it has no `--brief`, `--json` or
dry run yet.

- **Reach for `--brief` first** — or `--json` when you need to parse the result — never the default human output. Brief is exactly one line per item, then a summary line and a `next:` line; JSON is a stable `{ tool, version, contract, command, effect, exit, items, summary, next }` object. The human output is for a person at a terminal and only wastes your context.

- **Any line whose verdict is not `ok` is a finding**, not noise. The verdicts are `ok`, `warn`, `skip`, `refuse`, `fail`; a non-`ok` line is never collapsed or dropped, and carries a parenthesised reason. A run is clean only when the summary reads `warn=0 refuse=0 fail=0` — `skip` is not a failure, but report what was skipped and why.

- **Dry-run before you commit.** `contact-sheet-cli pages <input> …` (no `--go`) previews the sheet and every output; `--go` writes them. In `--json`, `effect` says which kind of run it was: `dry-run` or `applied`. This tool never prompts and has no confirmation or override flag: `--go` is the only gate, and whether to pass it after a dry run is a person’s call.

- **Check the exit code, then read `next`:** `0` all ok · `1` partial (something warned, refused, or failed) · `2` usage error · `3` could not run to completion (an environment or internal error). **Exit `0` does not mean go** — a clean dry run exits `0` and still says `ask`. On exit `2` or `3` there is nothing on stdout and no `next`: report stderr and halt.

- **Quote back** the final summary line plus every non-`ok` line verbatim. That is the whole result — do not paraphrase a refusal into “done”.

### The babysit loop: run, read `next`, obey or halt

Every run ends with one piece of advice: the `next:` line, or the `next` object in `--json`.

```
next: ask  (dry run clean: would write review/sheet.html)
next: done  (wrote review/sheet.html; report 1 missing image: IMG_7.jpg)
```

- **`run`** — run exactly that command, then read its `next` in turn. `pages` never advises `run` today (no command is in `AUTO_RUN_COMMANDS`), but if it does: the text line reads `next: run <command>  (<why>)`, and `<command>` starts with `cd <dir> &&`; in `--json`, take the `argv` array as given and run it from `next.cwd`; never rebuild or re-quote it.

- **`done`** — nothing is left for this tool to do. Report and finish. At exit `1` it means no further tool step, not success: report the findings.

- **`ask`** — a person’s decision. Report the summary and the findings, then halt. Never take the step yourself; in `--json`, `argv` is what the person would review, not a command for you. (A person running the tool by hand sees the same step as `next: your call: <command>`.)

- **`stop`** — something is broken beyond the tool’s remedy. Report and halt.

**The runbook can only hold you back.** A runbook can halt you where `next` says `run`; nothing but a person carries you past `ask` or `stop`. `next` never carries an override flag, and it never contradicts the exit code.

## How matching works (read this before touching `buildRows`)

Rows are filename **stems** (basename minus extension), case-insensitive.
The core rule: stem `S` is a *variant* of stem `T` iff `S === T` or `S`
starts with `T + "-"`. A stem with no shorter root anywhere in the batch
becomes its own row.

Implementation in `buildRows` (`contact-sheet-cli.mjs`):
1. Collect every stem (lowercased) seen across all columns into one set.
2. `findParent(stem)` finds the *longest* other stem in that set that `stem`
   is a hyphen-suffixed variant of (longest wins so `name-gemini-bg` attaches
   to `name-gemini` if that exists, not straight to `name`).
3. `findRoot(stem)` walks `findParent` until it bottoms out (no further
   parent) — that's the row's identity key. Parent strings are always
   strictly shorter, so the chain terminates; no cycle guard needed beyond
   the iteration cap already in the code.
4. A file's caption (the little suffix label under a stacked thumbnail) is
   computed against the **ultimate root**, not the immediate parent — so
   `name-gemini-bg` gets caption `gemini-bg`, not `bg`. This is deliberate:
   test `buildRows: suffix variants (incl. multi-level)...` locks it in.
5. Row label casing comes from whichever file's stem equals the root exactly
   (guaranteed to exist, since the root value is drawn from real stems).

Don't be tempted to "simplify" this to a single per-column prefix check —
that breaks the moment two related-but-distinct roots coexist (e.g. `name`
and `name-gemini` both present as real rows, with `name-gemini-bg` needing to
attach to the *second* one, not the first). The longest-parent + chain-walk
is what makes that unambiguous.

## The self-contained-HTML constraint

Non-negotiable: the output HTML must never issue an external request. That
means:
- No CDN links, no `<link rel="stylesheet">`, no external fonts/scripts.
- Images are embedded by **relative path** (`relHref`, computed with
  `path.relative` from `--out`'s directory), not inlined as data URIs — the
  spec deliberately keeps the HTML+images relationship as "keep them
  relative to each other," not "one giant blob." If a future ask wants a
  truly portable single-file-with-embedded-pixels mode, that's a new flag
  (e.g. `--embed`), not a change to the default — the default's whole value
  is opening a 5000-photo batch instantly without re-encoding everything to
  base64 first.
- Interactivity (the lightbox) is a few lines of vanilla inline `<script>` —
  no framework, ever, per the original spec. Keep it that way.
- CSS is one inline `<style>` block. Watch out for hardcoded pixel offsets
  between independently-styled sticky elements — the header/thead overlap
  bug (fixed by making the outer `<header>` non-sticky and letting `thead th`
  stick to `top: 0` on its own) came from exactly that: guessing a magic
  `top: 3.2rem` offset for one sticky element to clear another sticky
  element above it. If you add more chrome above the table, prefer a single
  sticky element or a wrapping scroll container over stacking two stickies
  with hand-measured offsets.

## Extension ideas and where they'd slot in

- **Status/notes sidecar JSON** — e.g. `contact-sheet.json` next to each source
  dir with `{ "filename.png": "flagged, redo background" }`. Would slot into
  `scanDir` (read the sidecar once per column) and `renderItem` (append a
  `.note` div). Keep it optional/absent-safe: no sidecar, no behavior change.
- **Diff-slider cell mode** (`--diff colA,colB`) — an overlay slider between
  two specific columns instead of (or alongside) the plain grid. Would need
  a second cell-rendering path since it's fundamentally a 2-image compare,
  not an N-column stack; probably a `--diff` flag that reduces the columns
  used in that mode to exactly two and swaps `renderCell` for a slider
  variant (still zero-JS-framework: a single `<input type="range">` driving
  a CSS `clip-path`, or a drag handle with ~15 lines of inline JS).
- **Recursive column directories** — currently `scanDir` is deliberately
  flat (one dir = one column of files sitting directly inside it). If
  someone wants nested batches, that's a `--recursive` flag, and it changes
  what "column" means (probably: recurse and use the sub-path as part of the
  row key, not just the basename) — non-trivial, don't bolt it on without
  redesigning the row-key shape first.

## The `pages` mode (review sheets)

Built for review rounds over an ordered selection, where the reviewer answers
in numbers (“drop 009 and 019”). Its inputs are the photo tools’ shared JSONL
manifest (`photo-face-find`, `photo-date-fix`, `near-dupe-pick`; schema in
`~/sw/github-public/photo-face-find/CONTRACT.md`), a plain list file, or a
directory. `main()` hands off to `pagesMain()` when `argv[2] === 'pages'`,
and otherwise to `gridMain()`, the 1.2.0 grid unchanged. Its sheets,
stdout, error messages and exit codes have not changed: the commit that
added `pages` and the one that put it on the contract each checked that
against the commit before with a before/after harness. Only the grid’s
`--help` text grew, since the shared header documents both modes.

Shape, top to bottom in the file:
1. **Readers** turn an input into items: `itemsFromManifest`,
   `itemsFromList`, `itemsFromDir`. Pure apart from `scanDir`. Video rows
   (CONTRACT.md) never become tiles from their `paths`: a `kind: "range"` row
   is skipped and counted; a `kind: "frame"` row shows its `group.copy` still
   (resolved from the manifest’s folder) or is skipped and counted.
2. **`planPages(items, { perPage, sort, keepers })`** is the core, and the place to change
   any rule: order (`--sort date` by each item’s `sortDate` — `date.iso`, else a
   dated label — undated last in input order; otherwise by `seq` only when
   *every* item has one, so a partly numbered manifest can’t produce two 009s;
   otherwise input order — manifests are unordered sets per CONTRACT.md, so
   ordering is this viewer’s job), the `--keepers` filter (rows with
   `group.keeper === true` plus rows with no `group` block; the rest are
   counted in `dropped`), sections (first appearance),
   numbers (one running count across the whole sheet, so a number names one
   photo), pages (each section starts a new page; a page knows `from/to/total`
   in its section and `number/of` in the sheet).
3. **Two renderers draw the same plan**: `renderPagesHtml` (the default,
   zero-dependency) and `renderPagesPdf` (`--pdf`, ImageMagick). Never let
   either compute its own numbering or paging — that is how the HTML and the
   PDF would come to disagree about which photo is 009.

The “≈” rule (`isEstimated`): `date.estimated === true` is the contract’s
flag (photo-date-fix sets it on every estimate: hints, file dates, approved
clock corrections); `dateSrc` matching `^(file|estimated|undated|archival)` is
the rule of the hand-built sheets the mode was generalised from. “≈” shows
only beside a date.

HTML page geometry. Every size inside a page is in page inches, written
`calc(N * var(--in))`, where `--in` is `100cqw / <paper width in inches>`
and `<main>` is the inline-size container. So the page scales to the window
on screen and is exact on paper. `@page` sets the paper size with zero
margins (the page draws its own, and Chrome then prints no header or
footer); a page’s height is the paper height, and the headless-Chrome print
of a 3-section sample gave exactly 3 PDF pages, so no stray blank pages. The
masthead has a fixed height, so a titled and an untitled section give the
same tile size. Images load eagerly (no `loading="lazy"`), so a print never
catches a tile before it has loaded; that is what `--thumbs` is for on big
sheets. Print forces light colours and keeps the tile ground tone
(`print-color-adjust: exact`).

PDF (`renderPagesPdf`). One `magick` run per page: a white canvas, the
masthead, then each tile fitted onto a toned frame
(`-auto-orient -thumbnail WxH -extent WxH`) and composited at its grid
position, with its label annotated under it; then all page JPEGs join into
one PDF at 150 dpi, so the PDF page is the paper size. Details that bit:
`montage` ignores EXIF orientation without `-auto-orient`; `+size` after the
canvas, or the page size lingers as a setting; every text argument goes
through `imText()` (ImageMagick expands `%` escapes, backslashes and a
leading `@`, which reads a file); the font is the macOS Arial path, because
ImageMagick can’t resolve “Helvetica” by name, and a missing font file falls
back to ImageMagick’s default. `--pdf` checks for `magick` before anything is
written, and exits 3 with the remedy when it isn’t there.

Thumbnails (`--thumbs <dir>`). `sips` on macOS, else `magick`; 640 px long
edge; named `<stem>-<sha1 of the source path, 8 hex>.jpg`, so two
`IMG_0001.JPG` from different folders never collide; reused while newer than
the source; written to a temp name and renamed. `sips` keeps the EXIF
orientation tag and browsers honour it; `magick` bakes it in. A folder that
holds source images is refused as `--thumbs` (exit 2), so nothing is ever
written beside a source. The folders are compared by identity (device and
inode), since a symlink, another letter case on a case-insensitive volume,
or `/tmp` for `/private/tmp` all passed the name comparison 1.3.0 started
with.

## The contract, for `pages` only

`pages` is on `mjs-tool/2` (mjs-tool-skeleton 0.2.0; the procedure followed
is its `ADOPTING.md`). The grid mode is not, yet: a partial adoption, so a
conformance scan’s “conformant” covers `pages` alone. The runtime fence at
the bottom of the file is byte-identical to `skeleton/tool.mjs`, and a test
pins its sha256: never edit it; to move to a later contract, swap the whole
block.

How `pagesMain()` is built, top to bottom:

1. **Usage first** (exit 2, nothing written): flags, `--tiles`, `--page`,
   `--sort`, one input that exists, `--out` and `--pdf` not one file. Then
   the tools `--pdf` and `--thumbs` need (exit 3 when missing, before
   anything is read). Then the input is read; a file that cannot be read, or
   a manifest line that is not valid JSON or not an object, is a `fail` item,
   not a usage error. A `--thumbs` folder that holds sources is still a usage
   error.

2. **Items, in the order of the work:** a `skip` per manifest row not drawn
   (`itemsFromManifest`’s `skippedRows`: range, frame without a still, no
   image path) and per row `--keepers` leaves out (`planPages`’s `left`);
   a `warn` per tile with a missing file and, under `--go`, per failed
   thumbnail; then one item per output, in write order (thumbnails, HTML,
   PDF). No images at all is a `refuse` on the input, with every output a
   `skip` “not written”.

3. **`verdict(item)` is the single source of verdicts**, from facts
   (`error`, `refused`, `missing`, `thumbFailed`, `notDrawn`, `notWritten`,
   `upToDate`) and the item’s `kind` (`row`, `tile`, `output`, `input`). A
   kind and facts with no rule throw, so a new finding can never pass as
   `ok`. Item construction goes through `makeReportItem()`, which calls it.

4. **The dry run is a prediction, and `--go` its own write path.** The dry
   run checks every output location (`checkOutput()`) and predicts the
   thumbnails (`predictThumbs()`, by `makeThumbs()`’s own reuse rule).
   `--go` re-checks each output just before writing it, writes the HTML
   through a temp file and a rename (`writeAtomic()`), and draws the PDF to a
   temp name beside the target before renaming it. A refused output is left
   alone and the others are still written; after a write fails, the rest are
   “not attempted”. A test compares the dry run’s outputs and thumbnail
   counts with what `--go` did.

5. **Never replace what this tool did not write.** An existing `--out` is
   replaced only when its first 4 KiB hold `SHEET_MARK` (the generator meta
   tag `renderPagesHtml()` writes); an existing `--pdf` only when it starts
   `%PDF-` and its last 256 KiB hold `PDF_MARK` (the Creator that
   `renderPagesPdf()` sets with `-define pdf:Creator=…`, which ImageMagick
   stores as UTF-16BE hex). The same call sets `pdf:Title` to the target’s
   name, so the temp file’s name never reaches the PDF. A symlinked output is
   followed, so the link keeps pointing where it did.

6. **`nextAction()`** starts from the runtime’s `defaultNextAction()` (a
   failure stops; an override flag in the argv keeps the default’s `ask`).
   No images, or a refused output, is `ask` with no `argv`, because the
   remedy is another input or path, not `--go`; a clean dry run, or one with
   missing images, is `ask` with the dry run’s argv plus `--go`; an applied
   run is `done`, naming what it wrote and any missing images or failed
   thumbnails. `AUTO_RUN_COMMANDS` is empty: an unattended `--go` is Dan’s
   call to pre-approve, and he has not.

**The grid path and the fence’s crash handlers.** The fence’s entry guard
installs `uncaughtException` and `unhandledRejection` handlers that turn any
crash into one `error:` line and exit 3. `main()` removes both on the grid
path and rethrows anything that escapes `gridMain()` from a `setImmediate`,
then returns a promise that never settles, so the runtime cannot exit 0
before the rethrow lands (a mutation that drops it turns the grid-crash test
red). The grid therefore crashes as 1.2.0 did: Node’s stack trace, exit 1.
When the grid adopts the contract, this goes.

Exit codes for `pages`: 0 every item `ok` or `skip`; 1 a `warn`, `refuse` or
`fail`; 2 usage, nothing written; 3 a tool `--pdf` or `--thumbs` needs is
not on `PATH`, or an internal error. A `magick` failure while drawing the PDF
is a `fail` item at exit 1, no longer exit 3, since the report can describe
it. The grid mode keeps its historical codes (1 for most usage errors).

## Test strategy

`test/cli.test.mjs` does two things:
- **Unit tests** against the named exports (`escapeHtml`, `parseColumnArg`,
  `relHref`, `buildRows`, `sortRows`) for the matching/grouping logic —
  faster and more precise than scraping generated HTML with regex.
- **CLI/integration tests** via `execFileSync` (the `run()` helper) that
  build real temp directories with tiny 1x1 PNGs (encoder is inlined in the
  test file, adapted from `lineart-rich-black/test/cli.test.mjs`) and assert
  on the actual written HTML: relative paths, `Label=dir` headers, TIFF-as-
  link, missing-cell placeholders, exit codes, and the `--help` header-only
  print.

`contact-sheet-cli.mjs` only runs `main()` when invoked as the entry point:
the guard is the last statement of the runtime fence, and it resolves
symlinks on both sides, so an npm-linked bin still runs. That is what lets
the unit tests import the file without running the CLI.

If you add a new pure-logic branch (another matching rule, another sort
mode), add a unit test against the exported function first — it's much
cheaper to reason about than a CLI/HTML assertion.

The `pages` tests follow the same split. Units cover `parseTiles`,
`parsePaper`, `isEstimated`, the three readers, `planPages` (order,
sections, numbering, paging, the “≈” rule), `imText`, `thumbName` and
`renderPagesHtml`. CLI tests (`runPages()`, which uses `spawnSync` for exit
codes) cover a three-section manifest, `--tiles` paging, a directory, a list
file with relative paths, a missing file, usage errors, `--pdf` with
`magick` absent (an empty `PATH`) and present, and `--thumbs`. The `--pdf`
test skips when `magick` isn’t on `PATH`; the `--thumbs` test when neither
`sips` nor `magick` is. When 1.3.0 landed, 17 targeted mutations of the
`pages` branches each turned at least one test red. Since `pages` is a dry
run by default, every CLI test that needs a written sheet passes `--go`, and
the ones that read counts or findings read them from `--json` items.

`test/contract.test.mjs` covers the contract, black-box like the rest: the
fence’s sha256 against the skeleton’s; zero runtime dependencies; `--help`,
`-h`, `--version` and a symlinked entry (whose `next.argv` names the link);
the four modes from one item list; a dry run that writes nothing against a
`--go` that writes exactly what it previewed (thumbnail counts included);
obeying a dry run’s `next.argv` from `next.cwd`; each verdict as the only
finding, with its exit code and `next`; usage errors and a missing `magick`
with `--go` writing nothing; the overwrite guard for the HTML and the PDF;
refused output locations (a file or a folder in the way, a dangling
symlink, a folder that cannot be written); the `--thumbs` source-folder
guard through a symlink and a letter-case variant; an open, silent stdin; no
images; a failed thumbnail; a failed PDF write, through a stub `magick` on
`PATH`; the grid’s Node-native crash; and `verdict()` throwing on an item no
rule covers. When it landed, 15 of its 17 tests failed against the
pre-adoption file (the two that passed guard behaviour that file already
had: no dependencies, and the grid’s crash), and 14 targeted mutations of
the new code each turned at least one test red.

## Release steps

Bump `version` in `package.json`, make sure `npm test` is green, then
`npm publish`.

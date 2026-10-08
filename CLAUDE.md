# contact-sheet-cli — agent guide

Zero-dependency Node 20+ CLI: turns N directories into one self-contained
HTML contact sheet (columns = directories, rows = filename stems) for
eyeballing an image-processing batch. One file: `contact-sheet-cli.mjs`.

Since 1.3.0 it has a second mode, `contact-sheet-cli pages <input>`: an
ordered list of images as numbered, fixed-size printable review pages. See
“The `pages` mode” below; the two modes share only the small utilities
(`escapeHtml`, `relHref`, `scanDir`) and the entry guard.

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
directory. `main()` hands off to `pagesCli()` when `argv[2] === 'pages'`;
nothing else in the grid path changed, and its output is byte-identical to
1.2.0.

Shape, top to bottom in the file:
1. **Readers** turn an input into items: `itemsFromManifest`,
   `itemsFromList`, `itemsFromDir`. Pure apart from `scanDir`.
2. **`planPages(items, { perPage })`** is the core, and the place to change
   any rule: order (by `seq` only when *every* item has one, so a partly
   numbered manifest can’t produce two 009s), sections (first appearance),
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
written beside a source.

Exit codes for `pages` follow the mjs-tool-skeleton meanings: 0 written; 1
written but with findings (missing files, failed thumbnails), or no images;
2 usage, nothing written; 3 a needed tool is missing or failed. The grid mode
keeps its historical codes (1 for most usage errors).

**Not on the skeleton contract yet.** Neither mode has `--brief`, `--json` or
`--quiet`; that adoption is an open item, deliberately left out of 1.3.0. When
it happens, `pages` should report one item per tile (missing, thumbnail
failed) plus the written files, from the same plan.

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

`contact-sheet-cli.mjs` only runs `main()` when invoked as the entry point
(`import.meta.url === pathToFileURL(process.argv[1]).href` guard at the
bottom) — this is required for the unit-test imports to not immediately
execute the CLI and blow up on missing argv. Don't remove that guard.

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
`pages` branches each turned at least one test red.

## Release steps

Bump `version` in `package.json`, make sure `npm test` is green, then
`npm publish`.

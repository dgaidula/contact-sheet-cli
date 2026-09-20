# contact-sheet-cli — agent guide

Zero-dependency Node 20+ CLI: turns N directories into one self-contained
HTML contact sheet (columns = directories, rows = filename stems) for
eyeballing an image-processing batch. One file: `contact-sheet-cli.mjs`.

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

## Release steps

Bump `version` in `package.json`, make sure `npm test` is green, then
`npm publish`.

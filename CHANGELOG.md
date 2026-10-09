# Changelog

## 1.3.0 (2026-10-09)

### Added

- **`pages`:** numbered, paged, printable review sheets from a manifest
  (JSONL, one object per image; the README lists the fields it reads), a
  list file, or a folder. Optional `--pdf` through ImageMagick, `--thumbs`,
  `--sort date` and `--keepers`. See the README’s “Review pages”.

- **`pages` speaks the `mjs-tool/2` contract** of
  [mjs-tool-skeleton](https://github.com/dgaidula/mjs-tool-skeleton):
  `--brief`, `--json` and `--quiet` beside the default human output, all
  from one item list; a `next:` line of advice; `--version`; `-h`.

- **The grid answers `--version` and `-h`.** Both were documented in the
  help header, and both crashed with a Node stack trace and exit 1. Now
  `--version` prints `contact-sheet-cli <version>` and `-h` prints the
  help, each with exit 0. Every other command line behaves as before.

### Changed

- **Breaking, technically: a first argument of `pages` now selects the new
  mode.** In 1.2.0, `contact-sheet-cli pages orig/` built a grid with a
  `pages` column and an `orig` column (when a `pages` folder was there).
  In 1.3.0 it is a `pages` dry run over `orig/`, and writes nothing. To pass a column directory that is
  really called `pages` first, write it as `./pages` or `pages/`.

### Changed, for anyone who ran a pre-release build of `pages`

- **`pages` is a dry run unless `--go` is passed.** The same command line
  that used to write the sheet now reports what it would write, writes
  nothing, and exits 0 (or 1 with findings). Add `--go` to write.

- **Its stdout is the report.** The old lines (`6 image(s), 3 section(s), …`,
  `thumbnails: …`, `wrote …`) and the stderr notes (`missing: …`,
  `skipped … manifest row(s) …`, `left out … row(s) …`) are items now: one
  per manifest row not drawn, one per tile with a finding, one per output.

- **Exit codes:** `0` every item `ok` or `skip`; `1` a tile warned (a
  missing image, a failed thumbnail), an output was refused, or something
  failed; `2` usage error; `3` `magick` (for `--pdf`) or `sips`/`magick`
  (for `--thumbs`) not on `PATH`. Two moved: a manifest line that is not
  JSON was `2` and is now a `fail` item at `1`; a `magick` failure while
  drawing the PDF was `3` and is now a `fail` item at `1`, after the HTML is
  written. No images at all is still `1`.

- **`pages` writes `contact-pages.html` by default**, not
  `contact-sheet.html`. The grid’s quick start writes `contact-sheet.html`,
  and a `pages` run in the same folder used to refuse it as a file “this
  tool did not write”, when the grid had written it. The refusal now says
  what it means: the file is not a sheet `pages` wrote.

- **`--go` replaces only its own outputs.** An existing `--out` or `--pdf`
  that `pages` did not write is refused and left alone. Sheets now carry
  `<meta name="generator" content="contact-sheet-cli pages">`, and PDFs the
  Creator `contact-sheet-cli pages`; a sheet from a pre-release build has
  neither, so move it away once. Outputs are written to a temporary file and
  renamed into place. The temporary file has a random name and is created
  new, so it is never a file that was already there, and never a symlink.

- **`--thumbs` compares folders by identity.** A folder that holds source
  images was refused by name only, so a symlink to it, or its name in
  another letter case, got through and thumbnails were written beside the
  sources. It is refused now however it is named (still exit `2`), and so
  is the folder of a symlinked source’s real file, the folder of a video
  row’s video, and a `--thumbs` that names the same path as `--out` or
  `--pdf` (that one passed the dry run and was refused only under `--go`).

- **File names with `%` work with `--pdf` and `--thumbs`.** ImageMagick
  expands `%` escapes in file names: `photo%20one.png` broke `--pdf`,
  `a%d.png` silently drew `a0.png` in its place, and `--pdf r%d.pdf`
  failed and left a hidden temp file behind. Every file name is now passed
  to ImageMagick literally.

- **An SVG tile is a placeholder in the PDF** (“SVG — not drawn in PDF”).
  ImageMagick follows an SVG’s own references to other files, so an SVG
  could draw an image that is in no manifest into the PDF. The HTML still
  shows SVGs.

- **A manifest or list saved with a byte-order mark** reads like one without.
  The mark broke the first line.

### Unchanged

- The grid mode, apart from `--version` and `-h` (above): the same sheets
  and output as 1.2.0, and when it crashes, the same error messages and exit
  codes (the stack frames differ). It is not on the contract yet. Its
  `--help` text grew with the `pages` documentation.

## Earlier versions

This file starts at 1.3.0; the git history has the earlier ones.

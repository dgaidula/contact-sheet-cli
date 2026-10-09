# Changelog

## 1.3.0 (unreleased)

### Added

- **`pages`:** numbered, paged, printable review sheets from a manifest
  (the photo tools’ JSONL), a list file, or a folder. Optional `--pdf`
  through ImageMagick, `--thumbs`, `--sort date` and `--keepers`. See the
  README’s “Review pages”.

- **`pages` speaks the `mjs-tool/2` contract** of
  [mjs-tool-skeleton](https://github.com/dgaidula/mjs-tool-skeleton):
  `--brief`, `--json` and `--quiet` beside the default human output, all
  from one item list; a `next:` line of advice; `--version`; `-h`.

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

- **`--go` replaces only its own outputs.** An existing `--out` or `--pdf`
  that this tool did not write is refused and left alone. Sheets now carry
  `<meta name="generator" content="contact-sheet-cli pages">`, and PDFs the
  Creator `contact-sheet-cli pages`; a sheet from a pre-release build has
  neither, so move it away once. Outputs are written to a temporary name and
  renamed into place.

- **`--thumbs` compares folders by identity.** A folder that holds source
  images was refused by name only, so a symlink to it, or its name in
  another letter case, got through and thumbnails were written beside the
  sources. It is refused now however it is named (still exit `2`).

### Unchanged

- The grid mode: the same sheets, output, messages and exit codes as 1.2.0.
  It is not on the contract yet. Its `--help` text grew with the `pages`
  documentation.

## Earlier versions

This file starts at 1.3.0; the git history has the earlier ones.

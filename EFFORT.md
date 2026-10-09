# Effort log

One row per work-pass, appended as work happens, so future estimates rest on
what things actually cost. Agent metrics are exact only when they come from a
completion record; anything else is marked as an estimate. Git author is the
machine identity, not who did the work.

| date | agent / model | role | scope | duration | tokens | tool calls | outcome |
|---|---|---|---|---|---|---|---|
| 2026-10-08 | dgbuilder subagent, Claude Opus 5.5 (1M ctx) [xhigh] | builder | 1.3.0: `pages` review-sheet mode (manifest, list and directory readers; `planPages`; print-styled HTML; optional `--pdf` via ImageMagick; `--thumbs`), 26 tests, 17-mutation check, README and CLAUDE.md | about 25 min wall clock (estimate: 02:26–02:43 measured from the first scratch file, plus reading beforehand) | not available to the agent; see the orchestrator’s completion record | about 50 (the agent’s own count, not a record) | success |
| 2026-10-09 | dgbuilder subagent, Claude Opus 5.5 (1M ctx) [xhigh] | builder | `pages` adopts the mjs-tool/2 contract: runtime fence pasted unedited (sha256 pinned), `--brief`/`--json`/`--quiet`, dry run unless `--go`, one item per row not drawn, per tile finding and per output, `next` policy, overwrite guard (generator tag, PDF Creator), output-location checks, atomic writes, `--thumbs` source guard by identity; grid left byte-identical with its crash path kept Node-native; 10 tests ported, 17 contract tests (15 red on the old file), 14 mutations all red; README, CLAUDE.md, new CHANGELOG | about 45 min wall clock (estimate: first scratch file 01:10, reading from about 01:00, commit about 01:45) | not available to the agent; see the orchestrator’s completion record | about 100 (the agent’s own count, not a record) | success |

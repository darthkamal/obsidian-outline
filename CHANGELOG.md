# Changelog

All notable changes to this project will be documented in this file.

## [1.9.0] – 2026-08-14

### Added

- **Directory → collection sync** – map a top-level vault folder to its own
  dedicated Outline collection (found by name, or created automatically),
  then sync just that folder, or every mapped folder at once, without a
  repeated collection-picker prompt. New commands: "Map this directory to an
  Outline collection", "Sync to Outline" (per mapped folder), "Sync all
  mapped directories to Outline". Managed from a new settings-tab section.
- **Sync log** – every mapped-directory sync run appends one entry (success
  or failure, with per-file detail on failure) to a JSON log at
  `.obsidian/plugins/obsidian-outline-sync/sync-log.json`, capped at the
  most recent 200 entries.

### Fixed

Substantial reliability work on self-hosted Outline instances, most found
against a real 700+ note vault push (full write-up in
`migration/findings.md`):

- Document create/update now retries on 5xx and network exceptions, not
  just HTTP 429 (previously only rate limits were retried).
- `skipUnchanged` now checks the target collection, not just the content
  hash — mapping an already-pushed folder to a new collection no longer
  silently skips every unchanged note while reporting success.
- A skipped note that also parents other documents is re-verified before
  being trusted, so a document deleted in Outline no longer strands its
  children on a dead id.
- Failed cross-reference (`[[wiki-link]]`) resolution is now retried
  instead of leaving a note permanently marked "synced" with literal
  `%%WIKILINK[...]%%` text live in Outline, and is now correctly counted
  in the run's failure total.
- Per-upload timeout on both transports, so a stalled attachment fails
  fast with a clear message instead of hanging indefinitely.
- `getDocument` now distinguishes "confirmed gone" (404) from "couldn't
  check" (any other failure), so a transient error no longer risks
  recreating or duplicating a document that's still there.
- Concurrent syncs of the same mapped directory (a double-click, or two
  trigger points firing close together) no longer race and create
  duplicate folder placeholders — confirmed against a live vault.
- The JSON sync log's own writes are now serialized, so two syncs
  finishing close together can no longer silently drop one entry.
- A mapped folder's context menu no longer shows both the ad-hoc "Push
  folder to Outline" and "Sync to Outline" side by side — the ad-hoc
  option, which silently targets the default collection, is hidden once a
  folder is mapped, so it can't be clicked by habit and push into the
  wrong collection.
- The collection's live document count (`total` in a sync summary) now
  correctly accounts for folder-placeholder documents, which were
  previously uncounted.
- Corrected stale command names in this README (no functional change).

## [1.8.0] – 2026-03-16

### Added / Changed – Major refactor by [@matthias-feddersen](https://github.com/matthias-feddersen)

A huge thank you to **Matthias Feddersen** for his substantial contribution to this release.
He refactored large parts of the codebase and added significant new capabilities:

- Modular pipeline architecture for Markdown transformers
- Improved callout conversion (info, warning, success, tip)
- Optional table-of-contents removal (plugin setting + `REMOVE_TOC` CLI env var)
- CLI runner (`npm run sync`) to push folders without Obsidian
- Auto-generated, fully typed Outline API client via Orval + OpenAPI spec
- Adapter pattern separating Obsidian and Node.js environments
- Comprehensive test suite (Jest) covering pipeline, callouts, frontmatter, images, TOC, wiki-links, document tree, folder sync
- Fix: internal wiki-links resolved correctly
- Fix: empty pages no longer disrupt folder/document tree structure
- Improved sync progress display and logging
- Prettier formatting setup

## [1.7.0] – 2026-03-?

- i18n: All UI strings switched to English

## [1.6.0] – 2026-03-?

- fix: Image upload fully repaired

## [1.5.1] – 2026-03-?

- fix: Two-step image upload – documentId known before upload

## [1.5.0] – 2026-03-?

- security: Audit corrections (all 8 points addressed)

## [1.4.0] – 2026-03-?

- feat: Nested folder structure via `parentDocumentId`

## [1.3.1] – 2026-03-?

- fix: Conflict modal also triggered when `outline_id` is already known

## [1.3.0] – 2026-03-?

- feat: Conflict modal with overwrite / duplicate-suffix option

## [1.2.0] – 2026-03-?

- feat: Duplicate handling via `documents.search`

## [1.1.1] – 2026-03-?

- fix: `validateConfig` no longer checks `targetCollectionId`

## [1.1.0] – 2026-03-?

- feat: Collection-Picker modal + collections cached on startup

## [1.0.0] – 2026-02-20

- Initial release: full plugin foundation implemented

# Project Markdown Documents

## Purpose

The Studio **Documents** section is a read-only browser for Markdown already
owned by a source project. It lets a Workspace keep implementation guides,
requirements, architecture notes, and repository READMEs close to the runtime
Canvas without copying them into Vistrea storage.

Project Documents and the Deep Wiki have different authority:

- Project Documents remain ordinary files owned and versioned by the source
  repository.
- The Deep Wiki remains Vistrea's linked, revisioned runtime knowledge graph in
  SQLite, Objects, Commits, and Refs.
- Browsing a file never imports, revises, publishes, or synchronizes it.
- A later explicit import or link workflow must preserve this distinction.

## Project configuration

A project may commit `vistrea.project.json` at its repository root:

```json
{
  "format_version": 1,
  "documents": [
    { "name": "Project", "path": "README.md" },
    { "name": "Documentation", "path": "docs" }
  ]
}
```

Each `documents` entry has:

- `name`: the source label shown in Studio;
- `path`: one file or directory relative to the project root.

Directories are searched recursively for `.md` and `.markdown` files. Source
order in the JSON controls the browser grouping order; paths within each source
are sorted. Paths are deliberately not globs in format version 1.

Without this file, Studio uses `README.md` and `docs/` when present. The
**Create Config** action writes the starter configuration only when no config
file exists; it never overwrites project content. **Open Config** uses the
system editor so the project retains normal source-control ownership.

## Workspace association

The user chooses a project folder from the Documents section. Studio remembers
that local absolute folder per Workspace in application preferences. The
portable document-root declaration stays in `vistrea.project.json`; machine
paths do not enter Workspace metadata, Hub data, command arguments, or project
configuration.

Moving a Workspace or opening it on another machine may require choosing the
local project checkout once. This does not affect offline runtime data.

## Browser behavior

The Documents section is available even when a Workspace has no Snapshots. It
provides:

- project-folder choose, change, reveal, and disconnect actions;
- filename, relative-path, and source-name filtering;
- rendered Markdown with selectable text and links;
- a source-text toggle;
- explicit configuration and read warnings.

The browser is read-only. Editing remains the responsibility of the user's
normal project editor.

## Safety and bounds

- Configured paths must be relative and remain inside the chosen project root.
- Symbolic-link entries are not traversed.
- Hidden directories, packages, `.git`, `.build`, `.vistrea`, `build`,
  `DerivedData`, and `node_modules` are skipped while scanning.
- One catalog is limited to 5,000 documents.
- One document is limited to 2 MiB and must be valid UTF-8.
- SwiftUI receives immutable summaries and content from
  `StudioProjectDocumentLibrary`; views do not construct Vistrea artifact paths
  or access SQLite.

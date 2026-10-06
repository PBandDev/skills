# The MCP Server and the Running App

You work on a vault from outside Tolaria, in your own harness. This file covers the two things on the other side: Tolaria's MCP server, when your harness has it, and the app the user has open. The tool-per-job table lives in `SKILL.md`; this file holds the detail behind it.

## The MCP server

The server is optional. It adds vault search, guarded writes, and a way to bring a note up in the app. Everything else works with file tools alone. A user who wants it registers it from Tolaria's AI settings (<https://tolaria.md/concepts/ai>).

It exposes tools only: `list_vaults`, `get_vault_context`, `search_notes`, `get_note`, `create_note`, `update_note`, `append_to_note`, `open_note`, `refresh_vault`, `highlight_editor`, `attach_vault`, `clone_vault`. Your harness may show them under a prefix.

**`search_notes(query, limit)`**

- Matches the whole query as one case-insensitive substring. `billing rewrite` finds only that exact phrase, so search one distinctive word or phrase at a time.
- Searches the raw file, frontmatter included, so `type: Project` or `"[[q3-goals]]"` are valid queries.
- Results are unranked and stop at `limit` (default 10) in folder-walk order. Raise `limit` when a miss would matter, such as a duplicate check.
- Covers `.md` files only, archived notes included. It has no type or property filter.
- With several vaults active, the first vault can fill the limit before later vaults are searched.

**`get_note(path)`**

- Needs the exact path with extension. It does not look up titles.
- Reads any text file in the vault, so it also reads `views/*.yml`.
- Returns `frontmatter` (keys as written on disk), `content` (the body), and `mtimeMs`.
- The frontmatter values are parsed, not raw: `due: 2026-11-15` comes back as `2026-11-15T00:00:00.000Z`. When you rebuild a note for `update_note`, write each value back in the form the file had: `due: 2026-11-15`, wikilinks quoted. With file tools available, read the raw file instead.

**`create_note(path, content)`**

- Accepts `.md` paths only and creates missing folders.
- Writes `content` exactly as given, so it also creates sheet notes.
- Fails with `EEXIST` when the file exists. Treat that as "found a duplicate" and read the existing note.
- Refreshes the app and opens the new note as a tab by itself.

**`update_note(path, content, expectedMtime)`**

- Replaces the whole file. Send frontmatter and body together.
- With `expectedMtime` from `get_note`, a concurrent edit fails the write with "Note was modified since read". Re-read, re-apply your change, retry.
- Works on any existing file in the vault, so it can edit an existing `views/*.yml`.
- Refreshes the app without opening a tab. Follow with `open_note`.

**`append_to_note(path, content)`**

- Writes your text straight onto the end of the file with no separator. Start `content` with a blank line.
- Keep it for prose notes. On a sheet note the text becomes CSV rows.

**`open_note`, `refresh_vault`, `highlight_editor`**

- They act on the running app, and report success even when the app is closed. A success message is not proof the user saw anything.
- `highlight_editor` pulses an area (`editor`, `tab`, `properties`, `notelist`) for under a second, to draw the eye to what you changed.

**`get_vault_context`**

- `types` lists type values found on notes in use. A type definition with no notes yet is missing from it, so also read the `type: Type` notes.
- `agentInstructions.content` is the vault's `AGENTS.md`.
- `recentNotes` holds the 20 most recently changed notes.
- With several vaults active the result is `{ "vaults": [...] }`, one entry per vault.

**`attach_vault(path, label)`** registers an existing folder as a vault. It does not run `git init` and does not switch the active vault. The vault lists under its folder name, whatever `label` says.

**`vaultPath`** must equal an active vault root character for character. Copy it from `list_vaults`. Pass it whenever more than one vault is active. On Windows the root may carry a `\\?\` prefix (a vault added with `attach_vault` has none): keep it as listed for `vaultPath`, and drop it for file tools.

**Jobs MCP has no tool for:** delete, rename or move, archive, mark organized, favorite, create a non-Markdown file (a new view, an `.html` report, an attachment), list notes by type or property, read backlinks, git. Use file tools for these.

The read and write tools work with the app closed. They resolve vaults from the app's saved vault list.

## The running app

- **You cannot see it.** You do not know which note the user has open; when "this note" is unclear, ask. You do not see how a note renders; `SKILL.md` covers asking the user to check.
- **It watches the vault.** It picks up a file change within about a second and reloads lists and views. An open note with unsaved edits is left alone. `refresh_vault` is a fallback for a change the user says did not appear.
- **AutoGit.** A user can turn on automatic commits. It is off by default and invisible from inside the vault. When on, it stages every change 30 to 90 seconds after the last one and pushes if a remote exists. So leave every file valid after each write, and finish a multi-file change in one go.
- **Renames.** The app rewrites wikilinks only for renames done in its own UI. In a git vault it may later offer the user a link fix for a file renamed on disk; fix the links yourself anyway, as `SKILL.md` describes.
- **Delete is permanent.** There is no trash. Only git history can bring a file back.
- **`AGENTS.md` belongs to the user once edited.** Tolaria replaces it only when it is missing, empty, or still an untouched old template. Vault-level preferences added to it are safe.

## Deep links

`tolaria://<vault-slug>/<relative-path-with-extension>` opens a file in the app. The slug is the vault's label in lower case with non-alphanumerics as `-`; each path segment is URL-encoded. A link opens existing files only.

Give the user a deep link when you have no `open_note` and they want to jump to a note, and use one for links placed outside the vault, such as in an email or an HTML report. Inside notes, use wikilinks.

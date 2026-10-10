---
name: lanraragi
description: Use when a request names LANraragi or LRR, or reads, searches, tags, uploads, or organizes archives on a LANraragi server.
---

# LANraragi

LANraragi (LRR) is a self-hosted server for manga and doujinshi archives. Clients use its HTTP JSON API under `<server>/api/`. Written for LANraragi 0.9.81. The server publishes the spec of its own API, the **live spec**; this skill covers connecting, finding endpoints in that spec, and the behavior the spec leaves out.

## Connect

Once per session, before the first request.

1. **Read preferences.** Open `preferences.local.md` in this skill's folder, beside this `SKILL.md`. It holds the server URL, where the API key lives, and the user's rules. The file is gitignored, so Grep, ripgrep, and `git ls-files` hide it; read it by path. When it is missing or has no URL, ask the user for the URL and the key, then offer to save them (see Preferences).
2. **Probe the server.** `GET <server>/api/info`. Note `version`, `has_password`, `nofun_mode`, `archives_per_page`, and `server_tracks_progress`. A `401` here means No-Fun Mode: every call needs the key.
3. **Check the key.** With `has_password: false`, every endpoint is open and the key is optional. Otherwise send the key to `GET <server>/api/shinobu`: `200` means it works, `401` means the key or its encoding is wrong. Without a key, the open endpoints still work outside No-Fun Mode; ask for the key when the task needs a 🔑 endpoint.

Done when you know the server version and which endpoints you can call: all, or only the open ones.

`<server>` is the scheme, host, and port, plus the path prefix when the server runs under one (`base_url_path` in `lrr.conf`), e.g. `http://192.168.1.10:3000` or `https://example.com/lanraragi`. The default port is 3000. Write it without a trailing `/` or `/api`.

## Authenticate

Send `Authorization: Bearer <base64 of the key>` on every call when you have a key. Encode the exact key as one line: `printf %s "$KEY" | base64 | tr -d '\n'`, or in PowerShell `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($key))`. `echo` adds a newline to the key, and `base64` wraps long output; either gets `401`. An empty key never authenticates.

Load the key from where `preferences.local.md` says it lives, and keep it out of your replies and command output.

## Find an endpoint

The live spec is the reference for paths, parameters, body formats, and response shapes. The online docs render LRR's development branch and can list endpoints the user's server lacks; trust the server.

- **Look up before first use.** `OPTIONS <server>/api/<path>` returns that path's operations in a few KB. Put a real ID in each path slot: `OPTIONS <server>/api/archives/<id>/metadata`.
- **Survey.** `GET <server>/api.json` returns the whole spec (about 160 KB). Save it to a file and extract each path's methods and `summary`; keep the full file out of context. Its paths are relative to `<server>/api`. An operation with a non-empty `security` list needs the key; the 🔑 in summaries misses a few.

Where to start:

| Job | Start with |
| --- | --- |
| Find archives | `GET /api/search`; `/api/search/random` for a sample |
| Archives with no tags | `GET /api/archives/untagged` |
| One archive's metadata | `GET /api/archives/<id>/metadata` |
| Edit title, tags, summary | `PUT /api/archives/<id>/metadata` (see Write safely) |
| Page images | `GET /api/archives/<id>/files`, then each URL in `pages` |
| Cover or page thumbnail | `GET /api/archives/<id>/thumbnail` |
| The archive file itself | `GET /api/archives/<id>/download` |
| Add a local file | `PUT /api/archives/upload` |
| Have the server fetch a URL | `POST /api/download_url` |
| The library's tag vocabulary | `GET /api/database/stats` |
| Categories, tankoubons | `/api/categories`, `/api/tankoubons` |
| Run a plugin | `GET /api/plugins/<type>`, then `POST /api/plugins/use` or `/api/plugins/queue` |
| Background job status | `GET /api/minion/<job>` |
| Backup | `GET /api/database/backup` |

## Requests and responses

- Most writes take query parameters or form fields, not JSON. Read the body format from `OPTIONS` before sending.
- URL-encode every parameter value. Search filters and tags carry `,`, `"`, `$`, `*`, and spaces: with curl, use `-G --data-urlencode 'tags=...'` in single quotes so the shell leaves `$` and `*` alone. `-G` sends a GET; add `-X PUT` (or the write's method) to send query parameters on a write.
- An operation replies with `success` (`1` or `0`) and, on failure, `error`. Bad parameters and auth failures reply with an `errors` list instead.

| Status | Meaning | Do |
| --- | --- | --- |
| `400` | The operation failed (`error`) or a parameter is invalid (`errors`) | Fix the request |
| `401` | Key missing, wrong, or badly encoded | Recheck Authenticate |
| `423` | Another write holds that resource's lock | Wait a few seconds, then retry |
| `204` from search | The search index is still warming up | Retry shortly |
| `202` with `job` | Work queued in the background | Poll the job |

- **Jobs.** Thumbnail generation, queued plugin runs, URL downloads, and queued backups run as background (Minion) jobs and return a `job` number. Poll `GET /api/minion/<job>` until `state` is `finished` or `failed`; `error` says why it failed. The job's output, such as a queued plugin's tags, is in `result` from `GET /api/minion/<job>/detail` (🔑).
- **Big replies.** `GET /api/archives` lists the whole library, and `GET /api/plugins/all` embeds base64 icons. Save such replies to a file and extract the fields you need. To walk the library, page through `/api/search` instead.

## Library model

- **IDs.** An archive ID is 40 lowercase hex characters. A tankoubon ID is `TANK_` plus 10 digits; a category ID is `SET_` plus 10 digits.
- **Tags** are one comma-separated string: `artist:wada rco, parody:fate grand order, full color`. Each tag is `namespace:value` or a bare value. Learn the namespaces this library uses from `/api/database/stats` before adding a new one. Metadata plugins use a `source:` tag (the gallery URL) to find an archive's metadata exactly.
- **Search** (`filter`): terms separated by commas, mixing tags and title words. `"..."` is an exact phrase; `?` or `_` matches one character; `*` or `%` matches any run; `-term` excludes; `tag$` matches that tag exactly instead of every tag starting with it; `pages:>20` and `read:<=30` compare page counts. `category=<id>` limits the search to a category.
- **Paging.** `/api/search` returns the `archives_per_page` matches from offset `start`, with `recordsFiltered` (matches) and `recordsTotal`. The search index can keep entries for archives that are gone; the server drops them from `data`, so a page can hold fewer items and the counts run high. Advance `start` by `archives_per_page` and stop once `start` reaches `recordsFiltered`; fewer rows than `recordsFiltered` is then the complete result. `start=-1` returns every match in one reply. `/api/search/ids` keeps the stale IDs, which fail on `/api/archives/...` calls.
- **Tankoubons** group archives in the database only; the files stay as they are. Search groups by default: a tankoubon's `TANK_` entry replaces its archives. Pass `groupby_tanks=false` when you need archive IDs for `/api/archives/...` calls.
- **Categories** are static (a list of archive IDs, changed with `PUT` or `DELETE /api/categories/<id>/<archive>`) or dynamic (a saved search in `search`; membership follows it). Bookmarks are one static category.
- **Page URLs** from `/files` are paths from the host root that already include any prefix, with the image path escaped. Resolve each against `<server>/` with standard URL resolution, as a browser follows a link; joining strings by hand doubles the prefix or re-escapes the path.

## Write safely

- **Metadata writes are read-merge-write.** `PUT /api/archives/<id>/metadata` changes only the fields you send, and `tags` replaces the whole tag string. To add or remove tags, read the current `tags`, split on commas, trim each tag, edit that list, drop duplicates (ignoring case), and send the full list joined with `, `. A call with only `summary` fails; send `title` or `tags` with it.
- **API plugin runs save nothing.** `/api/plugins/use` and `/api/plugins/queue` return the plugin's `new_tags` (and sometimes `title` and `summary`) in `data`. Merge them into the archive with a metadata write. Plugins that query remote sites can get the user temporarily banned when run over many archives; agree on the batch size and pace with the user first.
- **Bulk edits.** Show the user the planned change on a sample and get a go-ahead. Save `GET /api/database/backup` to a file, apply the change, then re-read a few archives to confirm it landed.
- **Confirm before every destructive call.** `DELETE /api/archives/<id>` deletes the file from disk. `POST /api/database/drop` wipes the database. `POST /api/database/clean` removes entries whose files are gone. `DELETE /api/database/isnew` clears every "new" flag. `DELETE` on a tankoubon or category loses its own metadata; the archives stay.
- **Uploads** send multipart `file`, plus optional `title`, `tags`, `summary`, `category_id`, and `file_checksum` (the file's SHA-1, which the server checks). `409` means the file is already in the library; its `id` is in the reply. `415` means an unsupported format. A reverse proxy's body-size limit can reject a large upload before LRR sees it.

## Preferences

`preferences.local.md` is read in Connect. Users create it by copying `preferences.example.md`. When the user gives you the server URL, the key's location, or a rule to remember, write it there, creating the file from `preferences.example.md` when missing. Store where the key lives (an environment variable or a file); store the key itself only when the user asks. The most specific wins: the user's request, then `preferences.local.md`, then this skill.

## Product questions

For installation, settings, plugins, and the web UI, read the docs at <https://sugoi.gitbook.io/lanraragi>.

# LANraragi Preferences (example)

Copy this file to `preferences.local.md` (gitignored) and keep only the lines you care about. Anything here overrides the skill's defaults. The agent also saves answers here when you ask it to remember them.

## Server

- URL: [http://localhost:3000 | https://example.com/lanraragi], with any path prefix and without `/api`
- API key: [environment variable LRR_API_KEY | path to a file holding it | the key itself, since this file is gitignored]
- Other servers: [label: URL, key location]

## Writes

- Ask before: [every write | bulk edits over N archives and anything destructive]
- Tag namespaces I use: [artist, group, parody, character, language, source]
- Tag style: [lowercase | as the source gives them]
- Metadata plugins to use: [plugin namespace, e.g. from `GET /api/plugins/metadata`]
- Default category for uploads and downloads: [category name or SET_ ID]

## Reading and files

- Save downloaded pages and archives to: [folder]
- Group tankoubons in search results: [no, give me archive IDs | yes]

## Hard rules

- e.g. never edit archives in the "Favorites" category; never run plugins that query remote sites

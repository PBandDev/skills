/**
 * The installed skill as a public artifact.
 *
 * Runtime tests prove the board's mechanics. This file proves that an agent can discover and
 * launch those mechanics without hidden build notes, a machine-specific path, or a command that
 * silently splits one board into two.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve, win32 } from 'node:path';
import test from 'node:test';

import { PARSER_BUG_THRESHOLD } from '../core/reconciliation.ts';
import { DEFAULT_PORT } from '../server/server.ts';

const SKILL_DIR = join(import.meta.dirname, '..');
const REPO_DIR = resolve(SKILL_DIR, '..', '..');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const POWERSHELL_COMMAND = ['Start', '-Process'].join('');
const GENERIC_POSIX_PATH = /(?<![A-Za-z0-9_./:}])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,}(?![A-Za-z0-9._/-])/g;
const SINGLE_POSIX_PATH = /(?<![A-Za-z0-9_./:<}])\/[A-Za-z0-9._-]+(?![A-Za-z0-9._/-])/g;
const NON_ASCII_POSIX_PATH = /(?<![-A-Za-z0-9_./:<>}])\/[^\x00-\x7F\s"'`<>]+(?:\/[^\s"'`<>]+)*/gu;
const UNQUOTED_WIDE_POSIX_PATH = /(?<![A-Za-z0-9_./:<}])\/[^\/\r\n"'`<>|]+(?:\/[^\/\r\n"'`<>|]+)+/gu;
const UNQUOTED_WIDE_WINDOWS_PATH = /(?<![\\\w])\\{1,2}[^\\\r\n"'`<>|]+(?:\\[^\\\r\n"'`<>|]+)+/gu;
const UNC_PATH = /(?<![\\\w])\\\\[A-Za-z0-9._$-]+\\[A-Za-z0-9._$-]+(?:\\[A-Za-z0-9._$-]+)*/g;
const ROOTED_WINDOWS_PATH = /(?<![\\\w])\\[A-Za-z0-9._$-]+(?:\\[A-Za-z0-9._$-]+)+(?![A-Za-z0-9._$\\-])/g;
const SINGLE_ROOTED_WINDOWS_PATH = /(?<![\\\w])\\[A-Za-z0-9._$-]+(?![A-Za-z0-9._$\\-])/g;
const ESCAPED_WINDOWS_PATH = /(?<![\\\w.])\\{2,}[A-Za-z0-9._$-]+\\+[A-Za-z0-9._$-]+(?:\\+[A-Za-z0-9._$-]+)*/g;
const ESCAPED_SINGLE_WINDOWS_PATH = /(?<![\\\w.])\\{2,}[A-Za-z0-9._$-]+(?![A-Za-z0-9._$\\-])/g;
const ALLOWED_EXACT_POSIX_PATHS = new Set([
  '/../server/server.ts',
  '/a',
  '/a#b#c/…',
  '/ab',
  '/b',
  '/bare',
  '/.git',
  '/.git/config',
  '/.scratch',
  '/corpus',
  '/domain-modeling',
  '/docs',
  '/elsewhere',
  '/events',
  '/fixtures',
  '/health',
  '/index.html',
  '/map.md',
  '/nope',
  '/other',
  '/package.json',
  '/pricing',
  '/r',
  '/records',
  '/reconcile',
  '/repo',
  '/repo-a',
  '/repo-b',
  '/roots',
  '/snapshot',
  '/spec.md',
  '/tracker-board-fake',
  '/ui',
  '/ui/..',
  '/x',
]);
const ALLOWED_SYNTHETIC_POSIX_PATHS = [
  /^\/(?:corpus|fixtures)\/\.scratch(?:\/[A-Za-z0-9._-]+)*$/,
  /^\/elsewhere\/\.git\/worktrees\/detached$/,
  /^\/r\/(?:\.scratch(?:\/[A-Za-z0-9._-]+)*|a|alpha\/map\.md|b|tracker)$/,
  /^\/repo\/\.scratch(?:\/[A-Za-z0-9._-]+)*$/,
  /^\/ui\/(?:assets\.ts|board\.css|board\.js|corrections\.(?:css|js)|digest\.(?:css|js)|domain\.(?:css|js)|index\.html|panels\.js|render\.js|transport\.js|view\.js)$/,
  /^\/ui\/(?:\.\.\/)+(?:core\/(?:index|types)\.ts)$/,
  /^\/ui\/board\.js\/(?:\.\.\/)+(?:core\/types\.ts)$/,
  /^\/x\/tickets\/issues\/a\.md$/,
] as const;

test('SKILL metadata names tracker-board and describes trigger conditions', () => {
  assert.ok(existsSync(SKILL_FILE), 'tracker-board has no SKILL.md, so the CLI cannot discover it');
  const markdown = readFileSync(SKILL_FILE, 'utf8');
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter !== null, 'SKILL.md has no leading YAML frontmatter');

  const fields = new Map(
    [...(frontmatter[1] ?? '').matchAll(/^([a-z][a-z0-9_-]*):\s*(.+)$/gm)].map((match) => [
      match[1] ?? '',
      unquote((match[2] ?? '').trim()),
    ]),
  );
  assert.deepEqual([...fields.keys()].sort(), ['description', 'name']);
  assert.equal(fields.get('name'), basename(SKILL_DIR));

  const description = fields.get('description') ?? '';
  assert.match(description, /^Use when\b/);
  assert.match(description, /(?:view|show|open|monitor).*(?:Markdown|issue tracker|\.scratch).*board/i);
  assert.ok(!/(?:starts?|launches?) (?:a|the) server|runs? Node/i.test(description), 'description summarizes the workflow instead of its triggers');
});

test('the launch contract states every invariant independently and forbids split boards', () => {
  const contract = section(skillMarkdown(), 'Launch contract');
  assert.match(contract, /surviv\w* the spawning shell exit/i);
  assert.match(contract, /singleton[^.\n]*fixed port|fixed-port singleton/i);
  assert.match(contract, /already serving[\s\S]*print[\s\S]*URL[\s\S]*(?:stop|exit)/i);
  assert.match(contract, /Roots? accrete|new repositor\w*[\s\S]*register[\s\S]*re-scan/i);
  assert.match(contract, /browser tab|SSE client/i);
  assert.match(contract, /(?:about|roughly|~)\s*15 minutes/i);
  assert.match(contract, /success[\s\S]*print[\s\S]*URL[\s\S]*nothing else/i);
  assert.match(contract, /refus\w* Root[\s\S]*(?:fail|error)/i);
  assert.match(contract, /structured JSON[\s\S]*requested\s+Root[\s\S]*canonical\s+Roots list[\s\S]*board-safety state/i);
  assert.match(contract, /generic HTTP success[\s\S]*(?:refusal|fail)/i);
  assert.match(contract, /Never start a second server[\s\S]*second port[\s\S]*split\w* the Roots list/i);
  assert.match(contract, /requests? another port[\s\S]*refuse/i);
});

test('PowerShell is one worked platform answer, not the launch contract', () => {
  const markdown = skillMarkdown();
  const contract = section(markdown, 'Launch contract');
  const example = section(markdown, 'Windows PowerShell worked example');
  assert.ok(!contract.includes(POWERSHELL_COMMAND), 'a Windows command was presented as a launch invariant');
  assert.ok(example.includes(POWERSHELL_COMMAND), 'the worked example does not start the detached process');
  assert.match(example, /one platform(?:'s|’s) answer/i);
  assert.match(example, /not (?:the|a) (?:universal|cross-platform) (?:command|answer)/i);
  assert.match(example, /param\([\s\S]*\$SkillMdPath[\s\S]*\)/i);
  assert.match(example, /Get-Item\s+-LiteralPath\s+\$SkillMdPath/i);
  assert.match(example, /\$skillDir\s*=\s*\$skillMd\.Directory\.FullName/i);
  assert.match(example, /Get-Command\s+node\s+-CommandType\s+Application/i);
  assert.match(example, /Get-Command\s+node[\s\S]{0,120}Select-Object\s+-First\s+1/i);
  assert.match(example, /realpathSync\(process\.argv\[1\]\)/i);
  assert.match(example, /server\\detach\.mjs/i);
  assert.match(example, /function\s+Quote-WindowsPath/i);
  assert.match(
    example,
    new RegExp(
      String.raw`\$detacherProcess\s*=\s*${POWERSHELL_COMMAND}[\s\S]*-FilePath\s+\$nodePath[\s\S]*RedirectStandardOutput\s+\$detacherOutPath[\s\S]*RedirectStandardError\s+\$detacherErrorPath[\s\S]*-WindowStyle\s+Hidden[\s\S]*-PassThru`,
      'i',
    ),
  );
  assert.match(example, /\$detacherProcess\.WaitForExit\(10000\)/i);
  assert.match(
    example,
    /if\s*\(-not\s+\[string\]::IsNullOrWhiteSpace\(\$detacherDetail\)\)[\s\S]{0,220}Console\]::Error\.Write\(\$detacherDetail\)[\s\S]{0,80}exit\s+1/i,
  );
  assert.match(example, /\[string\]\$candidate/);
  assert.match(example, /IsNullOrWhiteSpace\(\$candidate\)/);
  assert.match(example, /\$detacherDetail[\s\S]*Invoke-RestMethod/i);
  assert.match(example, /IsNullOrWhiteSpace\(\$detail\)/);
  assert.match(example, /\.git/);
  assert.match(example, /\.Parent/);
  assert.doesNotMatch(example, /\$rootPath\s*=\s*\(Get-Location\)\.Path/);
  assert.match(example, /Invoke-RestMethod/);
  assert.match(example, /health/i);
  assert.match(example, /\.roots/);
  assert.match(example, /\.clients/);
  assert.doesNotMatch(example, /\$clientBaseline/i);
  assert.match(example, /\$clientConnected\s*=\s*\[int\]\$clientHealth\.clients\s+-gt\s+0/i);
  assert.match(example, /Stop-Process[\s\S]*-Force/i);
  assert.match(example, /Console\]::Error\.WriteLine\(\$detail\)[\s\S]*exit 1/i);
  const configuredPort = example.match(/127\.0\.0\.1:(\d+)\//)?.[1];
  assert.equal(Number(configuredPort), DEFAULT_PORT, 'the worked example drifted from the runtime port');
});

test('preflight and watcher guidance fail plainly and calibrate rather than assume', () => {
  const markdown = skillMarkdown();
  assert.match(markdown, /Node 22\.18\+/);
  assert.match(markdown, /before[\s\S]{0,160}(?:import|load)[\s\S]{0,40}\.ts/i);
  assert.match(markdown, /tracker-board requires Node 22\.18 or newer\./);
  assert.match(markdown, /tracker-board requires Node 23\.6 or newer on the Node 23 release line\./);
  assert.match(markdown, /recursive[^.\n]*file watch/i);
  assert.match(markdown, /falls? back[\s\S]{0,80}poll/i);
  assert.match(markdown, /verify-then-fallback/i);
  assert.match(markdown, /250\s*ms[\s\S]{0,140}measured starting value/i);
  assert.match(markdown, /server\/launch\.mjs/);
  assert.match(markdown, /first launch[\s\S]{0,80}singleton handoff[\s\S]{0,100}48 KiB/i);
  assert.match(markdown, /refuse paths containing control characters/i);
  assert.match(markdown, /Root[\s\S]{0,80}existing directory/i);
  assert.match(markdown, /without writing[\s\S]{0,40}watched repositor/i);
  assert.match(markdown, /\.tracker-board[\s\S]{0,100}home\s+directory[\s\S]{0,60}platform/i);
  assert.match(markdown, /refuses state writes[\s\S]{0,60}inside\s+a watched Root/i);
});

test('the skill runs the changed-only reconciliation pass on every invocation and on demand', () => {
  const workflow = section(skillMarkdown(), 'Reconciliation pass');
  assert.match(workflow, /every (?:skill )?invocation/i);
  assert.match(workflow, /on demand/i);
  assert.match(workflow, /changed[^.\n]*files|content hash/i);
  assert.match(workflow, /steady[- ]state[\s\S]{0,100}(?:zero|no) AI/i);
  assert.match(workflow, /tools\/reconcile\.ts/);
  assert.match(workflow, /plan\s+--board/i);
  assert.match(workflow, /apply\s+--board[\s\S]{0,100}--input/i);
  assert.match(workflow, /64 candidates/i);
  assert.match(workflow, /nextCursor[\s\S]{0,180}--after/i);
  assert.match(workflow, /advanc\w*[\s\S]{0,160}parser bug/i);
  assert.match(workflow, /candidate[\s\S]{0,120}exact[\s\S]{0,80}source/i);
  assert.match(workflow, /do not\s+re-?open[\s\S]{0,100}(?:path|file)/i);
  for (const field of [
    'title',
    'criteria',
    'blockedBy',
    'externalBlocker',
    'rawStatus',
    'ticketType',
    'dialect',
  ]) {
    assert.match(workflow, new RegExp(`\\b${field}\\b`));
  }
  assert.match(workflow, /Extraction fields only/i);
  assert.match(workflow, /code[\s\S]{0,80}diff/i);
  assert.match(workflow, /Lane[\s\S]{0,100}(?:code|deriv)/i);
  assert.match(workflow, new RegExp(`\\b${String(PARSER_BUG_THRESHOLD)}\\b[\\s\\S]{0,180}parser bug`, 'i'));
  assert.match(workflow, /distinct files[\s\S]{0,100}(?:the\s+)?same\s+(?:parser\s+)?component/i);
  assert.match(workflow, /across pages and invocations/i);
  assert.match(workflow, /re-diffs?[\s\S]{0,120}evidence[\s\S]{0,100}current parser/i);
  assert.match(workflow, /unrelated[\s\S]{0,80}one-off[\s\S]{0,100}Override/i);
  assert.match(workflow, /identical retry[\s\S]{0,180}written:\s*false/i);
  assert.match(workflow, /newly promoted evidence[\s\S]{0,40}(?:is|causes) a write/i);
  assert.match(workflow, /hash-keyed\s+Override/i);
  assert.match(
    workflow,
    /expir[\s\S]{0,100}source content changes|source (?:content )?(?:changes|is edited)[\s\S]{0,100}expir/i,
  );
  assert.match(workflow, /rejected Overrides remain counted and surfaced/i);
  assert.match(workflow, /outside[\s\S]{0,80}watched Roots?/i);
  assert.match(workflow, /unpredictable private directory/i);
  assert.match(workflow, /0600[\s\S]{0,100}(?:ACL|Windows)/i);
  assert.match(workflow, /finally[\s\S]{0,160}delete/i);
  assert.match(workflow, /cleanup[\s\S]{0,100}secure erasure/i);
  assert.match(workflow, /incumbent board[\s\S]{0,180}synchronous/i);
  assert.match(workflow, /Root registration[\s\S]{0,160}(?:linearize|racing)/i);
  assert.match(workflow, /successful write[\s\S]{0,180}(?:refresh|fresh Snapshot|re-scan)/i);
  assert.match(
    workflow,
    /parser and (?:the )?AI agree[\s\S]{0,100}both wrong[\s\S]{0,140}fixtures?[\s\S]{0,80}backstop/i,
  );

  const readme = readFileSync(join(REPO_DIR, 'README.md'), 'utf8');
  assert.match(readme, /tracker-board[^\n]*changed-file reconciliation/i);
  const context = section(readFileSync(join(REPO_DIR, 'CONTEXT.md'), 'utf8'), 'tracker-board');
  assert.match(context, /Reconciliation[\s\S]{0,500}three\s+distinct\s+files/i);

  const tool = readFileSync(join(SKILL_DIR, 'tools', 'reconcile.ts'), 'utf8');
  const board = readFileSync(join(SKILL_DIR, 'watch', 'board.ts'), 'utf8');
  assert.doesNotMatch(tool, /\bwriteAnnotations\b|new URL\(['"]\/roots['"]/);
  assert.match(board, /\bwriteAnnotations\s*\(/);
});

test('the shipped tree contains no machine identity, credential, literal URL, or hidden build artifact', () => {
  const hierarchicalUri = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/i;
  const opaqueUriSchemes = [
    ['mail', 'to'].join(''),
    ['mag', 'net'].join(''),
    ['s', 'ms'].join(''),
    ['t', 'el'].join(''),
    ['u', 'rn'].join(''),
  ];
  const opaqueUri = new RegExp(
    `\\b(?:${opaqueUriSchemes.join('|')}):[^\\s"'\`<>]+`,
    'i',
  );
  const executableSuffix = new RegExp(['\\.e', 'xe(?=["\'`\\s]|$)'].join(''), 'i');
  const tildePath = new RegExp(['(?<![~\\w])~', '[\\\\/](?=[A-Za-z0-9._-])'].join(''));
  const drivePath = new RegExp(['(?<![\\w/-])[A-Za-z]:', '[\\\\/]'].join(''));
  const namedHome = new RegExp(['(?:/', 'Users', '/|/', 'home', '/)[A-Za-z0-9._-]+'].join(''));
  const systemRootPath = new RegExp(
    ['(?<![A-Za-z0-9_])/', '(?:tmp|var|private/var|srv|etc|opt|usr|mnt|Volumes)/'].join(''),
    'i',
  );
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const usernameLabels = [
    ['user', 'name'].join(''),
    ['user_', 'name'].join(''),
    ['user-', 'name'].join(''),
    ['log', 'in'].join(''),
  ];
  const quotedUsername = new RegExp(
    `["']?\\b(?:${usernameLabels.join('|')})\\b["']?\\s*[:=]\\s*(["'])[A-Za-z0-9][A-Za-z0-9._-]{1,63}\\1`,
    'im',
  );
  const bareUsernameRecord = new RegExp(
    `^\\s*(?:${usernameLabels.join('|')})\\s*[:=]\\s*` +
      `(?!string\\b|number\\b|boolean\\b|unknown\\b|never\\b|any\\b|object\\b|undefined\\b|null\\b)` +
      `[A-Za-z][A-Za-z0-9._-]{1,63}\\s*$`,
    'im',
  );
  const usernameRecordFile = /\\.(?:conf|ini|json|md|toml|txt|ya?ml)$/i;
  const privateKeyHeader = new RegExp(
    ['-----', 'BEGIN\\s+(?:[A-Z0-9]+\\s+)*PRIVATE\\s+KEY(?:\\s+BLOCK)?', '-----'].join(''),
    'i',
  );
  const serviceTokenPrefixes = [
    ['gh', 'p_'].join(''),
    ['gh', 'o_'].join(''),
    ['gh', 'u_'].join(''),
    ['gh', 's_'].join(''),
    ['gh', 'r_'].join(''),
    ['github_', 'pat_'].join(''),
    ['gl', 'pat-'].join(''),
    ['xo', 'xb-'].join(''),
    ['xo', 'xp-'].join(''),
    ['xo', 'xa-'].join(''),
    ['xo', 'xr-'].join(''),
    ['xo', 'xs-'].join(''),
    ['np', 'm_'].join(''),
    ['py', 'pi-'].join(''),
    ['h', 'f_'].join(''),
    ['sk_', 'live_'].join(''),
    ['sk_', 'test_'].join(''),
    ['rk_', 'live_'].join(''),
    ['rk_', 'test_'].join(''),
    ['s', 'k-'].join(''),
  ];
  const prefixedCredential = new RegExp(
    `\\b(?:${serviceTokenPrefixes.map(escapeRegex).join('|')})[A-Za-z0-9._~-]{20,}`,
    'i',
  );
  const cloudAccessId = new RegExp(`\\b(?:${[['AK', 'IA'].join(''), ['AS', 'IA'].join('')].join('|')})[A-Z0-9]{16}\\b`);
  const googleApiKey = new RegExp(`\\b${['AI', 'za'].join('')}[A-Za-z0-9_-]{30,}\\b`);
  const authorizationCredential = new RegExp(
    `\\b${['Author', 'ization'].join('')}\\s*:\\s*` +
      `(?:${[['Bear', 'er'].join(''), ['Bas', 'ic'].join('')].join('|')})\\s+[A-Za-z0-9._~+/-]{20,}={0,2}`,
    'i',
  );
  const jwtCredential = new RegExp(
    `\\b${['ey', 'J'].join('')}[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b`,
  );
  const hiddenArtifacts = [
    ['.scratch/', 'tracker-board'].join(''),
    ['orchestrat', 'ion-', 'handoff'].join(''),
    ['-raw', '.log'].join(''),
  ];

  // Prove every split spelling above still detects the values it keeps out of this very file.
  assert.ok(hierarchicalUri.test(['HtTpS', '://', 'example.invalid', '/', 'path'].join('')));
  assert.ok(hierarchicalUri.test(['ssh', '://', 'git', '@', 'example.invalid', '/', 'repo'].join('')));
  assert.ok(hierarchicalUri.test(['file', ':///', 'tmp', '/', 'private'].join('')));
  for (const scheme of opaqueUriSchemes) {
    assert.ok(opaqueUri.test([scheme, ':', 'opaque-identifier'].join('')), `opaque URI scheme ${scheme} is not detected`);
  }
  assert.ok(!hierarchicalUri.test(['node', ':', 'fs'].join('')));
  assert.ok(!opaqueUri.test(['data', ':', ','].join('')));
  assert.ok(drivePath.test(['C:', '\\', 'Users', '\\', 'name'].join('')));
  assert.ok(namedHome.test(['/', 'home', '/', 'name', '/', 'repo'].join('')));
  assert.ok(systemRootPath.test(['/', 'var', '/', 'lib', '/', 'private'].join('')));
  const privatePosixPaths = [
    ['', 'workspace', 'private', 'repo'].join('/'),
    ['', 'data', 'account', 'repo'].join('/'),
    ['', 'root', 'secret'].join('/'),
    ['', 'app', 'repo'].join('/'),
    ['', 'repo', 'private', 'account'].join('/'),
    ['', 'ui', 'private', 'account'].join('/'),
  ];
  for (const path of privatePosixPaths) {
    assert.deepEqual(concretePosixPaths(`local path: ${path}`), [path]);
  }
  const singlePosixPath = ['', 'secret'].join('/');
  assert.deepEqual(concretePosixPaths(['local path: ', singlePosixPath].join('')), [singlePosixPath]);
  const singleRootPosixPath = ['', 'root'].join('/');
  assert.deepEqual(concretePosixPaths(['local path: ', singleRootPosixPath].join('')), [singleRootPosixPath]);
  const uncPath = ['\\', '\\', 'server', '\\', 'share', '\\', 'private'].join('');
  const rootedWindowsPath = ['\\', 'Windows', '\\', 'Temp', '\\', 'private'].join('');
  const singleRootedWindowsPath = ['\\', 'secret'].join('');
  assert.deepEqual(concreteWindowsPaths(`local path: ${uncPath}`), [uncPath]);
  assert.deepEqual(concreteWindowsPaths(`local path: ${rootedWindowsPath}`), [rootedWindowsPath]);
  assert.deepEqual(concreteWindowsPaths(`local path: ${singleRootedWindowsPath}`), [singleRootedWindowsPath]);
  const escapedUncPath = JSON.stringify(uncPath).slice(1, -1);
  const escapedRootedPath = JSON.stringify(rootedWindowsPath).slice(1, -1);
  const escapedSingleRootedPath = JSON.stringify(singleRootedWindowsPath).slice(1, -1);
  assert.deepEqual(concreteWindowsPaths(`const value = '${escapedUncPath}'`), [escapedUncPath]);
  assert.deepEqual(concreteWindowsPaths(`const value = '${escapedRootedPath}'`), [escapedRootedPath]);
  assert.deepEqual(concreteWindowsPaths(`const value = '${escapedSingleRootedPath}'`), [escapedSingleRootedPath]);
  const spacedPosixPath = ['', 'Work Stuff', 'private'].join('/');
  const unicodePosixPath = ['', '秘密', 'private'].join('/');
  const mixedUnicodePosixPath = ['', 'Users', '名', 'private'].join('/');
  const terminalUnicodePosixPath = ['', 'workspace', '秘密'].join('/');
  const spacedWindowsPath = ['\\', 'Work Stuff', '\\', 'private'].join('');
  const terminalUnicodeWindowsPath = ['\\', 'workspace', '\\', '秘密'].join('');
  assert.deepEqual(wideAbsolutePaths(`const value = '${spacedPosixPath}'`), [spacedPosixPath]);
  assert.deepEqual(wideAbsolutePaths(`const value = '${unicodePosixPath}'`), [unicodePosixPath]);
  assert.deepEqual(wideAbsolutePaths(`stored under ${spacedPosixPath}`), [spacedPosixPath]);
  assert.deepEqual(wideAbsolutePaths(`copied from ${mixedUnicodePosixPath}`), [mixedUnicodePosixPath]);
  assert.deepEqual(wideAbsolutePaths(`copied from ${terminalUnicodePosixPath}`), [terminalUnicodePosixPath]);
  assert.deepEqual(wideAbsolutePaths(`const value = '${spacedWindowsPath}'`), [spacedWindowsPath]);
  assert.deepEqual(wideAbsolutePaths(`copied from ${terminalUnicodeWindowsPath}`), [terminalUnicodeWindowsPath]);
  assert.deepEqual(concreteWindowsPaths(['/','\\binnerHTML\\b','/'].join('')), []);
  assert.deepEqual(concreteWindowsPaths(['[','\\s\\S',']'].join('')), []);
  assert.deepEqual(concretePosixPaths(['local path: ', unicodePosixPath].join('')), [unicodePosixPath]);
  assert.deepEqual(concretePosixPaths("import value from '../core/value.ts'"), []);
  assert.deepEqual(concretePosixPaths("const route = '/ui/board.js'"), []);
  assert.deepEqual(concretePosixPaths("const synthetic = '/repo/.scratch/example'"), []);
  assert.ok(email.test(['person', '@', 'example', '.', 'com'].join('')));
  assert.ok(tildePath.test(['~', '/', 'private'].join('')));
  assert.ok(executableSuffix.test(['tool', '.', 'exe'].join('')));
  assert.ok(quotedUsername.test(['"', 'user', 'name', '"', ': ', '"', 'developer-account', '"'].join('')));
  assert.ok(bareUsernameRecord.test(['log', 'in', ' = ', 'developer-account'].join('')));
  assert.ok(!bareUsernameRecord.test(['user', 'name', ': string'].join('')));
  assert.ok(privateKeyHeader.test(['-----', 'BEGIN RSA ', 'PRIVATE KEY', '-----'].join('')));
  assert.ok(privateKeyHeader.test(['-----', 'BEGIN OPENSSH ', 'PRIVATE KEY', '-----'].join('')));
  for (const prefix of serviceTokenPrefixes) {
    assert.ok(prefixedCredential.test([prefix, 'A'.repeat(24)].join('')), `credential prefix ${prefix} is not detected`);
  }
  assert.ok(cloudAccessId.test([['AK', 'IA'].join(''), 'A'.repeat(16)].join('')));
  assert.ok(googleApiKey.test([['AI', 'za'].join(''), 'A'.repeat(35)].join('')));
  assert.ok(
    authorizationCredential.test(
      [['Author', 'ization'].join(''), ': ', ['Bear', 'er'].join(''), ' ', 'A'.repeat(24)].join(''),
    ),
  );
  assert.ok(!authorizationCredential.test([['Bas', 'ic'].join(''), ' authentication'].join('')));
  assert.ok(jwtCredential.test([['ey', 'J'].join(''), 'A'.repeat(12), '.', 'B'.repeat(12), '.', 'C'.repeat(12)].join('')));

  for (const file of filesUnder(SKILL_DIR)) {
    const text = readFileSync(file, 'utf8');
    const relative = file.slice(SKILL_DIR.length + 1);
    assert.ok(!hierarchicalUri.test(text), `${relative} contains a literal hierarchical URI`);
    assert.ok(!opaqueUri.test(text), `${relative} contains a literal opaque URI`);
    assert.ok(!drivePath.test(text), `${relative} contains a drive-rooted path`);
    assert.deepEqual(concreteWindowsPaths(text), [], `${relative} contains a rooted Windows path`);
    assert.ok(!namedHome.test(text), `${relative} contains a concrete home-directory path`);
    assert.ok(!systemRootPath.test(text), `${relative} contains a concrete system-rooted path`);
    assert.deepEqual(concretePosixPaths(text), [], `${relative} contains a concrete POSIX path`);
    assert.deepEqual(wideAbsolutePaths(text), [], `${relative} contains an absolute path with spaces or non-ASCII characters`);
    assert.ok(!email.test(text), `${relative} contains an email or email-shaped identity`);
    const hasUsername = quotedUsername.test(text) ||
      (usernameRecordFile.test(relative) && bareUsernameRecord.test(text));
    assert.ok(!hasUsername, `${relative} contains an explicit standalone username`);
    assert.ok(!tildePath.test(text), `${relative} contains a tilde path that fs will not expand`);
    assert.ok(!privateKeyHeader.test(text), `${relative} contains a private-key header`);
    assert.ok(!prefixedCredential.test(text), `${relative} contains a prefixed service credential`);
    assert.ok(!cloudAccessId.test(text), `${relative} contains a cloud access-key identifier`);
    assert.ok(!googleApiKey.test(text), `${relative} contains an API-key credential`);
    assert.ok(!authorizationCredential.test(text), `${relative} contains an authorization credential`);
    assert.ok(!jwtCredential.test(text), `${relative} contains a JWT-shaped credential`);
    const publicationSurface = `${relative.replaceAll('\\', '/')}\n${text}`;
    for (const marker of hiddenArtifacts) {
      assert.equal(hiddenArtifact(publicationSurface, [marker]), null, `${relative} contains hidden build artifact ${marker}`);
    }

    const withoutWindowsExample = relative === 'SKILL.md'
      ? text.replace(section(text, 'Windows PowerShell worked example'), '')
      : text;
    assert.ok(!withoutWindowsExample.includes(POWERSHELL_COMMAND), `${relative} assumes PowerShell outside its worked example`);
    assert.ok(!executableSuffix.test(withoutWindowsExample), `${relative} assumes an executable suffix`);
  }
});

test('shipped source explains durable rules without hidden build history', () => {
  const phrases = [
    ['adversarial', ' review'].join(''),
    ['orchestrat', 'ion'].join(''),
    ['this ', 'build'].join(''),
    ['.scratch/', 'tracker-board'].join(''),
    ['today', "'s ADR"].join(''),
    ['nothing else ', 'today'].join(''),
    ['editors on ', 'this platform'].join(''),
    ['an earlier ', 'version'].join(''),
    ['an earlier ', 'spelling'].join(''),
    ['found by ', 'attacking'].join(''),
    ['happened during ', 'design'].join(''),
    ['during ', 'design'].join(''),
    ['today', "'s view model"].join(''),
  ];
  const ticketPurpose = new RegExp(['\\bthis\\s+ticket', '(?:\\s|//\\s*)+exists\\s+to\\b'].join(''), 'i');
  const numberedTicket = new RegExp(['\\bticket', '(?:[ \\t]+|[ \\t]*[#:_-][ \\t]*)\\d+\\b'].join(''), 'gi');
  const numberedCriterion = /\b(?:acceptance\s+)?criteri(?:on|a)\s*(?:#|number\s*)?\d+\b/gi;
  const hiddenDecision = new RegExp(['\\bD(?:[0-9]+|-[a-z])\\b'].join(''));
  assert.ok(ticketPurpose.test(['this ticket', '\n// exists to'].join('')));
  const numericTicketSentinel = ['Ticket', ' 20'].join('');
  assert.deepEqual(hiddenNumericTicketReferences(numericTicketSentinel, numberedTicket), [numericTicketSentinel]);
  for (const numeric of [
    ['TICKET', ' 417'].join(''),
    ['ticket', ' #417'].join(''),
    ['ticket', '-417'].join(''),
  ]) {
    assert.deepEqual(hiddenNumericTicketReferences(numeric, numberedTicket), [numeric]);
  }
  const criterionSentinel = ['criterion', ' 2'].join('');
  assert.deepEqual(hiddenNumericTicketReferences(criterionSentinel, numberedCriterion), [criterionSentinel]);
  assert.ok(hiddenDecision.test(['D', '17'].join('')));
  for (const marker of [
    ['.scratch/', 'tracker-board'].join(''),
    ['orchestrat', 'ion-', 'handoff'].join(''),
    ['-raw', '.log'].join(''),
  ]) {
    assert.equal(hiddenArtifact(['folder/', marker].join(''), [marker]), marker);
  }
  const mixedCaseArtifact = ['-raw', '.log'].join('');
  assert.equal(hiddenArtifact(['folder/', '-RAW', '.LOG'].join(''), [mixedCaseArtifact]), mixedCaseArtifact);

  for (const file of filesUnder(SKILL_DIR).filter((path) => /\.(?:css|html|js|md|mjs|ts)$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    const relative = file.slice(SKILL_DIR.length + 1);
    const publicationSurface = `${relative.replaceAll('\\', '/')}\n${text}`;
    for (const phrase of phrases) {
      assert.ok(!publicationSurface.toLowerCase().includes(phrase), `${relative} cites hidden build history: ${phrase}`);
    }
    assert.ok(!ticketPurpose.test(publicationSurface), `${relative} explains itself through a hidden build ticket`);
    assert.deepEqual(
      hiddenNumericTicketReferences(publicationSurface, numberedTicket),
      [],
      `${relative} cites a hidden numeric build ticket`,
    );
    assert.deepEqual(
      hiddenNumericTicketReferences(publicationSurface, numberedCriterion),
      [],
      `${relative} cites a hidden numbered build criterion`,
    );
    assert.ok(!hiddenDecision.test(publicationSurface), `${relative} cites a hidden decision label`);
  }
});

test('runtime paths come from platform APIs and module-relative locations', () => {
  const state = shipped('state/store.ts');
  assert.match(state, /import\s*\{[^}]*homedir[^}]*\}\s*from\s*['"]node:os['"]/);
  assert.match(state, /join\(homedir\(\),\s*STATE_DIR_NAME\)/);

  const detacher = shipped('server/detach.mjs');
  assert.match(detacher, /detached:\s*true/);
  assert.match(detacher, /windowsHide:\s*true/);
  assert.match(detacher, /stdio:\s*\['ignore',\s*stdoutHandle,\s*stderrHandle\]/);

  const launcher = shipped('server/launch.mjs');
  assert.match(launcher, /createBoard:\s*\(\)\s*=>\s*watch\.createBoard\(\{\s*persist:\s*true\s*\}\)/);

  for (const relative of ['ui/assets.ts', 'test/corpus-tree.ts', 'tools/build-corpus-golden.ts']) {
    assert.match(shipped(relative), /import\.meta\.dirname/, `${relative} resolves from the caller's cwd`);
  }
  for (const file of filesUnder(SKILL_DIR).filter((path) => /\.(?:js|mjs|ts)$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    const relative = file.slice(SKILL_DIR.length + 1);
    if (text.includes('mkdtempSync(')) {
      assert.match(text, /tmpdir\(\)/, `${relative} creates temporary paths without os.tmpdir()`);
    }
    if (/^(?:core|scan|server|state|tools|ui|watch)[\\/]/.test(relative)) {
      assert.ok(!text.includes('process.cwd('), `${relative} resolves a shipped resource from cwd`);
    }
  }
});

test('repository docs, UI metadata, and fixture policy agree with the shipped skill', () => {
  const readme = readFileSync(join(REPO_DIR, 'README.md'), 'utf8');
  assert.match(readme, /^\| `tracker-board` \|[^\n]+\|$/m);

  const context = readFileSync(join(REPO_DIR, 'CONTEXT.md'), 'utf8');
  const tracker = section(context, 'tracker-board');
  assert.match(tracker, /A live board/i);
  assert.match(tracker, /"Read-only" means[\s\S]{0,160}never writes a watched repository/i);
  assert.match(tracker, /Roots?\s+(?:\*\*)?accrete/i);
  assert.match(tracker, /^### Operation\s*$/m);

  const metadata = shipped('agents/openai.yaml');
  assert.match(metadata, /^interface:\s*$/m);
  assert.match(metadata, /^\s+display_name:\s+"Tracker Board"\s*$/m);
  const short = metadata.match(/^\s+short_description:\s+"([^"]+)"\s*$/m)?.[1] ?? '';
  assert.ok(short.length >= 25 && short.length <= 64, `short_description is ${String(short.length)} characters`);
  assert.match(metadata, /^\s+default_prompt:\s+"[^"]*\$tracker-board[^"]*"\s*$/m);

  assert.equal(existsSync(join(REPO_DIR, '.gitattributes')), false, 'the settled repository-wide checkout policy changed');
  const fixtureReadme = shipped('test/fixtures/README.md');
  assert.match(fixtureReadme, /no repository-wide [`']?\.gitattributes/i);
  assert.match(fixtureReadme, /corpus reader[\s\S]{0,80}normali[sz]\w*/i);
  assert.match(fixtureReadme, /normali[sz]\w*[\s\S]{0,80}to LF/i);
  assert.match(fixtureReadme, /CRLF[\s\S]{0,100}(?:tested|asserted) separately/i);

  assert.match(shipped('test/fixtures/tickets/blockers-parenthetical.md'), /2026-07-24/);
  assert.match(shipped('test/fixtures/corpus/search-ranking/issues/10-name-the-launch-date.md'), /2026-07-24/);
  assert.match(shipped('test/fixtures/tickets/status-long-prose.md'), /2026-07-23/);
  const humanLaneLines = shipped('test/fixtures/tickets/human-lane-all-checked.md').split(/\r?\n/);
  assert.deepEqual(
    [
      humanLaneLines.find((line) => line.startsWith('- [x] Final acceptance review')),
      humanLaneLines.find((line) => line.startsWith('      Evidence: see Comments.')),
      humanLaneLines.find((line) => line.startsWith('Final pass')),
    ].map((line) => Buffer.byteLength(line ?? '', 'utf8')),
    [34, 29, 40],
    'fixture scrubbing changed the three load-bearing line shapes',
  );

  const zeroBuild = readFileSync(join(REPO_DIR, 'docs', 'adr', '0002-zero-dependency-zero-build.md'), 'utf8');
  assert.match(zeroBuild, /server\/launch\.mjs <absolute-root>/);
  assert.match(zeroBuild, /server\/detach\.mjs/);
  assert.match(zeroBuild, /Node 23\.6/);
  const platformLaunch = readFileSync(
    join(REPO_DIR, 'docs', 'adr', '0005-platform-agnostic-launch-contract.md'),
    'utf8',
  );
  assert.match(platformLaunch, /server\/detach\.mjs/);
  assert.match(platformLaunch, /Node 23\.6/);
  assert.match(platformLaunch, /no per-launch authorization token/i);
  assert.match(platformLaunch, /same operating-system user[\s\S]{0,220}(?:register|Root)/i);
  assert.match(platformLaunch, /not a\s+cross-user security boundary/i);
});

function skillMarkdown(): string {
  assert.ok(existsSync(SKILL_FILE), 'tracker-board has no SKILL.md');
  return readFileSync(SKILL_FILE, 'utf8');
}

function section(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = markdown.match(
    new RegExp(`(?:^|\\n)## ${escaped}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`),
  );
  assert.ok(found !== null, `Markdown has no "${heading}" section`);
  return found[1] ?? '';
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function concretePosixPaths(text: string): string[] {
  const multiSegment = [...text.matchAll(GENERIC_POSIX_PATH)];
  const nonAscii = [...text.matchAll(NON_ASCII_POSIX_PATH)];
  const singleSegment = [...text.matchAll(SINGLE_POSIX_PATH)].filter((match) => {
    const value = match[0];
    const index = match.index;
    const before = text[index - 1] ?? '';
    const after = text[index + value.length] ?? '';
    const quoted = /["'`]/.test(before) && after === before;
    const labelled = /(?:path|root|directory|location|file)\s*(?::|=|is)?\s*$/i.test(
      text.slice(Math.max(0, index - 32), index),
    );
    return quoted || labelled;
  });

  return [...multiSegment, ...singleSegment, ...nonAscii]
    .filter((match) => {
      const value = match[0];
      const index = match.index;
      const before = text.slice(Math.max(0, index - 2), index);
      if (before.endsWith('#!')) return false;

      const preceding = text[index - 1] ?? '';
      const looksLikeRegex = !/["'`]/.test(preceding)
        && /\/(?:[dgimsuvy]+(?:\.test)?|\.test)$/.test(value);
      if (looksLikeRegex) return false;

      return !posixPathIsAllowed(value);
    })
    .map((match) => match[0]);
}

function posixPathIsAllowed(value: string): boolean {
  return ALLOWED_EXACT_POSIX_PATHS.has(value.toLowerCase()) ||
    ALLOWED_SYNTHETIC_POSIX_PATHS.some((allowed) => allowed.test(value.toLowerCase()));
}

function concreteWindowsPaths(text: string): string[] {
  const unc = [...text.matchAll(UNC_PATH)].map((match) => match[0]);
  const rooted = [...text.matchAll(ROOTED_WINDOWS_PATH), ...text.matchAll(SINGLE_ROOTED_WINDOWS_PATH)]
    .filter((match) => matchIsQuotedOrLabelled(text, match))
    .map((match) => match[0])
    .filter((value) => {
      const last = value.split('\\').at(-1) ?? '';
      return !/^(?:[.bBdDfFnNpPrRsStTvVwW0]|[0-9A-Fa-f]{1,6}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2})$/.test(last);
    });
  const escaped = [...text.matchAll(ESCAPED_WINDOWS_PATH)]
    .map((match) => match[0])
    .filter((value) => {
      const last = value.split(/\\+/).at(-1) ?? '';
      return !/^(?:[.bBdDfFnNpPrRsStTvVwW0]|[0-9A-Fa-f]{1,6}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2})$/.test(last);
    });
  const escapedSingle = [...text.matchAll(ESCAPED_SINGLE_WINDOWS_PATH)]
    .filter((match) => matchIsQuotedOrLabelled(text, match))
    .map((match) => match[0])
    .filter((value) => {
      const component = value.replace(/^\\+/, '');
      return !/^(?:[.bBdDfFnNpPrRsStTvVwW0]|\.e|bticket|[0-9A-Fa-f]{1,6}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2})$/.test(component);
    });
  return [...new Set([...unc, ...rooted, ...escaped, ...escapedSingle])];
}

function wideAbsolutePaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(["'`])([^"'`\r\n]*)\1/g)) {
    const value = match[2] ?? '';
    if (!/[\u0080-\u{10FFFF} ]/u.test(value)) continue;
    if (
      /^\/(?:[*/]|\/)/.test(value) ||
      /^\\{1,2}[^A-Za-z0-9._$-]/.test(value) ||
      /^\\{1,2}(?:[bBdDfFnNpPrRsStTvVwW0](?=[^A-Za-z])|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2})/.test(value)
    ) {
      continue;
    }
    if (posix.isAbsolute(value) && posixPathIsAllowed(value)) continue;
    if (posix.isAbsolute(value) || win32.isAbsolute(value)) found.push(value);
  }

  for (const match of text.matchAll(UNQUOTED_WIDE_POSIX_PATH)) {
    const value = (match[0] ?? '').replace(/[.,;:!?\])}]+$/u, '');
    const components = value.slice(1).split('/');
    const wideInterior = components
      .slice(0, -1)
      .some((component) => /[\u0080-\u{10FFFF} ]/u.test(component));
    const terminalUnicode = /[\u0080-\u{10FFFF}]/u.test(components.at(-1) ?? '');
    if (!wideInterior && !terminalUnicode) continue;

    const index = match.index ?? 0;
    const labelled = /(?:path|root|directory|location|file|at|under|from)\s*(?::|=|is)?\s*$/i.test(
      text.slice(Math.max(0, index - 32), index),
    );
    const conventionalHome = /^\/(?:Users|home)\//i.test(value);
    if (!labelled && !conventionalHome) continue;
    if (!posixPathIsAllowed(value)) found.push(value);
  }

  for (const match of text.matchAll(UNQUOTED_WIDE_WINDOWS_PATH)) {
    const value = (match[0] ?? '').replace(/[.,;:!?\])}]+$/u, '');
    const components = value.replace(/^\\+/, '').split('\\');
    const wideInterior = components
      .slice(0, -1)
      .some((component) => /[\u0080-\u{10FFFF} ]/u.test(component));
    const terminalUnicode = /[\u0080-\u{10FFFF}]/u.test(components.at(-1) ?? '');
    if (!wideInterior && !terminalUnicode) continue;

    const index = match.index ?? 0;
    const labelled = /(?:path|root|directory|location|file|at|under|from)\s*(?::|=|is)?\s*$/i.test(
      text.slice(Math.max(0, index - 32), index),
    );
    if (labelled && win32.isAbsolute(value)) found.push(value);
  }
  return [...new Set(found)];
}

function matchIsQuotedOrLabelled(text: string, match: RegExpMatchArray): boolean {
  const value = match[0];
  const index = match.index ?? 0;
  const before = text[index - 1] ?? '';
  const after = text[index + value.length] ?? '';
  const quoted = /["'`]/.test(before) && after === before;
  const labelled = /(?:path|root|directory|location|file|at|under)\s*(?::|=|is)?\s*$/i.test(
    text.slice(Math.max(0, index - 32), index),
  );
  return quoted || labelled;
}

function hiddenNumericTicketReferences(text: string, detector: RegExp): string[] {
  return text.split(/\r?\n/).flatMap((line) => line.match(detector) ?? []);
}

function hiddenArtifact(surface: string, markers: readonly string[]): string | null {
  const lower = surface.toLowerCase();
  return markers.find((marker) => lower.includes(marker.toLowerCase())) ?? null;
}

function shipped(relative: string): string {
  return readFileSync(join(SKILL_DIR, relative), 'utf8');
}

function filesUnder(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
    else if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      throw new Error(`published skill contains a symbolic link: ${entry.name} -> ${target}`);
    }
  }
  return files;
}

test('the publication walk rejects symbolic links instead of silently skipping their metadata', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'tracker-board-publication-link-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const target = join(sandbox, 'target');
  mkdirSync(target);
  symlinkSync(target, join(sandbox, 'published-link'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(() => filesUnder(sandbox), /contains a symbolic link/);
});

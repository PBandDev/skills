/**
 * A Feature's **member list** — the one place that knows what a member entry is spelled
 * like, what a Feature's `contentSha` is a hash of, and how many files moved under a Digest
 * that expired.
 *
 * A member entry is `<root-relative POSIX path>:<sha>`, and the Feature's `contentSha` is
 * the sha of those entries sorted and joined by newlines. **Pairs, not bare hashes.** The
 * path half is what makes the expired-Digest count a count at all: with bare hashes the two
 * sides can only be compared as sets, and a set difference reports **2** for a single edited
 * file — one hash gone, one hash arrived — which reads as a bug rather than as a number.
 * Keyed by path, the same edit is the one file it is.
 *
 * ## The counting rule
 *
 * `countChangedPaths` counts **paths whose content differs**, and an added or a removed path
 * counts one each. It is deliberately **not** the symmetric difference of the two lists.
 *
 * A **rename is two** — a removed path and an added path — and that is a decision, not an
 * omission. Collapsing it to one means matching an only-in-old path to an only-in-new path
 * by equal content, and equal content is not evidence of a rename: deleting a file and
 * adding an unrelated identical one is indistinguishable from moving it. The board would
 * then be stating a history it cannot see. Two is what a path-keyed rule says, and a
 * path-keyed rule is what the count is.
 *
 * A path whose file **could not be read** takes the count away entirely. The rule counts
 * paths whose *content* differs, and an unreadable file's content is not known — so whether
 * it differs is not known, and neither is the total. Counting it as changed would report a
 * permissions error as an edit, and skipping it would report a Feature as quieter than it
 * was. `contentSha` still records the file, under the `unreadable` sentinel, because a key
 * that stops matching is not a claim about anything; a printed number is.
 *
 * ## Why the stored side is checked against the key it was filed under
 *
 * The stored list arrives from the Annotation store, which is written by the AI layer, and a
 * count printed from a list in the wrong shape is not slightly wrong — it is the Feature's
 * entire file count, printed on the board as fact, on every expired Digest. Bare hashes
 * compare unequal to every pair, so *every* file reads as changed.
 *
 * So a stored list is used only when `memberListSha` of it reproduces the `contentSha` the
 * entry was filed under. That is cheap, and it is the strongest check available here: it
 * proves the list is in this module's canonical form and that it is the list that produced
 * that key, so a list written to some other convention is refused rather than diffed.
 *
 * It does **not** prove the list is true — an entry is written whole by the AI layer, so a
 * fabricated list and a matching fabricated key are self-consistent. That is the same trust
 * the board already extends to every Extraction under ADR-0001: the model states content
 * facts, code derives from them, and the derivation here is the count. Nothing on this path
 * accepts a *count* from the store, which is the part ADR-0001 actually forbids.
 *
 * Anything that fails leaves the count `null`, and `null` renders as a sentence that does
 * not claim a number. A missing count costs a reader one sentence; a wrong one costs the
 * panel the only thing it has, which is that it never says what it cannot stand behind.
 */

import { createHash } from 'node:crypto';

/**
 * The sha half of a member entry for a file whose text could not be read.
 *
 * A constant rather than an omission, so an unreadable file still occupies its path in the
 * list and a Feature holding one still has a `contentSha`. It is a marker for *absence of
 * knowledge*, not a hash: `countChangedPaths` refuses any list containing one rather than
 * comparing it, because two files being equally unknown is not the same as their being equal.
 */
export const UNREADABLE_SHA = 'unreadable';

/** 64 lower-case hex, which is what `sha256` below produces and the only other legal half. */
const SHA_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One member entry: a path and the sha of its text.
 *
 * `relPath` is expected already POSIX-separated and Root-relative — this module does not
 * normalise, because a normalisation applied here and not at the other call site would make
 * the two halves of the same list disagree.
 */
export function memberEntry(relPath: string, text: string | null): string {
  return `${relPath}:${text === null ? UNREADABLE_SHA : sha256(text)}`;
}

/**
 * The Feature `contentSha`: sha of the member entries, sorted, newline-joined.
 *
 * Sorted **here** as well as at the call site, so the hash is a function of the set of
 * members rather than of the order they happened to be walked in. That is what lets a
 * writer copy a published list back verbatim and have it verify.
 */
export function memberListSha(members: readonly string[]): string {
  return sha256([...members].sort(compareStrings).join('\n'));
}

/**
 * How many of a Feature's paths moved between the list a Digest was written against and the
 * list on disk now — or `null` when that is not answerable.
 *
 * `null` on every one of: no stored list, a stored list that is not a list of strings, a
 * stored list that does not reproduce `storedSha`, either list holding an entry that is not
 * a `path:sha` pair, either list holding a path whose file could not be read, either list
 * naming one path twice, and a difference of zero.
 *
 * Zero is not reachable from a board-built `current` and a stored list that verified against
 * its own key, because two duplicate-free pair lists that agree path-for-path have the same
 * sorted join and so the same sha — the Digest would have read *current*, not expired. It is
 * refused rather than returned because both lists arrive from a disk read, and "expired, and
 * nothing changed" is a contradiction to report as unknowable rather than to print.
 */
export function countChangedPaths(
  current: readonly string[],
  stored: readonly string[] | undefined,
  storedSha: string,
): number | null {
  if (!isStringList(stored)) return null;
  if (memberListSha(stored) !== storedSha) return null;

  const before = byPath(stored);
  const now = byPath(current);
  if (before === null || now === null) return null;

  let changed = 0;
  for (const path of new Set([...before.keys(), ...now.keys()])) {
    // `undefined` on one side is an added or a removed path, and it can never collide with a
    // real sha, so absence and difference are the same comparison and each costs one.
    if (before.get(path) !== now.get(path)) changed += 1;
  }
  return changed > 0 ? changed : null;
}

/**
 * A member list as a path-keyed map, or `null` if it is not one.
 *
 * Split at the **last** colon, not the first: a sha never contains one and a path may, so
 * the join is injective and this recovers both halves exactly.
 *
 * A repeated path is refused rather than folded. One file is a member of one Feature once,
 * so a list naming a path twice is not a list this module produced, and folding it would
 * mean picking which of the two shas the count is about.
 *
 * Two kinds of entry are refused for one underlying reason — they break the framing that makes
 * `memberListSha` a key rather than a coincidence, which is the hole that check cannot close on
 * its own:
 *
 *   - **A newline anywhere in the entry.** The list is joined by newlines, so a path holding
 *     one makes the join non-injective: `['a:<sha1>', 'b:<sha2>']` and the single entry
 *     `['a:<sha1>\nb:<sha2>']` produce the same text and therefore the same key. The second
 *     form verifies and is then diffed as one oddly-named path against two on the other
 *     side, reporting changes that never happened.
 *   - **An entry that does not survive a UTF-8 round trip**, which means an unpaired
 *     surrogate. `sha256` encodes as UTF-8 and replaces one with U+FFFD, so a path ending
 *     `\uD800` and the same path ending U+FFFD hash identically while remaining different
 *     strings — a stored list that verifies and then compares unequal to a live path that is
 *     really the same file.
 *
 * Both are pathological in a tracker directory, and losing the count for them costs a
 * sentence. Reporting a number derived from a partition nobody chose costs the panel the one
 * guarantee it has.
 */
function byPath(members: readonly string[]): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const member of members) {
    if (typeof member !== 'string') return null;
    if (member.includes('\n')) return null;
    if (Buffer.from(member, 'utf8').toString('utf8') !== member) return null;
    const at = member.lastIndexOf(':');
    // `<= 0` refuses both a member with no separator at all and one with an empty path.
    if (at <= 0) return null;
    const path = member.slice(0, at);
    const sha = member.slice(at + 1);
    // One test, two refusals. A half that is not a content hash means the entry is not a
    // member entry; and `UNREADABLE_SHA` is deliberately not one, so a file the scanner could
    // not read lands here too — its content is unknown, so whether it differs is unknown, and
    // so is the total. Written as one condition because two would mask each other: either
    // alone still refuses the sentinel, so neither could be shown to be doing any work.
    if (!SHA_PATTERN.test(sha)) return null;
    if (map.has(path)) return null;
    map.set(path, sha);
  }
  return map;
}

/** Type stripping erases and does not check; this list arrived from a file. */
function isStringList(value: readonly string[] | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((member) => typeof member === 'string');
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

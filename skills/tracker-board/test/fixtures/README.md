# Parser fixtures

Every file here is a **trap**. Each one encodes a parsing hazard that was found by measuring a
real `.scratch/` tree, not by imagining what might go wrong. Several of them look like
pedantic edge cases and are not: the blocker-parenthetical trap alone moves three cards and
two lane counts on a real board.

Fixtures are markdown because the parser's input is markdown. They review like prose and diff
like prose.

## Layout

```
tickets/    one file per trap — parser rule to fixture is 1:1
corpus/     a whole synthetic .scratch/ tree — cross-file behaviour
expected.md what corpus/ must derive to, as a reviewable table
```

## The two kinds, and why both

**`tickets/` catches rule bugs.** One file, one hazard, one assertion. When a rule breaks you
know which file to open.

**`corpus/` catches graph bugs**, which unit fixtures structurally cannot. A blocker parser
can be wrong on half the tickets and leave the board looking perfect: fictional dependency
edges on already-finished tickets move **no lane**, because blockers only gate incomplete work.
Nothing short of a whole-tree golden catches that class.

## Adding a fixture

1. It must come from a **real** file you observed, not one you invented. Imagined edge cases
   drive real complexity into the parser for no measured benefit.
2. Name it for the hazard, not the subject: `blockers-parenthetical.md`, not `subject-10.md`.
3. Put the expectation in a `<!-- expect: … -->` comment at the top of the file, so the
   fixture is self-describing and the test file stays a loop rather than a wall of literals.
4. De-identify. Keep the byte shapes; change the subject matter.

## Rule zero

**The parser never throws.** Agents rewrite these files while the board is watching them, so
the parser routinely reads a file mid-write. Anything unrecognisable degrades to an
`unparsed` card showing the raw filename. A fixture that makes the parser throw is a failing
test, whatever else it proves.

## Line endings

There is intentionally no repository-wide `.gitattributes` policy. The corpus reader normalizes
checked-out text to LF before deriving the committed golden, and the golden comparison normalizes
both sides. Parser behavior under CRLF is tested separately. This keeps fixture identity and
expected output checkout-independent without changing every contributor's working-tree policy.

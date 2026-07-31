<!-- expect: state=unparsed throws=never -->
<!-- trap: this is what a file looks like when the parser reads it WHILE AN AGENT IS WRITING
     IT. That is not an edge case here — it is the steady state. The board watches the same
     directories that agents are actively editing, and fs.watch fires DURING the write, so
     the parser will read torn files routinely rather than rarely.
     A parser that throws on malformed input fails constantly, and the failure looks like the
     board being broken rather than like a file being half-written.
     Degrade to an `unparsed` card showing the raw filename. The next write fires another
     event a few milliseconds later and the card resolves itself. Never throw. Never retry.
     Never block the scan on one bad file. -->

# 11 — Ship gat

**What to buil

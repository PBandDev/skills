<!-- expect: number=7 title="Qualify and normalize roster sources" -->
<!-- trap: two width/format assumptions in one file.
       - The filename is zero-padded to THREE digits. "Numbered from 01" fixes the start,
         not the width. Derive with ^(\d+)- at any width, and sort NUMERICALLY — a string
         sort puts 10 before 2, which silently reorders the whole dependency display.
       - The H1 separator is a plain hyphen, not an em-dash. 70 of 76 H1s in the sample used
         an em-dash and 6 did not, so an em-dash-only strip leaves "07 - " glued to the front
         of the display title on 8% of cards.
     Strip an optional NN prefix with any of — – - as the separator. The number comes from
     the FILENAME; the H1 is display text only. -->

# 07 - Qualify and normalize roster sources

**What to build:** One normalizer that every roster source passes through, so downstream
consumers never branch on which source a row came from.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] All three sources normalize to one row shape
- [x] Downstream consumers have no source-specific branches left

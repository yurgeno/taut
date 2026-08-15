---
name: fx-verify
description: 'Stage 4 of the fx flow: final quality gate - review, owner-picked fixes, re-run gates.'
metadata:
  taut:
    agents: [fx-reviewer, fx-implementer, fx-qa]
---

# fx-verify — verify (stage 4)

The fx-reviewer reviews the cross-repo change into _cr.md; the owner picks fixes;
fx-implementer applies them; gates re-run; fx-qa drafts test scenarios (chat-only).
<!-- atlas:on -->
Then offer the knowledge write-back (fx-knowledge mechanics).
<!-- atlas:end -->

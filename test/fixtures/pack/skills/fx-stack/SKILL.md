---
name: fx-stack
description: 'Bring up a named local stack profile by following the deployment runbooks shipped with the workspace.'
metadata:
  taut:
    role: stack-engine
---

# fx-stack — stack engine

Bring up the requested profile.
<!-- kaut:on -->
Recipes come from KAUT at run time (`runbook/local-startup` per repo).
<!-- kaut:off -->
Recipes are the deployment runbooks in `.taut/runbooks/` (index: manifest `runbooks`).
<!-- kaut:end -->
Per L4 a stack is never the default tier.

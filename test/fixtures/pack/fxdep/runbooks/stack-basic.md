---
name: stack-basic
description: "Bring up the basic stack: repo-svc backend + repo-core SPA"
repos: [repo-svc]
---

# stack-basic — bring-up recipe (fixture)

Start repo-svc: `./gradlew bootRun`; wait for the log line `Started SvcApplication`.
Then start the SPA from repo-core.

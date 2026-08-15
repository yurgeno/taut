---
name: ops-shared
description: "Shared operational values for the fixture deployment"
repos: [repo-core, repo-svc]
---

# ops-shared — deployment model (fixture)

What runs where: repo-svc serves the API on :8080; repo-core is the SPA on :3000.

## Known failure signatures
- Port already bound: a previous run left the service up — stop it first.

---
name: dev-server
description: 'Bring up the react-app Vite dev server for interactive verification'
repos: [react-app]
---

# dev-server — react-app bring-up recipe

The `dev-server` rung of `runtimeTiers` — climb here only when the change is visual or
interactive; unit tests on the `static` tier come first.

1. From the react-app repo root (path: workspace `.taut/local.json` → `repoPaths`):

   ```bash
   npm ci        # only when node_modules is missing or the lockfile changed
   npm run dev
   ```

2. Ready marker: Vite prints `Local: http://localhost:5173/` — open that URL.
   The port shifts (5174, …) when 5173 is busy; TRUST THE LOG LINE, not the default.
3. Verify the actual change, not just the landing page: navigate to the affected route,
   exercise the interaction, watch the browser console for errors.
4. Shut the server down when done (Ctrl-C) — a forgotten dev server confuses the next
   port probe.

Known failures:

- `EADDRINUSE` — a previous dev server is still running; find it (`lsof -i :5173`) and
  stop it rather than stacking instances.
- Blank page + console import errors after switching branches — stale deps;
  `npm ci` and restart.
- Node version complaints — react-app pins its floor in `package.json` `engines`;
  runtime observation wins over this note if they disagree (and report the drift).

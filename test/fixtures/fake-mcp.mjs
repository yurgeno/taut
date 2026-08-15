// Minimal stdio MCP server for the `taut check` handshake test: answers the JSON-RPC
// initialize and nothing else. No dependencies — spawned as `node fake-mcp.mjs --serve`.
// The --serve guard matters: bare `node --test` executes EVERY .mjs under test/, and an
// unguarded stdin listener would hang the whole suite run.
if (process.argv.includes('--serve')) {
  process.stdin.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          // The reported name signals PRESENCE of the env var (not its value): lets the
          // launcher test prove a value written to .taut/local.env reaches the server with
          // no exporting, while `taut check` still redacts the secret VALUE from its report.
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: process.env.FAKE_MCP_NAME ? 'ENV-DELIVERED' : 'fake-mcp', version: '1.0' } },
          }) + '\n');
        }
      } catch { /* partial line */ }
    }
  });
}

# wtch+ MCP

Every trench tool for your AI agent. Read-only Solana wallet intel. Zero keys. MIT.

Remote, no install:

```bash
claude mcp add --transport http wtch https://mcp.wtch.plus
```

Local stdio:

```bash
claude mcp add wtch -- npx -y wtch-plus
```

Cursor / any MCP client:

```json
{ "mcpServers": { "wtch": { "url": "https://mcp.wtch.plus" } } }
```

Tools: `whats_important`, `trades`, `bags`, `pnl`, `style`, `live`, `top_wallets`, `wallet_stats`, `coins_up`, `digest`, `position`.
Self-host the API: set `FMT_API=http://127.0.0.1:5531/api`.

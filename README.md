[![wtch+](brand/readme-banner.png)](https://wtch.plus)

# wtch+

**Solana wallet data for your AI agent, with Telegram alerts you can configure.**

wtch+ tracks wallet trades, holdings and SOL flows. Connect a compatible AI client through MCP, inspect a wallet on the website, or follow its activity in Telegram. The wallet tools read public data; they do not sign transactions or place trades.

[Open wtch+](https://wtch.plus) · [MCP setup](https://wtch.plus/mcp) · [Documentation](https://wtch.plus/docs)

## Start with your agent

1. Open the website and create your agent with your wallet.
2. Choose the wallets to watch.
3. Open Feed and connect Telegram.
4. Set minimum trade size, trade side and delivery timing in Settings.

Receive individual trade alerts or choose an hourly or daily digest. Updating your rules changes subsequent delivery; existing Telegram messages remain in your history.

## Connect your AI

Open the MCP setup page on the website and copy the endpoint and client configuration shown there. Use a public Solana wallet address in your questions.

> Show the largest recent swaps for this wallet.

> Check this wallet’s holdings and its position in this token.

## MCP tools

| Tool | Data |
| --- | --- |
| `whats_important` | Largest recent wallet swaps, ranked by SOL size |
| `trades` | Recent wallet swaps with transaction references |
| `bags` | Token holdings and available USD values |
| `pnl` | SOL in, SOL out and net over recent swaps |
| `style` | Trading pattern, typical size and pace |
| `live` | Recent swaps across watched wallets |
| `top_wallets` | The watched-wallet list |
| `wallet_stats` | Recent wallet statistics |
| `coins_up` | Growth signals for coins traded by tracked wallets |
| `position` | One wallet’s position in one token |
| `digest` | A summary of recent tracked-wallet activity |

The tool list reflects the source snapshot used for this brand package. Check the connected server’s `tools/list` response for the tools available in a particular deployment.

## Read the numbers in context

`pnl` describes recent SOL flows, not a full lifetime-profit or cost-basis calculation. Trade alerts are selected by your settings. Trade size is not a measure of expected return. Growth signals and trade-side filters are separate rules.

## Development

See the repository’s existing setup instructions and environment example for the app, API and bot. The brand uses the Circuit monogram and the Acid palette. Brand assets are supplied as SVG and PNG; backgrounds for bot cards reserve space for runtime text and numbers.

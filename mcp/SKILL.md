---
name: wtch
description: Solana trench intel through the wtch+ MCP — what a wallet just did, its bags, PnL flow and style, and live swaps from top traders. Use when the user pastes a Solana wallet, asks what a trader is doing, or wants the biggest moves right now.
---

# wtch+ skill

Tools (MCP server `wtch`, read-only, zero keys):
- `whats_important(wallet)` — start here for any wallet.
- `trades(wallet)`, `bags(wallet)`, `pnl(wallet)`, `style(wallet)` — drill down.
- `live(min_sol)` — biggest swaps across top wallets now. `top_wallets()` — who wtch+ watches.
- `coins_up()` — coins up 50%+ in 1 hour that tracked wallets traded, with CA. `digest()` — the last hour in one answer.
- `wallet_stats(wallet)` — win rate, buys, sells and tokens closed.
- `position(wallet, mint)` — one wallet in one coin: full bag, building since (after any full exit), PnL on the coin.

Answer in 3 lines max: what happened, how big (SOL), what to watch next. Link `https://wtch.plus/w/<wallet>`.
Never give financial advice; report what the chain shows.

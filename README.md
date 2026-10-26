<p align="center">
  <img src="public/logo.png" width="120" alt="BSC Agent logo" />
</p>

<h1 align="center">BSC Agent</h1>

<p align="center">A local BSC market, quoting, and trading terminal with a GMGN-style trenches view.</p>

<p align="center">
  <img src="docs/screenshots/trenches-demo.png" alt="BSC Agent trenches view using simulated data" />
</p>

BSC Agent starts a Node.js service on your computer, listens only on `127.0.0.1`, and provides a browser interface. It supports BSC launchpad markets from Flap, Four, and gang.fun. Live transaction signing is handled by the Binance Agentic Wallet CLI (`baw`); private keys are not stored locally.

## Features

- GMGN-style trenches with New, Near Graduation, and Launched columns
- Filters for market cap, holders, progress, tax, quote asset, social links, keywords, and creation time
- `Min / Max` age filters that hide tokens still not launched after the maximum age
- K-line charts, live trades, all-market trades, trader P&L, and holdings
- Quick buy, sell-all, slippage controls, and approval review or revocation
- Market adapters for Flap, Four, and Gang
- Automated buy and sell strategies: **included but disabled by default and never enabled automatically after a restart**
- Auto-claim, auto-transfer, post-sale BNB conversion, and large-allowance approval: disabled by default
- Simulation mode that does not connect to a wallet or send on-chain transactions

## Safety boundaries

This is third-party software that can interact with real funds and has not undergone a formal security audit. Start with simulation mode and verify live behavior with a very small amount.

- Live orders are submitted only when `MODE=live`, `LIVE_TRADE=1`, the wallet is signed in, and the order is confirmed in the interface.
- Automated buy and sell strategies are disabled by default and run only after you enable their controls in the interface.
- The server listens only on `127.0.0.1`; do not expose the port publicly or forward it from the internet.
- Keep RPC keys, transfer addresses, and other private settings in the local `.env` file. Never commit them to Git.
- The public screenshot uses simulated data and contains no wallet address, AI account name, balance, or transaction history.

## Requirements

- macOS or Linux
- Node.js 22 or newer
- npm
- Binance Agentic Wallet CLI for live mode

```bash
npm i -g @binance/agentic-wallet
baw auth signin
baw wallet status
```

Live features require `baw wallet status` to show `CONNECTED`. Sign-in confirmation must be completed by you in the Binance App.

Four agent templates also require the official Binance skill:

```bash
npx skills add https://github.com/binance/binance-skills-hub --skill binance-agentic-wallet
```

## Install and run

```bash
git clone <your-repository-url> bsc-agent
cd bsc-agent
npm install
cp .env.example .env
```

Start with simulation mode:

```bash
npm run sim:8787
```

Open <http://127.0.0.1:8787>. Simulation mode uses local simulated assets and does not call the real wallet.

After simulation mode works, start live market data in read-only mode when needed:

```bash
npm run live:readonly
```

This mode reads live market data and wallet status but only quotes; it does not send real transactions.

If you explicitly need live order execution:

```bash
MODE=live LIVE_TRADE=1 PORT=8788 node server.js
```

After live mode starts, automated strategies remain disabled by default. Enable automated buying or selling separately for each platform in the interface.

## Configuration

Copy `.env.example` to `.env` and adjust the settings as needed:

| Variable | Default | Purpose |
|---|---:|---|
| `MODE` | `sim` | `sim` for simulation, `live` for live market data |
| `PORT` | `8787` | Local server port |
| `LIVE_TRADE` | `0` | Set to `1` to allow live orders; `0` is quote-only |
| `MAX_TRADE_BNB` | `0.5` | Maximum BNB amount per buy |
| `NODEREAL_RPC` | empty | Optional private BSC RPC; keep it in `.env` only |
| `BAW_BIN` | `baw` | Agentic Wallet CLI path |
| `AUTO_TRANSFER_TO` | empty | Transfer destination; auto-transfer stays unavailable when empty |
| `PREAPPROVE` | `0` | Large allowance approval; recommended to keep disabled |

Project data, logs, caches, and wallet state are written to local `data/`, which is ignored by Git.

## Development and testing

```bash
npm test
node --check public/app.js
```

## License

This project is released under the MIT License. You may use, copy, modify, publish, distribute, sublicense, and sell copies of the software, subject to the terms in [LICENSE](LICENSE). `public/vendor/` keeps the license files for its third-party libraries.

## Disclaimer

Token prices, liquidity, taxes, and platform APIs can change quickly. Every trade can lose money or become impossible to sell. The authors do not provide investment advice and are not responsible for financial losses.

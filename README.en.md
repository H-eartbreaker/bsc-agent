<p align="center">
  <img src="public/logo.png" width="110" alt="BSC Agent logo" />
</p>

<h1 align="center">BSC Agent</h1>

<p align="center"><a href="README.md">简体中文</a> · <b>English</b></p>

<p align="center">A BSC market and trading terminal that runs on your own computer<br/>Trenches · Charts · Quick trade · Wallet tracking · gang.fun sniping · NFT radar and auto-mint</p>

<p align="center">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-supported-2ea44f?logo=apple&logoColor=white" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-supported-2ea44f?logo=windows&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/Linux-supported-2ea44f?logo=linux&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

> **In one line:** download → install → start → sign in to your Binance wallet in the browser, and you're ready.
> Private keys never live on your machine, and the service listens on `127.0.0.1` only.

| System | Install | Start |
|---|---|---|
| **macOS** / Linux | run `./install.sh` in a terminal | run `./start.sh` in a terminal |
| **Windows** | double-click `install.bat` | double-click `start.bat` |

---

## Contents
1. [What it does](#what-it-does)
2. [Quick start (3 minutes)](#quick-start-3-minutes)
3. [NFT radar and auto-mint](#nft-radar-and-auto-mint)
4. [Using the interface](#using-the-interface)
5. [Safety notes (read first)](#safety-notes-read-first)
6. [Updates](#updates)
7. [Configuration](#configuration)
8. [FAQ](#faq)
9. [Development and testing](#development-and-testing)
10. [License and disclaimer](#license-and-disclaimer)

## What it does

**Market data**
- **Trenches:** New / Near Graduation / Launched columns covering Flap, Four and gang.fun (Gang V1 / V2 / V3 and fair launch). Every token card uses the same fixed layout: name → pool quote asset · tax · launch mode → pool size / tags → age · holders · trades → Dev / first buyer.
- **Filters:** three presets (P1 / P2 / P3) per column; filter by platform, quote asset, age, market cap, holders, progress, tax and social links. Saved automatically.
- **Charts and trades:** launched tokens merge on-chain trades with external-pool history; market cap / price toggle; 1s to 1h intervals; buy and sell markers.
- **Market page:** the left tabs (In curve / Soon / Migrated / Mine) share the trench filters; the token header shows price, change, market cap, liquidity, volume, holders, fees and platform links in a single row.

**Trading**
- **Quick trade:** quick buy, sell-all, slippage, and allowance review / revoke. Trades go through Binance's aggregator and fall back to PancakeSwap V2 directly for brand-new pools the aggregator doesn't know.
- **Tracking / copy trading:** follow smart-money addresses and copy their buys with your own amount, take-profit and stop-loss.
- **gang.fun sniping:** buy new launches right away. You decide how much per buy, how many tokens per day (unlimited by default) and the auto-sell rules.
- **Pause all:** one button at the top-right stops tracking and sniping together.

**NFT**
- **NFT radar:** lists newly launched NFT projects in real time, keeping only those that require an Agent ID, and flags the ones that match your auto-mint rules.
- **Auto-mint:** free projects are minted automatically (gas only); paid projects are always manual.
- **Manual mint:** open any project and mint a quantity you choose. Paid projects are quoted first, show the estimated cost in a dialog, and send a transaction only after a second confirmation.
- **Latest-NFT float:** open it from any page and dock it left or right.

**Convenience**
- **Task lights:** sniper / copy-trade / NFT lights at the top — green is on, grey is off.
- **Self-check page:** wallet, live-trading switch and every module at a glance, with plain-language hints when something is wrong.
- **Single wallet:** only the one Binance Agentic Wallet you sign in with; no multi-wallet options.
- **Unified UI:** all sub-navigation uses the same underline tabs; when the window gets narrower the whole page scales down instead of reflowing.

## Quick start (3 minutes)

**Requirements:** macOS, Windows or Linux, plus **Node.js 22 or newer** (download from <https://nodejs.org>; on Windows, close and reopen the window after installing).

### macOS / Linux
```bash
git clone https://github.com/H-eartbreaker/bsc-agent.git
cd bsc-agent
./install.sh      # checks Node, installs dependencies, creates .env, installs the Binance wallet CLI (baw)
./start.sh        # starts the service and opens http://localhost:8787
```
- No git? On the GitHub page click **Code → Download ZIP**, unzip, open a terminal in that folder and run the same two commands.
- If you get "permission denied", use `bash install.sh` and `bash start.sh` instead.
- On macOS you can also install Node first with `brew install node`.

### Windows
1. On the GitHub page click **Code → Download ZIP** and unzip it anywhere (or `git clone` if you have git).
2. **Double-click `install.bat`**: checks Node, installs dependencies, creates `.env` and installs the Binance wallet CLI `baw`.
3. **Double-click `start.bat`**: starts the service and opens <http://localhost:8787>. Close the black window to quit.
4. If Windows Firewall or your antivirus asks the first time, choose Allow. If installing `baw` automatically fails, open Command Prompt **as Administrator** and run:
   ```
   npm i -g @binance/agentic-wallet
   ```

### First launch
The page shows a **guide plus a self-check**. Follow it in order:
1. **Sign in to the Binance wallet:** click **Sign in to Binance wallet** → open the link it gives you → check the pairing code → confirm in the **Binance App**. The page detects it automatically; no commands needed. (If the wallet tool isn't installed, the window shows the install command with a Copy button.)
2. Open **🩺 Self-check** at the bottom-left of the footer. The first four items must show ✓.
3. In **Tracking / gang.fun sniping**, set **how much to buy each time**, and test with a very small amount first.
4. To stop everything: **Pause all** at the top-right.

> If market sites are unreliable on your network, just turn on your proxy app — the app finds the proxy automatically. If it can't, enter the proxy address on the self-check page (see the [FAQ](#faq)).

## NFT radar and auto-mint

**Works out of the box — no Telegram setup.** New projects are watched and published by the author's machine, and your app pulls them once a minute, so they simply show up on the **NFT** page.

**Auto-mint** (set your rules under **NFT → Auto-mint manager**; you turn it on and off yourself):
- Only **free** mints (payment = 0) of projects that require an **Agent ID**, so only gas is spent. Paid projects are never auto-run.
- Filter by website / X, set exclude keywords; mint up to each project's limit, or just 1 per project. There is no daily cap.
- Each project is simulated on-chain, then must pass `baw contract-call preview`; a transaction is sent only if both pass.
- By default only projects that appear **after** you turn it on are handled (you can also choose to include existing ones). Handled projects are never minted twice; failures are retried for a while.
- The switch is yours alone: **refreshing the page or restarting the service never changes it**. If it was on when you restarted, it keeps running; turn it off yourself to stop.
- The page shows success / failure reports, total stats and mint history (queryable by task time window).

**Manual mint:** open any project's details, enter a quantity and click **Manual mint**.
- Free projects: minted right away.
- Paid projects: you get a quote first (price, estimated gas, total, wallet balance) and a **second confirmation** dialog before anything is sent. There is a per-transaction cap (default 0.5 BNB, change it with `NFT_MANUAL_MAX_BNB`), and an insufficient balance is rejected outright. Try a cheap project first.

**Command line:** `node scripts/free-mint.mjs 0xContract…` probes the free quantity and runs a `baw` preview safety check before minting; `--dry` checks without sending; `--quote --qty N` only quotes the price.

**Good to know:**
- The feed comes from the author's machine. When the author isn't watching there are no new projects and the page says "feed stopped"; existing projects and your settings are unaffected.
- "Requires an Agent ID" is judged from whether the pushed message says so; projects whose message doesn't mention it aren't listed.
- To opt out of the feed set `NFT_FEED_SYNC=0` in `.env`. To use another source set `NFT_FEED_URL=https://…/nft-feed.json`.
- The project contracts are third-party. **Unknown projects are at your own risk** — check your wallet after minting.

<details>
<summary><b>Run your own Telegram watcher and publish a feed for others (author / advanced users — skip if you're a regular user)</b></summary>

1. Get an `api_id` / `api_hash` at <https://my.telegram.org> and run `node scripts/tg-login.mjs` once to sign in; the session is stored in `data/`.
2. Fill in `TG_API_ID`, `TG_API_HASH`, `TG_CHANNEL_ID` (and `TG_PROXY_HOST` / `TG_PROXY_PORT` if needed) in `.env` and restart; the watcher starts automatically.
3. To share the data publicly: create a GitHub **classic** token with **only the `gist` scope**, run `node scripts/setup-feed-gist.mjs` and paste it when prompted (input is hidden). The script creates a public Gist and writes the token and Gist ID into your local `.env`.
4. Credentials stay in your local `.env` and `data/`, both ignored by Git — **never commit them**. The public Gist contains only public information such as project names, contract addresses and prices.
</details>

## Using the interface
| Where | What it does |
|---|---|
| Top navigation: Market / Trenches / Holdings / Tracking / Sniping / NFT | The main pages, current page highlighted; each page's sub-navigation sits at the top of its content |
| Task lights (top) | Sniper / copy-trade / NFT tasks: green = on, grey = off |
| "Latest NFT" button | A site-wide new-project float that docks left or right |
| GitHub icon (top-right) | Opens the project repository; shows a red dot and a pop-up when a new version is out |
| Wallet name + balance (top-right) | Click to copy the wallet address and see the sign-in status |
| Trench column header | Keyword search, per-column ⚡ buy amount, P1–P3 presets, sound, hidden-token count, filter funnel |
| Trench card | Click the MC / buy area on the right to ⚡ buy; ⊘ to hide a token; click the card for details |
| Tracking / Sniping | Separate pages; set the amount, save, then turn on (real buying) |
| NFT | Project list / auto-mint manager / mint history tabs |
| Left token list | Drag the divider to resize; double-click it to reset |
| Footer: self-check / version | Self-check page, version number and update notice |

## Safety notes (read first)
This is third-party software that moves real funds and **has not had a formal security audit**. Test with small amounts first.
- Real orders require `MODE=live`, `LIVE_TRADE=1`, a signed-in wallet and your confirmation in the interface.
- Tracking and sniping are **off by default** and are **never turned on automatically** after a restart.
- The server listens on `127.0.0.1` only. Never forward the port to the internet.
- Keep RPC keys, transfer addresses, Telegram and GitHub tokens in the local `.env` and never commit them. The `data/` folder (positions, history, tokens) is ignored by Git.
- Auto-transfer, auto-claim and large allowance pre-approval are off by default.
- NFT auto-mint only spends gas; paid mints are manual only, with a quote and a second confirmation.

## Updates
- The app periodically checks this repository's version number. When a higher version exists, the **GitHub icon in the top-right shows a red dot and a pop-up** with the release notes. Choose **Remind me later**, **Don't remind for this version**, or **Open GitHub**.
- **It only reminds — it never updates by itself.** To update:
  ```bash
  git pull
  npm install
  # then restart the service (stop it and run ./start.sh again; on Windows close the black window and double-click start.bat)
  ```
  If you downloaded a ZIP: download the new one and copy `.env` and `data/` from the old folder into it. Your wallet, settings and records are not touched.
- To check a different repository set `BSC_AGENT_UPDATE_REPO=user/repo` in `.env`; to turn the reminder off set `BSC_AGENT_UPDATE=0`.
- Release notes for every version are in [CHANGELOG.en.md](CHANGELOG.en.md) ([简体中文](CHANGELOG.md)).

## Configuration
Copy `.env.example` to `.env` and adjust as needed (`install.sh` / `install.bat` already do this for you):

| Variable | Default | Purpose |
|---|---:|---|
| `MODE` | `live` | Live mode |
| `PORT` | `8787` | Local port |
| `LIVE_TRADE` | `1` | `1` allows real orders once signed in; `0` is read-only / quote-only |
| `MAX_TRADE_BNB` | `0.5` | Maximum BNB per buy, a safety valve |
| `NFT_MANUAL_MAX_BNB` | `0.5` | Maximum BNB per manual paid NFT mint |
| `NODEREAL_RPC` / `NODEREAL_KEYS` | empty | Private BSC RPC; keep in `.env` only |
| `BSC_AGENT_PROXY` | auto | Force a proxy, e.g. `http://127.0.0.1:7897`; `none` disables the proxy |
| `BAW_BIN` | `baw` | Path of the Binance wallet CLI |
| `AUTO_TRANSFER_TO` | empty | Auto-transfer destination (can also be set in the app; changing it needs a second confirmation) |
| `NFT_FEED_SYNC` | `1` | Set `0` to stop pulling the NFT feed |
| `NFT_FEED_URL` | author's feed | Use a different NFT data source |
| `BSC_AGENT_UPDATE_REPO` | official repo | Repository the new-version reminder checks |
| `BSC_AGENT_UPDATE` | on | Set `0` to turn the reminder off |
| `MYSQL_URL` / `REDIS_URL` | empty | Optional history cache; `scripts/enable-cache.sh` starts both with Docker |

## FAQ
- **Tokens have no avatars and the pool shows "—"?** Avatars, pool size and charts come from overseas data sites. The app finds a proxy automatically (direct first, then the system proxy, then common ports). If there are still no avatars, open your proxy app, then open **🩺 Self-check** in the footer: under "can reach the market data sites" there is an input box. Paste the HTTP proxy address from your proxy app (like `http://127.0.0.1:port`; look for "HTTP proxy port" or "mixed port" in Clash / V2Ray settings) and click **Save & test**. It takes effect immediately, no restart.
- **An NFT project has no avatar?** The image is read from the contract; some projects don't store one on-chain, so the first letter is shown instead.
- **The top-right says "demo account"?** You are using an old `.env`. Update to the latest version and restart, or delete the `MODE=sim` line from `.env`, or run `cp .env.example .env` again (Windows: `copy .env.example .env`).
- **The top-right says the wallet isn't signed in?** Click it, press **Sign in to Binance wallet** in the window that appears and confirm in the Binance App. You can also run `baw auth signin` in a terminal.
- **A chart has a gap or differs from another site?** History comes from GeckoTerminal and DexScreener, whose free APIs are rate-limited. A yellow note above the chart explains why. For newly opened tokens the history is back-filled in the background, so wait a few minutes. If the network is blocked, set `BSC_AGENT_PROXY`.
- **A buy fails?** The page explains the reason in plain language (insufficient balance, slippage too low, wallet not signed in…). You can also open the self-check.
- **NFT mint says `NETWORK_ERROR`?** Usually your network or proxy can't reach Binance's service. Read-only steps are retried automatically; if it keeps failing, check your proxy. The step that actually sends the transaction is never retried, so you can't be charged twice.
- **Nothing changed after updating the code?** Restart the service and hard-refresh the browser (Cmd / Ctrl + Shift + R).
- **How do I stop all automation?** Use **Pause all** at the top-right and turn off the NFT auto-mint switch, or just stop the service.

## Development and testing
```bash
npm test                    # all unit tests
node --check public/app.js  # front-end syntax check
```
`engine/` is the backend (market data, trading, tracking, sniping, NFT), `public/` is the static front end, and `server.js` is the entry point. Before opening a PR make sure tests pass and that no `.env`, `data/` or personal information is included.

## License and disclaimer
Released under the MIT License, see [LICENSE](LICENSE). `public/vendor/` keeps the license files of its third-party libraries.

Token prices, liquidity, taxes and platform APIs change quickly, and every trade can lose money or become impossible to sell. NFT mint contracts are third-party. The authors do not give investment advice and are not responsible for any financial loss.

# Changelog

[简体中文](CHANGELOG.md) · **English**

> The version number lives in `package.json`. When a newer version exists, the GitHub icon in the top-right shows a red dot and a pop-up.

## 0.3.8
**NFT**
- New-project data is now pushed by the author and pulled automatically every minute — **no Telegram setup needed**. When the author isn't watching, the page shows "feed stopped".

**Interface**
- When the window gets narrower the whole page scales down with the layout unchanged, instead of being cut off or scrolling sideways.
- Fixed the holdings summary cards (profit / loss) splitting the numbers over three lines and stretching the card.

**Docs**
- README rewritten: separate Mac and Windows install steps and a complete feature overview.

## 0.3.7
**New: NFT radar and auto-mint**
- New **NFT** tab: new-project data is watched and pushed by the author and pulled automatically by your app — no setup. Project list, rule matches, mint history and task manager live here; a "Latest NFT" float docks left / right and is visible site-wide. When the author isn't watching, the page says the feed has stopped.
- Auto-mint runs on the server: only free (`value=0`) projects with an Agent ID, optional website / X filters and exclude keywords, every mint passes `baw contract-call preview` first, and paid ones are never auto-executed. Failures retry after 2m / 10m / 30m / 2h (within 12h) and a broadcast transaction is never re-sent. The page shows success / failure reports and totals; the task is not resumed after a restart.
- Task lights at the top: sniper / copy-trade / NFT show green when on, grey when off.

**Interface**
- All sub-navigation now uses the same underline tabs, and the desktop layout stays fixed when the window shrinks.

**Windows**
- Added `install.bat` / `start.bat` for out-of-the-box Windows use; calls to the Binance wallet CLI (`baw.cmd`) are handled.

Restart the service and refresh the page after upgrading; if you ran the watcher by hand before, stop it first.

## 0.3.6
**Interface**
- The token detail header is now a single row: logo / name / address, price and 1h change, market cap / liquidity / volume / holders, name / migration progress / fees / age, plus the star, BscScan, GMGN and quick-quote links on the right. It only wraps when the screen is too narrow.
- Opened (migrated) trench cards: the "Opened · DEX" tag moved into the age / holders row instead of taking a full line, so all three columns have the same card height.

**Fixes**
- The "Migrated" tab in the left list always showed "No tokens": every tab used the "New" column's filter. Each tab now uses the filter of its matching trench column ("Mine" is not filtered).
- "External-chart history unavailable" banner: GeckoTerminal's free API allows about 30 requests a minute and we retried every 5 seconds, which made the limit worse. All requests are now queued (≥ 2 s apart); after a 429 everything cools down for 60 s (doubling on repeats, max 5 min) with no requests during the cooldown. The page shows "recovers in ~N s" and existing candles keep rendering.

**New: free-mint script** `scripts/free-mint.mjs`
- Give it contract addresses: it finds the ABI (Sourcify, falling back to common mint / claim signatures), probes the free quantity with `value=0` simulations, runs a `baw contract-call preview` safety check (aborts on any charge, approval, risk flag or non-NFT inflow), and only then executes, reporting tokenId, tx hash and timings.
- Free (0-value) mints only; paid mints are reported with their price and never executed. Usage: `node scripts/free-mint.mjs 0xContract Name=0xContract [--dry] [--max 10]`; `--dry` checks without sending. Logs go to `data/mint-logs/`.

Restart the service and hard-refresh the page after upgrading.

## 0.3.5
**Speed**
- Transaction confirmation now polls all RPC nodes in parallel and uses the first receipt, so one slow or hung node no longer delays a trade.
- Post-buy background pre-approval is capped to the held amount (not unlimited), so sells don't wait for an approval tx. Enable with `PREAPPROVE=1` in `.env`.

**My Holdings**
- Fixed the "My Holdings" tab always showing an empty table.
- Restyled as a GMGN-like table: token / last active, bought, sold, balance, unrealized, total profit. Sell 25% / 50% / all, claim, swap back to BNB and per-token trade history are kept.
- Removed the "hide dust / cleared" toggle and the Flap / Four / Gang platform filter, so every position is shown.
- The Gang trench side panel no longer appears inside the bottom "My Holdings" tab.

Restart the service and refresh the page after upgrading. The speed changes were not verified on-chain trade by trade; compare timings in `data/latency.jsonl`.

## 0.3.4
- Auto-transfer: removed the "Flap after claim" switch, which had no transfer logic behind it. Only Four / Gang post-launch auto-transfer remains.
- Fix: in Auto-transfer, "Set address" / "Change address" did nothing. The button was treated as a "copy" button; the address form now opens correctly.

## 0.3.3
- Fix: opening a gang.fun fair-launch ("Gang V3 打新") market showed "history failed to load". gang.fun has no trades endpoint for these markets (it returns "not found"), so the app no longer calls it; a failing trades request can no longer break the whole detail view, and gang.fun requests go through the proxy.

## 0.3.2
- Fix: an old `.env` containing `MODE=sim` made the page show "demo account" and stopped it from working out of the box. The public version has no simulation mode and now always starts in live mode (sim is only allowed for development tests).
- Automatic proxy detection: no need to type a proxy port any more. On startup the app tries a direct connection first, then reads the system proxy settings and probes common proxy ports (Clash, V2Ray…). If nothing works, the self-check page has an input box: paste the HTTP proxy address from your proxy app and click Save & test — it takes effect immediately, no restart. Avatars, pool size and charts depend on this.

## 0.3.1
- Maintenance release used to verify the GitHub new-version reminder: older versions will see the red dot on the GitHub icon and the update pop-up. No functional changes.

## 0.3.0
**Interface**
- Redesigned trench cards: name / pool quote asset · tax · launch mode (Gang V1 / V2 / V3, fair launch, Flap, Four — each with a fixed colour) / pool size and tags / age · holders · trades / Dev · first buyer. The useless "volume" line is gone.
- The three trench column headers now have identical width and height; the filter dialog uses the site's colours and is no longer clipped.
- Tracking / gang.fun sniping: green buttons, larger text and cards, a fixed-size switcher and a two-column sniping page.
- Text-style top navigation; the left token list can be resized (double-click to reset).
- Top-right: wallet name and balance aligned right; new GitHub icon with a red dot and pop-up when a new version is out.
- Simplified wallet menu; click the address to copy it.
- First-run guide, self-check page, a "Pause all" button and friendlier error messages.

**Features**
- Single wallet only; all multi-wallet options and scripts removed.
- All simulation / dry-run entry points removed — every action is a real trade. Sniping is now called **gang.fun sniping**, and "max tokens per day" defaults to unlimited.
- New GitHub new-version reminder (checks this repository by default; reminds only, never updates by itself).
- New `/api/selfcheck` and `/api/pause-everything` endpoints.

**Fixes**
- Charts: history requests go through the proxy and retry on failure; external-pool history is now back-filled page by page (it used to cover only the last ~16 hours); when no data is returned the chart shows the reason instead of pretending.
- Wallet display shows the AI account name instead of `true` or "wallet 2 signed in".
- Removed an invalid CSP source warning.

## 0.2.0
- Ready out of the box: live trading by default (manual buy and sell once the Binance wallet is signed in; `MAX_TRADE_BNB` per buy as a safety valve).
- Sniping and copy trading are off by default.
- Launched-token charts merge on-chain trades; direct PancakeSwap trading; search and trade any BSC token by contract address; Gang V3 curve markets, Gang fair launch, Flap Agent-ID gated markets; one-click quote-asset → BNB; `.ai` / `.bnb` reverse lookup and notes; USD pricing; optional MySQL / Redis cache.
- RPC load reduction: backup WSS and a per-minute cap for paid RPC.
- Added `install.sh` / `start.sh`.

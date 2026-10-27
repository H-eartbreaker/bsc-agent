# Changelog

[简体中文](CHANGELOG.md) · **English**

> The version number lives in `package.json`. When a newer version exists, the GitHub icon in the top-right shows a red dot and a pop-up.

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

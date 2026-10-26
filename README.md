<p align="center">
  <img src="public/logo.png" width="120" alt="BSC Agent logo" />
</p>

<h1 align="center">BSC Agent</h1>

<p align="center">本地运行的 BSC 行情、报价和交易终端，带 GMGN 风格战壕。</p>

<p align="center">
  <img src="docs/screenshots/trenches-demo.png" alt="BSC Agent 战壕演示（模拟数据）" />
</p>

BSC Agent 在你的电脑上启动一个只监听 `127.0.0.1` 的 Node.js 服务，并通过浏览器提供界面。它支持 Flap、Four 和 gang.fun 的 BSC 内盘行情；实盘签名由 Binance Agentic Wallet CLI（`baw`）完成，本地不保存私钥。

## 主要功能

- GMGN 风格战壕：新创建、即将打满、已开盘三列
- 市值、持有人、进度、税率、计价币、社交链接、关键词和创建时间筛选
- `Min / Max` 创建时间过滤：超过 Max 分钟仍未发射的代币自动隐藏
- K 线、实时成交、全市场成交、交易者盈亏和持仓页面
- 快捷买入、清仓、滑点设置、授权查看与撤销
- Flap / Four / Gang 行情适配
- 自动买入和自动卖出策略：**功能保留，默认全部关闭，重启后不会自动打开**
- 自动领取、自动转出、卖出后换回 BNB、较大额度预授权：默认关闭
- 模拟盘：不连接钱包、不发送链上交易

## 安全边界

这是会接触真实资金的第三方软件，未经过正式安全审计。请先使用模拟盘，再用极小金额验证。

- 实盘只有在 `MODE=live`、`LIVE_TRADE=1`、钱包已登录、并通过页面确认时才会提交真实订单。
- 自动买入和自动卖出策略默认关闭；只有你在页面里打开对应开关后才会运行。
- 服务器只监听 `127.0.0.1`，不要把端口暴露到公网，也不要做端口转发。
- RPC key、自动转出地址等私密配置只放在本地 `.env`，不要提交到 Git。
- 公开截图使用模拟数据，不包含钱包地址、AI 名称、余额或交易记录。

## 环境要求

- macOS 或 Linux
- Node.js 22 或更高版本
- npm
- 实盘需要 Binance Agentic Wallet CLI

```bash
npm i -g @binance/agentic-wallet
baw auth signin
baw wallet status
```

`baw wallet status` 显示 `CONNECTED` 后，才能使用实盘功能。登录确认必须由本人在 Binance App 中完成。

Four 的 Agent 专属模板还需要 Binance 官方技能：

```bash
npx skills add https://github.com/binance/binance-skills-hub --skill binance-agentic-wallet
```

## 安装和运行

```bash
git clone <你的仓库地址> bsc-agent
cd bsc-agent
npm install
cp .env.example .env
```

先运行模拟盘：

```bash
npm run sim:8787
```

打开 <http://127.0.0.1:8787>。模拟盘只使用本地模拟资产，不调用真实钱包。

确认模拟盘正常后，再按需运行正式行情：

```bash
npm run live:readonly
```

这个模式读取正式行情和钱包状态，但只报价，不发送真实交易。

如果你明确需要真实下单：

```bash
MODE=live LIVE_TRADE=1 PORT=8788 node server.js
```

正式模式启动后，自动策略仍然默认关闭；需要在页面中逐个平台打开自动买入或自动卖出。

## 配置

复制 `.env.example` 为 `.env` 后按需设置：

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `MODE` | `sim` | `sim` 模拟盘，`live` 正式行情 |
| `PORT` | `8787` | 本地端口 |
| `LIVE_TRADE` | `0` | `1` 才允许真实下单；`0` 只报价 |
| `MAX_TRADE_BNB` | `0.5` | 单笔买入上限 |
| `NODEREAL_RPC` | 空 | 可选的私有 BSC RPC，只放 `.env` |
| `BAW_BIN` | `baw` | Agentic Wallet CLI 路径 |
| `AUTO_TRANSFER_TO` | 空 | 自动转出目标地址；留空时自动转出不能打开 |
| `PREAPPROVE` | `0` | 较大额度预授权，建议保持关闭 |

项目数据、日志、缓存和钱包状态都写入本地 `data/`，该目录已被 Git 忽略。

## 开发和测试

```bash
npm test
node --check public/app.js
```

## License

This project is released under the MIT License. You may use, copy, modify, publish, distribute, sublicense, and sell copies of the software, subject to the terms in [LICENSE](LICENSE). `public/vendor/` keeps the license files for its third-party libraries.

## 免责声明

代币价格、流动性、税率和平台接口都可能快速变化。任何交易都可能亏损或无法卖出。作者不提供投资建议，也不对资金损失负责。

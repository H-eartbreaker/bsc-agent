<p align="center">
  <img src="public/logo.png" width="110" alt="BSC Agent logo" />
</p>

<h1 align="center">BSC Agent</h1>

<p align="center"><b>简体中文</b> · <a href="README.en.md">English</a></p>

<p align="center">跑在你自己电脑上的 BSC 行情 + 交易终端<br/>战壕 · K 线 · 一键买卖 · 追踪跟单 · gang.fun 狙击 · NFT 雷达与自动 mint</p>

<p align="center">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-supported-2ea44f?logo=apple&logoColor=white" />
  <img alt="Windows" src="https://img.shields.io/badge/Windows-supported-2ea44f?logo=windows&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/Linux-supported-2ea44f?logo=linux&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

> **一句话**：下载 → 安装 → 启动 → 在浏览器里登录币安钱包，就能用。
> 私钥不在你的电脑上，服务只监听 `127.0.0.1`，不对外开放。

| 系统 | 安装 | 启动 |
|---|---|---|
| **macOS** / Linux | 终端运行 `./install.sh` | 终端运行 `./start.sh` |
| **Windows** | 双击 `install.bat` | 双击 `start.bat` |

---

## 目录
1. [能做什么](#能做什么)
2. [3 分钟上手](#3-分钟上手)
3. [NFT 雷达与自动 mint](#nft-雷达与自动-mint)
4. [页面怎么用](#页面怎么用)
5. [安全须知（请先看）](#安全须知请先看)
6. [更新](#更新)
7. [配置](#配置)
8. [常见问题](#常见问题)
9. [开发与测试](#开发与测试)
10. [许可与免责](#许可与免责)

## 能做什么

**看行情**
- **战壕**：「新创建 / 即将打满 / 已开盘」三列，覆盖 Flap、Four、gang.fun（Gang V1 / V2 / V3、打新）。每张卡片格式固定：名字 → 底池配对币 · 税率 · 发射模式 → 池子 / 标签 → 时长 · 持有人 · 笔数 → Dev / 首买。
- **筛选**：每列 P1 / P2 / P3 三套预设，可按平台、报价代币、创建时间、市值、持有人、进度、税率、社交链接过滤，自动保存。
- **K 线与成交**：已开盘代币合并链上成交和外盘历史，市值 / 价格切换，1 秒到 1 小时多周期，带买卖点标注。
- **行情页**：左栏「内盘中 / 即将发射 / 已迁移 / 我的」，和战壕共用同一套筛选；代币头部一行看全价格、涨幅、市值、底池、成交量、持有人、费率和各平台链接。

**做交易**
- **一键买卖**：快速买入、清仓、滑点设置、授权查看与撤销。买卖走币安聚合，聚合没收录的新池子直连 PancakeSwap V2。
- **追踪 / 跟单**：盯住聪明钱地址，按你设的金额自动跟买，支持止盈止损。
- **gang.fun 狙击**：新盘一出就买，每次买多少、每天最多狙几个（默认不限）、怎么自动卖出，都由你定。
- **全部暂停**：右上角一个按钮，同时停掉追踪和狙击。

**NFT**
- **NFT 雷达**：实时列出新上线的 NFT 项目，只保留需要 Agent ID 的项目；标出哪些符合你的自动 mint 规则。
- **自动 mint**：免费项目自动 mint，只花 gas；付费项目永远手动。
- **手动 mint**：任何项目都能点开手动 mint，数量自己定；付费项目会先报价，并弹窗显示预计花费，二次确认后才会发交易。
- **我的 NFT**：看你 mint 到的每个项目的地板价和成交量，涨到你设的线就提醒（只读，不用 key）。
- **最新 NFT 浮窗**：全站任何页面都能打开，可停靠左 / 右侧。

**省心**
- **任务灯**：顶部「狙击 / 跟单 / NFT」三盏灯，绿灯开着、灰灯关着，不用点进去就知道在不在跑。
- **自检页**：钱包、实盘开关、各模块一眼看清，哪里不对用大白话告诉你。
- **单钱包**：只用你登录的那一个币安 Agentic Wallet，界面里没有多钱包选项。
- **统一界面**：全站子导航统一为下划线页签；窗口变窄时整体等比缩放，布局不乱。

## 3 分钟上手

**环境**：macOS、Windows 或 Linux，加上 **Node.js 22 或更新版本**（到 <https://nodejs.org> 下载安装；Windows 装完后要关掉再重新打开窗口）。

### macOS / Linux
```bash
git clone https://github.com/H-eartbreaker/bsc-agent.git
cd bsc-agent
./install.sh      # 检查 Node、装依赖、生成 .env、安装币安钱包命令行 baw
./start.sh        # 启动，并自动打开 http://localhost:8787
```
- 没装 git？在 GitHub 页面点 **Code → Download ZIP**，解压后在该文件夹里打开终端，运行同样的两条命令。
- 提示「权限不够」时，改用 `bash install.sh` 和 `bash start.sh`。
- 也可以先 `brew install node`（macOS）。

### Windows
1. 在 GitHub 页面点 **Code → Download ZIP**，解压到任意文件夹（装了 git 也可以 `git clone`）。
2. **双击 `install.bat`**：检查 Node、装依赖、生成 `.env`、安装币安钱包命令行 `baw`。
3. **双击 `start.bat`**：启动并自动打开 <http://localhost:8787>。关掉黑色窗口就是退出。
4. 第一次运行时，Windows 防火墙或杀毒软件可能弹窗，选「允许」。如果 `baw` 自动安装失败，用「**以管理员身份**」打开命令提示符，运行：
   ```
   npm i -g @binance/agentic-wallet
   ```

### 第一次打开
页面会弹出**新手引导 + 自检**，按顺序来：
1. **登录币安钱包**：点「**登录币安钱包**」→ 打开它给的链接 → 核对配对码 → 在**币安 App** 里确认。页面会自动检测，不用敲命令。（没装钱包工具时，窗口里会直接给出安装命令，点「复制」粘贴到终端即可。）
2. 点底栏左下角「🩺 自检」，前 4 项都是 ✓ 才算准备好。
3. 在「追踪 / gang.fun 狙击」里设好**每次买多少**，先用很小的金额试一笔。
4. 想停：右上角「全部暂停」。

> **国内网络**：行情站访问不稳时，打开你的代理软件即可，程序会自动找代理；找不到就在「自检」页里填代理地址（见[常见问题](#常见问题)）。

## NFT 雷达与自动 mint

**开箱即用，不需要配置 Telegram。** 新项目由作者的电脑统一监听并发布，你的程序每分钟自动拉取一次，页面里就能看到。

**自动 mint**（「NFT → 自动 mint 管理」里设规则，开关由你手动开、手动关）：
- 只 mint **免费**（付款为 0）且需要 **Agent ID** 的项目，花费只有 gas；付费项目永远不会自动执行。
- 可按官网 / X 条件筛选，可设排除关键词；一次 mint 多少枚按项目允许的上限，也可以改成每项目只 mint 1 枚。没有每日次数限制。
- 每个项目先在链上模拟，再过 `baw contract-call preview` 安全检查，两关都过才发交易。
- 默认只处理**开启之后**出现的新项目（也可在规则里选「也处理已有项目」）；处理过的项目不会重复 mint，失败的会在一段时间内自动重试。
- 开关只由你控制：**刷新页面、重启服务都不会改变它**。开着重启，任务会接着跑；想停就自己关。
- 页面里能看成功 / 失败报告、累计数据和 mint 历史（可按任务时段查）。

**我的 NFT**（「NFT → 我的 NFT」）：列出你 mint 到的项目的地板价、24 小时成交量、总成交量、持有人数。地板价或 24 小时成交量达到你设的线（成交量默认 1 BNB，填 0 不提醒）时，NFT 导航亮红点并弹出提示；检查间隔可选 5 分钟到 24 小时。数据读自 OKX NFT 市场的公开页面，不用 key，只读，不动你的钱包；地板价只是参考，挂单没人买不代表值钱，看 24 小时成交量更准。

**手动 mint**：打开任意项目详情，填数量点「手动 mint」。
- 免费项目：直接 mint。
- 付费项目：先报价（价格、预计 gas、合计、钱包余额），弹窗里**二次确认**后才发交易；单笔有上限（默认 0.5 BNB，可用 `NFT_MANUAL_MAX_BNB` 调整），余额不够会直接拒绝。第一次建议用小额项目试。

**命令行**：`node scripts/free-mint.mjs 0x合约…` 自动试出免费数量、做 `baw` 预览检查后才 mint；`--dry` 只检查不发交易；`--quote --qty N` 只报价。

**要知道的**：
- 推送由作者的电脑提供。作者没开监听时没有新项目，页面会提示「推送已停止」，已有项目和你的设置不受影响。
- 「需要 Agent ID」是根据推送消息里有没有写判断的，没写的项目不会收录。
- 不想用推送：`.env` 里设 `NFT_FEED_SYNC=0`。想换数据源：`NFT_FEED_URL=https://…/nft-feed.json`。
- 项目方合约都是第三方的，**陌生项目风险自担**，mint 完请自己查一下到账。

<details>
<summary><b>自己监听 Telegram、给别人发布推送（作者 / 进阶用户，普通用户跳过）</b></summary>

1. 到 <https://my.telegram.org> 申请 `api_id` / `api_hash`，运行一次 `node scripts/tg-login.mjs` 登录，会话保存在 `data/` 里。
2. 在 `.env` 填 `TG_API_ID`、`TG_API_HASH`、`TG_CHANNEL_ID`（以及需要时的 `TG_PROXY_HOST` / `TG_PROXY_PORT`），重启服务，会自动监听。
3. 想把数据公开给别人：生成一个**只勾 `gist` 权限**的 GitHub 经典令牌，运行 `node scripts/setup-feed-gist.mjs` 按提示粘贴（输入不显示），脚本会建好公开 Gist，把令牌和 Gist ID 写进你本机的 `.env`。
4. 所有凭据只放本机 `.env` 和 `data/`，已被 `.gitignore` 忽略，**不要提交**。公开的 Gist 里只有项目名、合约地址、价格这类公开信息。
</details>

## 页面怎么用
| 位置 | 作用 |
|---|---|
| 顶部 行情 / 战壕 / 持仓 / 追踪 / 狙击 / NFT | 主页面，当前页高亮；各页的子导航在内容区顶部 |
| 顶部任务灯 | 狙击 / 跟单 / NFT，绿灯 = 开着，灰灯 = 关着 |
| 「最新 NFT」按钮 | 全站可用的新项目浮窗，可停靠左 / 右 |
| 右上角 GitHub 图标 | 打开项目仓库；有新版本时亮红点并弹窗提醒 |
| 右上角 钱包名 + 余额 | 点开可复制钱包地址、查看登录状态 |
| 战壕列头 | 搜索关键词、每列 ⚡ 买入金额、P1–P3 预设、提示音、已屏蔽数量、筛选漏斗 |
| 战壕卡片 | 点右侧 MC / 买入区域 ⚡ 买入；⊘ 屏蔽；点卡片看详情 |
| 追踪 / 狙击 | 各自独立页面；设好金额、保存、开启（真实买入） |
| NFT | 项目列表 / 自动 mint 管理 / mint 历史 三个页签 |
| 左侧代币列表 | 宽度可拖动，双击分隔条恢复默认 |
| 底栏 自检 / 版本 | 自检页、版本号与更新提示 |

## 安全须知（请先看）
这是第三方软件，会动真实资金，**没有做过正式安全审计**。请先小额验证。
- 真实下单需要：`MODE=live`、`LIVE_TRADE=1`、钱包已登录，并在页面里确认。
- 追踪 / 狙击默认**关闭**，重启后也**不会自动开启**。
- 服务只监听 `127.0.0.1`，**不要把端口映射到公网**。
- RPC key、转出地址、Telegram 和 GitHub 令牌等私密设置只放本机 `.env`，不要提交到 Git。`data/`（持仓、记录、令牌）已被 `.gitignore` 忽略。
- 自动转出、自动领取、大额预授权默认关闭。
- NFT 自动 mint 只花 gas；付费 mint 必须手动，并经过报价和二次确认。

## 更新
- 程序会定时检查本仓库的版本号；有更高版本时，**右上角 GitHub 图标亮红点并弹出提示**（含更新内容）。可选「稍后提醒」「本版不再提醒」「去 GitHub 看看」。
- **只提醒，不会自动更新。** 更新方法：
  ```bash
  git pull
  npm install
  # 然后重启服务（停掉再 ./start.sh；Windows 关掉黑窗口再双击 start.bat）
  ```
  下载 ZIP 的用户：重新下载新版，把旧文件夹里的 `.env` 和 `data/` 复制过去即可。你的钱包、设置、记录不会被改动。
- 想检查别的仓库：`.env` 里设 `BSC_AGENT_UPDATE_REPO=用户名/仓库名`；想关闭：`BSC_AGENT_UPDATE=0`。
- 每个版本的更新内容见 [CHANGELOG.md](CHANGELOG.md)（[English](CHANGELOG.en.md)）。

## 配置
复制 `.env.example` 为 `.env` 后按需修改（`install.sh` / `install.bat` 已替你做了）：

| 变量 | 默认 | 说明 |
|---|---:|---|
| `MODE` | `live` | 实盘模式 |
| `PORT` | `8787` | 本地端口 |
| `LIVE_TRADE` | `1` | `1` 登录后可真实下单；`0` 只看行情、只报价 |
| `MAX_TRADE_BNB` | `0.5` | 单笔买入上限（BNB），安全阀 |
| `NFT_MANUAL_MAX_BNB` | `0.5` | NFT 手动付费 mint 的单笔上限（BNB） |
| `NODEREAL_RPC` / `NODEREAL_KEYS` | 空 | 私有 BSC 节点，只放 `.env` |
| `BSC_AGENT_PROXY` | 自动 | 手动指定代理，如 `http://127.0.0.1:7897`；填 `none` 表示不用代理 |
| `BAW_BIN` | `baw` | 币安钱包命令行路径 |
| `AUTO_TRANSFER_TO` | 空 | 自动转出地址（也可在页面「自动转出」里设置，改地址要二次确认） |
| `NFT_FEED_SYNC` | `1` | 设 `0` 不拉取 NFT 推送 |
| `NFT_FEED_URL` | 作者的推送源 | 换成别的 NFT 数据源 |
| `BSC_AGENT_UPDATE_REPO` | 官方仓库 | 新版本提醒检查的仓库 |
| `BSC_AGENT_UPDATE` | 开 | 设 `0` 关闭新版本提醒 |
| `MYSQL_URL` / `REDIS_URL` | 空 | 可选历史数据缓存，`scripts/enable-cache.sh` 可用 Docker 一键启动 |

## 常见问题
- **代币没有头像、池子显示「—」？** 头像、池子、K 线都来自国外行情站。程序会自动找代理（先直连，再读系统代理、试常见端口）。还是没有的话：打开代理软件，点底栏「🩺 自检」，在「能连上行情站」下面的输入框里填代理软件里的 HTTP 代理地址（形如 `http://127.0.0.1:端口`，在 Clash / V2Ray 等软件里找「HTTP 代理端口」或「混合端口」），点「保存并测试」，立刻生效，不用重启。
- **NFT 项目没有头像？** 头像是从合约里读出来的，有的项目链上没存图，就显示首字母。
- **右上角显示「演示账号」？** 说明用的是旧的 `.env`。更新到最新版并重启，或删掉 `.env` 里的 `MODE=sim` 那一行，或重新 `cp .env.example .env`（Windows：`copy .env.example .env`）。
- **右上角提示钱包没登录？** 点它，在弹出的窗口里点「登录币安钱包」，到币安 App 确认。也可以在终端运行 `baw auth signin`。
- **K 线缺一段 / 和别的软件不一样？** 历史 K 线来自 GeckoTerminal 和 DexScreener，免费接口有频率限制，页面会出现一行黄色提示说明原因；新打开的币会在后台分页补历史，等几分钟再看。网络不通时请设置 `BSC_AGENT_PROXY`。
- **点买入提示失败？** 页面会用大白话说明原因（余额不够、滑点太低、钱包未登录等）；也可以先打开「自检」。
- **NFT mint 提示 `NETWORK_ERROR`？** 多半是你的网络或代理连不上币安服务。程序会对只读步骤自动重试几次；仍然失败请检查代理，发交易那一步不会自动重试，不会重复扣费。
- **改完代码 / 更新后没变化？** 重启服务，浏览器按 Cmd / Ctrl + Shift + R 强制刷新。
- **怎么彻底停掉自动功能？** 右上角「全部暂停」，并关掉 NFT 自动 mint 开关；或直接关闭服务。

## 开发与测试
```bash
npm test                    # 全部单元测试
node --check public/app.js  # 前端语法检查
```
`engine/` 是后端（行情、交易、追踪、狙击、NFT），`public/` 是静态前端，`server.js` 是入口。提 PR 前请确认测试通过，且没有把 `.env`、`data/` 或任何私人信息带进提交。

## 许可与免责
本项目使用 MIT 许可，见 [LICENSE](LICENSE)；`public/vendor/` 里保留了第三方库的许可证文件。

代币价格、流动性、税率和平台接口随时会变；每一笔交易都可能亏损，甚至无法卖出。NFT mint 的合约来自第三方。作者不提供投资建议，也不对任何资金损失负责。

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = v => v ? v.slice(0,6)+'…'+v.slice(-4) : '—';
export const strategyFields = [
 ['maxPerTrade','每钱包单笔上限 BNB',0.05,0.001,0.5,0.001],['maxPerToken','单币合计上限 BNB',0.05,0,10,0.001],['dailyCap','每日合计上限 BNB',0.2,0,50,0.01],['maxOpen','同时持币上限',5,0,100,1],
 ['maxDelaySec','最大信号延迟 秒',15,1,600,1],['slippage','滑点 %',20,1,50,1],['minTargetBnb','目标最小买入 BNB',0,0,100000,0.001],['maxTargetBnb','目标最大买入 BNB',0,0,100000,0.001],['maxMcUsd','最高市值 USD',0,0,1e9,1000],
 ['takeProfitPct','止盈涨幅 %（0=关闭）',0,0,10000,1],['stopLossPct','止损跌幅 %（0=关闭）',0,0,99,1]
];
export function strategyFieldsMarkup() { return strategyFields.map(([id,label,value,min,max,step])=>`<label>${label}<input id="copy-${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}"/></label>`).join(''); }
export function taskDetailsMarkup(task, {targets=[],wallets=[],log=[],paused=false,execution={}} = {}) {
 const p=task.params||{},stats=task.stats||{},target=targets.find(t=>t.address===task.target);
 const name=target?.remark||target?.name||short(task.target);
 const entry=p.mode==='ratio'?`按对方金额 ${p.ratioPct}% 跟买`:`每个钱包固定 ${p.amountBnb} BNB`;
 const exits=[p.followSell?'目标减仓时按相同比例卖出，清仓时跟清':'不跟卖，需手动卖出',p.takeProfitPct>0?`上涨 ${p.takeProfitPct}% 止盈清仓`:'未设止盈',p.stopLossPct>0?`下跌 ${p.stopLossPct}% 止损清仓`:'未设止损'];
 const names=(p.wallets||[1]).map(slot=>wallets.find(w=>w.slot===slot)?.label||'钱包 '+slot).join(' / ');
 const logs=log.filter(r=>r.task===task.id),last=logs[0];
 const status=paused?'全局暂停':({running:'运行中',paused:'已暂停',closed:'已关闭'}[task.status]||task.status);
 const sim=p.dryRun===true,mode=sim?'模拟 · 不会真实下单':execution.live?'真实下单 · 会动用钱包资金':'真实模式 · 当前实盘通路不可用';
 const activeTokenRows=Object.entries(task.tokens||{}).filter(([,tk])=>sim?Object.values(tk.simLots||{}).some(l=>l.qty>0):tk.open);
 const row=(label,value)=>`<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const exitsShort=[p.followSell?'目标卖我也卖':'不跟卖（手动卖）',p.takeProfitPct>0?`涨 ${p.takeProfitPct}% 止盈`:'',p.stopLossPct>0?`跌 ${p.stopLossPct}% 止损`:''].filter(Boolean).join(' · ');
  const running=task.status==='running'&&!paused, copies=sim?stats.simCopies||0:stats.copies||0;
  const line=[`跟 <b>${esc(name)}</b>`,esc(entry),esc(exitsShort),esc(names),`已跟买 ${copies}/${p.maxCopies||'不限'} 次`].join(' · ');
  return `<article class="copy-task-card" data-task-card="${esc(task.id)}"><header><div class="ct-title"><h3>${esc(task.name||name)}</h3><span class="ct-state ${running?'on':''}">${esc(status)}</span><b class="${sim?'y':'r'}">${sim?'旧测试任务（不会下单）':'真实下单'}</b></div><div class="copy-task-actions">${running?`<button data-copy-action="pause" data-copy-id="${esc(task.id)}">暂停</button>`:`<button class="primary" data-copy-action="${task.status==='closed'?'reopen':'run'}" data-copy-id="${esc(task.id)}">启动</button>`}<button data-copy-action="edit" data-copy-id="${esc(task.id)}">编辑</button><button class="danger" data-copy-action="delete" data-copy-id="${esc(task.id)}">删除</button></div></header>
  <p class="copy-task-line">${line}</p>
 <details data-task-details="${esc(task.id)}"><summary>预算、持仓与执行详情</summary><dl class="copy-task-summary">${row('预算',`每钱包单笔 ≤ ${esc(p.maxPerTrade)} BNB<br>单币合计 ${p.maxPerToken||'不限'} BNB · 每日合计 ${p.dailyCap||'不限'} BNB<br>同时持币 ${p.maxOpen||'不限'} 个`)}${row('触发条件',`延迟 ≤ ${p.maxDelaySec} 秒 · 滑点 ${p.slippage}%<br>对方买入 ${p.minTargetBnb||0}–${p.maxTargetBnb||'不限'} BNB<br>最高市值 ${p.maxMcUsd?'$'+p.maxMcUsd:'不限'}`)}${row('当前结果',`${sim?'模拟跟买':'真实跟买'} ${sim?stats.simCopies||0:stats.copies||0} 次 · ${activeTokenRows.length} 个持币<br>真实累计买入 ${stats.buyBnb||0} BNB · 卖出 ${stats.sellBnb||0} BNB`)}${row('最近触发',last?`${esc(last.symbol||'—')} · ${esc(last.reason)}<small>${esc(new Date(last.ts).toLocaleString())}</small>`:'尚无触发记录：等待目标的新成交；已关闭或暂停时不会跟单。')}</dl>
 ${activeTokenRows.map(([address,tk])=>`<p class="copy-position">${esc(tk.symbol||short(address))} · ${tk.pending||tk.exitPending?'结果待确认，停止自动重试':'监控中'} · <span class="mono">${esc(short(address))}</span></p>`).join('')}
 <p class="muted">止盈止损按本任务买入的成本和实时成交价格触发，仅在服务运行时有效；不保证成交价格。模拟持仓与真实持仓分别记录。</p></details></article>`;
}

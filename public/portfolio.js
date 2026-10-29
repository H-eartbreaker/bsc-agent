export const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export function periodStats(events, prefix) {
  const rows = events.filter(e => dayKey(e.ts).startsWith(prefix)), known = rows.filter(e => Number.isFinite(e.pnl));
  return { rows, pnl: known.reduce((n,e)=>n+e.pnl,0), cost: known.reduce((n,e)=>n+(e.cost||0),0), unknown: rows.length-known.length, sells: rows.length, wins: known.filter(e=>e.pnl>0).length, losses: known.filter(e=>e.pnl<0).length };
}
export function monthCells(month) {
  const [y,m] = month.split('-').map(Number), first = new Date(y,m-1,1), cells = Array((first.getDay()+6)%7).fill(null);
  for(let i=1;i<=new Date(y,m,0).getDate();i++)cells.push(`${month}-${String(i).padStart(2,'0')}`);
  while(cells.length%7)cells.push(null);return cells;
}
// 原生 Canvas 绘制 BSC Agent 自有版式，不读取第三方品牌或邀请信息。
export function drawProfitCard(canvas, { period, stats, showAmount = true }) {
  canvas.width=1200;canvas.height=675;const c=canvas.getContext('2d');
  const font=(size,weight=500)=>c.font=`${weight} ${size}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  c.fillStyle='#0e191e';c.fillRect(0,0,1200,675);
  c.fillStyle='#e8b83f';c.fillRect(0,0,1200,8);font(42,750);c.fillText('BSC Agent',56,85);
  font(19);c.fillStyle='#9aadae';c.fillText('交易复盘 / 已实现盈亏',56,122);c.textAlign='right';c.fillText(period,1144,85);c.textAlign='left';
  c.strokeStyle='#30454d';c.beginPath();c.moveTo(56,156);c.lineTo(1144,156);c.stroke();
  const pct=stats.cost>0?stats.pnl/stats.cost*100:null, empty=!stats.sells;
  c.fillStyle=empty?'#9aadae':stats.pnl>=0?'#22b99e':'#e85b67';font(94,700);
  const value=empty?'暂无卖出':showAmount?`${stats.pnl>=0?'+':'−'}${Math.abs(stats.pnl)>0&&Math.abs(stats.pnl)<0.01?'<$0.01':'$'+Math.abs(stats.pnl).toFixed(2)}`:pct==null?'—':`${pct>=0?'+':'−'}${Math.abs(pct).toFixed(1)}%`;
  c.fillText(value,56,306);font(27,600);c.fillStyle='#e1ebe8';
  c.fillText(showAmount?(pct==null?'收益率 —':`收益率 ${pct>=0?'+':''}${pct.toFixed(1)}%`):'金额已隐藏',60,365);
  font(20);c.fillStyle='#9aadae';c.fillText(`卖出 ${stats.sells} 笔     盈利 ${stats.wins} 笔 / 亏损 ${stats.losses} 笔`,60,440);
  if(stats.unknown){c.fillStyle='#e8b83f';c.fillText(`${stats.unknown} 笔成本不完整，未计入盈亏`,60,480);}
  c.strokeStyle='#30454d';c.beginPath();c.moveTo(56,548);c.lineTo(1144,548);c.stroke();
  font(17);c.fillStyle='#9aadae';c.fillText('按已读取成交与移动平均成本统计 · 不代表全部历史收益',56,588);
  font(15);c.fillText('美元按历史小时价格换算，缺价时估算；不含未实现盈亏。',56,619);
  c.textAlign='right';font(19,650);c.fillStyle='#e8b83f';c.fillText('BSC / 56',1144,619);c.textAlign='left';return canvas;
}

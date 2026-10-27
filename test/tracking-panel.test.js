import test from 'node:test';
import assert from 'node:assert/strict';
import { filteredFeed, feedMarkup, actionLabel, copyLogMarkup } from '../public/tracking-panel.js';

test('tracking filter combines wallet and minimum BNB without accepting unknown amounts', () => {
  const feed = [{target:'0xABC',bnb:0.01},{target:'0xabc',bnb:0.1},{target:'0xdef',bnb:1},{target:'0xabc',bnb:null}];
  assert.deepEqual(filteredFeed(feed,'0xAbC',0.05), [feed[1]]);
  assert.equal(filteredFeed(feed).length,4);
});
test('feed renders untrusted wallet and token names as text and preserves unknown amounts', () => {
  const html = feedMarkup([{target:'0xabc',targetName:'<img src=x onerror=alert(1)>',token:'" onclick="alert(1)',symbol:'<script>x</script>',side:'buy',action:'建仓',bnb:null,ts:Date.now()}]);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('— <small>BNB'));
  assert.ok(html.includes('data-wt-token="&quot; onclick=&quot;'));
});
test('action labels accept both real Chinese tracker events and normalized actions', () => {
  assert.equal(actionLabel({action:'建仓',side:'buy'}),'建仓');
  assert.equal(actionLabel({action:'close',side:'sell'}),'清仓');
  assert.equal(actionLabel({side:'buy'}),'买入');
});

test('copy results identify actual task, target and token, translate result states and only link valid hashes', () => {
  const html = copyLogMarkup([{ts:Date.now(),taskName:'跟单 A',target:'0xabc',symbol:'GANG',kind:'pending',reason:'等待钱包确认',results:[{wallet:'钱包 2',status:'unknown',tx:'javascript:bad'},{wallet:'钱包 1',status:'filled',tx:'0x'+'a'.repeat(64)}]}],[{address:'0xabc',name:'追踪钱包'}]);
  for (const text of ['跟单 A','追踪钱包','GANG','待确认','等待钱包确认','钱包 2','成交']) assert.ok(html.includes(text));
  assert.ok(!html.includes('javascript:'));
  assert.equal((html.match(/bscscan.com/g)||[]).length,1);
  assert.ok(copyLogMarkup([{ts:Date.now(),kind:'sim'}]).includes('未关联代币'));
});

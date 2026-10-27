import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyAuthority } from '../engine/live/copyAuthority.js';

test('copy authority is single-use, bound to task/order and short lived', () => {
  let now=1000; const a=new CopyAuthority('secret',1,()=>now);
  const order={taskId:'t1',slot:1,token:'0xt',side:'buy',amount:0.01,slippage:20,source:'跟单 demo'};
  const grant=a.issue(order); const cap=a.authorize(order,grant); assert.equal(typeof cap,'symbol'); assert.equal(a.consume({...order,walletId:'baw',automaticAuthorization:cap}),true); assert.equal(a.consume({...order,walletId:'baw',automaticAuthorization:cap}),false);
  const late=a.issue(order); now+=30001; assert.equal(a.authorize(order,late),null);
  const other=a.issue(order); assert.equal(a.authorize({...order,amount:0.02},other),null);
});

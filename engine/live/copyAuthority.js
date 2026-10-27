import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
// Signed, short-lived peer grants become single-use process-local capabilities.
export class CopyAuthority {
  constructor(secret, slot, now = Date.now) { this.secret=secret;this.slot=slot;this.now=now;this.seen=new Map();this.permits=new Map(); }
  signature(payload,secret=this.secret) { return createHmac('sha256',secret).update(JSON.stringify(payload)).digest('hex'); }
  issue(order,secret=this.secret) {
    const payload={taskId:order.taskId,slot:order.slot,token:order.token,side:order.side,amount:Number(order.amount),slippage:Number(order.slippage),source:order.source,nonce:randomBytes(16).toString('hex'),expiresAt:this.now()+30000};
    return {payload,signature:this.signature(payload,secret)};
  }
  authorize(order,grant) {
    const p=grant?.payload,signature=grant?.signature;
    if(!p||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!p.taskId||p.slot!==this.slot||p.expiresAt<this.now()||p.expiresAt>this.now()+30000||this.seen.has(p.nonce)) return null;
    if(p.token!==order.token||p.side!==order.side||p.amount!==Number(order.amount)||p.slippage!==Number(order.slippage)||p.source!==order.source||!String(p.source).startsWith('跟单 '))return null;
    if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(this.signature(p),'hex')))return null;
    for(const [key,expiry] of this.seen)if(expiry<this.now())this.seen.delete(key);
    for(const [key,value] of this.permits)if(value.expiresAt<this.now())this.permits.delete(key);
    this.seen.set(p.nonce,p.expiresAt);const permit=Symbol('copy-order');this.permits.set(permit,p);return permit;
  }
  consume(order) {
    const p=this.permits.get(order.automaticAuthorization);this.permits.delete(order.automaticAuthorization);
    return !!p&&p.expiresAt>=this.now()&&order.walletId==='baw'&&p.token===order.token&&p.side===order.side&&p.amount===Number(order.amount)&&p.source===order.source;
  }
}

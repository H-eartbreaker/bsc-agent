import test from 'node:test';
import assert from 'node:assert/strict';
import { nftCandidates, inlineMetadata, NftPortfolio } from '../engine/live/nftPortfolio.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const wallet='0x1111111111111111111111111111111111111111', contract='0x2222222222222222222222222222222222222222';
const log={wallet,dry:false,results:[{status:'成功',contract,name:'TEST',tokenIds:['1','0x01','2']}]};
test('NFT discovery ignores previews, wrong wallets and failed mints and deduplicates IDs',()=>{
  const rows=nftCandidates([log,{...log,dry:true},{...log,wallet:contract},{...log,results:[{...log.results[0],status:'失败',tokenIds:['3']}]}],wallet);
  assert.equal(rows.length,1);assert.deepEqual(rows[0].ids,['1','2']);
});
test('NFT gallery verifies ownership, reports read errors, and caches reads',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'bsc-nft-test-'));let reads=0;
  try{await writeFile(path.join(directory,'log.json'),JSON.stringify(log));const p=new NftPortfolio({directory,contract:()=>({ownerOf:async id=>{reads++;if(id==='2')throw Error('offline');return wallet;},tokenURI:async()=> 'data:application/json;base64,'+Buffer.from(JSON.stringify({image:'data:image/svg+xml;base64,PHN2Zy8+'})).toString('base64')})});
    const a=await p.read(wallet);assert.equal(a.rows[0].count,1);assert.equal(a.rows[0].partial,true);assert.match(a.rows[0].image,/data:image/);await p.read(wallet);assert.equal(reads,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('malformed or remote NFT metadata is never executed or fetched',()=>{assert.equal(inlineMetadata('https://127.0.0.1/private'),null);assert.equal(inlineMetadata('data:application/json,%7Bbad'),null);});

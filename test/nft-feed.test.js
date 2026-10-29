import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nftFeedList, nftFeedOne, readNftFeed } from '../engine/nft/feedApi.js';

const contract = '0x1111111111111111111111111111111111111111';

test('NFT feed API reader filters candidates and sanitizes rows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nft-feed-'));
  const file = path.join(dir, 'nft-feed.json');
  try {
    await writeFile(file, JSON.stringify([
      { contract, name: 'Free', eligible: true, freeOnAgentPath: true, msgId: 12, raw: 'secret text' },
      { contract: '0x2222222222222222222222222222222222222222', name: 'Paid', eligible: false, msgId: 11 },
      { contract: 'bad', name: 'ignored' },
    ]));
    assert.equal(readNftFeed(file).length, 2);
    assert.equal(nftFeedList(file, { eligible: true, since: 10 })[0].contract, contract);
    assert.equal(nftFeedOne(file, contract).name, 'Free');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing NFT feed is an empty read-only result', () => {
  assert.deepEqual(nftFeedList('/tmp/does-not-exist-nft-feed.json'), []);
});

// ビッド練習帳の回答記録（データベースから保存したJSON）を data/ に取り込む
//   node tools/import-answers.js <JSONのフォルダ>
//   → data/answers.json（テスト用）と data/answers.pbn（PBN 2.1）を作る
const fs = require('fs'), path = require('path');
const E = require('../web/engine.js');
const dir = process.argv[2];
if (!dir) { console.error('使い方: node tools/import-answers.js <フォルダ>'); process.exit(1); }
const recs = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .map(d => d.data || d)
  .filter(a => a.status !== 'withdrawn')
  .sort((a, b) => (a.created || '') < (b.created || '') ? -1 : 1);
const keep = recs.map(a => ({ id: a.id, created: a.created, engine: a.engine, dealer: a.dealer, vul: a.vul || 'None',
  deal: a.deal, auction: a.auction, seat: a.seat || 'S', userCall: a.userCall, reason: a.reason || '', doubt: !!a.doubt,
  aiCall: a.aiCall, aiWhy: a.aiWhy || '', aiSource: a.aiSource || '' }));
const out = path.join(__dirname, '..', 'data');
fs.writeFileSync(path.join(out, 'answers.json'), JSON.stringify(keep, null, 1) + '\n');
const tag = (k, v) => `[${k} "${String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"]`;
const lines = ['% PBN 2.1', '% EXPORT', '% ビッド練習帳 — 「次のビッドは？」の回答記録', '% Auctionは問題の時点まで（* = 続きあり）。答えは Answer タグ。', ''];
keep.forEach((a, i) => {
  lines.push(tag('Event', 'Bidding quiz'), tag('Site', ''), tag('Date', (a.created || '').slice(0, 10).replace(/-/g, '.')), tag('Board', i + 1),
    tag('West', 'Pass'), tag('North', 'AI'), tag('East', 'Pass'), tag('South', 'You'),
    tag('Dealer', a.dealer), tag('Vulnerable', a.vul), tag('Deal', a.deal),
    tag('Scoring', ''), tag('Declarer', ''), tag('Contract', ''), tag('Result', ''), tag('Auction', a.dealer));
  const calls = a.auction.map(E.callPbn);
  for (let k = 0; k < calls.length; k += 4) lines.push(calls.slice(k, k + 4).join(' '));
  lines.push('*', tag('QuizSeat', a.seat), tag('Answer', E.callPbn(a.userCall)), tag('AnswerReason', a.reason),
    tag('AIBid', E.callPbn(a.aiCall)), tag('AIReason', a.aiWhy), tag('AISource', a.aiSource),
    tag('AuctionDoubt', a.doubt ? 'yes' : 'no'), tag('Created', a.created || ''), tag('QuizId', a.id), tag('EngineVersion', a.engine || ''), '');
});
fs.writeFileSync(path.join(out, 'answers.pbn'), lines.join('\n'));
console.log(`${keep.length}件を data/answers.json と data/answers.pbn に保存しました`);

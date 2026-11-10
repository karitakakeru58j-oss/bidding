// エンジンの簡単な動作確認: node tools/selftest.js
const E = require('../web/engine.js');
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const H = s => E.pbnToHand(s);
const cases = [
  // [ハンド(♠.♥.♦.♣), オークション(ディーラーから), ディーラー, 期待]
  ['AK2.QJ3.K432.Q32', [], 'N', '1N'],
  ['AK432.QJ3.K4.Q32', [], 'N', '1N'],
  ['AK432.QJ3.K4.Q32'.replace('Q32','932'), [], 'N', '1S'],
  ['K432.A432.KQ2.32', [], 'N', '1D'],
  ['K432.A432.K32.Q2', [], 'N', '1D'],
  ['K432.AQ4.K32.Q32', [], 'N', '1C'],
  ['AKQ2.AKQ3.AK2.32', [], 'N', '2C'],
  ['Q32.KQJ987.32.32', [], 'N', '2H'],
  ['K432.Q432.K2.432', ['1N','P'], 'N', '2C'],
  ['K4322.Q32.32.432', ['1N','P'], 'N', '2H'],
  ['A32.QJ8765.32.K2', ['1N','P'], 'N', '4D'],
  ['K32.QJ876.32.K32', ['1N','P','2D','P'], 'N', '2H'],
  ['K32.QJ876.A2.K32', ['1N','P','2D','P','2H','P'], 'N', '3N'],
  ['32.K32.K432.K432', ['1S','P'], 'N', '1N'],
  ['K32.K432.32.Q432', ['1S','P'], 'N', '2S'],
  ['K432.32.AQ2.K432', ['1S','P'], 'N', '3S'],
  ['K32.J2.AQ32.K432', ['1S','P'], 'N', '2C'],
  ['K32.J2.AQ432.K43', ['1S','P'], 'N', '2D'],
  ['AQ32.K432.KJ32.2', ['1D','P'], 'N', '4C'],
  ['32.K32.AQ432.K32', ['1D','P'], 'N', '2D'],
  ['32.A32.K432.KJ32', ['2C','P'], 'N', '2D'],
  ['32.932.8432.5432', ['2C','P'], 'N', '2H'],
  ['AKQ2.AQJ32.AK.32', ['2C','P','2D','P'], 'N', '2H'],
  ['32.A32.K432.KJ32', ['2C','P','2D','P','2H','P'], 'N', '2S'],
  ['AK32.A32.AK32.32', ['2H','P'], 'N', '2N'],
  ['Q2.KQ9876.32.432', ['2H','P','2N','P'], 'N', '3D'],
];
let ok = 0, ng = 0;
for (const [hs, auc, dlr, exp] of cases) {
  if (!exp) continue;
  const r = E.chooseCall(H(hs), auc, dlr);
  if (r.call === exp) ok++; else { ng++; console.log('NG', hs, auc.join(' '), 'expected', exp, 'got', r.call, r.why); }
}
console.log(`ルールのテスト: ${ok} OK / ${ng} NG`);
// ランダムに配って最後までビッドしてみる（エラーが出ないか）
let fb = 0, total = 0;
for (let i = 0; i < 3000; i++) {
  const hands = E.deal(rnd);
  const dealer = E.SEATS[i % 4];
  const { auction, steps } = E.autoAuction(hands, dealer);
  if (!E.isOver(auction)) { console.log('終わらない', auction.join(' ')); ng++; }
  for (const s of steps) if (s.source !== 'opp') { total++; if (s.source === 'fallback') fb++; }
  if (i < 8) console.log(dealer, E.dealToPbn(hands), '|', auction.map(E.callPbn).join(' '));
}
console.log(`ランダム3000局: ビッド${total}回中 汎用判断 ${fb}回 (${(100*fb/total).toFixed(1)}%)`);
process.exit(ng ? 1 : 0);

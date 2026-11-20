// 2/1 GFになるボードを作る（北オープン → 東パス → 南が2/1 GF。東西はずっとパス）
//   node tools/gen21.js [局数=200] [シード=21]
//   出力：data/gf21/boards.json（web/gf21.json にも同じものを置く。練習帳の「2/1」タブで使う）
//   合計点（南北のHCP）は 25〜28／29〜32／33以上 を 35％／40％／25％ くらいに混ぜる（ゲームかスラムかの境目を多めに）
const fs = require('fs'), path = require('path');
const E = require('../web/engine.js');
const N = Number(process.argv[2] || 200);
let seed = Number(process.argv[3] || 21);
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const TWO_ONE = { '1S': ['2C', '2D', '2H'], '1H': ['2C', '2D'], '1D': ['2C'] };
const bucket = t => t <= 28 ? 0 : t <= 32 ? 1 : 2;
const want = [Math.round(N * 0.35), Math.round(N * 0.40)]; want.push(N - want[0] - want[1]);
const got = [0, 0, 0];
// 2/1の種類も偏らないように（1♠-2♣ばかりにならない）：種類ごとの上限
const kinds = Object.entries(TWO_ONE).flatMap(([o, rs]) => rs.map(r => o + '-' + r));
const cap = Math.ceil(N / kinds.length) + Math.ceil(N * 0.1);
const kindN = {};
const boards = [];
for (let t = 0; t < 3e6 && boards.length < N; t++) {
  const hands = E.deal(rnd);
  const o = E.chooseCall(hands.N, [], 'N', null).call;
  if (!TWO_ONE[o]) continue;
  const r = E.chooseCall(hands.S, [o, 'P'], 'N', null).call;
  if (!TWO_ONE[o].includes(r)) continue;
  const tot = E.evaluate(hands.N).rawHcp + E.evaluate(hands.S).rawHcp, b = bucket(tot);
  if (got[b] >= want[b]) continue;
  const k = o + '-' + r;
  if ((kindN[k] || 0) >= cap) continue;
  got[b]++; kindN[k] = (kindN[k] || 0) + 1;
  boards.push({ deal: E.dealToPbn(hands, 'N'), open: o, resp: r, hcp: tot });
}
// 並びをまぜて番号をつける
for (let i = boards.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [boards[i], boards[j]] = [boards[j], boards[i]]; }
boards.forEach((b, i) => { b.no = i + 1; });
const out = JSON.stringify(boards.map(b => ({ no: b.no, deal: b.deal, open: b.open, resp: b.resp, hcp: b.hcp })));
fs.writeFileSync(path.join(__dirname, '..', 'data', 'gf21', 'boards.json'), out);
fs.writeFileSync(path.join(__dirname, '..', 'web', 'gf21.json'), out);
console.log(boards.length, '局', { 合計点: got, 種類: kindN });

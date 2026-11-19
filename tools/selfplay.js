// AI4体でビッドして、結果をダブルダミー（現実に近づける調整つき）で採点し、損の多い流れを報告する
//   node tools/selfplay.js [局数=100] [出力フォルダ=data/selfplay]
//   採点：web/score.js（敵の手の配り直し・ルールのオープニングリード・ぎりぎりのコントラクトの成功率の割引）
const fs = require('fs'), path = require('path');
const E = require('../web/engine.js');
require('../web/overcall.js');
const S = require('../web/score.js');
const DDS = require('../web/ddsolve.js'); // DDS（web/vendor の WebAssembly）

const N = Number(process.argv[2] || 100);
const outDir = process.argv[3] || path.join(__dirname, '..', 'data', 'selfplay');
try { E.overcall.train(require('../data/overcalls.json')); } catch (e) { /* 学習データがなければそのまま */ }
const solve = DDS.solve;
const SEATS = ['N', 'E', 'S', 'W'];
const sideOf = s => (s === 'N' || s === 'S') ? 'NS' : 'EW';
const ctext = c => c ? `${c.level}${c.strain === 'N' ? 'NT' : c.strain}${c.doubled === 2 ? 'XX' : c.doubled ? 'X' : ''} ${c.declarer}` : 'パスアウト';

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const hands = E.deal(), dealer = SEATS[i % 4];
    const { auction, steps } = E.autoAuction(hands, dealer, null, 60, { full4: true });
    const c = E.contractOf(auction, dealer);
    // 採点はディクレアラー側（パスアウトならNS）から見て、そちらの側の一番良いコントラクトと比べる
    const decSide = c ? sideOf(c.declarer) : 'NS';
    const actual = c ? await S.evalContract(solve, hands, c, auction, dealer) : { exp: 0, pMake: 0, tricks: 0 };
    const best = await S.bestFor(solve, hands, decSide, auction, dealer);
    const bestExp = Math.max(best.exp, 0);
    // ディクレアラー側が失ったIMP（＋なら損）。同じ代・同じスートなら0（ディクレアラーの違いだけ）
    const same = c && best.c && best.c.level === c.level && best.c.strain === c.strain;
    const loss = same ? 0 : S.imps(bestExp - actual.exp);
    const key = auction.filter(x => x !== 'P').slice(0, 3).join('-') || 'パスアウト';
    rows.push({ i, dealer, deal: E.dealToPbn(hands, 'N'), auction, contract: ctext(c), side: decSide,
      exp: Math.round(actual.exp), pMake: Math.round(actual.pMake * 100) / 100, best: ctext(best.c), bestExp: Math.round(bestExp), loss, key,
      fallback: steps.filter(s => s.source === 'fallback').length });
    if ((i + 1) % 10 === 0) console.error(`${i + 1}/${N}局 ${Math.round((Date.now() - t0) / 1000)}秒`);
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 1));
  // 集計：損の大きい局、流れ（最初の3つのビッド）ごとの平均損
  const byKey = {};
  for (const r of rows) { const k = byKey[r.key] || (byKey[r.key] = { n: 0, loss: 0 }); k.n++; k.loss += r.loss; }
  const keys = Object.entries(byKey).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].loss - a[1].loss).slice(0, 15);
  const worst = rows.slice().sort((a, b) => b.loss - a.loss).slice(0, 15);
  let md = `# AI4体の自己対戦（${N}局）\n\n平均の損：${(rows.reduce((t, r) => t + r.loss, 0) / N).toFixed(2)} IMP／局\n\n## 損の大きい流れ（2局以上）\n\n| 流れ | 局数 | 損の合計(IMP) |\n|---|---|---|\n`;
  for (const [k, v] of keys) md += `| ${k} | ${v.n} | ${v.loss} |\n`;
  md += `\n## 損の大きい局\n\n| 損 | オークション | 到達 | 期待得点 | 一番良い | 期待得点 | 配り（N:） |\n|---|---|---|---|---|---|---|\n`;
  for (const r of worst) md += `| ${r.loss} | ${r.auction.join(' ')}（ディーラー${r.dealer}） | ${r.contract} | ${r.exp} | ${r.best} | ${r.bestExp} | ${r.deal} |\n`;
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  console.log(md);
})().catch(e => { console.error(e); process.exit(1); });

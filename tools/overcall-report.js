// 介入（オーバーコール）の回答から、種類ごとに重視しているパラメータを出す
//   node tools/overcall-report.js <overcallsのJSONのフォルダ>   （data/overcalls.json も作る）
const fs = require('fs'), path = require('path');
const E = require('../web/engine.js');
const OC = require('../web/overcall.js');
const dir = process.argv[2];
let recs;
if (dir) {
  recs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).map(d => d.data || d)
    .sort((a, b) => (a.created || '') < (b.created || '') ? -1 : 1);
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'overcalls.json'), JSON.stringify(recs, null, 1) + '\n');
} else recs = require('../data/overcalls.json');
OC.train(recs);
console.log(`介入の回答 ${recs.length}件`);
for (const r of OC.analysis()) {
  console.log(`\n${r.name}：${r.n}件（する${r.yes}・しない${r.n - r.yes}）`);
  console.log('  重視：' + r.order.map(k => OC.PARAM_JA[k]).join(' > '));
  for (const k of OC.PARAMS) console.log(`  ${OC.PARAM_JA[k]}：重み ${r.weights[k].toFixed(2)}　するの平均 ${r.meanYes[k] == null ? '-' : r.meanYes[k].toFixed(1)}　しないの平均 ${r.meanNo[k] == null ? '-' : r.meanNo[k].toFixed(1)}`);
}
// 判断の一致（学習に使ったデータでの当てはまり）
let ok = 0;
for (const r of recs) { const d = OC.decide(E.pbnToDeal(r.deal).S, r.open); if ((d.call !== 'P') === r.decision) ok++; }
if (recs.length) console.log(`\n判断の一致：${ok} / ${recs.length}`);

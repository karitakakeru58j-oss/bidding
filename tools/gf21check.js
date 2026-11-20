// 2/1 GFの入力（db の gf21 コレクションを書き出したJSON）とAIを比べる
//   node tools/gf21check.js data/gf21/answers.json
//   南北のコールを1つずつ、あなたのそれまでのオークションでAIに答えさせて一致を数える（2/1の後＝5番目のコール以降）
const fs = require('fs');
const E = require('../web/engine.js');
const rows = JSON.parse(fs.readFileSync(process.argv[2] || 'data/gf21/answers.json', 'utf8'));
const NTH = ['オープン', '2/1', 'オープナーの2回目', 'レスポンダーの2回目', 'オープナーの3回目', 'レスポンダーの3回目'];
const byTurn = {}, byKey = {}, diffs = [];
let final = 0;
for (const r of rows.sort((a, b) => a.no - b.no)) {
  const hands = E.pbnToDeal(r.deal), a = r.auction;
  const ai = E.autoAuction(hands, 'N', null, 40);
  const ca = E.contractOf(a, 'N'), cb = E.contractOf(ai.auction, 'N');
  if (ca && cb && ca.level === cb.level && ca.strain === cb.strain) final++;
  for (let i = 4; i < a.length; i += 2) {
    const seat = i % 4 === 0 ? 'N' : 'S', ours = a.slice(0, i).filter((c, k) => k % 2 === 0);
    const x = E.chooseCall(hands[seat], a.slice(0, i), 'N', null);
    const t = NTH[ours.length] || `${ours.length + 1}番目`, key = ours.join('-');
    const ok = x.call === a[i];
    for (const [m, k] of [[byTurn, t], [byKey, key]]) { const v = m[k] || (m[k] = { n: 0, ok: 0 }); v.n++; if (ok) v.ok++; }
    if (!ok) diffs.push({ no: r.no, key, seat, user: a[i], ai: x.call, why: x.why, rule: x.ruleId, memo: r.memo || '' });
    if (E.isBid(a[i]) === false && a[i] === 'P') break;
  }
}
console.log(`${rows.length}局。最終コントラクト（代とスート）の一致 ${final}/${rows.length}`);
console.log('\n## 手番ごとの一致');
for (const [k, v] of Object.entries(byTurn)) console.log(`${k}: ${v.ok}/${v.n}`);
console.log('\n## 流れごとの一致（3回以上）');
for (const [k, v] of Object.entries(byKey).filter(([, v]) => v.n >= 3).sort((a, b) => b[1].n - a[1].n)) console.log(`${k}: ${v.ok}/${v.n}`);
console.log('\n## 違ったところ');
for (const d of diffs) console.log(`#${d.no} ${d.key} ${d.seat}：あなた ${d.user} ／ AI ${d.ai}（${d.rule || ''}）${d.why.slice(0, 80)}${d.memo ? '　メモ：' + d.memo.slice(0, 80) : ''}`);

// コントラクトの採点（ダブルダミーを現実に近づける調整つき）
//   1. 敵（ディフェンダー）の2人の手を、オークションと合う形で何通りも配り直して平均する（その局の配りの運を除く）
//   2. オープニングリードはルールで現実的に選び、その後だけダブルダミーで計算する
//   3. ぎりぎりのコントラクトは成功率を割り引く（余裕0トリック＝MARGIN0、1トリック足りない＝MINUS1 の確率でメイク）
// ダブルダミーの計算（solver）は外から渡す：solve(deal, trick, toPlay, trump) → toPlay側が取れる残りのトリック数（Promise）
//   deal = { N:[{suit,rank}], E:[...], S:[...], W:[...] }、trump = 'S'|'H'|'D'|'C'|'NT'
(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.BridgeEngine;
  const SEATS = ['N', 'E', 'S', 'W'], SUITS = ['S', 'H', 'D', 'C'], RANKS = 'AKQJT98765432';
  const CONFIG = { layouts: 16, MARGIN0: 0.75, MINUS1: 0.1 };
  const next = s => SEATS[(SEATS.indexOf(s) + 1) % 4];
  const partner = s => SEATS[(SEATS.indexOf(s) + 2) % 4];
  const side = s => (s === 'N' || s === 'S') ? 'NS' : 'EW';
  const HCP = { A: 4, K: 3, Q: 2, J: 1 };
  const hcpOf = h => SUITS.reduce((t, s) => t + [...h[s]].reduce((u, c) => u + (HCP[c] || 0), 0), 0);

  // 得点（ノンバル）
  function scoreOf(c, tricks) {
    if (!c) return 0;
    const need = c.level + 6, minor = c.strain === 'C' || c.strain === 'D';
    if (tricks < need) { const down = need - tricks; return -(c.doubled ? (c.doubled === 2 ? 2 : 1) * (down === 1 ? 100 : down === 2 ? 300 : down === 3 ? 500 : 500 + (down - 3) * 300) : down * 50); }
    const per = minor ? 20 : 30, mult = c.doubled === 2 ? 4 : c.doubled ? 2 : 1;
    let trickPts = (c.level * per + (c.strain === 'N' ? 10 : 0)) * mult;
    let s = trickPts + (trickPts >= 100 ? 300 : 50);
    if (c.level === 6) s += 500; if (c.level === 7) s += 1000;
    if (c.doubled) s += c.doubled === 2 ? 100 : 50;
    const over = tricks - need;
    s += over * (c.doubled ? (c.doubled === 2 ? 200 : 100) : per);
    return s;
  }
  function imps(diff) {
    const t = [20, 50, 90, 130, 170, 220, 270, 320, 370, 430, 500, 600, 750, 900, 1100, 1300, 1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000];
    const a = Math.abs(diff); let i = 0; while (i < t.length && a >= t[i]) i++;
    return diff < 0 ? -i : i;
  }

  // オープニングリード（ルール）
  function leadCard(hand, trump, partnerSuits, oppSuits) {
    const ranks = s => [...hand[s]];
    const cand = SUITS.filter(s => hand[s].length && s !== trump);
    const seqTop = s => { const x = hand[s]; for (let i = 0; i + 1 < x.length; i++) { const a = RANKS.indexOf(x[i]), b = RANKS.indexOf(x[i + 1]); if (b === a + 1 && a <= RANKS.indexOf('T')) return x[i]; } return null; };
    const pick = (s, card) => ({ suit: s, rank: card });
    // パートナーのスート
    for (const s of partnerSuits) if (hand[s].length && s !== trump) {
      const x = ranks(s);
      if (x.length <= 2) return pick(s, x[0]);
      if (x[0] === 'A' && trump !== 'NT') return pick(s, 'A');
      return pick(s, /[AKQJ]/.test(x[0]) && seqTop(s) ? seqTop(s) : x[x.length - 1]);
    }
    if (trump === 'NT') {
      const s = cand.filter(x => !oppSuits.includes(x)).sort((a, b) => hand[b].length - hand[a].length || hcpS(hand, b) - hcpS(hand, a))[0] || cand[0];
      const x = ranks(s), st = seqTop(s);
      if (st && RANKS.indexOf(st) <= RANKS.indexOf('Q')) return pick(s, st);
      return pick(s, x.length >= 4 ? x[3] : x[x.length - 1]);
    }
    // スートのコントラクト：AK・KQ・QJなどのシークエンス → サイドのシングルトン → 何もないスートのトップ → それ以外は小さいカード
    for (const s of cand) { const st = seqTop(s); if (st && (st === 'A' ? hand[s].includes('K') : true) && RANKS.indexOf(st) <= RANKS.indexOf('J')) return pick(s, st); }
    const single = cand.find(s => hand[s].length === 1 && !hand[s].includes('A') && hand[trump].length <= 3);
    if (single) return pick(single, hand[single]);
    const nothing = cand.filter(s => !/[AKQ]/.test(hand[s]) && !oppSuits.includes(s)).sort((a, b) => hand[b].length - hand[a].length)[0];
    if (nothing) return pick(nothing, hand[nothing][0]);
    const s = cand.filter(x => !hand[x].startsWith('A')).sort((a, b) => hand[b].length - hand[a].length)[0] || cand[0] || trump;
    const x = ranks(s); return pick(s, x[x.length - 1]);
  }
  function hcpS(hand, s) { return [...hand[s]].reduce((u, c) => u + (HCP[c] || 0), 0); }

  // ディフェンダーの手の条件（オークションから大まかに）
  function constraintsOf(auction, dealer) {
    const d = SEATS.indexOf(dealer), cons = {};
    for (const s of SEATS) cons[s] = { minLen: {}, minHcp: 0, maxHcp: 37 };
    let opened = false;
    auction.forEach((c, i) => {
      const seat = SEATS[(d + i) % 4], k = cons[seat];
      if (E.isBid(c)) {
        const lv = Number(c[0]), s = c[1];
        if (!opened) { k.minHcp = Math.max(k.minHcp, lv === 1 ? 11 : 5); opened = true; }
        else k.minHcp = Math.max(k.minHcp, 5);
        if (s !== 'N' && lv <= 3) k.minLen[s] = Math.max(k.minLen[s] || 0, (lv === 1 && (s === 'C' || s === 'D') && !Object.keys(k.minLen).length) ? 3 : 5);
      } else if (c === 'P' && !opened) k.maxHcp = Math.min(k.maxHcp, 12);
    });
    return cons;
  }
  function okHand(h, k) {
    const p = hcpOf(h);
    if (p < k.minHcp || p > k.maxHcp) return false;
    for (const s in k.minLen) if (h[s].length < k.minLen[s]) return false;
    return true;
  }
  // ディクレアラーとダミーの手はそのまま、ディフェンダー2人の26枚を配り直す
  function layouts(deal, declarer, auction, dealer, n, rnd = Math.random) {
    const dum = partner(declarer), d1 = next(declarer), d2 = partner(d1);
    const cons = constraintsOf(auction, dealer);
    const pool = [];
    for (const s of [d1, d2]) for (const su of SUITS) for (const r of deal[s][su]) pool.push(su + r);
    const out = [deal];
    for (let tries = 0; out.length < n && tries < n * 300; tries++) {
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const mk = cards => { const h = { S: '', H: '', D: '', C: '' }; for (const su of SUITS) h[su] = cards.filter(c => c[0] === su).map(c => c[1]).sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b)).join(''); return h; };
      const h1 = mk(pool.slice(0, 13)), h2 = mk(pool.slice(13));
      if (!okHand(h1, cons[d1]) || !okHand(h2, cons[d2])) continue;
      out.push({ [declarer]: deal[declarer], [dum]: deal[dum], [d1]: h1, [d2]: h2 });
    }
    return out;
  }
  const toCards = deal => { const D = {}; for (const s of SEATS) { D[s] = []; for (const su of SUITS) for (const r of deal[s][su]) D[s].push({ suit: su, rank: r }); } return D; };

  // 1つのコントラクトを採点する：{ tricks: 平均トリック, pMake: 成功率, exp: 期待得点（ディクレアラー側から）, n }
  async function evalContract(solve, deal, c, auction, dealer, opts = {}) {
    const cfg = { ...CONFIG, ...opts };
    if (!c) return { tricks: 0, pMake: 0, exp: 0, n: 0 };
    const trump = c.strain === 'N' ? 'NT' : c.strain;
    const leader = next(c.declarer), dummy = partner(c.declarer);
    const dd = SEATS.indexOf(dealer);
    const bidsOf = seat => auction.filter((x, i) => E.isBid(x) && SEATS[(dd + i) % 4] === seat && x[1] !== 'N').map(x => x[1]);
    const lays = layouts(deal, c.declarer, auction, dealer, cfg.layouts, cfg.rnd);
    const need = c.level + 6;
    let tSum = 0, pSum = 0, sSum = 0;
    for (const L of lays) {
      const lead = leadCard(L[leader], trump, bidsOf(partner(leader)), [...bidsOf(c.declarer), ...bidsOf(dummy)]);
      const D = toCards(L);
      D[leader] = D[leader].filter(x => !(x.suit === lead.suit && x.rank === lead.rank));
      const t = await solve(D, [lead], dummy, trump);
      const m = t - need;
      const pm = m >= 1 ? 1 : m === 0 ? cfg.MARGIN0 : m === -1 ? cfg.MINUS1 : 0;
      tSum += t; pSum += pm;
      // 成功：DDのトリック（余裕0・-1なら、ちょうどメイク）、失敗：余裕0・-1なら1ダウン、それ以外はDDのダウン
      const make = scoreOf(c, Math.max(t, need)), fail = scoreOf(c, Math.min(t, need - 1));
      sSum += pm * make + (1 - pm) * fail;
    }
    const n = lays.length;
    return { tricks: tSum / n, pMake: pSum / n, exp: sSum / n, n };
  }
  // ある側の一番良いコントラクト（同じ配り直しで、各スートの最善ディフェンスのDDから成功率の割引をかけて期待得点が最大のもの）
  async function bestFor(solve, deal, seatSide, auction, dealer, opts = {}) {
    const cfg = { ...CONFIG, ...opts };
    const decls = seatSide === 'NS' ? ['N', 'S'] : ['E', 'W'];
    let best = { exp: -Infinity, c: null };
    for (const strain of ['N', 'S', 'H', 'D', 'C']) {
      // ディクレアラーは長さの合計が多い方（NTは点の多い方）
      const decl = strain === 'N' ? (hcpOf(deal[decls[0]]) >= hcpOf(deal[decls[1]]) ? decls[0] : decls[1]) : (deal[decls[0]][strain].length >= deal[decls[1]][strain].length ? decls[0] : decls[1]);
      const lays = layouts(deal, decl, auction, dealer, cfg.layouts, cfg.rnd);
      const tr = [], trump = strain === 'N' ? 'NT' : strain, leader = next(decl), dd = SEATS.indexOf(dealer);
      const bidsOf = seat => auction.filter((x, i) => E.isBid(x) && SEATS[(dd + i) % 4] === seat && x[1] !== 'N').map(x => x[1]);
      for (const L of lays) {
        // 実際のコントラクトと同じく、オープニングリードはルールで選ぶ
        const lead = leadCard(L[leader], trump, bidsOf(partner(leader)), [...bidsOf(decl), ...bidsOf(partner(decl))]);
        const D = toCards(L); D[leader] = D[leader].filter(x => !(x.suit === lead.suit && x.rank === lead.rank));
        tr.push(await solve(D, [lead], partner(decl), trump));
      }
      for (let level = 1; level <= 7; level++) {
        const c = { level, strain, doubled: 0, declarer: decl };
        let s = 0;
        for (const t of tr) { const m = t - (level + 6); const pm = m >= 1 ? 1 : m === 0 ? cfg.MARGIN0 : m === -1 ? cfg.MINUS1 : 0; s += pm * scoreOf(c, Math.max(t, level + 6)) + (1 - pm) * scoreOf(c, Math.min(t, level + 5)); }
        s /= tr.length;
        if (s > best.exp) best = { exp: s, c };
      }
    }
    return best;
  }

  const api = { CONFIG, scoreOf, imps, leadCard, layouts, constraintsOf, evalContract, bestFor, toCards };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BridgeScore = api;
})(typeof window !== 'undefined' ? window : globalThis);

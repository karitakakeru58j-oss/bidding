/*
 * overcall.js — 敵のオープンの直後に介入するか（オーバーコール）を判断・学習する
 *
 * 流れ
 *   1. 候補：手と敵のオープンから「介入し得るなら、どの種類の何のビッドか」を決める
 *      種類：1D / 1M / 2m / 2M / weak（ウィークオーバーコール＝ジャンプ）
 *      1NTオーバーコールは学習しない：1NTオープンと同じ形で補正込み16点以上、オープンのスートにストッパー
 *      （A、Kの2枚以上、Qの2枚以上、Jの3枚以上、または4枚以上）があればビッドする
 *   2. パラメータ（1〜5）：リードショーイング・ゲームの可能性・競り合い・プリエンプト性
 *      最初は目安の式で推定し、あなたの評価がたまると手の特徴から評価を予測するように補正する
 *   3. 判断：種類ごとに「4つのパラメータの重み」を学習し、介入する確率を出す（ロジスティック回帰）
 *      データが少ない種類は、全種類まとめた重みに引き寄せる
 */
(function (root) {
  'use strict';
  const E = root.BridgeEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const { SUITS, SYM, JA_SUIT, evaluate, isBid, rankOf, callText } = E;

  const TYPES = ['1D', '1M', '2m', '2M', 'weak'];
  const TYPE_JA = { '1D': '1♦オーバーコール', '1M': '1Mオーバーコール', '1N': '1NTオーバーコール', '2m': '2mオーバーコール', '2M': '2Mオーバーコール', weak: 'ウィークオーバーコール' };
  const PARAMS = ['lead', 'game', 'compete', 'preempt'];
  const RATED = ['lead', 'game', 'compete']; // あなたが評価するパラメータ（プリエンプト性はビッドで決まる）
  // プリエンプト性：オーバーコールのビッドで決まる
  //   1♦＝1、1M＝2、2m・2♥＝3、2♠・3m＝4、3♥以上＝5
  function preemptOf(call) {
    if (call === '1D') return 1;
    if (call === '1H' || call === '1S') return 2;
    if (call === '2C' || call === '2D' || call === '2H') return 3;
    if (call === '2S' || call === '3C' || call === '3D') return 4;
    return 5;
  }
  const PARAM_JA = { lead: 'リードショーイング', game: 'ゲームの可能性', compete: '競り合い', preempt: 'プリエンプト性' };
  const isMaj = s => s === 'H' || s === 'S';
  const clamp = (x, a = 1, b = 5) => Math.max(a, Math.min(b, x));
  const STR = 'CDHSN';
  const cheapest = (strain, after) => { for (let lv = 1; lv <= 7; lv++) { const c = lv + strain; if (rankOf(c) > rankOf(after)) return c; } return null; };

  // ------------------------------------------------------------------
  // 1. 候補
  // ------------------------------------------------------------------
  function candidate(hand, open) {
    if (!/^1[CDHS]$/.test(open)) return null;
    const h = evaluate(hand), O = open[1];
    const suits = SUITS.filter(s => s !== O).sort((a, b) => h.len[b] - h.len[a] || STR.indexOf(b) - STR.indexOf(a));
    const s = suits[0];
    // ウィーク（ジャンプ）：6枚以上・弱い
    // ただしAKQのうち2枚以上のスートで、ボイドか5-5以上の手はゲームの可能性が高すぎるので普通のオーバーコール
    const strongShape = h.top3(s) >= 2 && (SUITS.some(t => h.len[t] === 0) || SUITS.filter(t => t !== s).some(t => h.len[t] >= 5));
    // ウィークは9点以下（HCP。プリエンプトに点数の下限はない）。10点以上はジャンプせず普通にオーバーコールする
    if (h.len[s] >= 6 && h.rawHcp <= 9 && !strongShape) {
      // 6枚は2の代か3の代（1段ジャンプ）、7枚以上は3の代
      const c1 = cheapest(s, open);
      const jump = (h.len[s] >= 7 ? 3 : Number(c1[0]) + 1) + s;
      if (Number(jump[0]) <= 3) return { type: 'weak', call: jump, suit: s };
    }
    // 1♦オーバーコールの特例：♣のオープンに対して、ほかに5枚スートがなければ♦4枚でもビッドすることがある
    if (h.len[s] < 5) {
      if (O === 'C' && h.len.D >= 4 && h.adjNoLen >= 8 && h.adjNoLen < 18) return { type: '1D', call: '1D', suit: 'D' };
      return null;
    }
    const call = cheapest(s, open);
    const lv = Number(call[0]);
    if (lv === 1 && (h.adjNoLen < 5.5 || h.adjNoLen >= 18)) return null;
    if (lv === 2 && (h.adjNoLen < 7.5 || h.adjNoLen >= 18)) return null;
    const type = lv === 1 ? (s === 'D' ? '1D' : '1M') : (isMaj(s) ? '2M' : '2m');
    return { type, call, suit: s };
  }

  // ------------------------------------------------------------------
  // 2. パラメータ：手の特徴と目安の式
  // ------------------------------------------------------------------
  // 3つのパラメータは、それぞれ次だけから判断する
  //   リードショーイング＝ビッドするスートの内容、ゲームの可能性＝HCP、競り合い＝シェイプ
  function features(hand, open, cand) {
    const h = evaluate(hand);
    const s = cand.suit || (cand.call && cand.call[1] !== 'N' ? cand.call[1] : null);
    const x = s ? hand[s] : '';
    const has = c => x.includes(c) ? 1 : 0;
    const lens = SUITS.map(t => h.len[t]).sort((a, b) => b - a);
    return {
      // スートの内容
      len: s ? h.len[s] : 0, A: has('A'), K: has('K'), Q: has('Q'), J: has('J'), T: has('T'), N9: has('9'),
      two3: s && h.top3(s) >= 2 ? 1 : 0,
      // 点数
      hcp: h.rawHcp, lenB: s ? h.lenB[s] : 0, outside: h.rawHcp - (s ? h.sHcp[s] : 0), // スートの外の点数
      // シェイプ
      l1: lens[0], l2: lens[1], single: SUITS.filter(t => h.len[t] === 1).length, voids: SUITS.filter(t => h.len[t] === 0).length,
      lenO: h.len[open[1]], // 敵のオープンしたスートの長さ（短いほど競り合いの評価が上がる）
    };
  }
  function suitScore(f) { return 1.5 * f.A + 1.2 * f.K + 1.0 * f.Q + 0.8 * f.J + 0.5 * f.T + 0.2 * f.N9 + 1.0 * f.two3; }
  function shapeScore(f) { return Math.max(0, f.l1 + f.l2 - 8) + f.single + 2 * f.voids; }
  // ゲームの可能性はオーバーコールの種類ごとの点数の幅で決める（同じ点数でも種類が違えば評価が違う）
  //   例：1Mはおおむね8〜17点で14点以上なら必ずする → 12〜13点は4。2mはおおむね11〜17点 → 12〜13点は3
  //   1♦は10〜17点（10点でビッドすることはほとんどない）→ 13点で3。2Mは2mとほぼ同じ。ウィークは2〜9点
  const GAME_RANGE = { '1D': [9, 17], '1M': [7, 14], '2m': [9, 16], '2M': [9, 16], weak: [3, 10] };
  function gameOf(hcp, type) {
    const [lo, hi] = GAME_RANGE[type] || [8, 14];
    return clamp(1 + (hcp - lo) * 4 / (hi - lo));
  }
  // 競り合い（シェイプ）も種類ごと：
  //   1♦は4枚でもビッドするので5枚あれば2以上。2mは5枚ではほとんどビッドしない（6322で2）、
  //   2Mは5枚でもゲームの可能性があればビッドする（6322で3）
  function competeOf(f, type, call) {
    // 敵のスートが短いと上がる：ボイド+1、シングルトン+0.6、ダブルトン+0.3、4枚以上-0.4
    const oppAdj = f.lenO === 0 ? 1 : f.lenO === 1 ? 0.6 : f.lenO === 2 ? 0.3 : f.lenO >= 4 ? -0.4 : 0;
    const sh = 1.3 * shapeScore(f) + oppAdj;
    if (type === '1D') return clamp(1 + Math.max(0, f.len - 4) + sh);
    // 3の代のウィークは7枚が基本：6-4は2の代なら最高級だが、3の代では並以下。長さそのものを重く見る
    if (type === 'weak' && call && call[0] === '3')
      return clamp(1.3 + 1.2 * (f.len - 6) + 0.3 * Math.max(0, f.l2 - 3) + 0.5 * f.single + f.voids + oppAdj);
    // 2の代は、オーバーコールするスートの長さでほぼ決まる（5-4やシングルトンは少し上がる程度）
    //   2m：5枚で1、6枚で2、8枚で5。2M：5枚で1〜2、6枚で3前後、7枚で5（2mより高め）
    const side = 0.5 * f.single + f.voids + 0.3 * Math.max(0, f.l2 - 3) + (f.lenO <= 1 ? 0.3 : 0);
    // 7枚目以降は大きく評価する（2♦で1372なら4〜5）
    if (type === '2m') return clamp(1 + 1.0 * (f.len - 5) + 1.5 * Math.max(0, f.len - 6) + side);
    if (type === '2M') return clamp(1.3 + 1.5 * (f.len - 5) + 1.0 * Math.max(0, f.len - 6) + side);
    return clamp(1 + sh);
  }
  function heuristic(f, cand) {
    return {
      lead: clamp(0.2 + 1.3 * suitScore(f)),
      // ウィークのゲームの可能性はスートの外の点数も見る（全体の点数＋外の点数を少し）
      // ウィーク以外は、内容が標準以上のスートの6枚目以降を1枚ごとに+1点として数える（一般原則）
      game: cand.type === 'weak' ? clamp(-0.2 + 0.4 * f.hcp + 0.2 * f.outside) : gameOf(f.hcp + (f.lenB || 0), cand.type),
      compete: competeOf(f, cand.type, cand.call),
      preempt: preemptOf(cand.call),
    };
  }
  // 補正の学習に使う特徴も、パラメータごとに分ける（ほかの要素が混ざらないように）
  // 回答からの補正を学ぶパラメータ。57件の時点では、リードショーイングとゲームの可能性は
  // 補正を学ぶと目安の式より当てはまりが悪くなった（回答が少ない）ので、競り合いだけ学ぶ
  const LEARN = ['compete'];
  // 補正は、その種類の回答が12件以上たまってから使う（少ないうちは目安の式の方が当てはまりが良かった）
  // 補正はウィークだけ2の代と3の代に分ける（競り合いの基準が違う）
  const corrKey = c => c.type === 'weak' ? (c.call && c.call[0] === '3' ? 'weak3' : 'weak2') : c.type;
  const CORR_KEYS = ['1D', '1M', '2m', '2M', 'weak2', 'weak3'];
  const PFEAT = {
    lead: f => [1, f.A, f.K, f.Q, f.J, f.T, f.N9, f.two3, f.len],
    game: f => [1, f.hcp],
    compete: f => [1, f.l1, f.l2, f.single, f.voids, f.lenO],
  };

  // ------------------------------------------------------------------
  // 小さな線形代数（リッジ回帰用）
  // ------------------------------------------------------------------
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < n; i++) {
      let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
      [M[i], M[p]] = [M[p], M[i]];
      if (Math.abs(M[i][i]) < 1e-12) continue;
      for (let k = 0; k < n; k++) if (k !== i) { const r = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= r * M[i][j]; }
    }
    return M.map((r, i) => Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]);
  }
  function ridge(X, y, lam) {
    const d = X[0].length, A = Array.from({ length: d }, () => Array(d).fill(0)), b = Array(d).fill(0);
    X.forEach((x, n) => { for (let i = 0; i < d; i++) { b[i] += x[i] * y[n]; for (let j = 0; j < d; j++) A[i][j] += x[i] * x[j]; } });
    for (let i = 0; i < d; i++) A[i][i] += lam;
    return solve(A, b);
  }
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  // ロジスティック回帰（重みを prior に引き寄せる）
  function logistic(X, y, prior, lam, iters = 3000, lr = 0.05) {
    const w = prior.slice();
    for (let it = 0; it < iters; it++) {
      const g = w.map((wi, i) => lam * (wi - prior[i]));
      X.forEach((x, n) => { const e = sigmoid(x.reduce((t, xi, i) => t + xi * w[i], 0)) - y[n]; for (let i = 0; i < w.length; i++) g[i] += e * x[i]; });
      for (let i = 0; i < w.length; i++) w[i] -= lr * g[i] / Math.max(1, X.length);
    }
    return w;
  }

  // ------------------------------------------------------------------
  // 3. 学習
  //   records: [{deal, open, type, call, params:{lead,game,compete,preempt}, decision:true/false}]
  // ------------------------------------------------------------------
  // 判断の重み：[切片, lead, game, compete, preempt]（パラメータは 3 を中心にする）
  // 判断の重み：[切片, lead, game, compete, preempt, majorGame]
  //   majorGame（ウィークだけ）：アンビッドのメジャー4枚を持つとき、ゲームの可能性が3から上がるほど大きくなる値
  const DEFAULT_W = [0.3, 0.9, 1.2, 0.9, 0.7, 0];
  // 種類ごとの最初の重み。ウィークは強ければいいわけではないので、ゲームの可能性の重みを低めにする
  //   ウィークはスートの内容（リードショーイング）がかなり大事。アンビッドのメジャー4枚＋ゲームの可能性が高いとしないことが多い
  const DEFAULT_WT = { weak: [0.3, 1.6, 0.4, 1.0, 0.7, -1.5] };
  const defW = t => (DEFAULT_WT[t] || DEFAULT_W).slice();
  const px = (p, m4) => [1, ...PARAMS.map(k => p[k] - 3), m4 ? Math.max(0, p.game - 2) : 0];
  // アンビッドのメジャー（敵のオープンでもオーバーコールのスートでもないメジャー）を4枚以上持っているか
  function unbidMajor4(hand, open, call) {
    return ['H', 'S'].some(M => M !== open[1] && M !== call[1] && hand[M].length >= 4);
  }
  let MODEL = null;

  function train(records) {
    const recs = (records || []).filter(r => r && r.params && typeof r.decision === 'boolean' && TYPES.includes(r.type));
    // パラメータの予測（目安の式からのずれを手の特徴から学ぶ）
    const corr = {};
    const rows = [];
    for (const r of recs) {
      const hand = r.hand || E.pbnToDeal(r.deal)[r.seat || 'S'];
      const f = features(hand, r.open, r);
      rows.push({ r, f, hand, base: heuristic(f, r) });
    }
    // 補正は種類ごとに別々に学ぶ（種類が違えば同じ手でも評価が違うので混ぜない）
    for (const t of CORR_KEYS) {
      const rt = rows.filter(o => corrKey(o.r) === t);
      corr[t] = {};
      for (const k of LEARN) corr[t][k] = rt.length >= 12 ? ridge(rt.map(o => PFEAT[k](o.f)), rt.map(o => o.r.params[k] - o.base[k]), 10) : null;
    }
    // プリエンプト性はビッドで決まる値を使う（以前の記録で評価していても置き換える）
    const fixed = recs.map(r => ({ ...r.params, preempt: preemptOf(r.call) }));
    // 判断の重み：種類ごと
    const PX = fixed.map((p, i) => px(p, recs[i].type === 'weak' && unbidMajor4(rows[i].hand, recs[i].open, recs[i].call))), PY = recs.map(r => r.decision ? 1 : 0);
    const pooled = recs.length >= 4 ? logistic(PX, PY, DEFAULT_W, 1) : DEFAULT_W.slice();
    const byType = {};
    for (const t of TYPES) {
      const idx = recs.map((r, i) => r.type === t ? i : -1).filter(i => i >= 0);
      // 判断の重みも種類ごとに学ぶ（ほかの種類の回答は使わない。回答が少ないうちは最初の目安の重みに近い）
      byType[t] = { n: idx.length, yes: idx.filter(i => PY[i]).length, w: idx.length ? logistic(idx.map(i => PX[i]), idx.map(i => PY[i]), defW(t), 1) : defW(t) };
      const mean = (sel) => { const ii = idx.filter(i => PY[i] === sel); return Object.fromEntries(PARAMS.map(k => [k, ii.length ? ii.reduce((t, i) => t + fixed[i][k], 0) / ii.length : null])); };
      byType[t].meanYes = mean(1); byType[t].meanNo = mean(0);
    }
    MODEL = { n: recs.length, corr, pooled, byType, dbl: trainDouble(records) };
    return MODEL;
  }

  function estimate(hand, open, cand) {
    const f = features(hand, open, cand), base = heuristic(f, cand);
    if (!MODEL) return base;
    const out = {};
    for (const k of RATED) { const b = MODEL.corr[corrKey(cand)] && MODEL.corr[corrKey(cand)][k], x = PFEAT[k](f); out[k] = clamp(base[k] + (b ? x.reduce((t, xi, i) => t + xi * b[i], 0) : 0)); }
    out.preempt = base.preempt;
    return out;
  }
  function probability(type, params, m4) {
    const w = MODEL ? MODEL.byType[type].w : defW(type);
    return sigmoid(px(params, type === 'weak' && m4).reduce((t, xi, i) => t + xi * w[i], 0));
  }

  // ------------------------------------------------------------------
  // ダブル（テイクアウト）
  //   形：敵のスートが3枚以下で、敵のスート以外のメジャーがすべて3枚か4枚
  //   強さ：補正込みの点数と敵のスートの枚数で「ダブルする確率」を学ぶ
  //   （239件の回答では、敵のスートが短いほどダブルしやすかった。マイナーの長さは足しても当たりが増えなかった）
  // ------------------------------------------------------------------
  function doubleShape(hand, open) {
    if (!/^1[CDHS]$/.test(open)) return false;
    const O = open[1];
    // 7枚以上のスートがあれば、ダブルせずそのスートでオーバーコールする（1372で1♠に2♦など）
    if (SUITS.some(t => hand[t].length >= 7)) return false;
    return hand[O].length <= 3 && ['H', 'S'].filter(M => M !== O).every(M => hand[M].length >= 3 && hand[M].length <= 4);
  }
  // 敵のスートの持ち方：A以外のアナー（K・Q・J、ほかのアナーと一緒の10）が多いとダブルしない寄り
  //   KQx、AJx、AQ10などは減点、Axxは減点なし
  function oppHonors(hand, open) {
    const x = hand[open[1]];
    return [...x].filter(c => 'KQJ'.includes(c)).length + (x.includes('T') && /[AKQJ]/.test(x) ? 1 : 0);
  }
  const DBL_PRIOR = [0, 1.2, -1, -1]; // [切片, 点数, 敵のスートの枚数, 敵のスートのA以外のアナー]
  let DBL = DBL_PRIOR.slice();
  const dblX = (adj, lenO, hon) => [1, adj - 11.5, lenO - 3, hon];
  function trainDouble(records) {
    // ダブルの形の手で、あなたが「ダブル」を選んだか（ダブルの問題・オーバーコールの問題の両方）
    const rows = (records || []).filter(r => r && r.deal && r.open && (r.type === 'X' || r.action)).map(r => {
      const hand = E.pbnToDeal(r.deal)[r.seat || 'S'];
      return { hand, r };
    }).filter(o => doubleShape(o.hand, o.r.open))
      // スートでオーバーコールした回答は「ダブルかオーバーコールか」の選択なので、ダブルの強さの学習には使わない
      .filter(o => o.r.action !== 'overcall');
    DBL = rows.length ? logistic(rows.map(o => dblX(evaluate(o.hand).adjNoLen, o.hand[o.r.open[1]].length, oppHonors(o.hand, o.r.open))), rows.map(o => (o.r.action === 'double' || (o.r.type === 'X' && o.r.decision)) ? 1 : 0), DBL_PRIOR, 1) : DBL_PRIOR.slice();
    return { n: rows.length, yes: rows.filter(o => o.r.action === 'double' || (o.r.type === 'X' && o.r.decision)).length, w: DBL.slice(),
      // 半々になる点数（敵のスートが1・2・3枚で、A以外のアナーがないとき）
      honW: DBL[3],
      half: DBL[1] > 0.05 ? Object.fromEntries([1, 2, 3].map(n => [n, 11.5 - (DBL[0] + DBL[2] * (n - 3)) / DBL[1]])) : null };
  }
  const doubleProb = (adj, lenO, hon = 0) => sigmoid(dblX(adj, lenO, hon).reduce((t, x, i) => t + x * DBL[i], 0));

  // 1NTオーバーコール（ルール）：1NTオープンの形・補正込み16点以上（19点未満）・オープンのスートに止め
  function ntOvercall(hand, open) {
    const h = evaluate(hand), O = open[1], x = hand[O];
    const stop = h.stopper(O) || (x.includes('Q') && x.length >= 2) || (x.includes('J') && x.length >= 3);
    return E.ntShape(h, { pos: 0 }) && h.adjNoLen >= 16 && h.adjNoLen < 19 && stop;
  }
  // 介入の判断（engine の chooseCall から呼ばれる）
  function decide(hand, open) {
    if (/^1[CDHS]$/.test(open) && ntOvercall(hand, open))
      return { call: '1N', why: `1NTオープンの形で補正込み16点以上、${JA_SUIT[open[1]]}が止まっているので1NTオーバーコール`, cand: { type: '1N', call: '1N' } };
    // ダブルの形なら、点数でダブルするかを決める
    //   ダブルかスートのオーバーコールかは、メジャーの持ち方とスートの内容で決める：
    //   アンビッドのメジャーが4枚 → ダブル寄り（ダブルを優先）
    //   3枚だけ → スートのオーバーコール寄り。ただしスートの内容が悪い（リードショーイング2以下）ならダブル
    const dShape = doubleShape(hand, open);
    let preferOC = null, dNote = '';
    if (dShape) {
      const m4 = ['H', 'S'].some(M => M !== open[1] && hand[M].length >= 4);
      dNote = m4 ? '（アンビッドのメジャーが4枚なのでスートのオーバーコールよりダブル）' : '（アンビッドのメジャーは3枚だが、オーバーコールするスートの内容が悪いのでダブル）';
      const c0 = candidate(hand, open);
      if (!m4 && c0) { const p0 = estimate(hand, open, c0); if (p0.lead > 2) preferOC = { cand: c0, lead: p0.lead }; }
    }
    const dbl = () => {
      const hon = oppHonors(hand, open);
      const adj = evaluate(hand).adjNoLen, pd = doubleProb(adj, hand[open[1]].length, hon);
      if (pd >= 0.5) return { call: 'X', why: `${JA_SUIT[open[1]]}が3枚以下で、ほかのメジャーが3〜4枚なのでダブルの形。補正込み${Math.round(adj * 10) / 10}点・${JA_SUIT[open[1]]}${hand[open[1]].length}枚${hon ? `（A以外のアナー${hon}枚）` : ''}でダブルする確率${Math.round(pd * 100)}%なのでダブル${preferOC ? '（スートでオーバーコールするほどではない）' : candidate(hand, open) ? dNote : ''}`, cand: { type: 'X', call: 'X' }, p: pd };
      return null;
    };
    if (dShape && !preferOC) { const x = dbl(); if (x) return x; }
    const cand = candidate(hand, open);
    if (!cand) return { call: 'P', why: '介入し得る形・強さではないのでパス', cand: null };
    const ocNote = preferOC ? `（ダブルの形だが、アンビッドのメジャーが3枚だけでスートの内容が良い（リードショーイング${preferOC.lead.toFixed(1)}）のでスートでのオーバーコールを優先）` : '';
    const params = estimate(hand, open, cand);
    const m4 = cand.type === 'weak' && unbidMajor4(hand, open, cand.call);
    const p = probability(cand.type, params, m4);
    const ptxt = PARAMS.map(k => `${PARAM_JA[k]}${params[k].toFixed(1)}`).join('・');
    // 2Mオーバーコールを5枚でするのは、ゲームの可能性か競り合いの数値が十分ある手だけ（5332の弱い手はしない）
    //   目安：推定のゲームの可能性＋競り合いが4以上（回答では、5枚の2Mは評価の合計が4以上のときだけしている）
    if (p >= 0.5 && cand.type === '2M' && hand[cand.call[1]].length === 5 && params.game + params.compete < 4)
      return { call: 'P', why: `2Mの候補（${callText(cand.call)}）だが、5枚の2Mはゲームの可能性か競り合いが十分ある手だけ（${ptxt}）なのでパス`, cand, params, p };
    if (p >= 0.5) return { call: cand.call, why: `${TYPE_JA[cand.type]}の候補（${ptxt}）。介入する確率${Math.round(p * 100)}%なので${callText(cand.call)}${ocNote}`, cand, params, p };
    // スートでオーバーコールするほどではないときは、ダブルを考える
    if (preferOC) { const x = dbl(); if (x) return x; }
    return { call: 'P', why: `${TYPE_JA[cand.type]}の候補（${callText(cand.call)}）だが、${ptxt}で介入する確率${Math.round(p * 100)}%なのでパス`, cand, params, p };
  }

  // 分析：種類ごとにどのパラメータを重視しているか
  function analysis() {
    const m = MODEL || train([]);
    return TYPES.map(t => {
      const bt = m.byType[t];
      const weights = Object.fromEntries(PARAMS.map((k, i) => [k, bt.w[i + 1]]));
      const order = PARAMS.slice().sort((a, b) => weights[b] - weights[a]);
      return { type: t, name: TYPE_JA[t], n: bt.n, yes: bt.yes, weights, order, meanYes: bt.meanYes, meanNo: bt.meanNo, majorGame: t === 'weak' ? bt.w[5] : null };
    });
  }

  const api = { oppHonors, doubleShape, doubleProb, get doubleModel() { return MODEL ? MODEL.dbl : trainDouble([]); }, unbidMajor4, ntOvercall, preemptOf, RATED, TYPES, TYPE_JA, PARAMS, PARAM_JA, candidate, features, heuristic, estimate, probability, decide, train, analysis, get model() { return MODEL; } };
  E.overcall = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

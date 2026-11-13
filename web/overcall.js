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
    if (h.len[s] >= 6 && h.adj >= 4 && h.adj < 11 && !strongShape) {
      const c1 = cheapest(s, open), jump = (Number(c1[0]) + 1) + s;
      if (Number(jump[0]) <= 3) return { type: 'weak', call: jump, suit: s };
    }
    if (h.len[s] < 5) return null;
    const call = cheapest(s, open);
    const lv = Number(call[0]);
    if (lv === 1 && (h.adj < 5.5 || h.adj >= 18)) return null;
    if (lv === 2 && (h.adj < 7.5 || h.adj >= 18)) return null;
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
      hcp: h.rawHcp,
      // シェイプ
      l1: lens[0], l2: lens[1], single: SUITS.filter(t => h.len[t] === 1).length, voids: SUITS.filter(t => h.len[t] === 0).length,
    };
  }
  function suitScore(f) { return 1.5 * f.A + 1.2 * f.K + 1.0 * f.Q + 0.8 * f.J + 0.5 * f.T + 0.2 * f.N9 + 1.0 * f.two3; }
  function shapeScore(f) { return Math.max(0, f.l1 + f.l2 - 8) + f.single + 2 * f.voids; }
  // ゲームの可能性はオーバーコールの種類ごとの点数の幅で決める（同じ点数でも種類が違えば評価が違う）
  //   例：1Mはおおむね8〜17点で14点以上なら必ずする → 12〜13点は4。2mはおおむね11〜17点 → 12〜13点は3
  const GAME_RANGE = { '1D': [8, 13], '1M': [7, 14], '2m': [9, 16], '2M': [8, 15], weak: [3, 12] };
  function gameOf(hcp, type) {
    const [lo, hi] = GAME_RANGE[type] || [8, 14];
    return clamp(1 + (hcp - lo) * 4 / (hi - lo));
  }
  function heuristic(f, cand) {
    return {
      lead: clamp(0.2 + 1.3 * suitScore(f)),
      game: gameOf(f.hcp, cand.type),
      compete: clamp(1 + 1.3 * shapeScore(f)),
      preempt: preemptOf(cand.call),
    };
  }
  // 補正の学習に使う特徴も、パラメータごとに分ける（ほかの要素が混ざらないように）
  const PFEAT = {
    lead: f => [1, f.A, f.K, f.Q, f.J, f.T, f.N9, f.two3, f.len],
    game: f => [1, f.hcp],
    compete: f => [1, f.l1, f.l2, f.single, f.voids],
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
  const DEFAULT_W = [0.3, 0.9, 1.2, 0.9, 0.7];
  const px = p => [1, ...PARAMS.map(k => p[k] - 3)];
  let MODEL = null;

  function train(records) {
    const recs = (records || []).filter(r => r && r.params && typeof r.decision === 'boolean' && TYPES.includes(r.type));
    // パラメータの予測（目安の式からのずれを手の特徴から学ぶ）
    const corr = {};
    const rows = [];
    for (const r of recs) {
      const hand = r.hand || E.pbnToDeal(r.deal)[r.seat || 'S'];
      const f = features(hand, r.open, r);
      rows.push({ r, f, base: heuristic(f, r) });
    }
    // 補正は種類ごとに別々に学ぶ（種類が違えば同じ手でも評価が違うので混ぜない）
    for (const t of TYPES) {
      const rt = rows.filter(o => o.r.type === t);
      corr[t] = {};
      for (const k of RATED) corr[t][k] = rt.length >= 5 ? ridge(rt.map(o => PFEAT[k](o.f)), rt.map(o => o.r.params[k] - o.base[k]), 6) : null;
    }
    // プリエンプト性はビッドで決まる値を使う（以前の記録で評価していても置き換える）
    const fixed = recs.map(r => ({ ...r.params, preempt: preemptOf(r.call) }));
    // 判断の重み：全体 → 種類ごと（全体に引き寄せる）
    const PX = fixed.map(p => px(p)), PY = recs.map(r => r.decision ? 1 : 0);
    const pooled = recs.length >= 4 ? logistic(PX, PY, DEFAULT_W, 1) : DEFAULT_W.slice();
    const byType = {};
    for (const t of TYPES) {
      const idx = recs.map((r, i) => r.type === t ? i : -1).filter(i => i >= 0);
      // 判断の重みも種類ごとに学ぶ（ほかの種類の回答は使わない。回答が少ないうちは最初の目安の重みに近い）
      byType[t] = { n: idx.length, yes: idx.filter(i => PY[i]).length, w: idx.length ? logistic(idx.map(i => PX[i]), idx.map(i => PY[i]), DEFAULT_W, 1) : DEFAULT_W.slice() };
      const mean = (sel) => { const ii = idx.filter(i => PY[i] === sel); return Object.fromEntries(PARAMS.map(k => [k, ii.length ? ii.reduce((t, i) => t + fixed[i][k], 0) / ii.length : null])); };
      byType[t].meanYes = mean(1); byType[t].meanNo = mean(0);
    }
    MODEL = { n: recs.length, corr, pooled, byType };
    return MODEL;
  }

  function estimate(hand, open, cand) {
    const f = features(hand, open, cand), base = heuristic(f, cand);
    if (!MODEL) return base;
    const out = {};
    for (const k of RATED) { const b = MODEL.corr[cand.type] && MODEL.corr[cand.type][k], x = PFEAT[k](f); out[k] = clamp(base[k] + (b ? x.reduce((t, xi, i) => t + xi * b[i], 0) : 0)); }
    out.preempt = base.preempt;
    return out;
  }
  function probability(type, params) {
    const w = MODEL ? MODEL.byType[type].w : DEFAULT_W;
    return sigmoid(px(params).reduce((t, xi, i) => t + xi * w[i], 0));
  }

  // 1NTオーバーコール（ルール）：1NTオープンの形・補正込み16点以上（19点未満）・オープンのスートに止め
  function ntOvercall(hand, open) {
    const h = evaluate(hand), O = open[1], x = hand[O];
    const stop = h.stopper(O) || (x.includes('Q') && x.length >= 2) || (x.includes('J') && x.length >= 3);
    return E.ntShape(h, { pos: 0 }) && h.adj >= 16 && h.adj < 19 && stop;
  }
  // 介入の判断（engine の chooseCall から呼ばれる）
  function decide(hand, open) {
    if (/^1[CDHS]$/.test(open) && ntOvercall(hand, open))
      return { call: '1N', why: `1NTオープンの形で補正込み16点以上、${JA_SUIT[open[1]]}が止まっているので1NTオーバーコール`, cand: { type: '1N', call: '1N' } };
    const cand = candidate(hand, open);
    if (!cand) return { call: 'P', why: '介入し得る形・強さではないのでパス', cand: null };
    const params = estimate(hand, open, cand);
    const p = probability(cand.type, params);
    const ptxt = PARAMS.map(k => `${PARAM_JA[k]}${params[k].toFixed(1)}`).join('・');
    if (p >= 0.5) return { call: cand.call, why: `${TYPE_JA[cand.type]}の候補（${ptxt}）。介入する確率${Math.round(p * 100)}%なので${callText(cand.call)}`, cand, params, p };
    return { call: 'P', why: `${TYPE_JA[cand.type]}の候補（${callText(cand.call)}）だが、${ptxt}で介入する確率${Math.round(p * 100)}%なのでパス`, cand, params, p };
  }

  // 分析：種類ごとにどのパラメータを重視しているか
  function analysis() {
    const m = MODEL || train([]);
    return TYPES.map(t => {
      const bt = m.byType[t];
      const weights = Object.fromEntries(PARAMS.map((k, i) => [k, bt.w[i + 1]]));
      const order = PARAMS.slice().sort((a, b) => weights[b] - weights[a]);
      return { type: t, name: TYPE_JA[t], n: bt.n, yes: bt.yes, weights, order, meanYes: bt.meanYes, meanNo: bt.meanNo };
    });
  }

  const api = { ntOvercall, preemptOf, RATED, TYPES, TYPE_JA, PARAMS, PARAM_JA, candidate, features, heuristic, estimate, probability, decide, train, analysis, get model() { return MODEL; } };
  E.overcall = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

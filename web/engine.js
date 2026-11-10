/*
 * engine.js — ビッドを決める「AI」本体
 *
 * 仕組み（3段構え）
 *   1. ルール表（RULES）: ビッドシステムを「この流れで、こういう手なら、このビッド」と書いた表。
 *      上から順に調べて、最初に当てはまったものを選ぶ。
 *   2. 汎用判断（fallback）: ルール表にない流れでは、パートナーの示した点数・枚数から
 *      「合計点とフィット」でゲーム/パートスコアを判断する。
 *   3. あなたの回答例（examples）: 同じオークションの流れで、点数・形がほぼ同じ手に
 *      あなたが別のビッドを答えていたら、ルールよりあなたの答えを優先する。
 *
 * ブラウザでもNode.jsでも動くように書いてある。
 */
(function (root) {
  'use strict';

  const ENGINE_VERSION = '0.5.3';
  const SUITS = ['S', 'H', 'D', 'C'];           // 表示順（♠♥♦♣）
  const STRAINS = ['C', 'D', 'H', 'S', 'N'];     // ビッドの順位
  const RANKS = 'AKQJT98765432';
  const SEATS = ['N', 'E', 'S', 'W'];
  const SYM = { S: '♠', H: '♥', D: '♦', C: '♣', N: 'NT' };
  const JA_SUIT = { S: 'スペード', H: 'ハート', D: 'ダイヤ', C: 'クラブ', N: 'ノートランプ' };

  // ------------------------------------------------------------------
  // コール（ビッド）の基本操作。内部表記: "1C".."7N", "P"
  // ------------------------------------------------------------------
  function isBid(c) { return /^[1-7][CDHSN]$/.test(c); }
  function rankOf(c) { return (Number(c[0]) - 1) * 5 + STRAINS.indexOf(c[1]); }
  function levelOf(c) { return Number(c[0]); }
  function strainOf(c) { return c[1]; }
  function callText(c) {
    if (c === 'P') return 'パス';
    if (c === 'X') return 'ダブル';
    if (c === 'XX') return 'リダブル';
    return c[0] + SYM[c[1]];
  }
  function callPbn(c) {
    if (c === 'P') return 'Pass';
    if (!isBid(c)) return c;
    return c[0] + (c[1] === 'N' ? 'NT' : c[1]);
  }
  function parseCall(s) {
    s = String(s).trim().toUpperCase();
    if (s === 'PASS' || s === 'P' || s === 'AP') return 'P';
    if (s === 'X' || s === 'XX') return s;
    const m = s.match(/^([1-7])(NT|N|C|D|H|S)$/);
    return m ? m[1] + m[2][0] : null;
  }
  function gameLevel(strain) { return strain === 'N' ? 3 : (strain === 'H' || strain === 'S') ? 4 : 5; }

  // ------------------------------------------------------------------
  // ハンドの評価
  // hand = {S:'AKQ2', H:'T9', D:'...', C:'...'}（強い順の文字列）
  // ------------------------------------------------------------------
  const HCP = { A: 4, K: 3, Q: 2, J: 1 };
  function evaluate(hand) {
    const len = {}, sHcp = {};
    let hcp = 0;
    for (const s of SUITS) {
      len[s] = hand[s].length;
      sHcp[s] = 0;
      for (const c of hand[s]) sHcp[s] += HCP[c] || 0;
      hcp += sHcp[s];
    }
    const sorted = SUITS.map(s => len[s]).sort((a, b) => b - a);
    const pattern = sorted.join('');
    const balanced = pattern === '4333' || pattern === '4432' || pattern === '5332';
    const count = (s, set) => [...hand[s]].filter(c => set.includes(c)).length;
    const h = {
      hand, len, sHcp, hcp, pattern, balanced,
      top3: s => count(s, 'AKQ'),
      top5: s => count(s, 'AKQJT'),
      stopper: s => {
        const x = hand[s], n = x.length;
        return x.includes('A') || (x.includes('K') && n >= 2) || (x.includes('Q') && n >= 3) || (x.includes('J') && n >= 4);
      },
      longest: () => SUITS.slice().sort((a, b) => len[b] - len[a] || STRAINS.indexOf(b) - STRAINS.indexOf(a))[0],
      shortSuits: () => SUITS.filter(s => len[s] <= 1),
      twoLongest: sorted[0] + sorted[1],
    };
    // 強さの補正（端数）：3枚以上のスートの10=1/3、5枚以上のスートのA・K=1/2、Q・J=1/3（1スート最大1点）
    //   2枚以下のスートで、より強い札（A・K）がないQ・Jは0.5点減らす（Qx=1.5、Jx=0.5、QJ=2。QT・JTは減らさない）
    let bonus = 0;
    for (const s of SUITS) {
      const x = hand[s];
      const shortBare = x.length <= 2 && !/[AKT]/.test(x);
      let long = 0;
      for (const c of x) {
        if (shortBare && (c === 'Q' || c === 'J')) bonus -= 1 / 2; // Qx=1.5点、Jx=0.5点、QJ=2点
        if (c === 'T' && x.length >= 3) bonus += 1 / 3;
        if (x.length >= 5) long += (c === 'A' || c === 'K') ? 1 / 2 : (c === 'Q' || c === 'J') ? 1 / 3 : 0;
      }
      bonus += Math.min(1, long);
    }
    h.bonus = bonus;
    h.rawHcp = hcp;             // 補正なしのHCP（表示・回答例の比較用）
    h.adj = hcp + bonus;        // 補正込みの点数（「強め／弱め」を含めた強さ）
    h.hcp = h.adj;              // ルールの点数はすべて補正込みで判断する
    // ダミーポイント：スート s にフィットを示すとき、サイドのショートに点を足す（K・Q・Jのシングルトンは足さない）
    //   pLen = パートナーがそのスートに持っていると分かっている最低枚数
    // 5-5・6-4のように2スートで10枚以上ある手は、そのどちらかがフィットしたら+1.5（11枚なら+2.5…）
    const twoSuiter = s => {
      const top2 = SUITS.slice().sort((a, b) => len[b] - len[a]).slice(0, 2);
      const sum = len[top2[0]] + len[top2[1]];
      return top2.includes(s) && len[s] >= 4 && sum >= 10 ? 1.5 + (sum - 10) : 0;
    };
    h.dpBonus = (s, pLen) => {
      const mine = len[s];
      let t1 = null; // [シングルトン, ボイド]
      if (pLen >= 5 && mine === 3) t1 = [1, 3];
      else if (pLen === 3 && mine >= 5) t1 = [1, 3];   // 自分の5枚以上にパートナーの3枚（逆向き）
      else if (pLen >= 5 && mine >= 4) t1 = [4, 5];
      else if (pLen === 4 && mine === 4) t1 = [3, 5];
      else if (pLen === 4 && mine >= 5) t1 = [4, 5];
      if (!t1) return 0;
      let b = twoSuiter(s);
      if (pLen >= 5 && mine >= 5) b += mine - 4;     // 5枚以上のサポートは1枚ごとに+1
      for (const o of SUITS) if (o !== s) { if (len[o] === 1 && !/[KQJ]/.test(hand[o])) b += t1[0]; else if (len[o] === 0) b += t1[1]; }
      return b;
    };
    h.dp = (s, pLen) => h.adj + h.dpBonus(s, pLen); // ダミーポイント（補正込み）
    // 長いスートを切り札にするとき：パートナーの平均枚数 pAvg と合わせたフィットの大きさで、サイドのショートを加点
    //   8枚 → シングルトン+1／ボイド+3、8.5枚 → +2.5／+4、9枚以上 → +4／+5
    h.dpLong = (s, pAvg) => {
      const f = len[s] + pAvg;
      const t1 = f >= 9 ? [4, 5] : f >= 8.5 ? [2.5, 4] : f >= 8 ? [1, 3] : null;
      let b = 0;
      if (t1) for (const o of SUITS) if (o !== s) { if (len[o] === 1 && !/[KQJ]/.test(hand[o])) b += t1[0]; else if (len[o] === 0) b += t1[1]; }
      return h.adj + b;
    };
    return h;
  }

  // ------------------------------------------------------------------
  // パターン照合
  // "1M 1N" のように書く。M=メジャー、m=マイナー、X=任意のスート、
  // Y=Xと別のスート。同じ文字は同じスートを指す。'*'=何でも1つ。
  // ------------------------------------------------------------------
  const VAR_OK = {
    M: s => s === 'H' || s === 'S',
    m: s => s === 'C' || s === 'D',
    X: s => s !== 'N',
    Y: s => s !== 'N',
    Z: s => s !== 'N',
  };
  const patCache = {};
  function matchSeq(pattern, seq) {
    const toks = patCache[pattern] || (patCache[pattern] = pattern.trim() ? pattern.trim().split(/\s+/) : []);
    if (toks.length !== seq.length) return null;
    const b = {};
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i], c = seq[i];
      if (t === '*') continue;
      if (t.length !== 2 || !(t[1] in VAR_OK)) { if (t !== c) return null; continue; }
      if (!isBid(c) || c[0] !== t[0]) return null;
      const v = t[1], s = c[1];
      if (!VAR_OK[v](s)) return null;
      if (b[v] && b[v] !== s) return null;
      if (!b[v] && Object.values(b).includes(s)) return null; // 違う文字は違うスート
      b[v] = s;
    }
    return b;
  }
  function fill(tpl, b) {
    if (tpl === 'P') return 'P';
    return tpl.replace(/[MmXYZOW]/g, ch => {
      if (ch === 'O') return b.M === 'H' ? 'S' : 'H'; // O = もう一方のメジャー
      return b[ch];
    });
  }

  // ------------------------------------------------------------------
  // 「何を示したか」の記録（パートナーの点数・枚数の推定に使う）
  // ------------------------------------------------------------------
  function freshKnow() {
    return { hcp: [0, 37], S: [0, 13], H: [0, 13], D: [0, 13], C: [0, 13], bal: false, stop: [] };
  }
  function merge(know, shows) {
    if (!shows) return;
    for (const k of Object.keys(shows)) {
      if (k === 'bal') { know.bal = know.bal || shows.bal; continue; }
      if (k === 'stop') { for (const s of shows.stop) if (!know.stop.includes(s)) know.stop.push(s); continue; }
      if (!Array.isArray(know[k])) continue; // agree / interest / ctrl はスラムの仕組みで使う
      const [a, b] = shows[k];
      const lo = Math.max(know[k][0], a), hi = Math.min(know[k][1], b);
      know[k] = lo <= hi ? [lo, hi] : [a, b];
    }
  }
  const BAL_SHOWS = { S: [2, 5], H: [2, 5], D: [2, 5], C: [2, 5], bal: true };

  // ------------------------------------------------------------------
  // ルール表
  //   seq   : ここまでの自分たちのビッドの流れ
  //   call  : 選ぶビッド（M,m,X,O などはパターンで決まったスート）
  //   test  : (h, c) => このハンドで選ぶか
  //   shows : このビッドが示す内容（パートナーから見た情報）
  //   force : 1=1巡フォーシング, 'GF'=ゲームフォーシング
  //   why   : 説明文
  // ------------------------------------------------------------------
  const RULES = [];
  let ruleSeq = 0;
  function R(seq, call, test, shows, why, force) {
    RULES.push({ id: 'r' + (++ruleSeq), seq, call, test, shows: shows || null, why, force: force || 0 });
  }
  // 手によってビッドが変わるルール：pick(h,c) → {call, why} / null、
  // interp(call, b, seqBefore) → {shows, force} / null（パートナーから見た意味）
  function RD(seq, pick, interp) {
    RULES.push({ id: 'r' + (++ruleSeq), seq, dyn: true, pick, interp });
  }
  // seq には文字列パターンのほか、関数（seq → 束縛 / null）も使える
  const matchRule = (r, seq) => typeof r.seq === 'function' ? r.seq(seq) : matchSeq(r.seq, seq);
  // a以上・(b+1)未満。補正で端数が付いても「6〜8点」に8.67点が入るようにする
  const between = (x, a, b) => x >= a && x < b + 1;
  // オープンの強さ：補正込み11.5点以上。
  //   1・2番手：AAKだけ（Q・Jなし、Aが2枚以上）の11点もオープン
  //   4番手：12.5点以上、またはスペード5枚以上で「点数＋スペードの枚数」が15以上
  const opens = (h, c) => {
    const pos = c ? c.pos : 0;
    if (pos === 3) return h.adj >= 12.5 || (h.len.S >= 5 && h.adj + h.len.S >= 15);
    if (h.adj >= 11.5) return true;
    const honors = SUITS.map(s => h.hand[s].replace(/[^AKQJ]/g, '')).join('');
    return pos < 2 && h.adj >= 11 && !/[QJ]/.test(honors) && (honors.match(/A/g) || []).length >= 2;
  };
  // ウィーク2のスートの質：トップ3枚中2枚、またはトップ3枚中1枚＋10以上の札が3枚
  const goodWeak = (h, s) => h.top3(s) >= 2 || (h.top3(s) >= 1 && h.top5(s) >= 3);
  const sideAce = (h, s) => SUITS.some(o => o !== s && h.hand[o].includes('A'));
  const early = c => (c.pos || 0) < 2; // 1番手・2番手

  // ===== パス済みのパートナーの応答へのオープナー =====
  R(seq => seq.length === 2 && seq.every(isBid) && seq[0][0] === '1' && seq[1][0] === '1' && seq[1][1] !== 'N' ? { Y: seq[1][1] } : null,
    'P', (h, c) => c.respPassed && h.adj < 14.5 && h.len[c.b.Y] >= 4,
    null, 'パートナーはパス済みなのでゲームの可能性はない。フィットがあり最低点なので、低いレベルでプレイするためにパス');
  // ===== オープニング =====
  R('', 'P', (h, c) => c.pos === 3 && h.adj < 22 && !opens(h, c), { hcp: [0, 12.49] }, '4番手で3人がパスしている。ゲームの可能性は低く、スペードが短いのでオープンぎりぎりの強さではパス（4番手は12.5点以上か、点数＋スペードの枚数が15以上でオープン）');
  R('', '2C', h => h.hcp >= 22, { hcp: [22, 37] }, '22点以上なのでストロング2♣オープン', 1);
  R('', '2N', h => h.balanced && between(h.hcp, 20, 21), { hcp: [20, 21], ...BAL_SHOWS }, 'バランスハンド20〜21点なので2NTオープン');
  // 1NTの形：バランスハンド、またはシングルトンがA・K・Qの4441・5431。
  //   5431は、5枚スートの内容が悪い（AKQが1枚以下かつAKQJ10が3枚以下）か、パートナーがパスしているときだけ
  const ntShape = (h, c) => {
    if (h.balanced) return true;
    const single = SUITS.find(s => h.len[s] === 1);
    if (!single || !/[AKQ]/.test(h.hand[single])) return false;
    if (h.pattern === '4441') return true;
    if (h.pattern !== '5431') return false;
    const five = SUITS.find(s => h.len[s] === 5);
    return (h.top3(five) <= 1 && h.top5(five) <= 3) || (c && c.pos >= 2);
  };
  R('', '1N', (h, c) => ntShape(h, c) && between(h.hcp, 15, 17), { hcp: [15, 17], ...BAL_SHOWS, S: [1, 5], H: [1, 5], D: [1, 5], C: [1, 5] },
    h => h.balanced ? 'バランスハンド15〜17点なので1NTオープン'
      : h.pattern === '4441' ? '15〜17点で、シングルトンがA・K・Qなので1NTオープン'
      : '15〜17点の5431。シングルトンがA・K・Qで、5枚スートの内容が悪いかパートナーがパスしている（そのスートのスラムを逃す心配が小さい）ので1NTオープン');
  for (const s of ['S', 'H', 'D']) {
    R('', '2' + s, (h, c) => h.len[s] === 6 && between(h.hcp, 5, 10) && !opens(h, c) && goodWeak(h, s) && !(early(c) && sideAce(h, s)) &&
      (s === 'D' || h.len[s === 'S' ? 'H' : 'S'] < 4),
      { hcp: [5, 10], [s]: [6, 6] }, `${JA_SUIT[s]}6枚・5〜10点なのでウィーク2${SYM[s]}`);
  }
  for (const s of ['S', 'H', 'D', 'C']) {
    R('', '3' + s, (h, c) => h.len[s] >= 7 && between(h.hcp, 5, 10) && !opens(h, c) && h.longest() === s,
      { hcp: [5, 10], [s]: [7, 13] }, `${JA_SUIT[s]}7枚以上・5〜10点なので3レベルのプリエンプト`);
  }
  R('', '1S', (h, c) => opens(h, c) && h.len.S >= 5 && h.len.S >= h.len.H, { hcp: [11.5, 21], S: [5, 13] }, 'スペード5枚以上でオープニングの強さがあるので1♠（5枚メジャー）');
  R('', '1H', (h, c) => opens(h, c) && h.len.H >= 5, { hcp: [11.5, 21], H: [5, 13], S: [0, 5] }, 'ハート5枚以上でオープニングの強さがあるので1♥（5枚メジャー）');
  R('', '1D', (h, c) => opens(h, c) && (h.len.D > h.len.C || (h.len.D === h.len.C && h.len.D >= 4)),
    { hcp: [11.5, 21], D: [3, 13], S: [0, 4], H: [0, 4] }, '5枚メジャーがなく、ダイヤが長い（4-4以上の同じ長さもダイヤ）ので1♦');
  R('', '1C', (h, c) => opens(h, c), { hcp: [11.5, 21], C: [2, 13], S: [0, 4], H: [0, 4] }, '5枚メジャーがなく、クラブが長い（3-3はクラブ）ので1♣');
  R('', 'P', () => true, { hcp: [0, 11.49] }, 'オープンする強さ（補正込み11.5点）がないのでパス');

  // ===== NTオープン後の仕組み（1NT, 2NT, 2♣-2♦-2NT など共通） =====
  function ntSystem(prefix, lo, hi, L, name) {
    const p = prefix ? prefix + ' ' : '';
    const game = 25 - lo, inv = game - 2, quant = 31 - lo, slam = 33 - lo;
    const mid = (lo + hi) / 2;
    const accept = h => h.hcp >= lo + 1;           // 招待を受ける
    const acceptQ = h => h.hcp >= hi;              // 4NT（クオンティタティブ）を受ける
    const st = L + 'C', tH = L + 'D', tS = L + 'H'; // ステイマン / トランスファー
    const N2 = L === 2;
    const ntNote = `（${name}は${lo}〜${hi}点）`;
    // --- レスポンス ---
    R(prefix, '4D', h => h.len.H >= 6 && h.len.H >= h.len.S && between(h.dpLong('H', 3), game, quant - 1), { H: [6, 13], hcp: [game, quant - 1] },
      `ハート6枚以上でゲームの点数があるのでテキサス・トランスファー（4♦→4♥）${ntNote}`);
    R(prefix, '4H', h => h.len.S >= 6 && between(h.dpLong('S', 3), game, quant - 1), { S: [6, 13], hcp: [game, quant - 1] },
      `スペード6枚以上でゲームの点数があるのでテキサス・トランスファー（4♥→4♠）${ntNote}`);
    const stOk = h => {
      const four = h.len.H === 4 || h.len.S === 4;
      const five = h.len.H >= 5 || h.len.S >= 5;
      const need = N2 ? inv : game;
      return h.hcp >= need && ((four && !five) || (h.len.H >= 4 && h.len.S >= 4));
    };
    R(prefix, st, stOk, { hcp: [N2 ? inv : game, 37] }, `4枚メジャーがあり、${N2 ? '招待' : 'ゲーム'}以上の点数があるのでステイマン${ntNote}`, 1);
    R(prefix, tS, h => h.len.S >= 5 && h.len.S >= h.len.H, { S: [5, 13] }, `スペード5枚以上なのでジャコビー・トランスファー（${callText(tS)}→${L}♠）`, 1);
    R(prefix, tH, h => h.len.H >= 5, { H: [5, 13] }, `ハート5枚以上なのでジャコビー・トランスファー（${callText(tH)}→${L}♥）`, 1);
    if (N2) R(prefix, '2N', h => between(h.hcp, inv, game - 1), { hcp: [inv, game - 1], S: [0, 3], H: [0, 3] }, `4枚メジャーがなく${inv}〜${game - 1}点なので2NTで招待${ntNote}`);
    R(prefix, '3N', h => between(h.hcp, game, quant - 1), { hcp: [game, quant - 1], S: [0, 4], H: [0, 4] }, `メジャーのフィットを探す必要がなく、ゲームの点数（${game}点以上）があるので3NT${ntNote}`);
    R(prefix, '4N', h => between(h.hcp, quant, slam - 1) && h.balanced, { hcp: [quant, slam - 1] }, `スラムの可能性があるので4NT（クオンティタティブ＝スラムへの招待）${ntNote}`);
    R(prefix, '6N', h => between(h.hcp, slam, slam + 3) && h.balanced, { hcp: [slam, slam + 3] }, `合計で33点以上あるので6NT${ntNote}`);
    R(prefix, 'P', h => h.hcp < (N2 ? inv : game), { hcp: [0, (N2 ? inv : game) - 1] }, `ゲームの可能性が低いのでパス${ntNote}`);

    // --- ステイマンへの答え ---
    R(p + st, L + 'H', h => h.len.H >= 4, { H: [4, 5] }, 'ステイマンへの答え：ハート4枚あり（スペード4枚の可能性もある）');
    R(p + st, L + 'S', h => h.len.S >= 4, { S: [4, 5], H: [2, 3] }, 'ステイマンへの答え：スペード4枚あり、ハート4枚なし');
    R(p + st, L + 'D', () => true, { S: [2, 3], H: [2, 3] }, 'ステイマンへの答え：4枚メジャーなし');
    // --- ステイマン後のレスポンダー ---
    const afterSt = (ans, fitSuit) => {
      const q = p + st + ' ' + ans;
      if (fitSuit) {
        if (N2) R(q, '3' + fitSuit, h => h.len[fitSuit] >= 4 && between(h.dp(fitSuit, 4), inv, game - 1), { [fitSuit]: [4, 5], hcp: [inv, game - 1] }, `${JA_SUIT[fitSuit]}でフィットが見つかったので3${SYM[fitSuit]}で招待`);
        R(q, '4' + fitSuit, h => h.len[fitSuit] >= 4 && h.dp(fitSuit, 4) >= game, { [fitSuit]: [4, 5], hcp: [game, 37] }, `${JA_SUIT[fitSuit]}でフィットが見つかり、ゲームの点数があるので4${SYM[fitSuit]}`);
      }
      if (N2) R(q, '2N', h => between(h.hcp, inv, game - 1), { hcp: [inv, game - 1] }, 'メジャーのフィットがなかったので2NTで招待（もう一方のメジャー4枚を持っている）');
      R(q, '3N', h => between(h.hcp, game, quant - 1), { hcp: [game, quant - 1] }, 'メジャーのフィットがなかったので3NT（もう一方のメジャー4枚を持っている）');
      R(q, '4N', h => between(h.hcp, quant, slam - 1), { hcp: [quant, slam - 1] }, 'フィットはないがスラムの可能性があるので4NT（クオンティタティブ）');
      R(q, '6N', h => h.hcp >= slam, { hcp: [slam, 37] }, '合計33点以上あるので6NT');
      R(q, 'P', () => true, null, 'ゲームの点数がないのでパス');
    };
    afterSt(L + 'D', null);
    afterSt(L + 'H', 'H');
    afterSt(L + 'S', 'S');
    // --- ステイマン後のオープナー ---
    if (N2) {
      R(p + st + ' 2D 2N', '3N', accept, { hcp: [lo + 1, hi] }, '招待を受けるので3NT');
      R(p + st + ' 2D 2N', 'P', () => true, null, '最低点なので招待を断ってパス');
      R(p + st + ' 2H 2N', '4S', h => h.len.S >= 4 && accept(h), { S: [4, 4] }, 'パートナーはスペード4枚を持っているのでスペードのフィット。招待を受けて4♠');
      R(p + st + ' 2H 2N', '3S', h => h.len.S >= 4, { S: [4, 4] }, 'スペードのフィットはあるが最低点なので3♠');
      R(p + st + ' 2H 2N', '3N', accept, null, '招待を受けて3NT');
      R(p + st + ' 2H 2N', 'P', () => true, null, '最低点なのでパス');
      R(p + st + ' 2H 3H', '4H', accept, null, '招待を受けて4♥');
      R(p + st + ' 2H 3H', 'P', () => true, null, '最低点なのでパス');
      R(p + st + ' 2S 2N', '3N', accept, null, '招待を受けて3NT');
      R(p + st + ' 2S 2N', 'P', () => true, null, '最低点なのでパス');
      R(p + st + ' 2S 3S', '4S', accept, null, '招待を受けて4♠');
      R(p + st + ' 2S 3S', 'P', () => true, null, '最低点なのでパス');
    }
    R(p + st + ' ' + L + 'H 3N', '4S', h => h.len.S >= 4, null, 'パートナーはスペード4枚を持っているので4♠に直す');
    for (const a of ['D', 'H', 'S']) {
      R(p + st + ' ' + L + a + ' 4N', '6N', acceptQ, null, '最高点なのでスラムへの招待を受けて6NT');
      R(p + st + ' ' + L + a + ' 4N', 'P', () => true, null, '最高点ではないのでパス');
    }

    // --- トランスファーの完了 ---
    for (const [tr, M] of [[tH, 'H'], [tS, 'S']]) {
      if (N2) R(p + tr, '3' + M, h => h.len[M] >= 4 && h.hcp >= hi, { [M]: [4, 5], hcp: [hi, hi] }, `最高点で${JA_SUIT[M]}4枚のサポートがあるのでスーパーアクセプト（3${SYM[M]}）`);
      R(p + tr, L + M, () => true, null, `トランスファーに応じて${L}${SYM[M]}`);
      const done = p + tr + ' ' + L + M;
      if (N2) {
        R(done, '2N', h => h.len[M] === 5 && between(h.hcp, inv, game - 1), { [M]: [5, 5], hcp: [inv, game - 1] }, `${JA_SUIT[M]}5枚で招待の点数なので2NT`);
        R(done, '3' + M, h => h.len[M] >= 6 && between(h.dpLong(M, 3), inv, game - 1), { [M]: [6, 13], hcp: [inv, game - 1] }, `${JA_SUIT[M]}6枚以上で招待の点数なので3${SYM[M]}`);
      }
      R(done, '3N', h => h.len[M] === 5 && between(h.hcp, game, quant - 1), { [M]: [5, 5], hcp: [game, quant - 1] }, `${JA_SUIT[M]}5枚でゲームの点数なので3NT（パートナーに4${SYM[M]}か3NTを選んでもらう）`);
      R(done, '4' + M, h => h.len[M] >= 6 && h.dpLong(M, 3) >= game, { [M]: [6, 13], hcp: [game, 37] }, `${JA_SUIT[M]}6枚以上でゲームの点数なので4${SYM[M]}`);
      R(done, '4N', h => h.len[M] === 5 && h.hcp >= quant, { [M]: [5, 5], hcp: [quant, 37] }, 'スラムの可能性があるので4NT（クオンティタティブ）');
      R(done, 'P', () => true, null, 'ゲームの可能性が低いのでパス（トランスファーでスートを決めた）');
      if (N2) {
        R(p + tr + ' 3' + M, '4' + M, h => h.hcp >= inv - 3, null, 'パートナーがスーパーアクセプトしたのでゲームに上がる');
        R(p + tr + ' 3' + M, 'P', () => true, null, '点数がないのでパス');
        R(done + ' 2N', '4' + M, h => h.len[M] >= 3 && accept(h), null, `${JA_SUIT[M]}3枚以上で招待を受けるので4${SYM[M]}`);
        R(done + ' 2N', '3' + M, h => h.len[M] >= 3, null, `${JA_SUIT[M]}3枚以上あるが最低点なので3${SYM[M]}`);
        R(done + ' 2N', '3N', accept, null, `${JA_SUIT[M]}2枚で招待を受けるので3NT`);
        R(done + ' 2N', 'P', () => true, null, '最低点なのでパス');
        R(done + ' 3' + M, '4' + M, accept, null, '招待を受けてゲームへ');
        R(done + ' 3' + M, 'P', () => true, null, '最低点なのでパス');
      }
      R(done + ' 3N', '4' + M, h => h.len[M] >= 3, null, `${JA_SUIT[M]}3枚以上あるので4${SYM[M]}を選ぶ`);
      R(done + ' 3N', 'P', () => true, null, `${JA_SUIT[M]}が2枚なので3NTのまま`);
      R(done + ' 4N', '6' + M, h => acceptQ(h) && h.len[M] >= 3, null, '最高点でフィットがあるのでスラム');
      R(done + ' 4N', '6N', acceptQ, null, '最高点なのでスラム');
      R(done + ' 4N', 'P', () => true, null, '最高点ではないのでパス');
    }
    // --- テキサス ---
    R(p + '4D', '4H', () => true, null, 'テキサス・トランスファーに応じて4♥');
    R(p + '4H', '4S', () => true, null, 'テキサス・トランスファーに応じて4♠');
    R(p + '4D 4H', 'P', () => true, null, 'テキサスでゲームに決めたのでパス');
    R(p + '4H 4S', 'P', () => true, null, 'テキサスでゲームに決めたのでパス');
    // --- NTレイズへの対応 ---
    if (N2) {
      R(p + '2N', '3N', accept, null, '招待を受けて3NT');
      R(p + '2N', 'P', () => true, null, '最低点なので招待を断ってパス');
    }
    R(p + '3N', 'P', () => true, null, 'パートナーがゲームを決めたのでパス');
    R(p + '4N', '6N', acceptQ, null, '最高点なのでスラムへの招待を受けて6NT');
    R(p + '4N', 'P', () => true, null, '最高点ではないのでパス');
    R(p + '6N', 'P', () => true, null, 'スラムに決まったのでパス');
  }
  ntSystem('1N', 15, 17, 2, '1NT');
  ntSystem('2N', 20, 21, 3, '2NT');
  ntSystem('2C 2D 2N', 22, 24, 3, '2♣→2NT');
  ntSystem('2C 2H 2N', 22, 24, 3, '2♣→2NT');
  ntSystem('2C 2D 2H 2S 2N', 25, 27, 3, '2♣→コキッシュ→2NT');

  // ===== 1メジャーオープン後 =====
  // 強さはダミーポイント（DP）で数える。サポートがないときはHCP。
  const supDp = (h, c) => h.dp(c.b.M, 5);
  // --- 4枚以上サポート ---
  //   1♥: 2♠=16点以上 / 2NT=強めの6〜8 / 3♣=9〜10 / 3♦=11〜弱めの12 / 3♥=3〜弱めの6
  //       3♠=強めの12〜15（ショートなし）/ 3NT・4♣・4♦=スプリンター（♠・♣・♦が1枚以下、12〜15）
  //   1♠: 2NT / 3♣ / 3♦ / 3♥ / 3♠、3NT=強めの12〜15 / 4♣・4♦・4♥=スプリンター
  const LADDER = {
    H: { gf: '2S', s68: '2N', r910: '3C', r1112: '3D', weak: '3H', s1215: '3S', spl: { S: '3N', C: '4C', D: '4D' } },
    S: { gf: '2N', s68: '3C', r910: '3D', r1112: '3H', weak: '3S', s1215: '3N', spl: { C: '4C', D: '4D', H: '4H' } },
  };
  const sup4 = (h, c) => h.len[c.b.M] >= 4;
  const splSuit = (h, M) => SUITS.filter(o => o !== M && h.len[o] <= 1).sort((a, b) => h.len[a] - h.len[b])[0] || null;
  for (const M of ['H', 'S']) {
    const L = LADDER[M], o = '1' + M, sym = SYM[M], name = JA_SUIT[M];
    const dpOf = h => h.dp(M, 5);
    R(o, L.gf, h => h.len[M] >= 4 && dpOf(h) >= 16, { [M]: [4, 13], hcp: [16, 37], agree: M },
      `${name}4枚以上のサポートで16点以上（ダミーポイント）なので${callText(L.gf)}（ゲームフォーシングのレイズ）`, 'GF');
    for (const [short, call] of Object.entries(L.spl)) {
      R(o, call, h => h.len[M] >= 4 && (v => v >= 12.5 && v < 16)(dpOf(h)) && splSuit(h, M) === short, { [M]: [4, 13], [short]: [0, 1], hcp: [12.5, 15.99], agree: M, ctrl: [short] },
        `${name}4枚以上のサポートで強めの12〜15点（ダミーポイント）、${JA_SUIT[short]}が1枚以下なのでスプリンター（${callText(call)}）`, 'GF');
    }
    R(o, L.s1215, h => h.len[M] >= 4 && (v => v >= 12.5 && v < 16)(dpOf(h)), { [M]: [4, 13], hcp: [12.5, 15.99], agree: M },
      `${name}4枚以上のサポートで強めの12〜15点（ダミーポイント）、ショートなしなので${callText(L.s1215)}`, 'GF');
    R(o, L.r1112, h => h.len[M] >= 4 && (v => v >= 11 && v < 12.5)(dpOf(h)), { [M]: [4, 13], hcp: [11, 12.49] },
      `${name}4枚以上のサポートで11〜弱めの12点（ダミーポイント）なので${callText(L.r1112)}`, 1);
    R(o, L.r910, h => h.len[M] >= 4 && (v => v >= 9 && v < 11)(dpOf(h)), { [M]: [4, 13], hcp: [9, 10.99] },
      `${name}4枚以上のサポートで9〜10点（ダミーポイント）なので${callText(L.r910)}`, 1);
    R(o, L.s68, h => h.len[M] >= 4 && (v => v >= 6.5 && v < 9)(dpOf(h)), { [M]: [4, 13], hcp: [6.5, 8.99] },
      `${name}4枚以上のサポートで強めの6〜8点（ダミーポイント）なので${callText(L.s68)}`, 1);
    R(o, L.weak, h => h.len[M] >= 4 && (v => v >= 3 && v < 6.5)(dpOf(h)), { [M]: [4, 13], hcp: [3, 6.49] },
      `${name}4枚以上のサポートで3〜弱めの6点（ダミーポイント）なので${callText(L.weak)}（弱いレイズ）`);
  }
  R('1H', '1S', h => h.len.S >= 4 && ((h.len.H < 3 && h.adj > 4) || (h.len.H === 3 && h.dp('H', 5) >= 11)), { S: [4, 13], hcp: [4, 37] },
    h => h.len.H === 3 ? 'スペード4枚以上。ハート3枚のサポートもあるが11点以上なのでまず1♠' : 'スペード4枚以上・4点を超えるので1♠（1巡フォーシング）', 1);
  // --- 3枚サポート: 1NT=3〜5 / 2M=6〜10 / 1NT→3M=11〜12 / 2/1=13以上 ---
  const pts = (h, c) => h.len[c.b.M] === 3 ? supDp(h, c) : h.adj; // 2/1の強さ
  R('1S', '2H', (h, c) => pts(h, c) >= 13 && h.len.H >= 5 && h.len.H >= h.len.D && h.len.H >= h.len.C, { H: [5, 13], hcp: [13, 37] }, 'ハート5枚以上・13点以上なので2/1の2♥（ゲームフォーシング）', 'GF');
  R('1M', '2D', (h, c) => pts(h, c) >= 13 && h.len.D >= 4 && h.len.D > h.len.C, { D: [4, 13], hcp: [13, 37] }, '13点以上でダイヤが長いので2/1の2♦（ゲームフォーシング）', 'GF');
  R('1M', '2C', (h, c) => pts(h, c) >= 13 && h.len.C >= 3, { C: [3, 13], hcp: [13, 37] }, '13点以上なので2/1の2♣（ゲームフォーシング。クラブは3枚のこともある）', 'GF');
  R('1M', '2D', (h, c) => pts(h, c) >= 13 && h.len.D >= 3, { D: [3, 13], hcp: [13, 37] }, '13点以上なので2/1の2♦（ゲームフォーシング）', 'GF');
  R('1M', '2M', (h, c) => h.len[c.b.M] === 3 && between(supDp(h, c), 6, 10), (b) => ({ [b.M]: [3, 3], hcp: [4, 10] }), 'サポート3枚で6〜10点（ダミーポイント）なので2メジャー');
  R('1M', '1N', (h, c) => h.len[c.b.M] === 3 && (between(supDp(h, c), 11, 12) || between(supDp(h, c), 4, 5) || (between(supDp(h, c), 3, 3) && h.hand[c.b.M].includes('K'))) || ((h.adj >= 6 || (h.adj > 4 && SUITS.some(s => h.hand[s].includes('A')))) && h.adj < 13),
    (b) => ({ hcp: [3, 12], ...(b.M === 'H' ? { S: [0, 3] } : {}) }), (h, c) => h.len[c.b.M] === 3 && supDp(h, c) >= 11
      ? 'サポート3枚で11〜12点（ダミーポイント）なので、まずセミフォーシング1NT（次に3メジャーにジャンプ）'
      : h.len[c.b.M] === 3 && supDp(h, c) < 6 ? (supDp(h, c) < 4 ? '切り札のKを持つサポート3枚で3点（ダミーポイント）なのでセミフォーシング1NT' : 'サポート3枚で4〜5点（ダミーポイント）なのでセミフォーシング1NT')
      : '6〜12点でほかに適当なビッドがないのでセミフォーシング1NT');
  R('1M', 'P', () => true, { hcp: [0, 5] }, '弱いのでパス');

  // オープナーのリビッド：1M-2M（3枚サポート・6〜10）
  const opDp = (h, c) => h.dp(c.b.M, 3); // オープナーもフィットが分かったらダミーポイントで数える
  R('1M 2M', '4M', (h, c) => opDp(h, c) >= 17, null, 'パートナーは6〜10点なので17点以上（ダミーポイント）ならゲーム');
  R('1M 2M', '3M', (h, c) => between(opDp(h, c), 15, 16), (b) => ({ hcp: [15, 16] }), '15〜16点なので3メジャーで招待');
  R('1M 2M', 'P', () => true, { hcp: [11, 14] }, '最低点なのでパス');
  R('1M 2M 3M', '4M', (h, c) => supDp(h, c) >= 8, null, '6〜10点の上の方（ダミーポイント）なので招待を受けて4メジャー');
  R('1M 2M 3M', 'P', () => true, null, '6〜10点の下の方なので招待を断ってパス');
  // 4枚サポートのレイズへのオープナー（暫定）
  for (const M of ['H', 'S']) {
    const L = LADDER[M], o = '1' + M, sym = SYM[M];
    const sign = '3' + M, game = '4' + M; // 強さはダミーポイント（パートナーは4枚以上）
    R(`${o} ${L.weak}`, game, h => h.dp(M, 4) >= 19, null, 'パートナーは3〜6点だが、こちらが非常に強いのでゲーム');
    R(`${o} ${L.weak}`, 'P', () => true, null, 'パートナーは3〜6点の弱いレイズなのでパス');
    R(`${o} ${L.s68}`, game, h => h.dp(M, 4) >= 17, null, 'パートナーは6〜8点の4枚サポート。17点以上なのでゲーム');
    R(`${o} ${L.s68}`, sign, () => true, null, `パートナーは6〜8点の4枚サポート。ゲームには足りないので3${sym}`);
    R(`${o} ${L.r910}`, game, h => h.dp(M, 4) >= 15, null, 'パートナーは9〜10点の4枚サポート。15点以上なのでゲーム');
    R(`${o} ${L.r910}`, sign, () => true, null, `パートナーは9〜10点の4枚サポート。最低点なので3${sym}`);
    R(`${o} ${L.r1112}`, game, h => h.dp(M, 4) >= 14, null, 'パートナーは11〜12点の4枚サポート。14点以上なのでゲーム');
    R(`${o} ${L.r1112}`, sign, () => true, null, `パートナーは11〜12点の4枚サポート。最低点なので3${sym}`);
    // 2♠/2NT（16点以上）・強めの12〜15・スプリンターの後は、スラムの仕組み（slamDecide）で決める
    for (const r2 of [L.s68, L.r910, L.r1112]) R(`${o} ${r2} ${sign}`, 'P', () => true, null, 'オープナーがゲームを断ったのでパス');
  }
  R('1M 4M', 'P', () => true, null, 'パートナーがゲームを決めたのでパス');

  // 1M-1NT（セミフォーシング）
  R('1M 1N', '2N', h => h.balanced && between(h.hcp, 18, 19), { hcp: [18, 19], bal: true }, 'バランスハンド18〜19点なので2NT');
  R('1M 1N', 'P', h => h.pattern === '5332' && between(h.hcp, 11, 14), { hcp: [11, 14] }, '5332の最低点なのでパス（セミフォーシングなのでパスしてよい）');
  R('1M 1N', '4M', (h, c) => h.len[c.b.M] >= 6 && h.hcp >= 18, null, 'メジャー6枚以上で18点以上なのでゲーム');
  R('1M 1N', '3M', (h, c) => h.len[c.b.M] >= 6 && between(h.hcp, 15, 17), (b) => ({ [b.M]: [6, 13], hcp: [15, 17] }), 'メジャー6枚以上・15〜17点なので3メジャーで招待');
  R('1S 1N', '3H', h => h.len.H >= 4 && h.hcp >= 18, { H: [4, 13], hcp: [18, 21] }, 'ハート4枚以上・18点以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1S 1N', '2H', h => h.len.H >= 4, { H: [4, 13], hcp: [11, 17] }, 'ハート4枚以上なので2♥');
  R('1M 1N', '2M', (h, c) => h.len[c.b.M] >= 6, (b) => ({ [b.M]: [6, 13], hcp: [11, 14] }), 'メジャー6枚以上の最低点なので2メジャー');
  R('1M 1N', '3D', h => h.len.D >= 4 && h.hcp >= 18 && h.len.D >= h.len.C, { D: [4, 13], hcp: [18, 21] }, 'ダイヤ4枚以上・18点以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1M 1N', '3C', h => h.len.C >= 4 && h.hcp >= 18, { C: [4, 13], hcp: [18, 21] }, 'クラブ4枚以上・18点以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1M 1N', '2D', h => h.len.D >= 4 && h.len.D > h.len.C, { D: [4, 13] }, 'ダイヤが長いので2♦');
  R('1M 1N', '2C', h => h.len.C >= 3, { C: [3, 13] }, 'クラブ3枚以上なので2♣（3枚のこともある）');
  R('1M 1N', '2D', h => h.len.D >= 3, { D: [3, 13] }, 'ダイヤ3枚以上なので2♦');
  R('1M 1N', '2M', () => true, null, 'ほかに適当なビッドがないのでメジャーをリビッド');

  // 1M-1NT-2x のレスポンダー
  R('1M 1N 2m', '3M', (h, c) => h.len[c.b.M] >= 3 && between(supDp(h, c), 11, 12), null, 'メジャー3枚のサポートで11〜12点（ダミーポイント）なので3メジャーにジャンプ');
  R('1M 1N 2m', '2M', (h, c) => h.len[c.b.M] >= 3 || (h.len[c.b.M] === 2 && h.len[c.b.m] <= 2), null, 'メジャーの方が合うので2メジャーに戻す（プリファレンス）');
  R('1M 1N 2m', '3m', (h, c) => h.len[c.b.m] >= 5 && between(h.hcp, 10, 12), null, 'マイナーのサポートが厚く10〜12点なので3マイナーで招待');
  R('1S 1N 2C', '2D', h => h.len.D >= 6 && h.hcp < 10, null, 'ダイヤ6枚以上で弱いので2♦');
  R('1M 1N 2m', '2H', (h, c) => c.b.M === 'S' && h.len.H >= 6 && h.hcp < 10, null, 'ハート6枚以上で弱いので2♥');
  R('1M 1N 2m', '2N', h => between(h.hcp, 11, 12) && h.balanced, null, '11〜12点のバランスハンドなので2NTで招待');
  R('1M 1N 2m', 'P', () => true, null, 'オープナーの2つ目のスートで止める');
  R('1S 1N 2H', '3H', h => h.len.H >= 4 && between(h.hcp, 10, 12), null, 'ハート4枚以上で10〜12点なので3♥で招待');
  R('1S 1N 2H', '3S', (h, c) => h.len.S >= 3 && between(supDp(h, c), 11, 12), null, 'スペード3枚のサポートで11〜12点（ダミーポイント）なので3♠');
  R('1S 1N 2H', 'P', h => h.len.H >= 3 || (h.len.H === 2 && h.len.S < 2), null, 'ハートで止める');
  R('1S 1N 2H', '2S', () => true, null, 'スペードの方が合うので2♠に戻す');
  R('1M 1N 2M', '4M', (h, c) => h.len[c.b.M] >= 3 && h.dp(c.b.M, 6) >= 11, null, '6枚スートに3枚サポート、11点以上（ダミーポイント）なのでゲーム');
  R('1M 1N 2M', '3M', (h, c) => h.len[c.b.M] >= 2 && between(h.dp(c.b.M, 6), 10, 12), null, '6枚スートに2枚あり10〜12点なので3メジャーで招待');
  R('1M 1N 2M', 'P', () => true, null, '最低点同士なのでパス');
  R('1M 1N 2N', '4M', (h, c) => h.len[c.b.M] >= 3 && supDp(h, c) >= 7, null, '18〜19点に対して7点以上あり、メジャー3枚なので4メジャー');
  R('1M 1N 2N', '3N', h => h.hcp >= 7, null, '18〜19点に対して7点以上あるので3NT');
  R('1M 1N 2N', '3M', (h, c) => h.len[c.b.M] >= 3, null, 'メジャー3枚あるが弱いので3メジャー');
  R('1M 1N 2N', 'P', () => true, null, '弱いのでパス');
  R('1M 1N 3M', '4M', (h, c) => h.dp(c.b.M, 6) >= 8 || (h.hcp >= 7 && h.len[c.b.M] >= 2), null, '招待を受けて4メジャー');
  R('1M 1N 3M', 'P', () => true, null, '弱いので招待を断る');

  // 1H-1S のオープナー
  R('1H 1S', '4S', h => h.len.S >= 4 && h.dp('S', 4) >= 18, null, 'スペード4枚のサポートで18点以上なので4♠');
  R('1H 1S', '3S', h => h.len.S >= 4 && between(h.dp('S', 4), 15, 17), { S: [4, 4], hcp: [15, 17] }, 'スペード4枚のサポートで15〜17点なので3♠');
  R('1H 1S', '2S', h => h.len.S >= 4, { S: [4, 4], hcp: [11, 14] }, 'スペード4枚のサポートがあるので2♠');
  R('1H 1S', '1N', h => h.balanced && h.hcp < 15, { hcp: [11.5, 14.99], bal: true, S: [0, 3] }, 'バランスハンドの最低点なので1NT');
  R('1H 1S', '2N', h => h.balanced && between(h.hcp, 18, 19), { hcp: [18, 19], bal: true, S: [0, 3] }, 'バランスハンド18〜19点なので2NT');
  R('1H 1S', '3H', h => h.len.H >= 6 && between(h.hcp, 15, 17), { H: [6, 13], hcp: [15, 17] }, 'ハート6枚以上・15〜17点なので3♥');
  R('1H 1S', '3C', h => h.len.C >= 4 && h.hcp >= 18, { C: [4, 13], hcp: [18, 21] }, '18点以上でクラブ4枚以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1H 1S', '3D', h => h.len.D >= 4 && h.hcp >= 18, { D: [4, 13], hcp: [18, 21] }, '18点以上でダイヤ4枚以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1H 1S', '2H', h => h.len.H >= 6, { H: [6, 13], hcp: [11, 14] }, 'ハート6枚以上なので2♥');
  R('1H 1S', '2D', h => h.len.D >= 4 && h.len.D > h.len.C, { D: [4, 13], hcp: [11.5, 17.99] }, 'ダイヤ4枚以上なので2♦（3つ目のスート＝アンバランスハンド）');
  R('1H 1S', '2C', h => h.len.C >= 4, { C: [4, 13], hcp: [11.5, 17.99] }, 'クラブ4枚以上なので2♣（3つ目のスート＝アンバランスハンド）');
  R('1H 1S', '2D', h => h.len.D >= 4, { D: [4, 13], hcp: [11.5, 17.99] }, 'ダイヤ4枚以上なので2♦（3つ目のスート＝アンバランスハンド）');
  R('1H 1S', '2H', () => true, null, 'ほかに適当なビッドがないので2♥');

  // 2/1 のあとのオープナー
  R('1S 2H', '3H', (h, c) => h.len.H >= 3 && motivation(h, 'H', c) >= 1, { H: [3, 13], agree: 'H', interest: true },
    (h, c) => `ハート3枚以上のサポートでフィット。ゲームフォーシング中で、スラムへのやる気が${motivation(h, 'H', c)}（1以上）なので3♥（スラムに興味あり）`);
  R('1S 2H', '4H', h => h.len.H >= 3, { H: [3, 13], agree: 'H' }, 'ハート3枚以上のサポートでフィット。スラムへのやる気がない（0）ので4♥（スラムに興味なし）');
  R('1M 2m', '2M', (h, c) => h.len[c.b.M] >= 6, (b) => ({ [b.M]: [6, 13] }), 'メジャー6枚以上なので2メジャー');
  R('1M 2X', '2D', (h, c) => c.b.X === 'C' && h.len.D >= 4, { D: [4, 13] }, 'ダイヤ4枚以上なので2♦');
  R('1M 2X', '2H', (h, c) => c.b.M === 'S' && c.b.X !== 'H' && h.len.H >= 4, { H: [4, 13] }, 'ハート4枚以上なので2♥');
  R('1M 2X', '2S', (h, c) => c.b.M === 'H' && h.len.S >= 4, { S: [4, 13] }, 'スペード4枚以上なので2♠');
  R('1M 2X', '3X', (h, c) => c.b.X !== 'H' && h.len[c.b.X] >= 4, (b) => ({ [b.X]: [4, 13] }), 'パートナーのマイナーに4枚以上のサポートがあるので3マイナー');
  R('1M 2X', '3C', (h, c) => c.b.X === 'D' && h.len.C >= 4, { C: [4, 13] }, 'クラブ4枚以上なので3♣');
  R('1M 2X', '2N', h => h.balanced, { bal: true }, 'バランスハンドなので2NT');
  R('1M 2X', '2M', () => true, (b) => ({ [b.M]: [5, 13] }), 'ほかに適当なビッドがないのでメジャーをリビッド');

  // ===== 1マイナーオープン後 =====
  // ダブルジャンプシフト（4441 / 5440 のショート、マイナー4枚以上のサポート、12〜15点）
  const splinter = (m, short) => (h) => (h.pattern === '4441' || h.pattern === '5440') && h.len[m] >= 4 && h.len[short] <= 1 && between(h.hcp, 12, 15);
  for (const [open, short, call] of [['1C', 'D', '3D'], ['1C', 'H', '3H'], ['1C', 'S', '3S'], ['1D', 'H', '3H'], ['1D', 'S', '3S'], ['1D', 'C', '4C']]) {
    const m = open[1];
    R(open, call, splinter(m, short), { [m]: [4, 5], [short]: [0, 1], hcp: [12, 15.99], agree: m, ctrl: [short] },
      `${JA_SUIT[m]}4枚以上のサポートがあり、${JA_SUIT[short]}がシングルトン以下の4441/5440形なのでダブルジャンプシフト（ショートを示す）`, 'GF');
  }
  const bidMajorFirst = h => h.len.H >= 4 || h.len.S >= 4;
  R('1C', '1D', h => h.adj >= 6 && h.len.D >= 4 && (!bidMajorFirst(h) || (h.len.D >= 5 && h.hcp >= 11 && h.len.D > h.len.H && h.len.D > h.len.S)),
    { D: [4, 13], hcp: [6, 37] }, 'ダイヤ4枚以上（4枚メジャーがないか、ダイヤがずっと長く強い）なので1♦', 1);
  R('1m', '1S', h => h.adj > 4 && h.len.S >= 4 && (h.len.S > h.len.H || (h.len.S === h.len.H && h.len.S >= 5)), { S: [4, 13], hcp: [6, 37] }, 'スペード4枚以上（ハートより長い）なので1♠', 1);
  R('1m', '1H', h => h.adj > 4 && h.len.H >= 4, { H: [4, 13], hcp: [6, 37] }, 'ハート4枚以上なので1♥（4-4のメジャーはハートから）', 1);
  R('1m', '1S', h => h.adj > 4 && h.len.S >= 4, { S: [4, 13], hcp: [6, 37] }, 'スペード4枚以上なので1♠', 1);
  R('1D', '2C', h => h.hcp >= 12 && h.len.C >= 5, { C: [5, 13], hcp: [12, 37], S: [0, 3], H: [0, 3] }, 'クラブ5枚以上・12点以上なので2♣（2/1ゲームフォーシング）', 'GF');
  R('1m', '2m', (h, c) => h.adj >= 13 && h.len[c.b.m] >= (c.b.m === 'C' ? 5 : 4), (b) => ({ [b.m]: [b.m === 'C' ? 5 : 4, 13], hcp: [13, 37], S: [0, 3], H: [0, 3] }),
    '4枚メジャーがなくマイナーのサポートがあり13点以上なのでインバーテッド・マイナーレイズ（ゲームフォーシング）', 'GF');
  R('1m', '2H', (h, c) => h.len[c.b.m] >= 4 && h.adj >= 10.5 && h.adj < 13, (b) => ({ [b.m]: [4, 13], hcp: [10, 12], S: [0, 3], H: [0, 3] }), 'マイナー4枚以上のサポートで強めの10〜12点なので2♥（GFではないレイズ）', 1);
  R('1m', '2S', (h, c) => h.len[c.b.m] >= 5 && h.adj >= 7 && h.adj < 10.5, (b) => ({ [b.m]: [5, 13], hcp: [7, 10], S: [0, 3], H: [0, 3] }), 'マイナー5枚以上のサポートで7〜9点（弱めの10点まで）なので2♠（GFではないレイズ）', 1);
  R('1m', '3m', (h, c) => h.len[c.b.m] >= 5 && h.adj >= 3 && h.adj < 7, (b) => ({ [b.m]: [5, 13], hcp: [3, 6], S: [0, 3], H: [0, 3] }), 'マイナー5枚以上のサポートでとても弱いので3マイナー（プリエンプティブ・レイズ）');
  R('1m', '3N', h => h.balanced && between(h.hcp, 13, 15), { hcp: [13, 15], bal: true, S: [0, 3], H: [0, 3] }, '4枚メジャーがないバランスハンド13〜15点なので3NT');
  R('1m', '2N', h => h.balanced && between(h.hcp, 11, 12), { hcp: [11, 12], bal: true, S: [0, 3], H: [0, 3] }, '4枚メジャーがないバランスハンド11〜12点なので2NTで招待');
  R('1m', '1N', h => h.adj >= 6 && h.adj < 11, { hcp: [6, 10], S: [0, 3], H: [0, 3] }, '4枚メジャーがなく6〜10点なので1NT');
  R('1m', '2m', (h, c) => h.adj >= 13 && h.len[c.b.m] >= 4, (b) => ({ [b.m]: [4, 13], hcp: [13, 37] }), '強いがほかに適当なビッドがないのでインバーテッド・マイナーレイズ（ゲームフォーシング）', 'GF');
  R('1m', 'P', () => true, { hcp: [0, 5] }, '5点以下なのでパス');

  // 1m-1M のオープナー
  R('1m 1M', '4M', (h, c) => h.len[c.b.M] >= 4 && h.dp(c.b.M, 4) >= 18, null, 'メジャー4枚のサポートで18点以上なのでゲーム');
  R('1m 1M', '3M', (h, c) => h.len[c.b.M] >= 4 && between(h.dp(c.b.M, 4), 15, 17), (b) => ({ [b.M]: [4, 4], hcp: [15, 17] }), 'メジャー4枚のサポートで15〜17点なのでジャンプレイズ');
  R('1m 1M', '2M', (h, c) => h.len[c.b.M] >= 4, (b) => ({ [b.M]: [4, 4], hcp: [11, 14] }), 'メジャー4枚のサポートがあるので2メジャー');
  R('1m 1H', '1S', h => !h.balanced && h.len.S >= 4 && h.hcp < 18, { S: [4, 4], H: [0, 3], hcp: [11.5, 17.99] }, 'スペード4枚があるアンバランスハンドなので1♠（3つ目のスート。バランスハンドなら1NT）');
  R('1m 1M', '1N', h => h.balanced && h.hcp < 15, (b) => ({ hcp: [11.5, 14.99], bal: true, [b.M]: [2, 3] }), 'バランスハンドの最低点なので1NT（4枚スートがあってもバランスハンドは1NT）');
  R('1m 1M', '2N', h => h.balanced && between(h.hcp, 18, 19), (b) => ({ hcp: [18, 19], bal: true, [b.M]: [2, 3] }), 'バランスハンド18〜19点なので2NT');
  R('1D 1M', '2H', (h, c) => c.b.M === 'S' && h.len.H >= 4 && h.hcp >= 16, { H: [4, 4], D: [5, 13], hcp: [16, 21] }, 'ハート4枚・16点以上なのでリバース（2♥）', 1);
  R('1C 1S', '2H', h => h.len.H >= 4 && h.hcp >= 16, { H: [4, 13], C: [5, 13], hcp: [16, 21] }, 'ハート4枚・16点以上なのでリバース（2♥）', 1);
  R('1C 1M', '2D', h => h.len.D >= 4 && h.hcp >= 16, { D: [4, 13], C: [5, 13], hcp: [16, 21] }, 'ダイヤ4枚・16点以上なのでリバース（2♦）', 1);
  R('1m 1M', '3m', (h, c) => h.len[c.b.m] >= 6 && between(h.hcp, 15, 17), (b) => ({ [b.m]: [6, 13], hcp: [15, 17] }), 'マイナー6枚以上・15〜17点なので3マイナー');
  R('1D 1M', '2C', h => h.len.C >= 4, { C: [4, 13], hcp: [11.5, 17.99] }, 'クラブ4枚以上のアンバランスハンドなので2♣（3つ目のスート）');
  R('1m 1M', '2m', (h, c) => h.len[c.b.m] >= 5, (b) => ({ [b.m]: [5, 13], hcp: [11, 14] }), 'マイナーが長いので2マイナー');
  R('1m 1M', '2M', (h, c) => h.len[c.b.M] >= 3 && h.hcp < 15, null, 'メジャー3枚サポートで形が悪いので2メジャー');
  R('1m 1M', '1N', h => h.hcp < 15, (b) => ({ hcp: [11, 14] }), 'ほかに適当なビッドがないので1NT');
  R('1m 1M', '2N', () => true, (b) => ({ hcp: [18, 19] }), '18点以上でほかに適当なビッドがないので2NT');
  // 1m-1M-(1NT/2m) のレスポンダー：6枚メジャー
  for (const r2 of ['2m']) {
    R('1m 1M ' + r2, '4M', (h, c) => h.len[c.b.M] >= 6 && h.hcp >= 13, null, 'メジャー6枚以上でゲームの点数があるので4メジャー');
    R('1m 1M ' + r2, '3M', (h, c) => h.len[c.b.M] >= 6 && between(h.hcp, 10, 12), null, 'メジャー6枚以上・10〜12点なので3メジャーで招待');
    R('1m 1M ' + r2, '2M', (h, c) => h.len[c.b.M] >= 6 && h.hcp < 10, null, 'メジャー6枚以上で弱いので2メジャー');
  }
  // 1C-1D のオープナー
  R('1C 1D', '1H', h => !h.balanced && h.len.H >= 4, { H: [4, 13], hcp: [11.5, 17.99] }, 'ハート4枚があるアンバランスハンドなので1♥（3つ目のスート。バランスハンドなら1NT）');
  R('1C 1D', '1S', h => !h.balanced && h.len.S >= 4, { S: [4, 13], H: [0, 3], hcp: [11.5, 17.99] }, 'スペード4枚があるアンバランスハンドなので1♠（3つ目のスート）');
  R('1C 1D', '1N', h => h.balanced && h.hcp < 15, { hcp: [11.5, 14.99], bal: true }, 'バランスハンドの最低点なので1NT');
  R('1C 1D', '2N', h => h.balanced && between(h.hcp, 18, 19), { hcp: [18, 19], bal: true }, 'バランスハンド18〜19点なので2NT');
  R('1C 1D', '2D', h => h.len.D >= 4, { D: [4, 13] }, 'ダイヤ4枚以上のサポートがあるので2♦');
  R('1C 1D', '2C', h => h.len.C >= 5, { C: [5, 13] }, 'クラブが長いので2♣');
  R('1C 1D', '1N', () => true, null, 'ほかに適当なビッドがないので1NT');
  // 1m-1NT, 1m-2NT, 1m-3NT, 1m-3m
  R('1m 1N', 'P', h => h.balanced && h.hcp < 15, null, 'バランスハンドの最低点なのでパス');
  R('1m 1N', '2N', h => h.balanced && h.hcp >= 18, null, 'バランスハンド18〜19点なので2NTで招待');
  R('1D 1N', '2C', h => h.len.C >= 4, null, 'クラブ4枚以上なので2♣');
  R('1m 1N', '2m', (h, c) => h.len[c.b.m] >= 6, null, 'マイナー6枚以上なので2マイナー');
  R('1m 1N', 'P', () => true, null, 'パス');
  R('1m 2N', '3N', h => h.hcp >= 13, null, '招待を受けて3NT');
  R('1m 2N', '3m', (h, c) => h.len[c.b.m] >= 6, null, '最低点でマイナーが長いので3マイナー');
  R('1m 2N', 'P', () => true, null, '最低点なのでパス');
  R('1m 3N', 'P', () => true, null, 'パートナーがゲームを決めたのでパス');
  R('1m 3m', '3N', h => h.hcp >= 18 && h.balanced, null, '強いバランスハンドなので3NT');
  R('1m 3m', 'P', () => true, null, 'パートナーは弱いのでパス');
  // 1m-2♥ / 1m-2♠ 後のオープナー（暫定）
  R('1m 2H', '3N', h => h.hcp >= 14 && (h.balanced || (h.stopper('H') && h.stopper('S'))), null, 'パートナーは10〜12点のサポート。14点以上でメジャーが止まっているので3NT');
  R('1m 2H', '5m', h => h.hcp >= 15, null, 'パートナーは10〜12点のサポート。強いのでマイナーのゲーム');
  R('1m 2H', '3m', () => true, null, 'パートナーは10〜12点のサポート。最低点なので3マイナーで止める');
  R('1m 2S', '3N', h => h.hcp >= 17 && (h.balanced || (h.stopper('H') && h.stopper('S'))), null, 'パートナーは7〜9点のサポート。17点以上でメジャーが止まっているので3NT');
  R('1m 2S', '5m', h => h.hcp >= 18, null, 'パートナーは7〜9点のサポート。とても強いのでマイナーのゲーム');
  R('1m 2S', '3m', () => true, null, 'パートナーは7〜9点のサポート。3マイナーで止める');
  R('1m 2H 3m', 'P', () => true, null, 'オープナーが最低点なのでパス');
  R('1m 2S 3m', 'P', () => true, null, 'オープナーが止めたのでパス');
  // インバーテッド・レイズ後のオープナー
  R('1m 2m', '2N', h => h.balanced && h.hcp < 15, { hcp: [11, 14], bal: true }, 'バランスハンドの最低点なので2NT');
  R('1m 2m', '3N', h => h.balanced && h.hcp >= 18, { hcp: [18, 19], bal: true }, 'バランスハンド18〜19点なので3NT');
  R('1m 2m', '2H', h => h.len.H >= 4 || (h.stopper('H') && !h.stopper('S')), { H: [3, 13] }, 'ハートにストッパー（または4枚）があるので2♥（ステージ・ビッド）');
  R('1m 2m', '2S', h => h.len.S >= 4 || h.stopper('S'), { S: [3, 13] }, 'スペードにストッパー（または4枚）があるので2♠（ステージ・ビッド）');
  R('1C 2C', '2D', h => h.len.D >= 4 || h.stopper('D'), { D: [3, 13] }, 'ダイヤにストッパー（または4枚）があるので2♦（ステージ・ビッド）');
  R('1m 2m', '3m', () => true, null, 'ほかに示すものがないので3マイナー');
  // ダブルジャンプシフト後のオープナーは、スラムの仕組み（slamDecide）で決める

  // ===== 3つ目のスートとフォース・スート（4th suit forcing） =====
  // オープナーが2回目に3つ目のスートを言ったら、アンバランスハンド（5-4以上など）確定。
  // レスポンダーの4つ目のスートは「追加の情報が欲しい」ゲームフォーシング。
  //   欲しい情報：4つ目のスートのストッパー / レスポンダーのメジャーへの3枚サポート / スラムの可能性
  function thirdSuitSeq(seq) {
    if (seq.length !== 3 || !seq.every(isBid)) return null;
    const [o1, r1, o2] = seq;
    if (o1[0] !== '1') return null;
    const X = o1[1], Y = r1[1], Z = o2[1];
    if ([X, Y, Z].includes('N') || new Set([X, Y, Z]).size !== 3) return null;
    if (r1 !== cheapest(Y, [o1])) return null;                         // ジャンプでない応答
    const gf = r1[0] === '2';
    if (gf && !(isMaj(X) || (X === 'D' && Y === 'C'))) return null;    // 2/1
    if (o2 !== cheapest(Z, [o1, r1]) || levelOf(o2) > 3) return null;   // ジャンプでない3つ目のスート
    const W = SUITS.find(s => ![X, Y, Z].includes(s));
    const fsf = cheapest(W, seq);
    if (!fsf || levelOf(fsf) > 3) return null;
    return { X, Y, Z, W, gf, fsf };
  }
  const fsfSeq = seq => {
    if (seq.length !== 4) return null;
    const b = thirdSuitSeq(seq.slice(0, 3));
    return b && seq[3] === b.fsf ? b : null;
  };
  const fsfAnsSeq = seq => seq.length === 5 && isBid(seq[4]) ? fsfSeq(seq.slice(0, 4)) : null;
  const fitShows = call => ({ agree: call[1], interest: rankOf(call) < rankOf(gameCall(call[1])) });
  const agreeWhy = (h, c, call) => {
    const T = call[1], mot = motivation(h, T, c);
    return rankOf(call) < rankOf(gameCall(T))
      ? `${JA_SUIT[T]}のフィットを示す。ゲームフォーシング中で、スラムへのやる気が${mot}（1以上）なので安く${callText(call)}（スラムに興味あり）`
      : `${JA_SUIT[T]}のフィットを示す。スラムへのやる気が0なので${callText(call)}（スラムに興味なし）`;
  };

  // 2/1の後、レスポンダーがオープナーのメジャーへのサポートを示す
  //   3枚以上 → 3M（スラムに興味あり）か4M（興味なし）の2択
  //   2Mが言えるときの2M → ちょうど2枚。オープナーが6枚以上ならそれを3M/4Mにレイズしてフィットが見つかる
  function twoOverOneSeq(seq) {
    if (seq.length !== 3 || !seq.every(isBid)) return null;
    const [o1, r1] = seq;
    if (o1[0] !== '1' || !isMaj(o1[1])) return null;
    const M = o1[1], X = r1[1];
    if (X === 'N' || X === M || r1[0] !== '2' || r1 !== cheapest(X, [o1])) return null;
    return { M, X };
  }
  const raise34 = (h, c, M) => {
    const three = '3' + M, four = '4' + M;
    if (legal(three, c.seq) && motivation(h, M, c) >= 1) return three;
    return legal(four, c.seq) ? four : null;
  };
  RD(twoOverOneSeq, (h, c) => {
    const { M } = c.b, two = '2' + M;
    const fit = h.len[M] >= 3 || (h.len[M] >= 2 && c.partner[M][0] >= 6);
    if (fit) {
      const call = raise34(h, c, M);
      if (call) return { call, why: `${JA_SUIT[M]}${h.len[M] >= 3 ? '3枚以上' : '2枚'}でフィットがある（${h.len[M] >= 3 ? '' : 'パートナーは6枚以上、'}ゲームフォーシング中）。` +
        (call[0] === '3' ? `スラムへのやる気が${motivation(h, M, c)}（1以上）なので3${SYM[M]}（スラムに興味あり）` : `スラムへのやる気が0なので4${SYM[M]}（スラムに興味なし）`) };
    }
    if (h.len[M] === 2 && legal(two, c.seq)) return { call: two, why: `${JA_SUIT[M]}がちょうど2枚なので2${SYM[M]}（オープナーが6枚以上ならフィット）` };
    return null;
  }, (call, b) => {
    if (call === '2' + b.M) return { shows: { [b.M]: [2, 2] } };
    if (isBid(call) && call[1] === b.M) return { shows: { [b.M]: [2, 13], ...fitShows(call) } };
    return null;
  });
  RD(seq => seq.length === 4 && twoOverOneSeq(seq.slice(0, 3)) && seq[3] === '2' + seq[0][1] ? twoOverOneSeq(seq.slice(0, 3)) : null, (h, c) => {
    const { M } = c.b;
    if (h.len[M] < 6) return null;
    const call = raise34(h, c, M);
    return call && { call, why: `パートナーは${JA_SUIT[M]}2枚、こちらは6枚以上なのでフィット。` +
      (call[0] === '3' ? `スラムへのやる気が${motivation(h, M, c)}（1以上）なので3${SYM[M]}（スラムに興味あり）` : `スラムへのやる気が0なので4${SYM[M]}（スラムに興味なし）`) };
  }, (call, b) => isBid(call) && call[1] === b.M ? { shows: { [b.M]: [6, 13], ...fitShows(call) } } : null);

  // レスポンダー：オープナーが3つ目のスートを言った後
  RD(thirdSuitSeq, (h, c) => {
    const { X, Y, Z, W, gf, fsf } = c.b;
    if (!gf && h.adj < 13) {                            // ゲームの点数がないとき
      const up = (s, n) => { const ch = cheapest(s, c.seq); return ch && (Number(ch[0]) + n) + s; };
      if (isMaj(Z) && h.len[Z] >= 4) {
        const v = h.dp(Z, 4);
        if (v < 11) return { call: up(Z, 0), why: `${JA_SUIT[Z]}4枚のサポートで6〜10点（ダミーポイント）なので${callText(up(Z, 0))}` };
        return { call: up(Z, 1), why: `${JA_SUIT[Z]}4枚のサポートで11〜12点（ダミーポイント）なので${callText(up(Z, 1))}で招待` };
      }
      if (h.len[Y] >= 6) {
        if (h.adj < 11 && levelOf(up(Y, 0)) <= 2) return { call: up(Y, 0), why: `${JA_SUIT[Y]}6枚以上で弱いので${callText(up(Y, 0))}で止める` };
        if (h.adj >= 11 && levelOf(up(Y, 1)) <= 3) return { call: up(Y, 1), why: `${JA_SUIT[Y]}6枚以上で11〜12点なので${callText(up(Y, 1))}で招待` };
      }
      return null;
    }
    const slam = slamPossible(h, c);
    let T = null;
    if (isMaj(X) && h.len[X] >= 3) T = X; else if (isMaj(Z) && h.len[Z] >= 4) T = Z;
    if (T) {
      if (gf) { const call = agreeCall(h, c, T); return { call, why: agreeWhy(h, c, call) }; }
      if (!slam) return { call: gameCall(T), why: `${JA_SUIT[T]}のフィットがあり、スラムの可能性はないのでゲームに直行` };
      return { call: fsf, why: `${JA_SUIT[T]}のフィットがあり、スラムの可能性もあるので、まずフォース・スート（${callText(fsf)}）でゲームフォーシングにする` };
    }
    if (isMaj(Y) && h.len[Y] >= 6 && !slam) return { call: gameCall(Y), why: `${JA_SUIT[Y]}6枚以上でゲームの点数があり、スラムの可能性はないので${callText(gameCall(Y))}` };
    const ask3 = isMaj(Y) && h.len[Y] === 5;
    if (!ask3 && !slam && h.stopper(W)) return { call: '3N', why: `${JA_SUIT[W]}（4つ目のスート）にストッパーがあり、ほかに聞きたいこともないので3NTに直行` };
    const need = [!h.stopper(W) && `${JA_SUIT[W]}のストッパー`, ask3 && `${JA_SUIT[Y]}の3枚サポート`, slam && 'スラムの可能性'].filter(Boolean).join('・');
    return { call: fsf, why: `ゲームの点数があり、${need}を知りたいのでフォース・スート（${callText(fsf)}：4つ目のスート、ゲームフォーシング）` };
  }, (call, b) => {
    if (call === b.fsf) return { shows: { hcp: [13, 37] }, force: 'GF' };
    if (!b.gf && isBid(call) && call[1] === b.Z && levelOf(call) <= 3) return { shows: { [b.Z]: [4, 13] } };
    if (!b.gf && isBid(call) && call[1] === b.Y && levelOf(call) <= 3) return { shows: { [b.Y]: [6, 13] } };
    if (call === '3N') return { shows: { hcp: [13, 37], stop: [b.W] } };
    if (b.gf && isBid(call) && (call[1] === b.X || call[1] === b.Z) && isMaj(call[1])) return { shows: { [call[1]]: [call[1] === b.X ? 3 : 4, 13], ...fitShows(call) } };
    return null;
  });
  // オープナー：フォース・スートへの答え
  RD(fsfSeq, (h, c) => {
    const { X, Y, Z, W } = c.b, s = c.seq;
    if (isMaj(Y) && h.len[Y] >= 3) return { call: cheapest(Y, s), why: `フォース・スートへの答え：${JA_SUIT[Y]}3枚のサポートがある` };
    if (h.stopper(W)) return { call: cheapest('N', s), why: `フォース・スートへの答え：${JA_SUIT[W]}にストッパーがある` };
    if (h.len[X] >= 6) return { call: cheapest(X, s), why: `フォース・スートへの答え：サポートもストッパーもなく、${JA_SUIT[X]}が6枚以上` };
    if (h.len[Z] >= 5) return { call: cheapest(Z, s), why: `フォース・スートへの答え：サポートもストッパーもなく、${JA_SUIT[Z]}が5枚以上` };
    if (h.len[W] >= 4) return { call: cheapest(W, s), why: `フォース・スートへの答え：サポートもストッパーもなく、${JA_SUIT[W]}が4枚ある` };
    return { call: cheapest(X, s), why: `フォース・スートへの答え：サポートもストッパーもないので${JA_SUIT[X]}をリビッド` };
  }, (call, b) => {
    if (!isBid(call)) return null;
    const t = call[1];
    if (t === b.Y) return { shows: { [b.Y]: [3, 3] } };
    if (t === 'N') return { shows: { stop: [b.W] } };
    if (t === b.X) return { shows: { [b.X]: [5, 13] } };
    if (t === b.Z) return { shows: { [b.Z]: [5, 13] } };
    if (t === b.W) return { shows: { [b.W]: [4, 4] } };
    return null;
  });
  // レスポンダー：フォース・スートの答えを聞いた後
  RD(fsfAnsSeq, (h, c) => {
    const { X, Y, Z, W } = c.b, ans = c.seq[4], a = ans[1];
    let T = null;
    if (isMaj(Y) && a === Y && h.len[Y] >= 5) T = Y;
    else if (isMaj(X) && h.len[X] >= 3) T = X;
    else if (isMaj(Z) && h.len[Z] >= 4) T = Z;
    if (T) { const call = agreeCall(h, c, T); return { call, why: agreeWhy(h, c, call) }; }
    if (a === 'N' || h.stopper(W)) {
      if (ans === '3N') return { call: 'P', why: 'メジャーのフィットがなく、ストッパーもそろったので3NTでパス' };
      return { call: '3N', why: `メジャーのフィットがなく、${JA_SUIT[W]}にストッパーがある（${a === 'N' ? 'オープナーが示した' : '自分が持っている'}）ので3NT` };
    }
    return null;
  }, (call) => isBid(call) && call[1] !== 'N' ? { shows: fitShows(call) } : null);

  // ===== オープナーの1NTリビッド後：2ウェイ・チェックバック =====
  //   2♣：11〜12点（2♦を強制。2♦でサインオフにも使う）  2♦：13点以上（ゲームフォーシング）
  //   1NTへのジャンプ：6枚以上の1スートか5-5以上の2スートで、スラムトライ
  function nt1Seq(seq) {
    if (seq.length !== 3 || seq[2] !== '1N') return null;
    const [o1, r1] = seq;
    if (!isBid(o1) || !isBid(r1) || o1[0] !== '1' || r1[0] !== '1') return null;
    const X = o1[1], Y = r1[1];
    if (X === 'N' || Y === 'N' || X === Y) return null;
    return { X, Y };
  }
  const nt1Ext = (...tail) => seq => {
    if (seq.length !== 3 + tail.length) return null;
    for (let i = 0; i < tail.length; i++) if (tail[i] !== '*' && tail[i] !== seq[3 + i]) return null;
    return nt1Seq(seq.slice(0, 3));
  };
  RD(nt1Seq, (h, c) => {
    const { X, Y } = c.b;
    const others = SUITS.filter(s => s !== X && s !== Y);
    const slam = slamPossible(h, c);
    if (slam && h.len[Y] >= 6 && !others.some(s => h.len[s] >= 5))
      return { call: '3' + Y, why: `${JA_SUIT[Y]}6枚以上の1スーターでスラムの可能性があるので、1NTにジャンプして3${SYM[Y]}（スラムトライ）` };
    const Z = others.find(s => h.len[s] >= 5);
    if (slam && h.len[Y] >= 5 && Z)
      return { call: '3' + Z, why: `${JA_SUIT[Y]}と${JA_SUIT[Z]}の5-5以上でスラムの可能性があるので、ジャンプして3${SYM[Z]}（スラムトライ）` };
    const ask = isMaj(Y) ? (h.len[Y] === 5 || (Y === 'H' && h.len.S >= 4)) : (h.len.H >= 4 || h.len.S >= 4);
    if (h.adj >= 13) {
      if (ask) return { call: '2D', why: '13点以上でメジャーについて聞きたいことがあるので2♦（2ウェイ・チェックバック、ゲームフォーシング）' };
      if (isMaj(Y) && h.len[Y] >= 6) return { call: '4' + Y, why: `${JA_SUIT[Y]}6枚以上でゲームの点数があるので4${SYM[Y]}` };
      if (h.balanced) return { call: '3N', why: '13点以上のバランスハンドで、メジャーについて聞くこともないので3NT' };
      return { call: '2D', why: '13点以上なので2♦（2ウェイ・チェックバック、ゲームフォーシング）で形を聞く' };
    }
    const inv = h.len[Y] >= 6 ? h.dpLong(Y, 2.5) : h.adj; // 6枚以上ならパートナーの平均2.5枚と合わせてショートを加点
    if (inv >= 10.5) return { call: '2C', why: `${h.len[Y] >= 6 ? `${JA_SUIT[Y]}6枚以上（ショートを加点して${fmt(inv)}点）` : '11〜12点'}なので2♣（2ウェイ・チェックバック。オープナーは必ず2♦と答える）` };
    if (h.len.D >= 6) return { call: '2C', why: 'ダイヤ6枚以上で弱いので、2♣（2♦を強制）を使って2♦で止める' };
    if (h.len[Y] >= 6) return { call: '2' + Y, why: `${JA_SUIT[Y]}6枚以上で弱いので2${SYM[Y]}で止める` };
    return { call: 'P', why: 'ゲームの可能性がないのでパス' };
  }, (call, b) => {
    if (call === '2C') return { shows: { hcp: [0, 12.99] }, force: 1 };
    if (call === '2D') return { shows: { hcp: [13, 37] }, force: 'GF' };
    if (call === '3' + b.Y) return { shows: { [b.Y]: [6, 13], hcp: [17, 37], agree: b.Y, interest: true }, force: 'GF' };
    if (isBid(call) && call[0] === '3' && call[1] !== b.X && call[1] !== 'N') return { shows: { [b.Y]: [5, 13], [call[1]]: [5, 13], hcp: [17, 37] }, force: 'GF' };
    if (call === '2' + b.Y) return { shows: { [b.Y]: [6, 13], hcp: [0, 10.99] } };
    return null;
  });
  R(nt1Ext('2C'), '2D', () => true, null, '2♣は2♦を強制するビッド（2ウェイ・チェックバック）なので2♦');
  // 2♣-2♦ のあと（11〜12点の招待、または弱いダイヤでパス）
  const cbInv = (h, c) => h.len[c.b.Y] >= 6 ? h.dpLong(c.b.Y, 2.5) : h.adj;
  R(nt1Ext('2C', '2D'), 'P', (h, c) => cbInv(h, c) < 10.5, null, 'ダイヤが長く弱いので2♦で止める');
  R(nt1Ext('2C', '2D'), '3Y', (h, c) => h.len[c.b.Y] >= 6, (b) => ({ [b.Y]: [6, 13], hcp: [11, 12.99] }), '6枚以上のスートで11〜12点なので3のレベルで招待');
  R(nt1Ext('2C', '2D'), '2Y', (h, c) => isMaj(c.b.Y) && h.len[c.b.Y] === 5, (b) => ({ [b.Y]: [5, 5], hcp: [11, 12.99] }), '5枚のメジャーで11〜12点なので2のレベルで招待（3枚サポートを聞く）');
  R(nt1Ext('2C', '2D'), '2H', (h, c) => c.b.Y !== 'H' && h.len.H >= 4, { H: [4, 13], hcp: [11, 12.99] }, 'ハート4枚で11〜12点なので2♥で招待');
  R(nt1Ext('2C', '2D'), '2S', (h, c) => c.b.Y !== 'S' && h.len.S >= 4, { S: [4, 13], hcp: [11, 12.99] }, 'スペード4枚で11〜12点なので2♠で招待');
  R(nt1Ext('2C', '2D'), '3X', (h, c) => !isMaj(c.b.X) && h.len[c.b.X] >= 4, (b) => ({ [b.X]: [4, 13], hcp: [11, 12.99] }), 'オープナーのマイナーに4枚以上のサポートがある11〜12点なので3のレベルで招待');
  R(nt1Ext('2C', '2D'), '2N', () => true, { hcp: [11, 12.99] }, 'メジャーで聞くことがない11〜12点なので2NTで招待');
  const ntMax = h => h.adj >= 13; // 1NTリビッド（11.5〜14点）の上の方
  for (const O of ['H', 'S']) {
    const q = nt1Ext('2C', '2D', '2' + O);
    R(q, '4' + O, (h, c) => h.len[O] >= (c.b.Y === O ? 3 : 4) && ntMax(h), null, `${JA_SUIT[O]}のフィットがあり上の方の点数なので招待を受けて4${SYM[O]}`);
    R(q, '3' + O, (h, c) => h.len[O] >= (c.b.Y === O ? 3 : 4), null, `${JA_SUIT[O]}のフィットはあるが最低点なので3${SYM[O]}`);
    R(q, '3N', ntMax, null, 'フィットはないが上の方の点数なので3NT');
    R(q, '2N', (h, c) => c.b.Y !== O || !/[AKQ]/.test(h.hand[O]), null, (h, c) => c.b.Y !== O ? 'フィットがなく最低点なので2NT'
      : `${JA_SUIT[O]}は2枚でQ以上の札がない（5-2のフィットでは弱い）ので、最低点だが2NT`);
    R(q, 'P', () => true, null, 'フィットがなく最低点なのでパス');
  }
  R(nt1Ext('2C', '2D', '2N'), '3N', ntMax, null, '上の方の点数なので招待を受けて3NT');
  R(nt1Ext('2C', '2D', '2N'), 'P', () => true, null, '最低点なので招待を断ってパス');
  const inv3 = (h, c) => c.seq[5] === '3' + c.b.Y;
  R(nt1Ext('2C', '2D', '*'), '4Y', (h, c) => inv3(h, c) && isMaj(c.b.Y) && ntMax(h), null, '上の方の点数なので招待を受けてゲーム');
  R(nt1Ext('2C', '2D', '*'), '3N', (h, c) => inv3(h, c) && ntMax(h), null, '上の方の点数なので招待を受けて3NT');
  R(nt1Ext('2C', '2D', '*'), 'P', inv3, null, '最低点なので招待を断ってパス');
  const invX = (h, c) => c.seq[5] === '3' + c.b.X;
  R(nt1Ext('2C', '2D', '*'), '3N', (h, c) => invX(h, c) && ntMax(h), null, '上の方の点数なので招待を受けて3NT');
  R(nt1Ext('2C', '2D', '*'), 'P', invX, null, '最低点なので招待を断ってパス');
  R(nt1Ext('2C', '2D', '*', '*'), 'P', () => true, null, 'オープナーが招待への答えを出したのでパス');
  // 2♦（ゲームフォーシング）への答え
  R(nt1Ext('2D'), '2Y', (h, c) => isMaj(c.b.Y) && h.len[c.b.Y] >= 3, (b) => ({ [b.Y]: [3, 3] }), '2♦への答え：パートナーのメジャーに3枚サポートがある');
  R(nt1Ext('2D'), '2H', (h, c) => c.b.Y !== 'H' && h.len.H >= 4, { H: [4, 4] }, '2♦への答え：ハート4枚がある');
  R(nt1Ext('2D'), '2S', (h, c) => c.b.Y !== 'S' && h.len.S >= 4, { S: [4, 4] }, '2♦への答え：スペード4枚がある');
  R(nt1Ext('2D'), '2N', () => true, null, '2♦への答え：メジャーのサポートも4枚スートもない');
  RD(nt1Ext('2D', '*'), (h, c) => {
    const Y = c.b.Y, ans = c.seq[4];
    let T = null;
    if (isMaj(Y) && ans === '2' + Y && h.len[Y] >= 5) T = Y;
    else if (ans !== '2N' && isMaj(ans[1]) && ans[1] !== Y && h.len[ans[1]] >= 4) T = ans[1];
    else if (isMaj(Y) && h.len[Y] >= 6) T = Y;
    if (T) { const call = agreeCall(h, c, T); return { call, why: agreeWhy(h, c, call) }; }
    return { call: '3N', why: 'メジャーのフィットがないので3NT' };
  }, (call) => isBid(call) && call[1] !== 'N' ? { shows: fitShows(call) } : null);
  // 5-5のスラムトライへのオープナー
  RD(nt1Ext('*'), (h, c) => {
    const { X, Y } = c.b, j = c.seq[3];
    if (!isBid(j) || j[0] !== '3' || [X, Y, 'N'].includes(j[1])) return null;
    const Z = j[1];
    let T = null;
    if (isMaj(Y) && h.len[Y] >= 3) T = Y; else if (isMaj(Z) && h.len[Z] >= 3) T = Z;
    else if (h.len[Y] >= 3) T = Y; else if (h.len[Z] >= 3) T = Z;
    if (!T) return { call: '3N', why: 'パートナーの2スートにどちらも3枚サポートがないので3NT' };
    const call = agreeCall(h, c, T);
    return { call, why: agreeWhy(h, c, call) };
  }, (call, b, before) => {
    const j = before[3];
    if (!isBid(j) || j[0] !== '3' || [b.X, b.Y, 'N'].includes(j[1])) return null;
    return isBid(call) && call[1] !== 'N' ? { shows: fitShows(call) } : null;
  });

  // ===== 2♣オープン後 =====
  R('2C', '2H', h => h.hcp < 4, { hcp: [0, 3] }, '0〜3点なのでスーパーネガティブの2♥', 1);
  R('2C', '2D', () => true, { hcp: [4, 37] }, '4点以上なので2♦（ウェイティング）', 1);
  R('2C 2D', '2N', h => h.balanced && between(h.hcp, 22, 24), { hcp: [22, 24], bal: true }, 'バランスハンド22〜24点なので2NT');
  // コキッシュ（2♥）：バランス25点以上、ハート6枚以上、またはハート5枚の5-5以上・5440の2スーター
  const kokishH = h => h.len.H >= 5 && h.len.H >= h.len.S &&
    (h.len.H >= 6 || SUITS.some(s => s !== 'H' && h.len[s] >= 5) || h.pattern === '5440');
  R('2C 2D', '2H', h => (h.balanced && h.hcp >= 25) || kokishH(h), { hcp: [22, 37] }, 'ハート6枚以上か、ハート5枚の5-5以上・5440、またはバランスハンド25点以上なのでコキッシュの2♥（パートナーは2♠と答える）', 1);
  R('2C 2D', '2S', h => h.len.S >= 5, { S: [5, 13] }, 'スペード5枚以上なので2♠', 'GF');
  R('2C 2D', '3D', h => h.len.D >= 5 && h.len.D >= h.len.C, { D: [5, 13] }, 'ダイヤ5枚以上なので3♦', 'GF');
  R('2C 2D', '3C', h => h.len.C >= 5, { C: [5, 13] }, 'クラブ5枚以上なので3♣', 'GF');
  R('2C 2D', '2N', () => true, { hcp: [22, 37] }, 'コキッシュを使う形（ハート6枚以上・5-5以上・5440）でも長いスートでもないので2NT');
  R('2C 2D 2H', '2S', () => true, null, 'コキッシュ・リレーなので必ず2♠と答える', 1);
  R('2C 2D 2H 2S', '2N', h => h.balanced, { hcp: [25, 27], bal: true }, 'コキッシュの後の2NT：バランスハンド25点以上');
  R('2C 2D 2H 2S', '3S', h => h.len.S >= 4, { H: [5, 13], S: [4, 13] }, 'ハートとスペードの2スーター', 'GF');
  R('2C 2D 2H 2S', '3D', h => h.len.D >= 4, { H: [5, 13], D: [4, 13] }, 'ハートとダイヤの2スーター', 'GF');
  R('2C 2D 2H 2S', '3C', h => h.len.C >= 4, { H: [5, 13], C: [4, 13] }, 'ハートとクラブの2スーター', 'GF');
  R('2C 2D 2H 2S', '3H', () => true, { H: [6, 13] }, 'ハートのワンスーター', 'GF');
  R('2C 2H', '2N', h => h.balanced && h.hcp < 25, { hcp: [22, 24], bal: true }, 'バランスハンド22〜24点なので2NT');
  R('2C 2H', '3N', h => h.balanced, { hcp: [25, 27], bal: true }, 'バランスハンド25点以上なので3NT');
  R('2C 2H', '2S', h => h.len.S >= 5 && h.len.S >= h.len.H, { S: [5, 13] }, 'スペード5枚以上なので2♠', 'GF');
  R('2C 2H', '3H', h => h.len.H >= 5, { H: [5, 13] }, 'ハート5枚以上なので3♥（2♥はパートナーの人工的なビッドなので）', 'GF');
  R('2C 2H', '3D', h => h.len.D >= 5 && h.len.D >= h.len.C, { D: [5, 13] }, 'ダイヤ5枚以上なので3♦', 'GF');
  R('2C 2H', '3C', h => h.len.C >= 5, { C: [5, 13] }, 'クラブ5枚以上なので3♣', 'GF');
  R('2C 2H', '2N', () => true, null, '長いスートがないので2NT');

  // ===== ウィーク2オープン後（オウガスト） =====
  R('2X', '2N', (h, c) => h.hcp >= 15 && c.b.X !== 'C', { hcp: [15, 37] }, '15点以上でゲームの可能性があるのでオウガスト（2NT）でパートナーの強さとスートの質を聞く', 1);
  R('2M', '4M', (h, c) => h.len[c.b.M] >= 4 || (h.len[c.b.M] >= 3 && h.dp(c.b.M, 6) >= 14), null, 'サポート4枚以上なので4メジャー（プリエンプティブ）');
  R('2X', '3X', (h, c) => c.b.X !== 'C' && h.len[c.b.X] >= 3, null, 'サポート3枚以上なのでプリエンプティブ・レイズ');
  R('2X', 'P', () => true, null, 'ゲームの可能性が低いのでパス');
  const ogMax = h => h.hcp >= 8;
  const ogGood = (h, s) => h.top3(s) >= 2;
  R('2X 2N', '3N', (h, c) => h.top3(c.b.X) === 3, null, 'オウガストへの答え：AKQがそろったスート');
  R('2X 2N', '3S', (h, c) => ogMax(h) && ogGood(h, c.b.X), { hcp: [8, 10] }, 'オウガストへの答え：最高点（8〜10点）・良いスート（トップ3枚中2枚）');
  R('2X 2N', '3H', (h, c) => ogMax(h), { hcp: [8, 10] }, 'オウガストへの答え：最高点（8〜10点）・悪いスート');
  R('2X 2N', '3D', (h, c) => ogGood(h, c.b.X), { hcp: [5, 7] }, 'オウガストへの答え：最低点（5〜7点）・良いスート（トップ3枚中2枚）');
  R('2X 2N', '3C', () => true, { hcp: [5, 7] }, 'オウガストへの答え：最低点（5〜7点）・悪いスート');
  for (const X of ['D', 'H', 'S']) {
    const g = X === 'D' ? '3N' : '4' + X;
    const so = '3' + X;
    R(`2${X} 2N 3N`, 'P', () => true, null, 'パートナーのスートが固いので3NTで決まり');
    for (const ans of ['3H', '3S']) R(`2${X} 2N ${ans}`, g, () => true, null, 'パートナーは最高点なのでゲーム');
    R(`2${X} 2N 3D`, g, h => h.hcp >= 17, null, 'パートナーは最低点だが良いスートで、こちらが強いのでゲーム');
    R(`2${X} 2N 3D`, X === 'D' ? 'P' : so, () => true, null, 'パートナーが最低点なのでパートスコアで止める');
    R(`2${X} 2N 3C`, g, h => h.hcp >= 19, null, 'パートナーは最低点だが、こちらが非常に強いのでゲーム');
    R(`2${X} 2N 3C`, so, () => true, null, 'パートナーが最低点なのでパートスコアで止める');
    R(`2${X} 2N 3C ${so}`, 'P', () => true, null, 'サインオフなのでパス');
    if (X !== 'D') R(`2${X} 2N 3D ${so}`, 'P', () => true, null, 'サインオフなのでパス');
    R(`2${X} 3${X}`, 'P', () => true, null, 'プリエンプティブ・レイズなのでパス');
  }
  R('2M 4M', 'P', () => true, null, 'パートナーがゲームを決めたのでパス');

  // ------------------------------------------------------------------
  // オークションの解析
  // ------------------------------------------------------------------
  // auction: ディーラーからの全コール。E/W は常にパス（今は競り合いなし）
  function analyze(auction, dealer) {
    const d = SEATS.indexOf(dealer);
    const ours = [];
    auction.forEach((c, i) => {
      const seat = SEATS[(d + i) % 4];
      if (seat === 'N' || seat === 'S') ours.push({ seat, call: c, idx: i });
    });
    const firstBid = ours.findIndex(o => o.call !== 'P');
    const seq = firstBid < 0 ? [] : ours.slice(firstBid).map(o => o.call);
    const seqSeats = firstBid < 0 ? [] : ours.slice(firstBid).map(o => o.seat);
    const passedSeats = ours.slice(0, firstBid < 0 ? ours.length : firstBid).map(o => o.seat);
    return { seq, seqSeats, passedSeats };
  }

  function isOver(auction) {
    const n = auction.length;
    if (n >= 4 && auction.every(c => c === 'P')) return true;
    if (n >= 4 && auction.some(c => c !== 'P') && auction.slice(-3).every(c => c === 'P')) return true;
    return false;
  }
  function lastBid(seq) { for (let i = seq.length - 1; i >= 0; i--) if (isBid(seq[i])) return seq[i]; return null; }
  function legal(call, seq) {
    if (call === 'P') return true;
    if (!isBid(call)) return false;
    const lb = lastBid(seq);
    return !lb || rankOf(call) > rankOf(lb);
  }

  // ルールで「このビッドは何を意味するか」を調べる
  function interpret(seqBefore, call, ctx) {
    for (const r of RULES) {
      const b = matchRule(r, seqBefore);
      if (!b) continue;
      if (r.dyn) {
        const x = r.interp(call, b, seqBefore);
        if (x) return { shows: x.shows || null, force: x.force || 0, rule: r };
        continue;
      }
      if (fill(r.call, b) !== call) continue;
      const shows = typeof r.shows === 'function' ? r.shows(b) : r.shows;
      return { shows, force: r.force, rule: r };
    }
    // ルールにないビッド：自然なビッドとして解釈する
    const shows = {};
    if (isBid(call) && call[1] !== 'N') {
      const s = call[1];
      const mine = ctx.self, pard = ctx.partner;
      if (pard[s][0] >= 4) shows[s] = [3, 13];            // パートナーのスートのレイズ
      else if (mine[s][0] >= 4) shows[s] = [Math.min(mine[s][0] + 1, 6), 13]; // 同じスートの再ビッド
      else shows[s] = [4, 13];                              // 新しいスート
    }
    return { shows, force: 0, rule: null };
  }

  // 自分たちの流れを1手ずつたどって、各自の示した内容と「フォーシングか」を計算する
  // respPassed: レスポンダーがパス済みのハンド（11点以下で、最初の応答はフォーシングでない）
  function buildContext(seq, respPassed) {
    const know = [freshKnow(), freshKnow()]; // [0]=オープナー側, [1]=レスポンダー側
    if (respPassed) know[1].hcp = [0, 11.49];
    let gf = false, forcing = false;
    const slam = freshSlam();
    for (let i = 0; i < seq.length; i++) {
      const me = i % 2;
      if (slam.active) { slamInterpret(slam, seq.slice(0, i), seq[i], me); forcing = false; continue; }
      const r = interpret(seq.slice(0, i), seq[i], { self: know[me], partner: know[1 - me] });
      merge(know[me], r.shows);
      const passedResp = respPassed && i === 1;
      if (r.force === 'GF' && !passedResp) gf = true;
      forcing = !!r.force && !passedResp;
      const sh = r.shows;
      if (sh && sh.agree && gf) {
        Object.assign(slam, { T: sh.agree, active: true, agreeIdx: i });
        if (sh.interest) slam.interest[me]++;
        if (sh.ctrl) { slam.ctrl[me].push(...sh.ctrl); slam.splShort = sh.ctrl[0]; }
      }
    }
    const meIdx = seq.length % 2;
    return { self: know[meIdx], partner: know[1 - meIdx], gf, forcing, slam };
  }

  function reachedGame(seq) {
    const lb = lastBid(seq);
    return lb && levelOf(lb) >= gameLevel(strainOf(lb));
  }

  // ------------------------------------------------------------------
  // スラムの仕組み
  //   FGでフィットが決まった後：切り札より下のゲーム未満のビッド（3Mなど）はスラムに興味あり、
  //   それ以降の切り札以外のスートのビッドはコントロール（A・K・ショート）を示す。
  //   やる気 = キーカード（4枚のAと切り札のK）の枚数 + 示した点数の下限からの余力2点ごとに1
  //   やる気1以上→1回、3以上→2回、5以上→コントロールのないスートが分かるまで何回でも
  //   全スートにコントロールがあり、2人のやる気の合計が6以上なら4NT（RKCB 1430）
  // ------------------------------------------------------------------
  function isMaj(s) { return s === 'H' || s === 'S'; }
  function gameCall(T) { return gameLevel(T) + T; }
  function keycards(h, T) { return SUITS.filter(s => h.hand[s].includes('A')).length + (h.hand[T].includes('K') ? 1 : 0); }
  function strengthFor(h, T, c) { return h.dp(T, c.partner[T][0]); }
  function motivation(h, T, c) {
    const spare = Math.max(0, Math.floor((strengthFor(h, T, c) - c.self.hcp[0]) / 2));
    return keycards(h, T) + spare;
  }
  // パートナーの推定点数の中央と合わせて31点以上ならスラムの可能性あり
  function slamPossible(h, c) {
    const p = c.partner.hcp, mid = (p[0] + Math.min(p[1], p[0] + 8)) / 2;
    return h.adj + mid >= 31;
  }
  // FGでフィットを示す：やる気があれば安く（3Mなど）、なければゲーム
  function agreeCall(h, c, T) {
    const g = gameCall(T), ch = cheapest(T, c.seq);
    if (ch && rankOf(ch) < rankOf(g) && motivation(h, T, c) >= 1) return ch;
    return legal(g, c.seq) ? g : ch;
  }
  function hasControl(h, s) { return h.hand[s].includes('A') || h.hand[s].includes('K') || h.len[s] <= 1; }
  function freshSlam() {
    return { T: null, active: false, interest: [0, 0], ctrl: [[], []], deny: [[], []], rk: null, ntSign: false, agreeIdx: -1, splShort: null };
  }
  // フィットが決まった後のビッドの意味を記録する
  function slamInterpret(st, before, call, me) {
    if (call === 'P') return;
    const T = st.T, G = gameCall(T);
    if (st.rk && st.rk.asker !== me && !st.rk.resp) { st.rk.resp = call; return; }
    if (st.rk && st.rk.resp && st.rk.asker === me && !st.rk.placed) { st.rk.placed = call; return; }
    if (call === '4N') { st.rk = { asker: me }; return; }
    if (call[1] === 'N') { st.ntSign = true; return; }
    if (call[1] === T) { if (rankOf(call) < rankOf(G)) st.interest[me]++; return; }
    if (rankOf(call) < rankOf(G)) {
      st.interest[me]++;
      const lb = lastBid(before);
      for (let r = lb ? rankOf(lb) + 1 : 0; r < rankOf(call); r++) {
        const s = STRAINS[r % 5];
        if (s !== 'N' && s !== T && !st.ctrl[me].includes(s) && !st.deny[me].includes(s)) st.deny[me].push(s);
      }
      if (!st.ctrl[me].includes(call[1])) st.ctrl[me].push(call[1]);
    }
  }
  function slamDecide(h, seq, c) {
    const st = c.slam, me = seq.length % 2, pa = 1 - me, T = st.T, G = gameCall(T);
    const lb = lastBid(seq);
    const P = why => ({ call: 'P', why });
    if (st.ntSign) return P('3NTに決まったのでパス');
    if (st.rk) {
      if (st.rk.placed) return P('キーカードを聞いた側がコントラクトを決めたのでパス');
      if (st.rk.asker === pa && !st.rk.resp) {
        const k = keycards(h, T), q = h.hand[T].includes('Q');
        // ボイドがあるとき：キーカードが偶数（2・4枚）→ 5NT、奇数（1・3枚）→ 6のレベルでボイドのスート
        //   （ボイドのスートが切り札より上なら6の切り札）
        const voidS = SUITS.find(s => s !== T && h.len[s] === 0);
        if (voidS && (k === 2 || k === 4))
          return { call: '5N', why: `RKCB（1430）への答え：キーカードが${k}枚（偶数）で、ボイドがあるので5NT` };
        if (voidS && (k === 1 || k === 3)) {
          const v6 = rankOf('6' + voidS) < rankOf('6' + T) ? '6' + voidS : '6' + T;
          return { call: v6, why: `RKCB（1430）への答え：キーカードが${k}枚（奇数）で、${JA_SUIT[voidS]}がボイドなので${callText(v6)}` };
        }
        const call = (k === 1 || k === 4) ? '5C' : (k === 0 || k === 3) ? '5D' : k === 2 ? (q ? '5S' : '5H') : '5C';
        return { call, why: `RKCB（1430）への答え：キーカード（4枚のAと${JA_SUIT[T]}のK）が${k}枚${k === 2 ? (q ? '・切り札のQあり' : '・切り札のQなし') : ''}なので${callText(call)}` };
      }
      if (st.rk.asker === me && st.rk.resp) {
        const resp = st.rk.resp, myK = keycards(h, T);
        const voidResp = resp === '5N' || resp[0] === '6';
        const opts = { '5C': [1, 4], '5D': [0, 3], '5H': [2], '5S': [2], '5N': [2, 4] }[resp] || (resp[0] === '6' ? [1, 3] : [1]);
        let pK = opts[0];
        if (opts.length > 1 && myK + opts[0] < 3 && myK + opts[1] <= 5) pK = opts[1];
        const missing = 5 - myK - pK;
        const qKnown = resp === '5S' || h.hand[T].includes('Q') || h.len[T] + c.partner[T][0] >= 10;
        const total = strengthFor(h, T, c) + c.partner.hcp[0];
        const five = '5' + T, six = '6' + T, seven = '7' + T;
        const note = `自分${myK}枚＋パートナー${pK}枚＝キーカード${myK + pK}枚${voidResp ? '（パートナーはボイドあり）' : ''}`;
        if (lb === six && missing > 0) return P(`${note}。パートナーの答えが${callText(six)}なのでパス`);
        if (missing >= 2) {
          if (legal(five, seq)) return { call: five, why: `${note}で2枚以上足りないので${callText(five)}で止める` };
          if (lb === five) return P(`${note}で2枚以上足りないのでパス`);
          return { call: six, why: `${note}。5のレベルで止められないので${callText(six)}` };
        }
        if (missing === 0 && qKnown && total >= 37)
          return { call: seven, why: `${note}で全部そろい、切り札のQもあり、合計点も十分（37点以上）なのでグランドスラム` };
        return { call: six, why: `${note}${missing ? 'で足りないのは1枚だけ' : 'で全部そろっている（グランドスラムは確実ではない）'}なのでスモールスラム` };
      }
    }
    if (lb && levelOf(lb) >= 6) return P('スラムに決まったのでパス');
    // マイナーのスプリンターに対して、ショートのスートに点が多いなら3NT
    if (!isMaj(T) && st.splShort && seq.length === st.agreeIdx + 1 && h.sHcp[st.splShort] >= 3 && h.stopper(st.splShort) && legal('3N', seq))
      return { call: '3N', why: `パートナーのショートの${JA_SUIT[st.splShort]}に点がある（無駄になりやすい）のでノートランプを選ぶ` };
    const mot = motivation(h, T, c);
    const allowed = mot >= 5 ? 99 : mot >= 3 ? 2 : mot >= 1 ? 1 : 0;
    const pMot = [0, 1, 3, 5][Math.min(3, st.interest[pa])];
    const side = SUITS.filter(s => s !== T);
    const covered = side.every(s => hasControl(h, s) || st.ctrl[pa].includes(s));
    const hole = side.find(s => !hasControl(h, s) && st.deny[pa].includes(s));
    const motTxt = `自分のやる気${mot}・パートナーのやる気${pMot}以上`;
    if (covered && mot + pMot >= 6) {
      if (legal('4N', seq)) return { call: '4N', why: `全スートにコントロールがあり、2人のやる気の合計が6以上（${motTxt}）なので4NT（RKCB：キーカードを聞く）` };
      const six = '6' + T;
      if (legal(six, seq)) return { call: six, why: `全スートにコントロールがあり、やる気も十分（${motTxt}）だが4NTが使えないので${callText(six)}` };
    }
    const signoff = why => legal(G, seq) ? { call: G, why } : P(why.replace(/[^、]*で止める$/, 'パス'));
    if (hole) return signoff(`${JA_SUIT[hole]}に2人ともコントロールがないと分かったので${callText(G)}で止める`);
    if (st.interest[me] >= allowed)
      return signoff(mot === 0 ? `スラムへのやる気がない（${motTxt}）ので${callText(G)}で止める` : `やる気（${motTxt}）の分だけスラムに興味を示したので${callText(G)}で止める`);
    const ch = cheapest(T, seq);
    if (st.interest[0] + st.interest[1] === 0 && ch && rankOf(ch) < rankOf(G))
      return { call: ch, why: `スラムに興味がある（${motTxt}）ので${callText(ch)}（フィットを確かめてスラムに興味を示す）` };
    for (let r = lb ? rankOf(lb) + 1 : 0; r < rankOf(G); r++) {
      const s = STRAINS[r % 5], call = (Math.floor(r / 5) + 1) + s;
      if (s === 'N' || s === T || st.ctrl[me].includes(s)) continue;
      if (hasControl(h, s)) return { call, why: `スラムに興味がある（${motTxt}）ので${callText(call)}：${JA_SUIT[s]}のコントロール（A・K・ショートのどれか）を示す` };
    }
    return signoff(`ゲームより下でコントロールを示せるビッドがないので${callText(G)}で止める`);
  }

  // ------------------------------------------------------------------
  // 汎用判断（ルール表にない流れ）
  // ------------------------------------------------------------------
  function fallback(h, seq, ctx) {
    const p = ctx.partner, self = ctx.self;
    const pMin = p.hcp[0], pMax = Math.min(p.hcp[1], p.hcp[0] + 10);
    let myPts = h.adj;
    for (const s of ['S', 'H']) if (p[s][0] >= 4 && h.len[s] >= 3 && h.len[s] + p[s][0] >= 8) myPts = Math.max(myPts, h.dp(s, p[s][0]));
    const totMin = myPts + pMin, totMax = myPts + pMax, totMid = (totMin + totMax) / 2;
    const lb = lastBid(seq);
    const mustBid = ctx.forcing || (ctx.gf && !reachedGame(seq));
    const notes = [`パートナーは${fmt(pMin)}〜${fmt(p.hcp[1])}点と推定、合計${fmt(totMin)}〜${fmt(totMax)}点`];

    // フィット（自分の枚数 + パートナーの最低枚数 ≥ 8）
    let fit = null;
    for (const s of ['S', 'H', 'D', 'C']) {
      const tot = h.len[s] + p[s][0];
      if (tot >= 8 && (!fit || (tot > fit.tot && !(fit.s === 'H' || fit.s === 'S')))) fit = { s, tot };
    }
    if (fit) notes.push(`${JA_SUIT[fit.s]}で合計${fit.tot}枚以上のフィット`);
    const pick = (cands, why) => {
      for (const c of cands) if (legal(c, seq)) return { call: c, why: why + '（' + notes.join('、') + '）' };
      return null;
    };
    const major = fit && (fit.s === 'H' || fit.s === 'S');
    const stoppersOk = SUITS.every(s => h.stopper(s) || p[s][0] >= 4 || h.len[s] >= 4 || p.stop.includes(s));

    // スラム
    if (totMin >= 33) {
      const r = fit ? pick(['6' + fit.s], 'スラムの点数があるのでフィットのスートでスラム') : pick(['6N'], 'スラムの点数があるので6NT');
      if (r) return r;
    }
    // ゲーム
    if (totMin >= 25 || ctx.gf) {
      if (reachedGame(seq) && !mustBid) return { call: 'P', why: 'すでにゲームに到達しているのでパス（' + notes.join('、') + '）' };
      let r = null;
      if (major) r = pick(['4' + fit.s], 'メジャーのフィットがありゲームの点数があるので4メジャー');
      if (!r && (stoppersOk || !fit)) r = pick(['3N'], 'ゲームの点数があるので3NT');
      if (!r && fit) r = pick(['5' + fit.s], 'マイナーのフィットがありゲームの点数があるので5マイナー');
      if (!r) r = pick(['3N', '4H', '4S', '5C', '5D'], 'ゲームを目指す');
      if (r) return r;
      return { call: 'P', why: 'これ以上のビッドが見つからないのでパス（' + notes.join('、') + '）' };
    }
    // 招待の範囲
    if (totMax >= 25 && !reachedGame(seq)) {
      let r = null;
      if (fit && lb) {
        const inv = (gameLevel(fit.s) - 1) + fit.s;
        r = pick([inv], 'ゲームの可能性があるのでフィットのスートで招待');
      }
      if (!r && !fit) r = pick(['2N'], 'ゲームの可能性があるので2NTで招待');
      if (r) return r;
    }
    // パートスコア
    if (!mustBid) return { call: 'P', why: 'ゲームの可能性が低いのでパス（' + notes.join('、') + '）' };
    // フォーシングなので何か言う：一番安く自然なビッド
    const cands = [];
    if (lb && lb[1] !== 'N' && h.len[lb[1]] >= 3) cands.push(cheapest(lb[1], seq));
    const ls = h.longest();
    cands.push(cheapest(ls, seq));
    cands.push(cheapest('N', seq));
    for (const s of ['C', 'D', 'H', 'S']) if (h.len[s] >= 4) cands.push(cheapest(s, seq));
    const r = pick(cands.filter(Boolean), 'フォーシングなので、一番自然で安いビッド');
    return r || { call: 'P', why: 'パス' };
  }
  function cheapest(strain, seq) {
    for (let lv = 1; lv <= 7; lv++) { const c = lv + strain; if (legal(c, seq)) return c; }
    return null;
  }

  // ------------------------------------------------------------------
  // あなたの回答例を参照する
  // examples: [{seqKey, hcp, len:{S,H,D,C}, call, id, reason}]
  // ------------------------------------------------------------------
  function seqKeyOf(seq, passedBeforeMe) {
    return (passedBeforeMe ? 'p:' : '') + (seq.length ? seq.join('-') : '(open)');
  }
  function distance(h, ex) {
    let d = Math.abs(h.rawHcp - ex.hcp);
    for (const s of SUITS) d += 0.75 * Math.abs(h.len[s] - ex.len[s]);
    return d;
  }
  const NEAR = 1.5; // これ以下の「近さ」ならあなたの例を優先

  function nearestExample(h, key, examples, seq) {
    let best = null;
    for (const ex of examples || []) {
      if (ex.seqKey !== key) continue;
      if (!legal(ex.call, seq)) continue;
      const d = distance(h, ex);
      if (!best || d < best.d || (d === best.d && (ex.created || '') > (best.ex.created || ''))) best = { ex, d };
    }
    return best;
  }

  // ------------------------------------------------------------------
  // メイン：次のビッドを選ぶ
  //   hand     : {S,H,D,C}
  //   auction  : ディーラーからの全コール
  //   dealer   : 'N'|'E'|'S'|'W'
  //   examples : あなたの回答例（省略可）
  // 戻り値 {call, why, source:'rule'|'fallback'|'example', ruleId, ruleCall, ruleWhy, example}
  // ------------------------------------------------------------------
  function chooseCall(hand, auction, dealer, examples) {
    const h = evaluate(hand);
    const { seq, seqSeats, passedSeats } = analyze(auction, dealer);
    const d = SEATS.indexOf(dealer);
    const mySeat = SEATS[(d + auction.length) % 4];
    if (mySeat === 'E' || mySeat === 'W') return { call: 'P', why: '相手はパス（今は競り合いなし）', source: 'rule' };
    const passedBeforeMe = false; // 将来：パス済みハンドを区別する
    const respSeat = seqSeats.length ? (seqSeats[0] === 'N' ? 'S' : 'N') : null;
    const respPassed = !!respSeat && passedSeats.includes(respSeat);
    const ctx = buildContext(seq, respPassed);
    ctx.pos = seq.length ? null : auction.length;   // オープンの何番手か（0〜3）
    ctx.respPassed = respPassed;

    let res = null;
    if (ctx.slam.active) {
      const s = slamDecide(h, seq, ctx);
      if (s && legal(s.call, seq)) res = { call: s.call, why: s.why, source: 'rule', ruleId: 'slam' };
    }
    for (const r of res ? [] : RULES) {
      const b = matchRule(r, seq);
      if (!b) continue;
      if (r.dyn) {
        let x = null;
        try { x = r.pick(h, { b, ...ctx, seq }); } catch (e) { x = null; }
        if (x && x.call && legal(x.call, seq)) { res = { call: x.call, why: x.why, source: 'rule', ruleId: r.id }; break; }
        continue;
      }
      const call = fill(r.call, b);
      if (!legal(call, seq)) continue;
      if (call === 'P' && seq.length && (ctx.forcing || (ctx.gf && !reachedGame(seq)))) continue;
      let ok = false;
      try { ok = r.test(h, { b, ...ctx, seq }); } catch (e) { ok = false; }
      if (ok) { res = { call, why: typeof r.why === 'function' ? r.why(h, { b, ...ctx, seq }) : r.why, source: 'rule', ruleId: r.id }; break; }
    }
    if (!res) {
      const f = fallback(h, seq, ctx);
      res = { call: f.call, why: '【汎用判断】' + f.why, source: 'fallback', ruleId: null };
    }
    // あなたの回答例
    const key = seqKeyOf(seq, passedBeforeMe);
    let near = nearestExample(h, key, examples, seq);
    // 例のビッドが示す枚数（5枚メジャーなど）をこの手が満たさないときは使わない
    if (near && near.ex.call !== res.call) {
      const sh = interpret(seq, near.ex.call, { self: ctx.self, partner: ctx.partner }).shows || {};
      if (SUITS.some(s => Array.isArray(sh[s]) && (h.len[s] < sh[s][0] || h.len[s] > sh[s][1]))) near = null;
    }
    if (near && near.d <= NEAR && near.ex.call !== res.call) {
      return {
        call: near.ex.call,
        why: `あなたの過去の回答に近い手があるのでそれに合わせる（${describeShape(near.ex)} → ${callText(near.ex.call)}${near.ex.reason ? '「' + near.ex.reason + '」' : ''}）`,
        source: 'example', ruleId: res.ruleId, ruleCall: res.call, ruleWhy: res.why, example: near.ex,
      };
    }
    if (near && near.d <= NEAR) res.agreesWithExample = near.ex.id;
    return res;
  }
  function fmt(x) { return Math.round(x * 10) / 10; }
  function describeShape(ex) {
    return `${ex.hcp}点 ♠${ex.len.S}♥${ex.len.H}♦${ex.len.D}♣${ex.len.C}`;
  }

  // 例として保存するための特徴
  function exampleFeatures(hand, auction, dealer) {
    const h = evaluate(hand);
    const { seq } = analyze(auction, dealer);
    return { seqKey: seqKeyOf(seq, false), hcp: h.rawHcp, len: { ...h.len } };
  }

  // ------------------------------------------------------------------
  // カードを配る / PBN
  // ------------------------------------------------------------------
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  function deal(rnd = Math.random) {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push(s + r);
    shuffle(deck, rnd);
    const hands = {};
    SEATS.forEach((seat, i) => {
      const cards = deck.slice(i * 13, i * 13 + 13);
      const hand = { S: '', H: '', D: '', C: '' };
      for (const s of SUITS) hand[s] = cards.filter(c => c[0] === s).map(c => c[1]).sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b)).join('');
      hands[seat] = hand;
    });
    return hands;
  }
  function handToPbn(hand) { return SUITS.map(s => hand[s]).join('.'); }
  function pbnToHand(str) { const p = str.split('.'); return { S: p[0] || '', H: p[1] || '', D: p[2] || '', C: p[3] || '' }; }
  function dealToPbn(hands, first = 'N') {
    const i = SEATS.indexOf(first);
    return first + ':' + [0, 1, 2, 3].map(k => handToPbn(hands[SEATS[(i + k) % 4]])).join(' ');
  }
  function pbnToDeal(str) {
    const [first, rest] = str.split(':');
    const parts = rest.trim().split(/\s+/);
    const i = SEATS.indexOf(first.trim());
    const hands = {};
    parts.forEach((p, k) => { hands[SEATS[(i + k) % 4]] = pbnToHand(p); });
    return hands;
  }

  // AI同士で最後までビッドする
  function autoAuction(hands, dealer, examples, maxCalls = 40) {
    const auction = [], steps = [];
    const d = SEATS.indexOf(dealer);
    while (!isOver(auction) && auction.length < maxCalls) {
      const seat = SEATS[(d + auction.length) % 4];
      let r;
      if (seat === 'E' || seat === 'W') r = { call: 'P', why: '相手はパス', source: 'opp' };
      else r = chooseCall(hands[seat], auction, dealer, examples);
      steps.push({ seat, ...r, index: auction.length });
      auction.push(r.call);
    }
    return { auction, steps };
  }

  const api = {
    ENGINE_VERSION, SUITS, SEATS, SYM, JA_SUIT, RULES,
    evaluate, chooseCall, autoAuction, analyze, isOver, legal, lastBid, isBid, rankOf,
    callText, callPbn, parseCall, deal, dealToPbn, pbnToDeal, handToPbn, pbnToHand,
    exampleFeatures, seqKeyOf, buildContext, matchSeq,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BridgeEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

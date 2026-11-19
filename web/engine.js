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

  const ENGINE_VERSION = '0.25.0';
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
        return x.includes('A') || (x.includes('K') && n >= 2) || (x.includes('Q') && n >= 3) || n >= 4; // A／Kの2枚以上／Qの3枚以上／4枚以上
      },
      longest: () => SUITS.slice().sort((a, b) => len[b] - len[a] || STRAINS.indexOf(b) - STRAINS.indexOf(a))[0],
      shortSuits: () => SUITS.filter(s => len[s] <= 1),
      twoLongest: sorted[0] + sorted[1],
    };
    // 強さの補正（端数）：3枚以上のスートの10=1/3、5枚以上のスートのA・K=1/2、Q・J=1/3（1スート最大1点）
    //   内容が標準以上の6枚以上のスートは、6枚目から1枚ごとに+1（そのスートを示すときの強さ：h.adjWith(s)）
    //   2枚以下のスートで、より強い札（A・K）がないQ・Jは0.5点減らす（Qx=1.5、Jx=0.5、QJ=2。QT・JTは減らさない）
    let bonus = 0;
    const lenB = { S: 0, H: 0, D: 0, C: 0 }; // 6枚目以降の加点（スートごと）
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
      // 6枚以上のロングスートは、トリックにできる見込みがあれば6枚目から1枚ごとに+1
      //   条件：A・Kのどちらかを持ち、AKQJ10のうち2枚以上（QJ…のようなA・Kのないスートは加点しない）
      //   さらにスートを立ててから使うためのエントリー：AKQのうち2枚以上ならスート自身がエントリー、
      //   そうでなければサイドのAがあれば+1、サイドのKだけなら+1/2、サイドにA・Kがなければ加点なし
      if (x.length >= 6 && /[AK]/.test(x) && [...x].filter(c => 'AKQJT'.includes(c)).length >= 2) {
        const side = SUITS.filter(t => t !== s).map(t => hand[t]).join('');
        const f = count(s, 'AKQ') >= 2 || side.includes('A') ? 1 : side.includes('K') ? 0.5 : 0;
        lenB[s] = (x.length - 5) * f;
      }
      if (x === 'KQ' || x === 'KQJ') bonus -= 1 / 2;                                     // KQの2枚・KQJの3枚
    }
    h.bonus = bonus;
    h.rawHcp = hcp;             // 補正なしのHCP（表示・回答例の比較用）
    const lenSum = lenB.S + lenB.H + lenB.D + lenB.C;
    h.adjNoLen = hcp + bonus;   // 6枚目以降の加点を除いた強さ（オープン・プリエンプト・オウガスト：長さはビッドが約束している）
    h.adj = hcp + bonus + lenSum; // 補正込みの点数（「強め／弱め」を含めた強さ）
    h.hcp = h.adj;              // ルールの点数はすべて補正込みで判断する
    h.lenB = lenB;
    h.adjWith = s => h.adj;
    // そのスートで promised 枚数をすでに約束しているビッドの強さ：約束した枚数を超えた分だけ加点する
    h.adjFor = (s, promised) => h.adj - lenB[s] + (lenB[s] ? Math.max(0, len[s] - promised) * lenB[s] / (len[s] - 5) : 0);
    // 6枚スートのリビッドの強さ：AKQのうち2枚以上を持つ6枚以上のスートは、A・K・Q・Jの加点の上限を1点から2点に広げる
    h.rebidPts = s => {
      if (len[s] < 6 || h.top3(s) < 2) return h.adjFor(s, 6);
      const raw = [...hand[s]].reduce((t, c) => t + ((c === 'A' || c === 'K') ? 1 / 2 : (c === 'Q' || c === 'J') ? 1 / 3 : 0), 0);
      return h.adjFor(s, 6) + Math.min(2, raw) - Math.min(1, raw); // 6枚スートのリビッドは6枚が前提なので7枚目から加点
    };
    // ダミーポイント：スート s にフィットを示すとき、サイドのショートに点を足す（Kのシングルトンは足さない）
    //   pLen = パートナーがそのスートに持っていると分かっている最低枚数
    // 5-5・6-4のように2スートで10枚以上ある手は、そのどちらかがフィットしたら+1.5（11枚なら+2.5…）
    const twoSuiter = s => {
      const top2 = SUITS.slice().sort((a, b) => len[b] - len[a]).slice(0, 2);
      const sum = len[top2[0]] + len[top2[1]];
      const other = top2.find(x => x !== s);
      // もう一方の長いスートにA・K・Qがないとき（中身のない長いスート）は加点しない
      return top2.includes(s) && len[s] >= 4 && sum >= 10 && other && /[AKQ]/.test(hand[other]) ? 1.5 + (sum - 10) : 0;
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
      // 2スーターの加点は長さを数えているので、6枚目以降の加点はその分差し引く。
      // 切り札のスートの長さも「5枚以上のサポートは1枚ごとに+1」で数えるので差し引く
      let b = twoSuiter(s) ? twoSuiter(s) - lenSum : 0;
      if (pLen >= 5 && mine >= 5 && !twoSuiter(s)) b -= lenB[s];
      for (const o of SUITS) if (o !== s && hand[o] === 'K') b -= 1; // フィットした後のシングルトンのKは2点として数える
      if (pLen >= 5 && mine >= 5) b += mine - 4;     // 5枚以上のサポートは1枚ごとに+1
      for (const o of SUITS) if (o !== s) { if (len[o] === 1 && hand[o] !== 'K') b += t1[0]; else if (len[o] === 0) b += t1[1]; }
      return b;
    };
    h.dp = (s, pLen) => h.adj + h.dpBonus(s, pLen); // ダミーポイント（補正込み）
    // 長いスートを切り札にするとき：パートナーの平均枚数 pAvg と合わせたフィットの大きさで、サイドのショートを加点
    //   8枚 → シングルトン+1／ボイド+3、8.5枚 → +2.5／+4、9枚以上 → +4／+5
    h.dpLong = (s, pAvg) => {
      const f = len[s] + pAvg;
      const t1 = f >= 9 ? [4, 5] : f >= 8.5 ? [2.5, 4] : f >= 8 ? [1, 3] : null;
      let b = 0;
      if (t1) for (const o of SUITS) if (o !== s) { if (len[o] === 1 && hand[o] !== 'K') b += t1[0]; else if (len[o] === 0) b += t1[1]; }
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
  //   4番手：12点以上、またはスペード5枚以上で「点数＋スペードの枚数」が15以上
  const opens = (h, c) => {
    const pos = c ? c.pos : 0;
    // オープンの強さは、6枚目以降の加点を入れずに判断する（ウィーク2・プリエンプトの範囲と合わせるため）
    const a = h.adjNoLen;
    if (pos === 3) return a >= 12 || (h.len.S >= 5 && a + h.len.S >= 15);
    if (a >= 11.5) return true;
    if (h.pattern === '4441' && h.adj >= 11) return true; // 4441の11点はオープン
    const honors = SUITS.map(s => h.hand[s].replace(/[^AKQJ]/g, '')).join('');
    return pos < 2 && h.adj >= 11 && !/[QJ]/.test(honors) && (honors.match(/A/g) || []).length >= 2;
  };
  // ウィーク2のスートの質：トップ3枚中2枚、またはトップ3枚中1枚＋10以上の札が3枚
  // ウィークのスート以外のメジャーの枚数
  const sideM4 = (h, s) => ['H', 'S'].some(M => M !== s && h.len[M] >= 4);
  const sideMajorOk = (h, s, c) => ['H', 'S'].every(M => M === s || h.len[M] <= 3 || (h.len[M] === 4 && !early(c)));
  // 7枚以上のプリエンプトのスートの内容（点数が5点未満のとき）：AKQのうち2枚以上、またはAKQの1枚とAKQJ10の2枚以上（QT87642など）
  const goodPre = (h, s) => h.top3(s) >= 2 || (h.top3(s) >= 1 && h.top5(s) >= 2);
  const goodWeak = (h, s) => h.top3(s) >= 2 || (h.top3(s) >= 1 && [...h.hand[s]].filter(x => 'AKQJT9'.includes(x)).length >= 3)
    || (h.sHcp[s] >= 3 && h.adjNoLen < 7); // メインスートに3点以上で手が6点以下なら積極的に
  const sideAce = (h, s) => SUITS.some(o => o !== s && h.hand[o].includes('A'));
  const early = c => (c.pos || 0) < 2; // 1番手・2番手

  // ===== パス済みのパートナーの応答へのオープナー =====
  R(seq => seq.length === 2 && seq.every(isBid) && seq[0][0] === '1' && seq[1][0] === '1' && seq[1][1] !== 'N' ? { Y: seq[1][1] } : null,
    'P', (h, c) => c.respPassed && h.len[c.b.Y] >= 4 && h.dp(c.b.Y, 4) < 12,
    null, 'パートナーはパス済みなのでゲームの可能性はない。フィットがあり最低点（ダミーポイント12点未満）なので、低いレベルでプレイするためにパス');
  // ===== オープニング =====
  R('', 'P', (h, c) => c.pos === 3 && h.adj < 22 && !opens(h, c), { hcp: [0, 11.99] }, '4番手で3人がパスしている。ゲームの可能性は低く、スペードが短いのでオープンぎりぎりの強さではパス（4番手は12点以上か、点数＋スペードの枚数が15以上でオープン）');
  R('', '2C', h => h.hcp >= 22, { hcp: [22, 37] }, '22点以上なのでストロング2♣オープン', 1);
  R('', '2N', h => h.balanced && between(h.hcp, 20, 21), { hcp: [20, 21], ...BAL_SHOWS }, 'バランスハンド20〜21点なので2NTオープン');
  // 1NTの形：バランスハンド、またはシングルトンがA・K・Qの4441・5431。
  //   5431は、5枚スートの内容が悪い（AKQが1枚以下かつAKQJ10が3枚以下）か、パートナーがパスしているときだけ
  const ntShape = (h, c) => {
    if (h.balanced) return true;
    // 6322で6枚のマイナーの内容が悪い（AKQが1枚以下）なら1NTでもよい
    // 6枚マイナーの6322は1NTでよい（3のレベルのリビッドには弱いことが多い）
    if (h.pattern === '6322') { const six = SUITS.find(s => h.len[s] === 6); if (!isMaj(six)) return true; }
    // 6331で6枚マイナーの内容が悪く（AKQが1枚以下）、シングルトンがA・K・Q
    if (h.pattern === '6331') {
      const six = SUITS.find(s => h.len[s] === 6), one = SUITS.find(s => h.len[s] === 1);
      if (!isMaj(six) && h.top3(six) <= 1 && /[AKQ]/.test(h.hand[one])) return true;
    }
    const single = SUITS.find(s => h.len[s] === 1);
    if (!single || !/[AKQ]/.test(h.hand[single])) return false;
    if (h.pattern === '4441') return true;
    if (h.pattern !== '5431') return false;
    const five = SUITS.find(s => h.len[s] === 5);
    if (h.len.S >= 4 && h.len.H >= 4) return false; // メジャーの5-4は1NTオープンしない
    return (h.top3(five) <= 1 && h.top5(five) <= 3) || (c && c.pos >= 2);
  };
  R('', '1N', (h, c) => ntShape(h, c) && between(h.adjNoLen, 15, 17), { hcp: [15, 17], ...BAL_SHOWS, S: [1, 5], H: [1, 5], D: [1, 5], C: [1, 5] },
    h => h.balanced ? 'バランスハンド15〜17点なので1NTオープン'
      : h.pattern === '4441' ? '15〜17点で、シングルトンがA・K・Qなので1NTオープン'
      : '15〜17点の5431。シングルトンがA・K・Qで、5枚スートの内容が悪いかパートナーがパスしている（そのスートのスラムを逃す心配が小さい）ので1NTオープン');
  for (const s of ['S', 'H', 'D']) {
    // プリエンプトに点数の下限はない（内容が十分なら2、3点でもビッドする）
    // ほかのメジャー：5枚以上があればウィークしない。4枚はパートナーがパスしているとき（3・4番手）だけ
    //   3番手で6-4・スートの内容が良い（AKQのうち2枚以上）なら、2の代でなく3の代で開ける（下のルール）
    R('', '2' + s, (h, c) => h.len[s] === 6 && h.adjNoLen < 11 && !opens(h, c) && goodWeak(h, s) && !(early(c) && sideAce(h, s)) &&
      sideMajorOk(h, s, c) && !(c.pos === 2 && sideM4(h, s) && h.top3(s) >= 2),
      { hcp: [0, 10.99], [s]: [6, 6] }, `${JA_SUIT[s]}6枚でオープンの強さがなく、スートの内容が十分なのでウィーク2${SYM[s]}`);
  }
  for (const s of ['S', 'H', 'D', 'C']) {
    // 7-4は、スートの内容が十分（AKQのうち2枚以上）なときだけ4の代。7枚は3の代で普通の長さなので、7枚目は加点しない
    if (isMaj(s)) R('', '4' + s, (h, c) => h.len[s] >= 7 && h.adjNoLen < 11 && (h.adjNoLen >= 5 || goodPre(h, s)) && !opens(h, c) && h.longest() === s && (h.len[s] >= 8 || (h.twoLongest >= 11 && h.top3(s) >= 2)),
      { hcp: [0, 10.99], [s]: [7, 13] }, h => h.len[s] >= 8 ? `${JA_SUIT[s]}8枚以上なので4の代のプリエンプト` : `${JA_SUIT[s]}7枚で7-4の形、スートの内容が十分（AKQのうち2枚以上）なので4の代のプリエンプト`);
    // 3番手（パートナーがパス）の6-4：スートの内容が良ければ3の代で開ける（K742.85.AQT852.4 で3♦）
    R('', '3' + s, (h, c) => c.pos === 2 && h.len[s] === 6 && sideM4(h, s) && h.top3(s) >= 2 && h.adjNoLen < 11 && !opens(h, c) && h.longest() === s && ['H', 'S'].every(M => M === s || h.len[M] <= 4),
      { hcp: [0, 10.99], [s]: [6, 13] }, `3番手で${JA_SUIT[s]}6枚・メジャー4枚の6-4、スートの内容が良いので3レベルのプリエンプト（パートナーがパスしているのでメジャー4枚があってもよい）`);
    R('', '3' + s, (h, c) => h.len[s] >= 7 && h.adjNoLen < 11 && (h.adjNoLen >= 5 || goodPre(h, s)) && !opens(h, c) && h.longest() === s,
      { hcp: [0, 10.99], [s]: [7, 13] }, h => h.adjNoLen >= 5 ? `${JA_SUIT[s]}7枚以上・5〜10点なので3レベルのプリエンプト` : `${JA_SUIT[s]}7枚以上で、点数は少ないがスートの内容が十分なので3レベルのプリエンプト`);
  }
  R('', '1S', (h, c) => opens(h, c) && h.len.S >= 5 && h.len.S >= h.len.H, { hcp: [11.5, 21], S: [5, 13] }, 'スペード5枚以上でオープニングの強さがあるので1♠（5枚メジャー）');
  R('', '1H', (h, c) => opens(h, c) && h.len.H >= 5, { hcp: [11.5, 21], H: [5, 13], S: [0, 5] }, 'ハート5枚以上でオープニングの強さがあるので1♥（5枚メジャー）');
  R('', '1D', (h, c) => opens(h, c) && (h.len.D > h.len.C || (h.len.D === h.len.C && h.len.D >= 4)),
    { hcp: [11.5, 21], D: [3, 13], S: [0, 4], H: [0, 4] }, '5枚メジャーがなく、ダイヤが長い（4-4以上の同じ長さもダイヤ）ので1♦');
  R('', '1C', (h, c) => opens(h, c), { hcp: [11.5, 21], C: [2, 13], S: [0, 4], H: [0, 4] }, '5枚メジャーがなく、クラブが長い（3-3はクラブ）ので1♣');
  R('', 'P', () => true, { hcp: [0, 11.49] }, 'オープンする強さ（補正込み11.5点）がないのでパス');

  // ===== 1NTオープン（と1NTオーバーコール）の後のレスポンダーの仕組み =====
  //   1NTは15〜17点。レスポンダーの点数は補正込み（6枚目以降の加点も含む）
  //   メジャー：5-4・5-5・6-4（7-4は6-4、6-5・6-6は5-5のフリ）／マイナー：3mインビ・2NT（♣リレー）・2♠（マイナーステイマン）・3M（mのスラムトライ）
  //   ステイマンで2Mが返ってきてフィットしたときのスラムトライ：3oM＝スプリンター（リレーでショートを示す）、4♣＝バランスのスラムトライ、4♦＝RKCB
  const NT1 = (() => {
    const oth = M => M === 'H' ? 'S' : 'H';
    const ctl = h => SUITS.reduce((t, s) => t + (h.hand[s].includes('A') ? 2 : 0) + (h.hand[s].includes('K') ? 1 : 0), 0);
    // オープナーのスラムへの興味：AK（A=2・K=1）とそのスートのAKQの合計が7以上（最高点なら6以上）
    const slamInt = (h, s, minLen = 3) => h.len[s] >= minLen && (ctl(h) + h.top3(s) >= 7 || (h.adj >= 16.5 && ctl(h) + h.top3(s) >= 6));
    const max = h => h.adj >= 16;            // 招待を受ける強さ
    const superMin = h => h.adj < 15.5;      // スーパーミニマム
    const noM = h => h.len.H <= 3 && h.len.S <= 3;
    const kind = h => {
      const H = h.len.H, S = h.len.S;
      if (H >= 5 && S >= 5) return '55';
      if ((H >= 6 && S === 4) || (S >= 6 && H === 4)) return '64';
      if ((H === 5 && S === 4) || (S === 5 && H === 4)) return '54';
      return null;
    };
    const shortOf = (h, excl) => SUITS.filter(s => !excl.includes(s) && h.len[s] <= 1).sort((a, b) => h.len[a] - h.len[b])[0] || null;
    const longMinor = (h, n) => ['C', 'D'].filter(m => h.len[m] >= n).sort((a, b) => h.len[b] - h.len[a] || (a === 'C' ? -1 : 1))[0] || null;
    // M4枚（もう一方は3枚以下）・m5枚以上のGF
    const m4m5 = h => (h.len.H === 4) !== (h.len.S === 4) && Math.max(h.len.H, h.len.S) === 4 && longMinor(h, 5) && h.adj >= 10;
    // M5枚以上（もう一方は3枚以下）・m4枚以上のGF
    const m5m4 = h => { const M = h.len.S >= 5 && h.len.H <= 3 ? 'S' : h.len.H >= 5 && h.len.S <= 3 ? 'H' : null; return M && longMinor(h, 4) && h.adj >= 10 ? M : null; };
    // M6枚以上の1スーター（もう一方のMは3枚以下、サイドに4枚スートなし）：スラムトライの強さ（パートナー平均3枚と合わせたダミーポイント）
    //   16点以上＝スラムのチャンス（15〜17点のパートナーと合わせて33点になりうる）、18点以上＝スラム確定（最低の15点とでも33点）
    const m6 = h => { const M = h.len.S >= 6 && h.len.H <= 3 ? 'S' : h.len.H >= 6 && h.len.S <= 3 ? 'H' : null; return M && h.len.C <= 3 && h.len.D <= 3 ? M : null; };
    const m6pts = (h, M) => h.dpLong(M, 3);
    // 3mインビの目安（トリックの見込み）：スートのA4・K3・Q2・J1・10が0.5、7枚目から1枚+1、サイドのA3・K2.5・Q1.2・J0.5。5.5以上でインビ
    //   （インビかサインオフか微妙なら、パスでなくインビ。J85.QJ4.5.KT9754 で3♣）
    //   例：サイドにQ以上なし→AQの6枚・AJの7枚、サイドにK→QJ10・KJの6枚、サイドにA→Q109の7枚・K10の6枚
    const minorTricks = (h, m) => {
      let suit = 0, side = 0;
      for (const c of h.hand[m]) suit += c === 'A' ? 4 : c === 'K' ? 3 : c === 'Q' ? 2 : c === 'J' ? 1 : c === 'T' ? 0.5 : 0;
      for (const s of SUITS) if (s !== m) for (const c of h.hand[s]) side += c === 'A' ? 3 : c === 'K' ? 2.5 : c === 'Q' ? 1.2 : c === 'J' ? 0.5 : 0;
      return { t: suit + Math.max(0, h.len[m] - 6) + side, suit };
    };
    const has = (h, s) => /[AK]/.test(h.hand[s]);
    // lastからlimitの手前までで、A・Kを持つスートのうち一番安いビッド（コントロール紹介）
    const ctrlBid = (h, seq, excl, limit, from) => {
      const lb = lastBid(seq);
      for (let r = Math.max(rankOf(lb), from ? rankOf(from) : -1) + 1; r < rankOf(limit); r++) {
        const s = STRAINS[r % 5], call = (Math.floor(r / 5) + 1) + s;
        if (s === 'N' || excl.includes(s)) continue;
        if (has(h, s)) return { call, s };
      }
      return null;
    };
    const better = (h, a, b) => (h.len[a] - h.len[b]) || (h.sHcp[a] - h.sHcp[b]) || (a === 'S' ? 1 : -1);
    const R_ = (call, why) => ({ call, why });

    function pick(h, s, c, seq) {
      const n = s.length, k = s.join(' '), v = h.adj - SUITS.filter(x => h.hand[x] === 'K').length, kd = kind(h); // シングルトンのKは1点低く
      // ---------- レスポンダーの1回目 ----------
      if (n === 0) {
        if (kd === '55') {
          if (v < 6) return R_('2D', '5-5のメジャーで弱い（〜5点）ので、2♦でトランスファーしてから2♠（サインオフ）');
          if (v < 8) return R_('2C', '5-5のメジャーでインビテーション（6〜7点）なので、ステイマンから');
          if (v < 12) return R_('2C', '5-5のメジャーでゲームフォーシング（8〜11点）なので、ステイマンから');
          return R_('2H', '5-5のメジャーでスラムトライ（12点以上）なので、2♥でトランスファーしてから3♥');
        }
        if (kd === '64') {
          const M = h.len.H >= 6 ? 'H' : 'S';
          if (v >= 12) return R_('2C', `${JA_SUIT[M]}6枚・${JA_SUIT[oth(M)]}4枚でスラムの可能性がある（12点以上）ので、ステイマンから`);
          if (h.dpLong(M, 3) >= 10) return R_(M === 'H' ? '4D' : '4H', `${JA_SUIT[M]}6枚・${JA_SUIT[oth(M)]}4枚。スラムの可能性は薄いので6枚の${JA_SUIT[M]}だけ示す：テキサス・トランスファー`);
          return R_(M === 'H' ? '2D' : '2H', `${JA_SUIT[M]}6枚・${JA_SUIT[oth(M)]}4枚。スラムの可能性は薄いので6枚の${JA_SUIT[M]}だけ示す：トランスファー`);
        }
        if (kd === '54') {
          const M5 = h.len.H === 5 ? 'H' : 'S';
          if (v >= 8) return R_('2C', `メジャーの5-4でインビテーション以上（8点以上）なので、ステイマンから`);
          return R_(M5 === 'H' ? '2D' : '2H', `メジャーの5-4でインビテーションしない強さなので、5枚の${JA_SUIT[M5]}にトランスファーしてパス`);
        }
        const M6 = m6(h);
        if (M6 && m6pts(h, M6) >= 18) return R_(M6 === 'H' ? '4D' : '4H', `${JA_SUIT[M6]}6枚以上でスラム確定の強さ（${fmt(m6pts(h, M6))}点）なので、テキサス・トランスファーしてから4NT（RKCB）`);
        if (M6 && m6pts(h, M6) >= 16) return R_(M6 === 'H' ? '2D' : '2H', `${JA_SUIT[M6]}6枚以上でスラムのチャンスがある（${fmt(m6pts(h, M6))}点）ので、2の代でトランスファーしてから${shortOf(h, [M6]) ? 'ジャンプシフト（スプリンター）' : '4' + SYM[M6] + '（テキサスより強い）'}`);
        const M5 = m5m4(h);
        if (M5) return R_(M5 === 'H' ? '2D' : '2H', `${JA_SUIT[M5]}5枚以上・マイナー4枚以上のGFなので、トランスファーしてから3マイナー`);
        // m6枚以上のサインオフ（4枚メジャーがあってもよい。5枚メジャーは上で扱う）
        if (h.len.H <= 4 && h.len.S <= 4 && !noM(h) && v < 8) {
          const m = longMinor(h, 6);
          if (m && h.len[m] >= 6) return m === 'C' ? R_('2N', 'クラブ6枚以上で弱いので、2NT（3♣を強制）から3♣でサインオフ（4枚メジャーがあってもマイナーでサインオフ）')
            : R_('2S', 'ダイヤ6枚以上で弱いので、2♠（マイナーステイマン）から3♦でサインオフ（4枚メジャーがあってもマイナーでサインオフ）');
        }
        if (noM(h)) {
          const C = h.len.C, D = h.len.D;
          if (C >= 4 && D >= 4 && v >= 14) return R_('2S', 'マイナーの4-4以上でスラムトライ（14点以上）なので2♠（マイナーステイマン）');
          if (C >= 5 && D >= 5 && v < 10) return R_('2S', 'マイナーの5-5以上で弱いので2♠（マイナーステイマン）から、マイナーでサインオフ');
          const m5 = longMinor(h, 5);
          // 6枚以上かショートがあれば13点以上、5枚のバランスハンド（KQ2.A2.KQJ32.K32など）は15点以上
          if (m5 && v >= (h.len[m5] >= 6 || shortOf(h, [m5]) ? 13 : 15))
            return R_(m5 === 'C' ? '3H' : '3S', `${JA_SUIT[m5]}5枚以上でスラムトライ（${h.len[m5] >= 6 || shortOf(h, [m5]) ? '13' : '5枚のバランスハンドは15'}点以上）なので${m5 === 'C' ? '3♥' : '3♠'}（${JA_SUIT[m5]}のスラムトライ）`);
          const m = longMinor(h, 6);
          if (m) {
            const { t, suit } = minorTricks(h, m);
            if (v < 10 && t >= 9) return R_('3N', `${JA_SUIT[m]}6枚以上でトリックが十分見込める（目安${fmt(t)}）ので3NT`);
            if (v < 10 && t >= 5.5 && suit >= 2.5) return R_('3' + m, `${JA_SUIT[m]}6枚以上で、${JA_SUIT[m]}でトリックを取る見込みが招待の強さ（目安${fmt(t)}、5.5以上）なので3${SYM[m]}（インビテーション）`);
            if (v < 8) return m === 'C' ? R_('2N', 'クラブ6枚以上で招待に満たないので、2NT（3♣を強制）から3♣でサインオフ')
              : R_('2S', 'ダイヤ6枚以上で招待に満たないので、2♠（マイナーステイマン）から3♦でサインオフ');
          }
          if (v >= 8 && v < 10) return R_('2C', '4枚メジャーはないがインビテーションの強さ（8〜9点）なので、ステイマンから2NTで招待（1NT-2NTは♣のリレー）');
        }
        return null;
      }
      // ---------- オープナーの2回目 ----------
      if (n === 1) {
        if (k === '3C' || k === '3D') {
          const m = k[1], x = h.hand[m];
          if (/[AK]/.test(x) || (x.includes('Q') && x.length >= 2)) return R_('3N', `パートナーの${JA_SUIT[m]}にフィットするアナー（A・K・Qx以上）があるので、招待を受けて3NT`);
          return R_('P', `パートナーの${JA_SUIT[m]}にフィットするアナーがないので、招待を断ってパス`);
        }
        if (k === '2N') return R_('3C', '2NTは3♣を強制するリレーなので3♣');
        if (k === '2S') {
          if (h.len.C >= 4) return R_('3C', 'マイナーステイマンへの答え：クラブ4枚以上');
          if (h.len.D >= 4) return R_('3D', 'マイナーステイマンへの答え：ダイヤ4枚以上（クラブ4枚なし）');
          return R_('2N', 'マイナーステイマンへの答え：4枚マイナーなし');
        }
        if (k === '3H' || k === '3S') {
          const m = k === '3H' ? 'C' : 'D';
          if (h.len[m] >= 3 && slamInt(h, m)) return R_('4' + m, `${JA_SUIT[m]}3枚以上のサポートがあり、AKが多い・サポートが良いのでスラムに興味あり：4${SYM[m]}`);
          return R_('3N', `${JA_SUIT[m]}のスラムに興味がない（または3枚サポートがない）ので3NT`);
        }
        return null;
      }
      // ---------- レスポンダーの2回目 ----------
      if (n === 2) {
        if (k === '2C 2D') {
          if (kd === '54' && v >= 8) { const M4 = h.len.H === 4 ? 'H' : 'S'; return R_('2' + M4, `4枚メジャーがないと分かった。2${SYM[M4]}で${JA_SUIT[oth(M4)]}5枚・${JA_SUIT[M4]}4枚（5-4）を示す（インビテーション以上）`); }
          if (kd === '55') return v < 8 ? R_('3H', '5-5のメジャーでインビテーションなので3♥') : R_('3S', '5-5のメジャーでゲームフォーシングなので3♠');
          if (kd === '64' && v >= 12) return h.len.H >= 6 ? R_('4C', '4枚メジャーがないと分かった。4♣で♥6枚・♠4枚を示す（スラムの可能性あり）') : R_('4D', '4枚メジャーがないと分かった。4♦で♥4枚・♠6枚を示す（スラムの可能性あり）');
          if (m4m5(h)) { const m = longMinor(h, 5); return R_('3' + m, `メジャーのフィットがなかったので、${JA_SUIT[m]}5枚以上を3${SYM[m]}で示す（GF）`); }
          return null;
        }
        if (k === '2C 2H' || k === '2C 2S') {
          const X = k[4], O = oth(X);
          if (h.len[X] >= 4) {
            if (kd === '55') return v < 8 ? R_('4' + X, `${JA_SUIT[X]}で9枚以上のフィット。5-5のインビテーションの手はフィットで評価が上がるので4${SYM[X]}`)
              : R_('3' + O, `${JA_SUIT[X]}でフィット。5-5のGFなのでスラムトライ：3${SYM[O]}（スプリンター。ショートはこの後示す）`);
            const dp = h.dp(X, 4);
            if (dp >= 18) return R_('4D', `${JA_SUIT[X]}でフィットし、ダミーポイント${fmt(dp)}点でスラムが十分ありそうなので4♦（RKCB）`);
            if (dp >= 15 || (kd === '64' && v >= 12)) {
              if (shortOf(h, [X])) return R_('3' + O, `${JA_SUIT[X]}でフィットし、スラムの可能性がある（ダミーポイント${fmt(dp)}点）。ショートがあるので3${SYM[O]}（スプリンター）`);
              return R_('4C', `${JA_SUIT[X]}でフィットし、スラムの可能性がある（ダミーポイント${fmt(dp)}点）。ショートがないので4♣（バランスのスラムトライ）`);
            }
            return null;
          }
          if (m4m5(h)) { const m = longMinor(h, 5); return R_('3' + m, `メジャーのフィットがなかったので、${JA_SUIT[m]}5枚以上を3${SYM[m]}で示す（GF）`); }
          return null;
        }
        if ((k === '2D 2H' || k === '2H 2S') && m6(h) === s[1][1] && m6pts(h, s[1][1]) >= 16) {
          const M = s[1][1], sh = shortOf(h, [M]);
          if (sh) { const ch = cheapest(sh, seq), call = (levelOf(ch) + 1) + sh; return R_(call, `${JA_SUIT[M]}6枚以上でスラムのチャンスがあり、${JA_SUIT[sh]}が1枚以下なのでジャンプシフトの${callText(call)}（スプリンター）`); }
          return R_('4' + M, `${JA_SUIT[M]}6枚以上でスラムのチャンスがある（ショートなし）ので4${SYM[M]}（テキサスより強い手）`);
        }
        if ((k === '4D 4H' || k === '4H 4S') && m6(h) === s[1][1] && m6pts(h, s[1][1]) >= 18) return R_('4N', `${JA_SUIT[s[1][1]]}6枚以上でスラム確定の強さなので4NT（RKCB）`);
        if (k === '2D 2H' && kd === '55' && v < 6) return R_('2S', '5-5のメジャーで弱いので2♠（パートナーに♥か♠を選んでもらう）');
        if (k === '2H 2S' && kd === '55' && v >= 12) return R_('3H', '5-5のメジャーでスラムトライなので3♥');
        if ((k === '2D 2H' || k === '2H 2S') && m5m4(h)) { const m = longMinor(h, 4); return R_('3' + m, `${JA_SUIT[m5m4(h)]}5枚以上・${JA_SUIT[m]}4枚以上のGFなので3${SYM[m]}`); }
        if (k === '2N 3C') return R_('P', 'クラブでサインオフするのでパス');
        if (k === '3H 3N' || k === '3S 3N') {
          // パートナーは興味なし（またはサポートなし）。それでも十分強ければ続ける
          const m = k[1] === 'H' ? 'C' : 'D';
          if (v + 15 >= 33) return R_('6N', `パートナーの興味はないが、自分${fmt(v)}点＋15点以上で合計33点以上あるので6NT`);
          if (v + 17 >= 33) return R_('4N', `パートナーの興味はないが、合計33点あるか分からない（${fmt(v)}点＋15〜17点）ので4NT（クオンティタティブ）`);
          return R_('P', '3NTに決まったのでパス');
        }
        if (k === '3C 3N' || k === '3D 3N') return R_('P', '3NTに決まったのでパス');
        if (/^2S (2N|3C|3D)$/.test(k)) {
          const ans = s[1], C = h.len.C, D = h.len.D;
          if (C >= 4 && D >= 4 && v >= 14) {
            if (ans === '2N') {
              if (C >= 5 && D >= 5) { const sh = shortOf(h, ['C', 'D']); if (sh) return R_('3' + sh, `マイナーの5-5以上でスラムトライ。${JA_SUIT[sh]}が1枚以下なので3${SYM[sh]}（スプリンター）`); }
              const m = longMinor(h, 5);
              if (m) return R_('4' + m, `${JA_SUIT[m]}5枚以上でスラムトライなので4${SYM[m]}（3NTを超えるので強い手）`);
              const lo = v + 15, hi = v + 17;
              const nt = hi < 33 ? '3N' : lo < 33 ? '4N' : hi < 37 ? '6N' : lo < 37 ? '5N' : '7N';
              const txt = { '3N': '合計33点はあり得ない', '4N': '合計33点あるか分からない', '6N': '合計33点はあるが37点はない', '5N': '合計37点あるか分からない', '7N': '合計37点ある' }[nt];
              return R_(nt, `パートナーに4枚マイナーがなかった。${txt}（${fmt(v)}点＋15〜17点）ので${callText(nt)}`);
            }
            const m = ans[1];
            const sh = shortOf(h, [m]);
            if (sh && sh !== (m === 'C' ? 'D' : 'C')) return R_('3' + sh, `${JA_SUIT[m]}でフィット。${JA_SUIT[sh]}が1枚以下なので3${SYM[sh]}（スプリンター）`);
            if (v >= 18) return R_('4N', `${JA_SUIT[m]}でフィットし、十分強いので4NT（RKCB）`);
            return R_('4' + m, `${JA_SUIT[m]}でフィット。ショートがないので4${SYM[m]}（スラムトライ）`);
          }
          if (C >= 5 && D >= 5 && v < 10) return ans === '2N' ? R_('3C', 'マイナーの5-5でサインオフ：3♣') : R_('P', `マイナーの5-5でサインオフ：${callText(ans)}でパス`);
          if (D >= 6 && v < 8) return ans === '3D' ? R_('P', 'ダイヤでサインオフするのでパス') : R_('3D', 'ダイヤ6枚以上のサインオフ：3♦');
          return null;
        }
        return null;
      }
      // ---------- オープナーの3回目 ----------
      if (n === 3) {
        if (k === '2C 2D 2H' || k === '2C 2D 2S') {
          const M5 = k === '2C 2D 2H' ? 'S' : 'H';  // 2♥＝♠5枚・♥4枚、2♠＝♥5枚・♠4枚
          if (h.len[M5] >= 3) {
            if (slamInt(h, M5)) {
              // ♥5枚（2♠）には3♠／4♣／4♦、♠5枚（2♥）には4♣／4♦／4♥（フィットの最低の3♥・2♠や3NTより上）
              const cb = ctrlBid(h, seq, [M5], '4' + M5, M5 === 'H' ? '3H' : '3N');
              if (cb) return R_(cb.call, `${JA_SUIT[M5]}にフィットし、AKが多い・${JA_SUIT[M5]}にアナーが寄っているのでスラムに興味あり：${callText(cb.call)}で${JA_SUIT[cb.s]}のコントロールを示す`);
            }
            if (max(h)) return R_('4' + M5, `${JA_SUIT[M5]}にフィットし、招待を受ける強さなので4${SYM[M5]}`);
            const lo = M5 === 'S' ? '2S' : '3H';
            return R_(lo, `${JA_SUIT[M5]}にフィットしたが最低点なので${callText(lo)}`);
          }
          return max(h) ? R_('3N', `${JA_SUIT[M5]}のフィットがなく、招待を受ける強さなので3NT`) : R_('2N', `${JA_SUIT[M5]}のフィットがなく最低点なので2NT`);
        }
        if (k === '2C 2D 3H') {
          const fits = ['H', 'S'].filter(M => h.len[M] >= 3);
          if (max(h)) {
            if (!fits.length) return R_('3N', 'どちらのメジャーにもフィットせず、招待を受ける強さなので3NT');
            const X = fits.length === 2 ? (better(h, 'H', 'S') >= 0 ? 'H' : 'S') : fits[0];
            return R_('4' + X, `${JA_SUIT[X]}にフィットし、招待を受ける強さなので4${SYM[X]}`);
          }
          if (fits.includes('H')) return R_('P', 'ハートにフィットしたが最低点なのでパス');
          if (fits.includes('S')) return R_('3S', 'スペードにフィットしたが最低点なので3♠');
          return R_('P', 'フィットがなく最低点なのでパス');
        }
        if (k === '2C 2D 3S') {
          const fits = ['H', 'S'].filter(M => h.len[M] >= 3);
          const X = fits.length === 2 ? (better(h, 'H', 'S') >= 0 ? 'H' : 'S') : fits[0];
          if (X && max(h) && slamInt(h, X)) return R_(X === 'H' ? '4C' : '4D', `${JA_SUIT[X]}にフィットし、メジャーにアナーが寄ってとても強いのでスラムを目指す：${X === 'H' ? '4♣（♥）' : '4♦（♠）'}`);
          if (X) return R_('4' + X, `${JA_SUIT[X]}にフィットしたので4${SYM[X]}`);
          return R_('3N', 'どちらのメジャーにもフィットしないので3NT');
        }
        if (k === '2C 2H 3S') return R_('3N', '3♠はスプリンター：ショートを聞くために3NT（リレー）');
        if (k === '2C 2S 3H') return R_('3S', '3♥はスプリンター：ショートを聞くために3♠（リレー）');
        if (k === '2C 2H 4C' || k === '2C 2S 4C') {
          const X = s[1][1];
          if (h.adj >= 16 || ctl(h) + h.top3(X) >= 7) return R_('4D', 'バランスのスラムトライに対して、スラムに興味があるので4♦（4メジャーより下）');
          return R_('4' + X, `スラムに興味がないので4${SYM[X]}`);
        }
        if (k === '2C 2H 4D' || k === '2C 2S 4D') {
          const X = s[1][1], kc = keycards(h, X), q = h.hand[X].includes('Q');
          const call = (kc === 1 || kc === 4 || kc === 5) ? '4H' : (kc === 0 || kc === 3) ? '4S' : q ? '5C' : '4N';
          return R_(call, `4♦はRKCB：キーカード（4枚のAと${JA_SUIT[X]}のK）が${kc}枚${kc === 2 ? (q ? '・切り札のQあり' : '・切り札のQなし') : ''}なので${callText(call)}（4♥＝1・4枚、4♠＝0・3枚、4NT＝2枚Qなし、5♣＝2枚Qあり）`);
        }
        if (k === '2C 2D 4C' || k === '2C 2D 4D') {
          const M = k === '2C 2D 4C' ? 'H' : 'S';
          const int = k === '2C 2D 4C' ? '4D' : '4H';
          if (slamInt(h, M, 2)) return R_(int, `パートナーは${JA_SUIT[M]}6枚。AKが多い・メジャーにアナーが寄っているのでスラムに興味あり：${callText(int)}`);
          return R_('4' + M, `パートナーは${JA_SUIT[M]}6枚。スラムに興味がないので4${SYM[M]}`);
        }
        if (/^2C (2D|2H|2S) (3C|3D)$/.test(k)) {
          const m = s[2][1];
          if (s[1] === '2H' && h.len.S >= 4) return slamInt(h, 'S') ? R_('3S', 'パートナーは♠4枚を持っているので♠でフィット。スラムに興味があるので3♠') : R_('4S', 'パートナーは♠4枚を持っているので♠でフィット。スラムに興味がないので4♠');
          if (h.len[m] >= 3 && h.top3(m) >= 1 && slamInt(h, m)) {
            const cb = ctrlBid(h, seq, [m], '3N');
            if (cb) return R_(cb.call, `${JA_SUIT[m]}のスラムに興味がある（AKが多い・サポートが良い）ので、3NTより下で${JA_SUIT[cb.s]}のコントロールを示す：${callText(cb.call)}`);
          }
          return R_('3N', `${JA_SUIT[m]}のスラムに興味がないので3NT`);
        }
        if (/^(2D 2H|2H 2S) (3C|3D)$/.test(k)) {
          const M = s[1][1], m = s[2][1];
          if (h.len[M] >= 3) return slamInt(h, M) ? R_('3' + M, `${JA_SUIT[M]}にフィットし、スラムに興味があるので3${SYM[M]}（${JA_SUIT[M]}のスラムトライ）`) : R_('4' + M, `${JA_SUIT[M]}にフィットしたがスラムに興味がないので4${SYM[M]}`);
          if (h.len[m] >= 4 && slamInt(h, m)) return R_('4' + m, `${JA_SUIT[m]}にフィットし、スラムに興味があるので4${SYM[m]}（${JA_SUIT[m]}のスラムトライ）`);
          return R_('3N', `${JA_SUIT[M]}のフィットがないので3NT`);
        }
        if (k === '2D 2H 4H' || k === '2H 2S 4S') {
          const M = s[1][1];
          if (slamInt(h, M, 2) || (h.adj >= 16.5 && h.len[M] >= 3)) return R_('4N', `パートナーは${JA_SUIT[M]}6枚以上でスラムのチャンスがある手。こちらも興味がある（AKが多い・最高点）ので4NT（RKCB）`);
          return R_('P', `パートナーは${JA_SUIT[M]}6枚以上でスラムのチャンスがある手だが、こちらは興味がないのでパス`);
        }
        if (/^(2D 2H (3S|4C|4D)|2H 2S (4H|4C|4D))$/.test(k)) {
          const M = s[1][1], sh = s[2][1];
          const waste = h.sHcp[sh] - (h.hand[sh].includes('A') ? 4 : 0);
          if (waste <= 1 && h.adj - waste >= 15 && ctl(h) >= 4) return R_('4N', `パートナーのショートの${JA_SUIT[sh]}に無駄な点がほとんどないので4NT（RKCB）`);
          return R_('4' + M, `パートナーのショートの${JA_SUIT[sh]}に点が無駄になる（${waste}点）か、強さが足りないので4${SYM[M]}で止める`);
        }
        if (k === '2D 2H 2S') return h.len.H >= h.len.S + 2 ? R_('3H', 'ハートの方がずっと長いので3♥') : R_('P', 'スペードでプレイするのでパス');
        if (k === '2H 2S 3H') {
          if (h.len.S >= 3) return superMin(h) ? R_('4S', 'スペードにフィットしたがスーパーミニマムなので4♠') : R_('3S', 'スペードにフィットしたので3♠');
          if (h.len.H >= 3) {
            if (superMin(h)) return R_('4H', 'ハートにフィットしたがスーパーミニマムなので4♥');
            for (const [suit, call] of [['S', '3N'], ['C', '4C'], ['D', '4D']]) if (has(h, suit)) return R_(call, `ハートにフィットした。${JA_SUIT[suit]}のコントロールを示す：${callText(call)}${call === '3N' ? '（♠のコントロール）' : ''}`);
            return R_('4H', 'ハートにフィットしたが、示せるコントロールがないので4♥');
          }
          const X = better(h, 'H', 'S') >= 0 ? 'H' : 'S';
          return R_('4' + X, `どちらのメジャーにもフィットしない（2-2）ので、良い方の4${SYM[X]}`);
        }
        if (k === '2C 2H 2N') {
          if (!max(h)) return R_('P', '最低点なので招待を断ってパス');
          return h.len.S >= 4 ? R_('3S', '招待を受ける強さで、スペード4枚も持っているので3♠（パートナーが♠4枚なら4♠）') : R_('3N', '招待を受けて3NT');
        }
        if (/^2S (2N|3C|3D) (3H|3S)$/.test(k)) {
          const M = s[2][1];
          const m = s[1] === '2N' ? (better(h, 'C', 'D') >= 0 ? 'C' : 'D') : s[1][1];
          if (h.sHcp[M] >= 5) return R_('3N', `パートナーのショートの${JA_SUIT[M]}に5点以上ある（無駄になりやすい）ので3NT`);
          if (superMin(h) && ctl(h) < 6) return R_('5' + m, `${JA_SUIT[M]}に点が少なく、スラムへのやる気がないので5${SYM[m]}`);
          return R_('4' + m, `${JA_SUIT[M]}に点が少ないので4${SYM[m]}（スラムへのやる気は普通〜あり）`);
        }
        if (k === '2S 2N 4C' || k === '2S 2N 4D') {
          const m = s[2][1];
          if (h.len[m] < 3) return R_('4N', `${JA_SUIT[m]}にフィットしないので4NT（サインオフ）`);
          const cb = ctrlBid(h, seq, [m], '5' + m);
          if (cb) return R_(cb.call, `${JA_SUIT[m]}にフィットしたので、${JA_SUIT[cb.s]}のコントロールを示す：${callText(cb.call)}`);
          return R_('5' + m, `${JA_SUIT[m]}にフィットしたが、示せるコントロールがないので5${SYM[m]}`);
        }
        if (k === '2S 2N 4N') return h.adj >= 17 ? R_('6N', '最高点なのでスラムへの招待を受けて6NT') : R_('P', '最高点ではないのでパス');
        if (k === '2S 2N 5N') return h.adj >= 17 ? R_('7N', '最高点なので7NT') : R_('6N', '最高点ではないので6NT');
        if (k === '3H 3N 4N' || k === '3S 3N 4N') return h.adj >= 17 ? R_('6N', '最高点なのでスラムへの招待を受けて6NT') : R_('P', '最高点ではないのでパス');
      }
      // ---------- レスポンダーの3回目 ----------
      if (n === 4) {
        if (k === '2C 2D 2H 2S') return v >= 10 ? R_('4S', 'ゲームの強さがあるので4♠') : R_('P', 'インビテーションの強さで、パートナーが最低点なのでパス');
        if (k === '2C 2D 2S 3H') return v >= 10 ? R_('4H', 'ゲームの強さがあるので4♥') : R_('P', 'インビテーションの強さで、パートナーが最低点なのでパス');
        if (k === '2C 2D 2H 2N' || k === '2C 2D 2S 2N') return v >= 10 ? R_('3N', 'フィットがなく、ゲームの強さがあるので3NT') : R_('P', 'フィットがなく、パートナーが最低点なのでパス');
        if (k === '2C 2H 2N 3S') return h.len.S >= 4 ? R_('4S', 'スペードでフィットしたので4♠') : R_('3N', 'スペード4枚がないので3NT');
        if (k === '2C 2H 3S 3N') { const sh = shortOf(h, ['H']); const call = sh === 'S' ? '4H' : '4' + sh; return R_(call, `ショートを示す：${JA_SUIT[sh]}が1枚以下なので${callText(call)}${sh === 'S' ? '（♠のショート）' : ''}`); }
        if (k === '2C 2S 3H 3S') { const sh = shortOf(h, ['S']); const call = sh === 'H' ? '3N' : '4' + sh; return R_(call, `ショートを示す：${JA_SUIT[sh]}が1枚以下なので${callText(call)}${sh === 'H' ? '（♥のショート）' : ''}`); }
        if (k === '2C 2H 4C 4D' || k === '2C 2S 4C 4D' || k === '2C 2D 4C 4D' || k === '2C 2D 4D 4H') return R_('4N', 'パートナーがスラムに興味を示したので4NT（RKCB）');
        if (/^2C (2H|2S) 4D (4H|4S|4N|5C)$/.test(k)) {
          const X = s[1][1], resp = s[3], myK = keycards(h, X);
          const opts = { '4H': [1, 4], '4S': [0, 3], '4N': [2], '5C': [2] }[resp];
          let pK = opts[0];
          if (opts.length > 1 && myK + opts[0] < 3 && myK + opts[1] <= 5) pK = opts[1];
          const missing = 5 - myK - pK;
          const note = `自分${myK}枚＋パートナー${pK}枚＝キーカード${myK + pK}枚`;
          if (missing >= 2) {
            const so = ['4' + X, '5' + X].find(x => legal(x, seq));
            if (resp === '4' + X) return R_('P', `${note}で2枚以上足りないのでパス`);
            return R_(so, `${note}で2枚以上足りないので${callText(so)}で止める`);
          }
          const q = resp === '5C' || h.hand[X].includes('Q');
          if (missing === 0 && q && h.dp(X, 4) + 16 >= 37) return R_('7' + X, `${note}で全部そろい、切り札のQもあり合計点も十分なので7${SYM[X]}`);
          return R_('6' + X, `${note}${missing ? 'で足りないのは1枚だけ' : 'で全部そろっている'}なので6${SYM[X]}`);
        }
      }
      // ---------- オープナーの4回目：スプリンターのショートを聞いた後 ----------
      if (n === 5 && (/^2C 2H 3S 3N (4C|4D|4H)$/.test(k) || /^2C 2S 3H 3S (3N|4C|4D)$/.test(k))) {
        const X = s[1][1], b = s[4];
        const sh = X === 'H' ? (b === '4H' ? 'S' : b[1]) : (b === '3N' ? 'H' : b[1]);
        const waste = h.sHcp[sh] - (h.hand[sh].includes('A') ? 4 : 0);
        if (waste <= 1 && h.adj - waste >= 15 && ctl(h) >= 4) return R_('4N', `パートナーのショートの${JA_SUIT[sh]}に無駄な点がほとんどないので4NT（RKCB）`);
        const g = '4' + X;
        return legal(g, seq) ? R_(g, `パートナーのショートの${JA_SUIT[sh]}に点が無駄になる（${waste}点）ので${callText(g)}で止める`) : R_('P', `パートナーのショートの${JA_SUIT[sh]}に点が無駄になるのでパス`);
      }
      // 決まったコントラクトへのパス
      if (n === 3 && (/^2S (2N|3C) 3D$/.test(k) || /^2S 2N (3C|3N|6N|7N)$/.test(k) || k === '2C 2H 4H' || k === '2C 2S 4S')) return R_('P', 'パートナーがコントラクトを決めたのでパス');
      if (n === 4 && /^2S 2N 4[CD] 4N$/.test(k)) return R_('P', 'パートナーの4NTはサインオフなのでパス');
      if (n === 6 && (/^2C 2H 3S 3N (4C|4D|4H) 4H$/.test(k) || /^2C 2S 3H 3S (3N|4C|4D) 4S$/.test(k))) return R_('P', 'パートナーはショートに点が無駄になると判断してゲームで止めたのでパス');
      if (n >= 4 && !c.slam.active) {
        const lb = lastBid(seq);
        if (lb && seq.lastIndexOf(lb) === seq.length - 1 && levelOf(lb) >= gameLevel(strainOf(lb)) && lb !== '4N' && lb !== '5N') return R_('P', 'パートナーがゲーム以上のコントラクトに決めたのでパス');
      }
      return null;
    }

    // パートナーから見た意味（shows / force）
    function interp(s, call) {
      const n = s.length, k = s.join(' ');
      const GF = 'GF';
      if (n === 0) {
        if (call === '2C') return { shows: {}, force: 1 };
        if (call === '2N') return { shows: { C: [6, 13], S: [0, 4], H: [0, 4] }, force: 1 };
        if (call === '2S') return { shows: { S: [0, 4], H: [0, 4] }, force: 1 };
        if (call === '3C' || call === '3D') return { shows: { [call[1]]: [6, 13], S: [0, 3], H: [0, 3], hcp: [4, 9.99] } };
        if (call === '3H' || call === '3S') return { shows: { [call === '3H' ? 'C' : 'D']: [5, 13], S: [0, 3], H: [0, 3], hcp: [13, 37] }, force: GF };
        return null;
      }
      if (n === 1) {
        if (k === '2S' && call === '3C') return { shows: { C: [4, 5] } };
        if (k === '2S' && call === '3D') return { shows: { D: [4, 5], C: [2, 3] } };
        if (k === '2S' && call === '2N') return { shows: { C: [2, 3], D: [2, 3] } };
        if ((k === '3H' && call === '4C') || (k === '3S' && call === '4D')) return { shows: { [call[1]]: [3, 5], agree: call[1], interest: true }, force: GF };
        return null;
      }
      if (n === 2) {
        if (k === '2C 2D') {
          if (call === '2H') return { shows: { S: [5, 5], H: [4, 4], hcp: [8, 37] }, force: 1 };
          if (call === '2S') return { shows: { H: [5, 5], S: [4, 4], hcp: [8, 37] }, force: 1 };
          if (call === '3H') return { shows: { H: [5, 6], S: [5, 6], hcp: [6, 7.99] }, force: 1 };
          if (call === '3S') return { shows: { H: [5, 6], S: [5, 6], hcp: [8, 11.99] }, force: GF };
          if (call === '4C') return { shows: { H: [6, 7], S: [4, 4], hcp: [12, 37] }, force: GF };
          if (call === '4D') return { shows: { S: [6, 7], H: [4, 4], hcp: [12, 37] }, force: GF };
          if (call === '3C' || call === '3D') return { shows: { [call[1]]: [5, 13] }, force: GF };
        }
        if (k === '2C 2H' || k === '2C 2S') {
          const X = k[4], O = oth(X);
          if (call === '3' + O || call === '4C' || call === '4D') return { shows: { [X]: [4, 6] }, force: GF };
          if (call === '3C' || call === '3D') return { shows: { [call[1]]: [5, 13] }, force: GF };
        }
        if (k === '2D 2H' && call === '2S') return { shows: { H: [5, 6], S: [5, 6], hcp: [0, 5.99] } };
        if (k === '2H 2S' && call === '3H') return { shows: { H: [5, 6], S: [5, 6], hcp: [12, 37] }, force: GF };
        if ((k === '2D 2H' || k === '2H 2S') && (call === '3C' || call === '3D')) return { shows: { [call[1]]: [4, 13] }, force: GF };
        if (/^(2D 2H|2H 2S)$/.test(k) && /^(3S|4C|4D|4H)$/.test(call) && call !== '4' + k[4] && call !== '3' + k[4]) {
          const M = k[4];
          if (!(k === '2D 2H' && call === '4H')) return { shows: { [call[1]]: [0, 1], [M]: [6, 13], agree: M, ctrl: [call[1]], interest: true }, force: GF };
        }
        if ((k === '2D 2H' && call === '4H') || (k === '2H 2S' && call === '4S')) return { shows: { [k[4]]: [6, 13] } };
        if (/^2S (3C|3D)$/.test(k)) {
          const m = k[4];
          if (call === '3H' || call === '3S') return { shows: { [call[1]]: [0, 1], agree: m, ctrl: [call[1]], interest: true }, force: GF };
          if (call === '4' + m) return { shows: { agree: m, interest: true }, force: GF };
          if (call === '4N') return { shows: { agree: m, rk: true }, force: GF };
        }
        if (k === '2S 2N' && ['3H', '3S', '4C', '4D'].includes(call)) return { shows: {}, force: GF };
        return null;
      }
      if (n === 3) {
        if (k === '2C 2D 2H' || k === '2C 2D 2S') {
          const M5 = k === '2C 2D 2H' ? 'S' : 'H';
          if (isBid(call) && call[1] !== M5 && call[1] !== 'N' && levelOf(call) >= 3) return { shows: { [M5]: [3, 5], agree: M5, interest: true, ctrl: [call[1]], cue: true }, force: GF };
        }
        if (k === '2C 2D 3S' && (call === '4C' || call === '4D')) return { shows: { agree: call === '4C' ? 'H' : 'S', interest: true }, force: GF };
        if ((k === '2C 2H 4C' || k === '2C 2S 4C') && call === '4D') return { shows: { agree: k[4], interest: true }, force: GF };
        if (k === '2C 2D 4C' && call === '4D') return { shows: { agree: 'H', interest: true }, force: GF };
        if (k === '2C 2D 4D' && call === '4H') return { shows: { agree: 'S', interest: true }, force: GF };
        if (/^2C (2D|2H|2S) (3C|3D)$/.test(k) && isBid(call) && levelOf(call) === 3 && call[1] !== 'N') {
          if (k.startsWith('2C 2H') && call === '3S') return { shows: { S: [4, 4], agree: 'S', interest: true }, force: GF };
          return { shows: { agree: k.slice(-1), interest: true, ctrl: [call[1]], cue: true }, force: GF };
        }
        if (/^(2D 2H|2H 2S) (3C|3D)$/.test(k)) {
          const M = k[4], m = k.slice(-1);
          if (call === '3' + M) return { shows: { [M]: [3, 5], agree: M, interest: true }, force: GF };
          if (call === '4' + m) return { shows: { [m]: [4, 5], agree: m, interest: true }, force: GF };
        }
        if (k === '2H 2S 3H') {
          if (call === '3S') return { shows: { S: [3, 5], agree: 'S', interest: true }, force: GF };
          if (call === '3N' || call === '4C' || call === '4D') return { shows: { H: [3, 5], agree: 'H', interest: true, ctrl: [call === '3N' ? 'S' : call[1]], cue: true }, force: GF };
        }
        if (/^2S (2N|3C|3D) (3H|3S)$/.test(k) && /^4[CD]$/.test(call)) return { shows: { agree: call[1], interest: true }, force: GF };
        if ((k === '2S 2N 4C' || k === '2S 2N 4D') && isBid(call) && call !== '4N' && levelOf(call) === 4) return { shows: { agree: k.slice(-1), interest: true, ctrl: [call[1]], cue: true }, force: GF };
        return null;
      }
      if (n === 4) {
        if ((k === '2C 2H 3S 3N' && /^4[CDH]$/.test(call)) || (k === '2C 2S 3H 3S' && /^(3N|4C|4D)$/.test(call))) {
          const X = k[4];
          const sh = X === 'H' ? (call === '4H' ? 'S' : call[1]) : (call === '3N' ? 'H' : call[1]);
          return { shows: { [sh]: [0, 1], agree: X, ctrl: [sh], interest: true }, force: GF };
        }
        if ((k === '2C 2H 4C 4D' || k === '2C 2S 4C 4D' || k === '2C 2D 4C 4D' || k === '2C 2D 4D 4H') && call === '4N') return { shows: {}, force: GF };
        return null;
      }
      return null;
    }
    return { pick, interp };
  })();

  // ===== 敵の介入（ナチュラルなオーバーコール）の後：3番手（レスポンダー）とオープナーのリビッド =====
  //   フリーランの取り決め（2/1 GF・インバーテッドマイナーなど）は使わない
  //   opp = { s: 敵のスート, call: 敵のビッド }
  const COMP = (() => {
    const MAJ = ['H', 'S'];
    const maxBid = (seq, opp) => { const lb = lastBid(seq); return !lb || rankOf(opp.call) > rankOf(lb) ? opp.call : lb; };
    // ダブルできるのは敵のオーバーコールの直後（3番手）と、3番手・4番手がパスした後のオープナー（リオープン）
    const ok = (call, seq, opp) => call === 'P' || (call === 'X' ? seq.length === 1 || (seq.length === 2 && seq[1] === 'P') : isBid(call) && rankOf(call) > rankOf(maxBid(seq, opp)));
    const cheap = (s, seq, opp) => { const mb = maxBid(seq, opp); for (let lv = 1; lv <= 7; lv++) { const c = lv + s; if (rankOf(c) > rankOf(mb)) return c; } return null; };
    const jump = (s, seq, opp, n = 1) => { const c = cheap(s, seq, opp); if (!c) return null; const lv = levelOf(c) + n; return lv <= 7 ? lv + s : null; };
    const ctlOf = h => SUITS.reduce((t, s) => t + (h.hand[s].includes('A') ? 2 : 0) + (h.hand[s].includes('K') ? 1 : 0), 0);
    const unbid = (X, Y) => MAJ.filter(M => M !== X && M !== Y);
    const minDbl = opp => levelOf(opp.call) >= 2 ? 8 : 6;
    const T = (s) => `${JA_SUIT[s]}`;

    // ---------- レスポンダーの1回目 ----------
    function resp(h, seq, opp) {
      const X = seq[0][1], Y = opp.s, v = h.adj, maj = isMaj(X);
      const U = unbid(X, Y), minX = minDbl(opp), stop = h.stopper(Y);
      const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
      const shortS = SUITS.filter(s => s !== X && h.len[s] <= 1).sort((a, b) => h.len[a] - h.len[b])[0] || null;
      const spl = s => s === Y ? jump(s, seq, opp, 1) : jump(s, seq, opp, 2);
      const cue0 = cheap(Y, seq, opp);
      // オープンしたスートの3の代を超えるキュービッドはスラムトライ（インビの手はゲームかダブル）
      const cueHigh = !!cue0 && rankOf(cue0) > rankOf('3' + X);
      const cueSlamOk = cueHigh && rankOf(cue0) < rankOf(gameCall(X));
      const solidStop = /A/.test(h.hand[Y]) || (/K/.test(h.hand[Y]) && h.len[Y] >= 2) || (/QJ/.test(h.hand[Y]) && h.len[Y] >= 3);
      // インビ以上の手：3の代以下ならキュービッド。それより上なら、スラムトライの強さ（16点以上）でキュービッド、
      // インビ〜ゲームの手は、サポートがあればゲーム、なければストッパーがしっかりあれば3NT、なければダブル
      const invOrCue = (pts, sup, label) => {
        if (!cueHigh) return R(cue0, `${label}なのでキュービッド（${callText(cue0)}）`);
        if (pts >= 16 && cueSlamOk) return R(cue0, `${label}でスラムトライの強さ（${fmt(pts)}点）。3の代を超えるキュービッド（${callText(cue0)}）はスラムトライ`);
        if (sup) return R(gameCall(X), `${label}。キュービッドは3の代を超える（スラムトライになる）ので、ゲームを直接ビッド`);
        if (solidStop) return R('3N', `${label}。キュービッドは3の代を超えるので、${T(Y)}のストッパーがしっかりあるので3NT`);
        return R('X', `${label}。キュービッドは3の代を超え、${T(Y)}のストッパーもないので、パスしたくないのでダブル`);
      };
      const cue = cue0;
      let r;
      // スプリンター（ダブルジャンプシフト・ジャンプキュービッド）
      if (shortS && ((maj && h.len[X] >= 4 && (d => d >= 12.5 && d < 16)(h.dp(X, 5))) || (!maj && h.len[X] >= 6 && h.dp(X, 4) >= 16))) {
        const c = spl(shortS);
        if (c && levelOf(c) <= 4 && rankOf(c) < rankOf(gameCall(X)) && (r = R(c, `${T(X)}に${maj ? '4' : '6'}枚以上のサポートがあり、${T(shortS)}が${h.len[shortS] ? 'シングルトン' : 'ボイド'}なので${shortS === Y ? 'ジャンプキュービッド' : 'ダブルジャンプシフト'}の${callText(c)}（スプリンター）`))) return r;
      }
      // 競り合いでのゲームのビッドは、それをプレイしたいという意味（1♣-(3♥)-4♠＝♠7枚以上くらいで4♠をプレイしたい）
      {
        const L = SUITS.filter(s => s !== X && s !== Y && isMaj(s) && (h.len[s] >= 7 || (h.len[s] >= 6 && v >= 11))).sort((a, b) => h.len[b] - h.len[a])[0];
        if (L && !(maj && h.len[X] >= 3) && rankOf(cheap(L, seq, opp)) <= rankOf('4' + L) && v >= 7 && (r = R('4' + L, `${T(L)}${h.len[L]}枚で、4${SYM[L]}をプレイしたい（競り合いでのゲームのビッドはそれをプレイしたいという意味）`))) return r;
      }
      // 1Mオープン：サポート
      if (maj && h.len[X] >= 3) {
        const dp = h.dp(X, 5);
        if (h.len[X] >= 4) {
          if (dp >= 11 && (r = invOrCue(dp, true, `${T(X)}に4枚以上のサポートがあり、11点以上（ダミーポイント${fmt(dp)}点）`))) return r;
          if (dp >= 7) {
            const fj = SUITS.filter(s => s !== X && s !== Y).map(s => jump(s, seq, opp, 1)).filter(c => c && rankOf(c) <= rankOf('3' + X)).sort((a, b) => rankOf(a) - rankOf(b))[0];
            if (fj && (r = R(fj, `${T(X)}に4枚以上のサポートがあり、ダミーポイント${fmt(dp)}点（7〜10点）なので、3${SYM[X]}以下のジャンプしたニュースート（${callText(fj)}）`))) return r;
            if ((r = R(cheap(X, seq, opp), `${T(X)}に4枚以上のサポートがあり7〜10点。ジャンプできるニュースートがないのでレイズ`))) return r;
          }
          if (dp >= 3 && (r = R('3' + X, `${T(X)}に4枚以上のサポートがあり、6点まで（ダミーポイント${fmt(dp)}点）なので3${SYM[X]}（プリエンプティブ・レイズ）`))) return r;
        } else {
          if (dp >= 10.5 && (r = invOrCue(dp, true, `${T(X)}に3枚サポートがあり、インビテーション以上（ダミーポイント${fmt(dp)}点）。メジャーのサポートはキュービッドで伝える`))) return r;
          if (dp >= 6 && levelOf(cheap(X, seq, opp)) <= 3 && (r = R(cheap(X, seq, opp), `${T(X)}に3枚サポートがあり、6〜10点（ダミーポイント${fmt(dp)}点）なのでシングルレイズ`))) return r;
        }
      }
      // アンビッドのメジャー
      if (U.length === 1) {
        const M = U[0], c = cheap(M, seq, opp);
        if (!maj && opp.call === '1H' && M === 'S') {
          if (h.len.S >= 5 && v >= 6 && (r = R(c, 'スペード5枚以上なので1♠（1♥のオーバーコールに対しては、1♠＝5枚以上・ダブル＝ちょうど4枚）'))) return r;
          if (h.len.S === 4 && v >= minX && (r = R('X', 'スペードちょうど4枚なのでダブル（1♥のオーバーコールに対しては、1♠＝5枚以上・ダブル＝ちょうど4枚）'))) return r;
        } else if (h.len[M] >= 4) {
          if (h.len[M] >= 5 && v >= 10.5 && levelOf(c) === 2 && (r = R(c, `${T(M)}5枚以上でインビテーション以上なので、ノンジャンプの${callText(c)}`))) return r;
          if (h.len[M] >= 5 && v >= 13 && levelOf(c) === 3 && (r = R(c, `${T(M)}5枚以上でゲームフォーシングなので、ノンジャンプの${callText(c)}`))) return r;
          // マイナーのオープン：5枚以上のメジャーと4枚以上のサポートでインビ以上ならジャンプしたニュースート
          if (!maj && h.len[X] >= 4 && h.len[M] >= 5 && v >= 10.5) { const j = jump(M, seq, opp, 1); if (j && levelOf(j) <= 4 && levelOf(j) < gameLevel(M) && rankOf(j) < rankOf('5' + X) && (r = R(j, `${T(M)}5枚以上・${T(X)}4枚以上のサポートで${rankOf(j) > rankOf('3' + X) ? 'ゲームフォーシング' : 'インビテーション以上'}なのでジャンプしたニュースート（${callText(j)}）`))) return r; }
          if (v >= minX && (r = R('X', `${T(M)}4枚以上なのでダブル（ネガティブ・ダブル）`))) return r;
        }
      } else if (U.length === 2) {
        const H = h.len.H, S = h.len.S;
        const lo = M => levelOf(cheap(M, seq, opp)) === 1;
        if (H >= 4 && S >= 4 && v >= minX) {
          const L5 = H >= 5 && H >= S ? 'H' : S >= 5 ? 'S' : null;
          if (L5 && lo(L5) && (r = R(cheap(L5, seq, opp), `メジャーの${H}-${S}。長い${T(L5)}から1の代でビッド（あとでもう一方を示す）`))) return r;
          if ((r = R('X', '両メジャー4枚以上なのでダブル'))) return r;
        }
        const one = MAJ.filter(M => h.len[M] >= 4).sort((a, b) => h.len[b] - h.len[a])[0];
        if (one && lo(one) && v >= 6 && (r = R(cheap(one, seq, opp), `${T(one)}4枚以上なので1${SYM[one]}`))) return r;
        if (one && h.len[one] >= 5 && v >= 10.5 && levelOf(cheap(one, seq, opp)) === 2 && (r = R(cheap(one, seq, opp), `${T(one)}5枚以上でインビテーション以上なので${callText(cheap(one, seq, opp))}`))) return r;
        // 1の代でメジャーを言えない（2の代以上のオーバーコール）：4枚メジャーが1つでもダブル
        if (one && !lo(one) && v >= minX && (r = R('X', `${T(one)}4枚以上（1の代では言えない）なのでダブル`))) return r;
      } else {
        // アンビッドのメジャーがない（1♠-(2♥) など）：ダブル＝マイナー4-4以上の8点以上、またはストッパーがなく5枚スートのないインビ以上
        if (h.len.C >= 4 && h.len.D >= 4 && v >= 8 && (r = R('X', 'アンビッドのメジャーがなく、マイナー4-4以上・8点以上なのでダブル'))) return r;
        if (v >= 10.5 && !stop && !SUITS.some(s => s !== Y && h.len[s] >= 5) && !(maj && h.len[X] >= 3) && (r = R('X', `${T(Y)}のストッパーがなく5枚スートもないインビテーション以上なので、まずダブル`))) return r;
      }
      // マイナーのオープン：サポート
      if (!maj && h.len[X] >= 4) {
        if (v >= 10.5) {
          const Z = SUITS.filter(s => s !== X && s !== Y && h.len[s] >= 5).sort((a, b) => h.len[b] - h.len[a])[0];
          if (Z) { const j = jump(Z, seq, opp, 1); if (j && levelOf(j) <= 4 && levelOf(j) < gameLevel(Z) && rankOf(j) < rankOf('5' + X) && (r = R(j, `${T(Z)}5枚以上・${T(X)}4枚以上のサポートで${rankOf(j) > rankOf('3' + X) ? 'ゲームフォーシング' : 'インビテーション以上'}なのでジャンプしたニュースート（${callText(j)}）`))) return r; }
          if ((r = invOrCue(v, false, `${T(X)}に4枚以上のサポートがあり、インビテーション以上`))) return r;
        }
        if (v >= 6 && (r = R(cheap(X, seq, opp), `${T(X)}に4枚以上のサポートがあり、6〜10点なのでシングルレイズ（インバーテッドは使わない）`))) return r;
      }
      // ニュースート（5枚以上）とNT
      const noUM = U.every(M => h.len[M] < 4);
      const unbal = SUITS.some(s => h.len[s] >= 6) || SUITS.filter(s => h.len[s] >= 5).length >= 2 || SUITS.some(s => h.len[s] <= 1);
      const newSuit = () => {
        const cands = SUITS.filter(s => s !== X && s !== Y && h.len[s] >= 5 && (!U.includes(s) || h.len[s] >= 5)).sort((a, b) => h.len[b] - h.len[a] || (isMaj(b) ? 1 : 0) - (isMaj(a) ? 1 : 0));
        for (const Z of cands) {
          const c = cheap(Z, seq, opp), lv = levelOf(c);
          if (lv === 2 && v >= 10.5 && (noUM || U.includes(Z))) return R(c, `${T(Z)}5枚以上でインビテーション以上なので、ノンジャンプの${callText(c)}（ダブルで示せるメジャーはない）`);
          if (lv === 3 && v >= 13) return R(c, `${T(Z)}5枚以上でゲームフォーシングなので、ノンジャンプの${callText(c)}`);
        }
        return null;
      };
      const nt = () => {
        if (!noUM) return null;
        if (v >= 13 && stop) return R('3N', `${T(Y)}のストッパーがあり13〜15点なので3NT`);
        if (v >= 11 && v < 13 && stop) return R('2N', `${T(Y)}のストッパーがあり11〜12点なので2NT`);
        if (v >= 8 && v < 11 && ok('1N', seq, opp)) return R('1N', `8〜10点なので1NT${stop ? '' : '（ストッパーがなくても点数があればビッドする）'}`);
        return null;
      };
      if (unbal) { if ((r = newSuit()) || (r = nt())) return r; } else { if ((r = nt()) || (r = newSuit())) return r; }
      if (v >= 10.5 && cueHigh && (r = invOrCue(v, false, `インビテーション以上（${fmt(v)}点）`))) return r;
      if (v >= 13 && (r = R(cue, `ゲームの強さがあるが適当なビッドがないのでキュービッド（${callText(cue)}）`))) return r;
      return { call: 'P', why: '介入されて、ビッドできる形・強さがないのでパス' };
    }

    // ---------- オープナーのリビッド ----------
    function opener(h, seq, opp) {
      const X = seq[0][1], Y = opp.s, r1 = seq[1], v = h.adj, maj = isMaj(X);
      const U = unbid(X, Y), stop = h.stopper(Y);
      const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
      const P = why => ({ call: 'P', why });
      const ntMin = h.balanced && v < 15 && stop;
      let r;
      if (r1 === 'P') return reopen(h, seq, opp);
      if (r1 === 'X') {
        if (U.length) {
          const Ms = U.filter(M => h.len[M] >= 4).sort((a, b) => h.len[b] - h.len[a] || (a === 'H' ? -1 : 1));
          if (Ms.length) {
            const M = Ms[0], dp = h.dp(M, 4), c = cheap(M, seq, opp);
            // 2の代以上のオーバーコールに両メジャーが残っているときのダブルは、どちらか一方の4枚かもしれないのでジャンプしない
            const sure = !(U.length === 2 && levelOf(opp.call) >= 2);
            const call = !sure ? c : dp >= 18 ? '4' + M : dp >= 15 ? (Math.min(levelOf(c) + 1, 4)) + M : c;
            if ((r = R(call, `パートナーのダブルは${T(M)}4枚以上。${T(M)}4枚でフィット（ダミーポイント${fmt(dp)}点）なので${callText(call)}`))) return r;
          }
          if (h.balanced && stop && v >= 18 && (r = R(jump('N', seq, opp, 1).replace(/^[4-7]/, '3'), `${T(Y)}のストッパーがあるバランスハンド18〜19点なのでジャンプのNT`))) return r;
          if (ntMin && levelOf(cheap('N', seq, opp)) <= 2 && (r = R(cheap('N', seq, opp), `${T(Y)}のストッパーがあるバランスハンドの最低点なので${callText(cheap('N', seq, opp))}`))) return r;
        } else {
          if (stop) return R(v >= 15 ? '3N' : cheap('N', seq, opp), `${T(Y)}のストッパーがあるので${v >= 15 ? '3NT' : callText(cheap('N', seq, opp))}`) || P('パス');
          if (h.len[X] >= 6 && v >= 15 && (r = R(jump(X, seq, opp, 1), `${T(X)}6枚以上で強いのでジャンプ`))) return r;
          const m = ['C', 'D'].filter(s => s !== X && h.len[s] >= 4).sort((a, b) => h.len[b] - h.len[a])[0];
          if (m && (r = R(cheap(m, seq, opp), `パートナーはマイナー4-4以上が多い。${T(m)}4枚以上なので${callText(cheap(m, seq, opp))}`))) return r;
          return R(cheap(X, seq, opp), `${T(Y)}のストッパーがないので${T(X)}をリビッド`) || P('パス');
        }
        if (v >= 15 && stop && (r = R('3N', `${T(Y)}のストッパーがあり強い（${fmt(v)}点）ので3NT`))) return r;
        if (v >= 18 && !stop && h.len[X] < 6 && (r = R(cheap(Y, seq, opp), `18点以上の強い手だが${T(Y)}のストッパーがないので、キュービッド（${callText(cheap(Y, seq, opp))}。GF、ストッパーを探す）`))) return r;
        if (v >= 18 && h.len[X] >= 6 && (r = R(maj ? '4' + X : '5' + X, `${T(X)}6枚以上で18点以上なのでゲーム`))) return r;
        if (h.len[X] >= 6 && (r = R(v >= 15.5 ? jump(X, seq, opp, 1) : cheap(X, seq, opp), `${T(X)}6枚以上なので${T(X)}をリビッド`))) return r;
        const s2 = SUITS.filter(s => s !== X && s !== Y && !U.includes(s) && h.len[s] >= 4).map(s => cheap(s, seq, opp)).filter(c => c && levelOf(c) <= 2)[0];
        if (s2 && (r = R(s2, `4枚以上の${T(s2[1])}を${callText(s2)}で示す`))) return r;
        return R(cheap(X, seq, opp), `ほかに適当なビッドがないので${T(X)}をリビッド`) || P('パス');
      }
      const rs = r1[1], rl = levelOf(r1);
      // パートナーのゲーム以上のビッド（キュービッド以外）は、それをプレイしたいという意味
      if (isBid(r1) && rs !== Y && rl >= gameLevel(rs)) return P(`パートナーの${callText(r1)}はそれをプレイしたいという意味なのでパス`);
      // 3の代を超えるキュービッドはスラムトライ → スラムの仕組みで
      if (rs === Y && rankOf(r1) > rankOf('3' + X)) return null;
      // NTの応答
      if (r1 === '1N') { if (v >= 17 && stop) return R('3N', '1NT（8〜10点）に対してゲームの点数なので3NT'); if (v >= 15) return R('2N', '1NT（8〜10点）に対して強いので2NTで招待'); return h.len[X] >= 6 ? R(cheap(X, seq, opp), `${T(X)}6枚以上なのでリビッド`) || P('パス') : P('1NT（8〜10点）でゲームの可能性が低いのでパス'); }
      if (r1 === '2N') return v >= 13.5 ? R('3N', '2NT（11〜12点）の招待を受けて3NT') || P('パス') : P('2NT（11〜12点）の招待を断ってパス');
      if (r1 === '3N') return P('パートナーがゲームを決めたのでパス');
      // レイズ
      if (rs === X) {
        const dp = h.dp(X, maj ? 3 : 4);
        if (maj && rl === 3 && seq[1] === '3' + X && cheap(X, [seq[0]], opp) !== '3' + X) return dp >= 19 ? R('4' + X, 'プリエンプティブ・レイズだがこちらが非常に強いのでゲーム') || P('パス') : P('パートナーはプリエンプティブ・レイズ（6点まで）なのでパス');
        if (maj) return dp >= 17 ? R('4' + X, `シングルレイズ（6〜10点）に対して17点以上（ダミーポイント${fmt(dp)}点）なのでゲーム`) || P('パス') : P('シングルレイズ（6〜10点）に対してゲームの点数がないのでパス');
        if (v >= 18) return stop ? R('3N', 'シングルレイズに対して18点以上でストッパーがあるので3NT') || P('パス') : R('5' + X, 'シングルレイズに対して18点以上なのでゲーム') || P('パス');
        return P('シングルレイズ（6〜10点）に対してゲームの点数がないのでパス');
      }
      // キュービッド
      if (rs === Y && r1 === cheap(Y, [seq[0]], opp)) {
        if (maj) {
          const dp = h.dp(X, 3);
          if (dp + 10.5 >= 31 && ctlOf(h) >= 5) { for (let rr = rankOf('3' + X) + 1; rr < rankOf('4' + X); rr++) { const s = STRAINS[rr % 5], c = (Math.floor(rr / 5) + 1) + s; if (s !== 'N' && s !== X && /[AK]/.test(h.hand[s]) && (r = R(c, `キュービッド（${T(X)}3枚以上のインビ以上）に対してスラムの可能性があるので、3${SYM[X]}より高い${callText(c)}でコントロール紹介`))) return r; } }
          if (dp >= 15) return R('4' + X, `キュービッド（インビ以上）に対して招待に乗る（ダミーポイント${fmt(dp)}点）ので4${SYM[X]}`) || R('5' + X, 'ゲーム') || P('パス');
          if (dp >= 13.5) { const ri = SUITS.filter(s => s !== X).map(s => cheap(s, seq, opp)).filter(c => c && rankOf(c) < rankOf('3' + X)).sort((a, b) => rankOf(a) - rankOf(b))[0]; if (ri && (r = R(ri, `ゲームするか微妙なので、3${SYM[X]}以下のニュースート（${callText(ri)}）でリインビテーション`))) return r; }
          return R('3' + X, `キュービッドに対して弱いので3${SYM[X]}（サインオフ）`) || R('4' + X, `キュービッドが4の代なので4${SYM[X]}`) || P('パス');
        }
        if (stop) return R(v >= 15 ? '3N' : cheap('N', seq, opp), `${T(Y)}のストッパーがあるので${v >= 15 ? '3NT' : 'NT'}`) || P('パス');
        return R(v >= 15 ? '4' + X : cheap(X, seq, opp), `${T(Y)}のストッパーがないので${T(X)}に戻る`) || R(cheap(X, seq, opp), `${T(X)}に戻る`) || P('パス');
      }
      // ジャンプしたニュースート（1M：4枚以上サポート7〜10点／1m：5枚以上＆4枚以上サポートのインビ以上）
      if (rl >= 2 && r1 === jump(rs, [seq[0]], opp, 1) && rs !== X && rs !== Y) {
        if (maj) return h.dp(X, 4) >= 15 ? R('4' + X, `パートナーは${T(X)}4枚以上のサポートで7〜10点。こちらは15点以上なので4${SYM[X]}`) || P('パス') : R('3' + X, `パートナーは${T(X)}4枚以上のサポートで7〜10点。最低点なので3${SYM[X]}`) || P('パス');
        const gf = rankOf(r1) > rankOf('3' + X);
        if (isMaj(rs) && h.len[rs] >= 3) return (gf || v >= 14) ? R('4' + rs, `パートナーの${T(rs)}5枚以上にフィットしたので4${SYM[rs]}`) || R('5' + X, 'ゲーム') || P('パス') : R(cheap(rs, seq, opp), `パートナーの${T(rs)}にフィットしたが最低点`) || P('パス');
        if (gf || v >= 14) return (stop && R('3N', `${T(Y)}のストッパーがあるので3NT`)) || R('5' + X, `${T(X)}のフィットでゲーム`) || P('パス');
        return R(cheap(X, seq, opp), `最低点なので${T(X)}に戻る`) || P('パス');
      }
      // 2の代のノンジャンプのニュースート（5枚以上のインビ以上）
      if (rl === 2 && r1 === cheap(rs, [seq[0]], opp) && rs !== X && rs !== Y) {
        const sup = h.len[rs] >= 3, game = isMaj(rs) ? '4' + rs : (stop ? '3N' : '5' + rs);
        if (sup) {
          const dp = h.dp(rs, 5);
          if (dp >= 15) return R(cheap(Y, seq, opp), `パートナーの${T(rs)}に3枚サポートがあり、余裕を持って招待に乗るのでキュービッド（GF）`) || R(game, 'ゲーム');
          if (dp >= 13.5) return R(game, `パートナーの${T(rs)}に3枚サポートがあり、招待にギリギリ乗るのでゲーム`) || P('パス');
          return R('3' + rs, `パートナーの${T(rs)}に3枚サポートがあるが弱いので3の代にレイズ`) || P('パス');
        }
        if (stop && h.balanced) return R(v >= 15 ? '3N' : cheap('N', seq, opp), `${T(Y)}のストッパーがあるので${v >= 15 ? '3NT' : '2NT'}`) || P('パス');
        if (h.len[X] >= 6) return R(v >= 15 ? jump(X, seq, opp, 1) : cheap(X, seq, opp), `${T(X)}6枚以上なのでリビッド`) || P('パス');
        if (v >= 15) return R(cheap(Y, seq, opp), '強い手なのでキュービッド（GF）') || P('パス');
        return R(cheap(X, seq, opp), `${T(X)}をリビッド`) || P('パス');
      }
      // 3の代のノンジャンプのニュースート（5枚以上GF）
      if (rl === 3 && r1 === cheap(rs, [seq[0]], opp) && rs !== X && rs !== Y) {
        if (isMaj(rs) && h.len[rs] >= 3) return R('4' + rs, `パートナーの${T(rs)}5枚以上にフィットしたので4${SYM[rs]}`);
        if (stop) return R('3N', `${T(Y)}のストッパーがあるので3NT`);
        if (maj && h.len[X] >= 6) return R(cheap(X, seq, opp), `${T(X)}6枚以上なのでリビッド`);
        if (h.len[rs] >= 3) return R(rankOf('4' + rs) > rankOf(maxBid(seq, opp)) ? '4' + rs : '5' + rs, `パートナーの${T(rs)}にフィット`);
        return R(cheap(X, seq, opp), `${T(X)}をリビッド`);
      }
      return null;
    }

    // ---------- オープナーのリオープン（3番手・4番手がパスしたとき） ----------
    //   優先順：NT（18〜19バランス＋ストッパー）→ ニュースート（5-5・6-4、17点まで）→ オープンしたスートのリビッド（6枚以上）→ ダブル
    const twoSuit = (h, X, Y) => SUITS.filter(s => s !== X && s !== Y && ((h.len[X] >= 5 && h.len[s] >= 5) || (h.len[X] >= 6 && h.len[s] >= 4)))
      .sort((a, b) => h.len[b] - h.len[a])[0] || null;
    function reopen(h, seq, opp) {
      const X = seq[0][1], Y = opp.s, v = h.adj, lv = levelOf(opp.call), lenY = h.len[Y];
      const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
      let r;
      // ダブル：敵のスートが2枚以下（4の代以上は枚数に関係なく17点以上）
      // アンビッドのメジャーが3枚以上の手に限る（5134で1♠-(2♣)-P-P は16点でもパス）
      const uOk = unbid(X, Y).every(M => h.len[M] >= 3);
      const dblOk = uOk && (lv >= 4 ? v >= 17 : lenY <= 2 && (lv === 1 || (lv === 2 && v - lenY >= 11) || (lv === 3 && v - lenY >= 13)));
      const dblWhy = lv >= 4 ? `4の代以上のオーバーコールなので、17点以上（${fmt(v)}点）でダブル` : lv === 1 ? `${T(Y)}が${lenY}枚（2枚以下）。1の代のオーバーコールなので強さにかかわらずダブル` : `${T(Y)}が${lenY}枚で、点数−${T(Y)}の枚数＝${fmt(v - lenY)}（${lv === 2 ? 11 : 13}以上）なのでダブル`;
      // NT：18〜19のバランスハンドとストッパー（ノンジャンプ）
      const cn = cheap('N', seq, opp);
      if (h.balanced && v >= 18 && v < 20 && h.stopper(Y) && cn && levelOf(cn) <= 3 && (r = R(cn, `18〜19点のバランスハンドで${T(Y)}のストッパーがあるので、ノンジャンプの${callText(cn)}`))) return r;
      // ニュースート：5-5・6-4（強さの下限なし、17点まで）。それより強ければダブルしてから自分のスートに戻す
      const Z = twoSuit(h, X, Y);
      if (Z && v < 17.5) { const c = cheap(Z, seq, opp); if (c && rankOf(c) < rankOf(gameCall(Z)) && (r = R(c, `${T(X)}${h.len[X]}枚・${T(Z)}${h.len[Z]}枚の2スーター（17点まで）なのでニュースートの${callText(c)}`))) return r; }
      if (Z && v >= 17.5 && (r = R('X', `${T(X)}と${T(Z)}の2スーターで17点より強いので、まずダブル（あとで${T(Z)}をビッドして強さを示す）`))) return r;
      // 5-4：ダブルに向かない手で、2の代以下でビッドできるなら4枚のニュースート（5242で1♠-(2♣)-P-P に2♦）
      if ((!uOk || (lenY >= 3 && lv < 4)) && h.len[X] >= 5 && v < 17.5) { // 形がダブルに向かない（弱いだけならパス）
        const Z4 = SUITS.filter(s => s !== X && s !== Y && h.len[s] >= 4 && levelOf(cheap(s, seq, opp)) <= 2).sort((a, b) => h.len[b] - h.len[a])[0];
        if (Z4 && (r = R(cheap(Z4, seq, opp), `${T(X)}${h.len[X]}枚・${T(Z4)}${h.len[Z4]}枚。ダブルに向かない（アンビッドのメジャーが3枚未満、または敵のスートが3枚以上）ので、2の代以下でビッドできる${callText(cheap(Z4, seq, opp))}`))) return r;
      }
      // オープンしたスートのリビッド（6枚以上・代に応じた強さ、ジャンプで招待も可）。ダブルより優先
      if (h.len[X] >= 6) {
        const c = cheap(X, seq, opp), L = levelOf(c), j = jump(X, seq, opp, 1);
        if (v >= 16 && j && levelOf(j) <= 3 && (r = R(j, `${T(X)}6枚以上で強い（${fmt(v)}点）ので、ジャンプして招待`))) return r;
        const need = L <= 2 ? 0 : L === 3 ? 14 : 17;
        if (v >= need && (r = R(c, `${T(X)}6枚以上で${L}の代にリビッドできる強さ（${fmt(v)}点）なので${callText(c)}`))) return r;
      }
      if (dblOk && (r = R('X', dblWhy))) return r;
      return { call: 'P', why: !uOk ? `アンビッドのメジャーが3枚未満でダブルできず、ほかにビッドできるものもないのでパス（仕方ない）` : lenY >= 3 && lv < 4 ? `${T(Y)}が${lenY}枚あり、リオープンする形ではないのでパス` : 'リオープンする強さ・形ではないのでパス' };
    }
    // リオープンのダブルへのレスポンダー
    function afterReopenX(h, seq, opp) {
      const X = seq[0][1], Y = opp.s, v = h.adj;
      const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
      const hon = [...h.hand[Y]].filter(c => 'AKQJT'.includes(c)).length;
      let r;
      if (h.len[Y] >= 5 || (h.len[Y] >= 4 && hon >= 2)) return { call: 'P', why: `${T(Y)}が${h.len[Y]}枚あり（ペナルティ）、ダブルをパスして守る` };
      const M = unbid(X, Y).filter(m => h.len[m] >= 4).sort((a, b) => h.len[b] - h.len[a])[0];
      if (M) { const c = v >= 9 ? jump(M, seq, opp, 1) : cheap(M, seq, opp); if ((r = R(c, `${T(M)}4枚以上なので${callText(c)}${v >= 9 ? '（9点以上なのでジャンプ）' : ''}`)) || (r = R(cheap(M, seq, opp), `${T(M)}4枚以上`))) return r; }
      if (isMaj(X) && h.len[X] >= 3 && (r = R(cheap(X, seq, opp), `${T(X)}に3枚サポートがあるので${callText(cheap(X, seq, opp))}`))) return r;
      if (h.stopper(Y) && v >= 8 && (r = R(cheap('N', seq, opp), `${T(Y)}のストッパーがあり8点以上なのでNT`))) return r;
      const L = SUITS.filter(s => s !== Y && s !== X && h.len[s] >= 5).sort((a, b) => h.len[b] - h.len[a])[0];
      if (L && (r = R(cheap(L, seq, opp), `${T(L)}5枚以上なので${callText(cheap(L, seq, opp))}`))) return r;
      const best = SUITS.filter(s => s !== Y).sort((a, b) => (h.len[b] + (b === X ? 1 : 0)) - (h.len[a] + (a === X ? 1 : 0)))[0];
      return R(cheap(best, seq, opp), `ダブルに応えて、一番長い${T(best)}をビッド`) || { call: 'P', why: 'パス' };
    }
    // リオープンの後のオープナー
    function afterReopen(h, seq, opp) {
      const X = seq[0][1], Y = opp.s, v = h.adj, r3 = seq[3];
      const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
      let r;
      if (seq[2] === 'X') {
        // 17点より強い2スーター：ダブルの後に2つ目のスートをビッドして強さを示す
        const Z2 = twoSuit(h, X, Y);
        if (Z2 && v >= 17.5 && r3[1] !== Z2 && (r = R(cheap(Z2, seq, opp), `ダブルの後に${T(Z2)}をビッド：${T(X)}と${T(Z2)}の17点より強い2スーターを示す`))) return r;
        if (isBid(r3) && r3[1] !== 'N' && h.len[r3[1]] >= 4) {
          const s = r3[1], dp = h.dp(s, 4);
          if (dp >= 19 && (r = R(gameCall(s), `パートナーの${T(s)}にフィット。強い（ダミーポイント${fmt(dp)}点）のでゲーム`))) return r;
          if (dp >= 16 && (r = R(jump(s, seq, opp, 0) && cheap(s, seq, opp), `パートナーの${T(s)}にフィット。強いのでレイズ`))) return r;
        }
        if (r3[1] === 'N' && v >= 17 && (r = R('3N', 'パートナーのNTに対して強いので3NT'))) return r;
        return { call: 'P', why: 'パートナーの答えでよいのでパス' };
      }
      return null;
    }

    // ---------- レスポンダーの2回目（主な流れ） ----------
    function resp2(h, seq, opp, ctx) {
      if (ctx && ctx.slam.active) return null; // スラムの仕組みで決める
      if (seq[1] === 'P') {
        if (seq[2] === 'X') return afterReopenX(h, seq, opp);
        const o = seq[2], X = seq[0][1], v = h.adj, Y = opp.s;
        const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
        let r;
        // NTのリオープン（18〜19点）：6点以上あればゲーム
        if (isBid(o) && o[1] === 'N' && levelOf(o) < 3) return (v >= 6 && R('3N', `オープナーは18〜19点のバランスハンド。こちらは${fmt(v)}点（6点以上）なので3NT`)) || { call: 'P', why: 'オープナーは18〜19点だが、こちらは6点未満なのでパス' };
        // オープンしたスートのジャンプ（招待・16点以上）：7点以上でゲーム
        if (isBid(o) && o[1] === X && o !== cheap(X, seq.slice(0, 2), opp) && v >= 7) {
          if (isMaj(X) && h.len[X] >= 2 && (r = R('4' + X, `オープナーの${T(X)}6枚以上のジャンプ（招待）に、7点以上で${T(X)}が${h.len[X]}枚あるので4${SYM[X]}`))) return r;
          if (h.stopper(Y) && (r = R('3N', `オープナーの招待に7点以上で、${T(Y)}のストッパーがあるので3NT`))) return r;
          if (!isMaj(X) && h.len[X] >= 2 && (r = R('5' + X, `オープナーの招待に7点以上なので5${SYM[X]}`))) return r;
        }
        return { call: 'P', why: 'オープナーのリオープン。こちらは一度パスしていてゲームの可能性は低いので、パス' };
      }
      const X = seq[0][1], Y = opp.s, r1 = seq[1], o2 = seq[2], v = h.adj, maj = isMaj(X);
      const R = (call, why) => call && ok(call, seq, opp) ? { call, why } : null;
      const P = why => ({ call: 'P', why });
      const stop = h.stopper(Y), U = unbid(X, Y);
      // 自分のキュービッド（1M）の後
      if (r1 === cheap(Y, [seq[0]], opp) && r1[1] === Y && maj) {
        const dp = h.dp(X, 5);
        if (o2 === '3' + X) return dp >= 13 ? R('4' + X, 'オープナーは弱いが、こちらはゲームフォーシングの強さなので4' + SYM[X]) || P('パス') : P('オープナーは弱くサインオフしたのでパス');
        if (isBid(o2) && rankOf(o2) < rankOf('3' + X)) return dp >= 12 ? R('4' + X, `オープナーのリインビテーション。こちらは上の方（ダミーポイント${fmt(dp)}点）なので4${SYM[X]}`) || P('パス') : R('3' + X, `オープナーのリインビテーション。こちらは下の方なので3${SYM[X]}`) || P('パス');
        if (o2 === '4' + X) return P('オープナーが招待に乗ったのでパス');
        return null; // コントロール紹介 → スラムの仕組み
      }
      // 自分のキュービッド（1m）の後
      if (r1 === cheap(Y, [seq[0]], opp) && r1[1] === Y && !maj) {
        if (o2[1] === 'N') return (o2 === '2N' && v >= 13) ? R('3N', 'ゲームの強さがあるので3NT') || P('パス') : P('オープナーがNTを選んだのでパス');
        if (o2[1] === X) { if (stop && ok('3N', seq, opp)) return R('3N', `${T(Y)}のストッパーがこちらにあるので3NT`); return v >= 13 ? R('5' + X, `ゲームの強さがあるので5${SYM[X]}`) || P('パス') : P('ゲームの強さがないのでパス'); }
        return null;
      }
      // 2の代のニュースートの後
      if (levelOf(r1) === 2 && r1[1] !== X && r1[1] !== Y && r1 === cheap(r1[1], [seq[0]], opp)) {
        const Z = r1[1];
        if (o2 === '3' + Z) return v >= 13 ? R(isMaj(Z) ? '4' + Z : (stop ? '3N' : '5' + Z), 'オープナーのレイズ（弱い）だが、こちらはゲームの強さがあるのでゲーム') || P('パス') : P('オープナーは弱いのでパス');
        if (o2 === cheap(Y, seq.slice(0, 2), opp) && o2[1] === Y) return R(stop ? '3N' : isMaj(Z) ? '4' + Z : '5' + Z, `オープナーのキュービッド（GF）。${stop ? `${T(Y)}のストッパーがあるので3NT` : 'ストッパーがないのでスートのゲーム'}`);
        if (isBid(o2) && levelOf(o2) >= gameLevel(o2[1])) return P('オープナーがゲームを決めたのでパス');
        if (o2[1] === 'N') return (o2 === '2N' && v >= 13) ? R('3N', 'ゲームの強さがあるので3NT') || P('パス') : P('パス');
        if (o2[1] === X && h.len[X] >= 2 && v >= 13) return R(maj ? '4' + X : stop ? '3N' : '5' + X, 'ゲームの強さがあるのでゲーム') || P('パス');
        return v >= 13 ? R(stop ? '3N' : (isMaj(Z) && h.len[Z] >= 6 ? '4' + Z : null), 'ゲームの強さがあるので3NT') || P('パス') : P('インビテーションの強さで、オープナーが招待に乗らなかったのでパス');
      }
      // ダブルの後
      if (r1 === 'X' && isBid(o2)) {
        const M = o2[1];
        // オープナーの強さの下限：ジャンプ＝15.5点、ジャンプのNT＝18点、それ以外＝11.5点
        const jumpedO = o2 !== cheap(M, seq.slice(0, 2), opp);
        const pMin = M === 'N' ? (jumpedO ? 18 : 11.5) : jumpedO ? 15.5 : 11.5;
        // 2の代以上で両メジャーが残っていたダブル：オープナーの選んだメジャーがなければ、もう一方の5枚以上を示す
        const other = U.find(x => x !== M);
        if (U.length === 2 && U.includes(M) && h.len[M] < 4 && other && h.len[other] >= 5) {
          if (v + pMin >= 25 || h.len[other] >= 6) return R('4' + other, `オープナーの${T(M)}にはフィットしない。${T(other)}${h.len[other]}枚でゲーム`) || P('パス');
          return R(cheap(other, seq, opp), `オープナーの${T(M)}にはフィットしない。${T(other)}5枚以上を示す`) || P('パス');
        }
        if (!U.includes(M) && M !== 'N' && levelOf(o2) < gameLevel(M) && v + pMin >= 25) {
          if (isMaj(M) && h.len[M] >= 2) return R('4' + M, `オープナー（${pMin}点以上）とでゲームの点数があり、${T(M)}にフィットするので4${SYM[M]}`) || P('パス');
          if (stop) return R('3N', `オープナー（${pMin}点以上）とでゲームの点数があり、${T(Y)}のストッパーがあるので3NT`) || R('5' + M, 'ゲーム') || P('パス');
          if (h.len[M] >= 3) return R('5' + M, `ゲームの点数があるので5${SYM[M]}`) || P('パス');
        }
        if (U.includes(M) && h.len[M] >= 4) {
          const dp = h.dp(M, 4), lv = levelOf(o2), jumped = o2 !== cheap(M, seq.slice(0, 2), opp);
          if (lv >= 4) return P('オープナーがゲームを決めたのでパス');
          if (jumped) return dp >= 8 ? R('4' + M, `オープナーのジャンプレイズ（15〜17点）に対して8点以上なので4${SYM[M]}`) || P('パス') : P('オープナーのジャンプレイズの招待を断ってパス');
          if (dp >= 13) return R('4' + M, `${T(M)}のフィットでゲームの強さがあるので4${SYM[M]}`) || P('パス');
          if (dp >= 11 && lv <= 2) return R('3' + M, `${T(M)}のフィットで招待の強さなので3${SYM[M]}`) || P('パス');
          return P(`${T(M)}のフィットだがゲームの強さがないのでパス`);
        }
        if (M === 'N') { if (levelOf(o2) >= 3) return P('オープナーがゲームを決めたのでパス'); return v >= 13 ? R('3N', 'ゲームの強さがあるので3NT') || P('パス') : (v >= 11 ? R('2N', '招待の強さなので2NT') || P('パス') : P('パス')); }
        if (v >= 13) return R(stop ? '3N' : (h.len[M] >= 3 && levelOf(o2) < gameLevel(M) ? gameCall(M) : null), 'ゲームの強さがあるのでゲーム') || null;
        if (v >= 11 && h.len[M] >= 3 && levelOf(o2) === 2) return R('3' + M, `${T(M)}のサポートがあり招待の強さなので3${SYM[M]}`) || P('パス');
        return P('ゲームの強さがないのでパス');
      }
      // NTの応答の後
      if (/^[12]N$/.test(r1)) {
        if (o2 === '2N') return v >= 9.5 ? R('3N', '招待の上の方なので3NT') || P('パス') : P('招待の下の方なのでパス');
        if (o2 === '3N') return P('オープナーがゲームを決めたのでパス');
        return P('パス');
      }
      // シングルレイズ・ジャンプしたニュースートの後など
      if (isBid(o2) && levelOf(o2) >= gameLevel(o2[1])) return P('オープナーがゲームを決めたのでパス');
      return null;
    }

    function pick(h, seq, opp, ctx) {
      if (seq.length === 1) return resp(h, seq, opp);
      if (seq.length === 2) return opener(h, seq, opp);
      if (seq.length === 3) return resp2(h, seq, opp, ctx);
      if (seq.length === 4 && seq[1] === 'P') return afterReopen(h, seq, opp);
      return null;
    }

    // パートナーから見た意味
    function interp(before, call, opp) {
      const X = before[0][1], Y = opp.s, maj = isMaj(X), U = unbid(X, Y), n = before.length;
      if (n === 1) {
        if (call === 'X') {
          if (U.length === 1) return { shows: { [U[0]]: [4, 13], hcp: [minDbl(opp), 37] }, force: 1 };
          if (U.length === 2) return levelOf(opp.call) === 1 ? { shows: { H: [4, 13], S: [4, 13], hcp: [minDbl(opp), 37] }, force: 1 } : { shows: { hcp: [minDbl(opp), 37] }, force: 1 };
          return { shows: { hcp: [8, 37] }, force: 1 };
        }
        if (!isBid(call)) return { shows: { hcp: [0, 9] } };
        const s = call[1], lv = levelOf(call), ch = cheap(s, before, opp);
        if (call === '1N') return { shows: { hcp: [8, 10.99] } };
        if (call === '2N') return { shows: { hcp: [11, 12.99], stop: [Y] } };
        if (call === '3N') return { shows: { hcp: [13, 15.99], stop: [Y] } };
        if (s === X) {
          if (maj && call === '3' + X && ch !== '3' + X) return { shows: { [X]: [4, 13], hcp: [3, 6.99] } };
          return { shows: { [X]: [maj ? 3 : 4, 13], hcp: [6, 10.99] } };
        }
        if (s !== Y && lv >= gameLevel(s)) return { shows: { [s]: [6, 13] } }; // ゲーム以上＝それをプレイしたい
        if (s === Y) {
          if (call === ch && rankOf(call) > rankOf('3' + X)) return { shows: { [X]: [maj ? 3 : 4, 13], hcp: [16, 37], agree: X, interest: true }, force: 'GF' }; // スラムトライ
          if (call === ch) return { shows: { [X]: [maj ? 3 : 4, 13], hcp: [10.5, 37] }, force: 1 };
          return { shows: { [X]: [maj ? 4 : 6, 13], [Y]: [0, 1], agree: X, ctrl: [Y], interest: true }, force: 'GF' }; // ジャンプキュービッド＝スプリンター
        }
        if (call === ch) {
          if (lv === 1) return { shows: { [s]: [Y === 'H' && s === 'S' && !maj ? 5 : 4, 13], hcp: [6, 37] }, force: 1 };
          if (lv === 2) return { shows: { [s]: [5, 13], hcp: [10.5, 37] }, force: 1 };
          return { shows: { [s]: [5, 13], hcp: [13, 37] }, force: 'GF' };
        }
        if (lv >= 5) return { shows: { [s]: [6, 13] } }; // 5の代以上は自然（ジャンプの取り決めは4の代まで）
        if (levelOf(ch) + 1 === lv) {
          if (maj) return { shows: { [X]: [4, 13], hcp: [7, 10.99] }, force: 1 };
          return { shows: { [s]: [5, 13], [X]: [4, 13], hcp: [10.5, 37] }, force: rankOf(call) > rankOf('3' + X) ? 'GF' : 1 };
        }
        if (levelOf(ch) + 2 === lv) return { shows: { [X]: [maj ? 4 : 6, 13], [s]: [0, 1], agree: X, ctrl: [s], interest: true }, force: 'GF' };
        return { shows: {} };
      }
      if (n === 2 && before[1] === 'P') {
        if (call === 'X') return { shows: { [Y]: [0, 2], hcp: [11.5, 37] }, force: 1 };
        if (!isBid(call)) return null;
        if (call[1] === 'N') return { shows: { hcp: [18, 19.99], stop: [Y] } };
        if (call[1] === X) return { shows: { [X]: [6, 13] } };
        return { shows: { [call[1]]: [4, 13], [X]: [5, 13], hcp: [11.5, 17.99] } };
      }
      if (n === 2) {
        const r1 = before[1];
        // キュービッド（1M）の後の、3Mより高いニュースート＝コントロール紹介
        if (maj && r1[1] === Y && r1 === cheap(Y, [before[0]], opp) && isBid(call) && call[1] !== 'N' && call[1] !== X && rankOf(call) > rankOf('3' + X) && rankOf(call) < rankOf('4' + X))
          return { shows: { agree: X, interest: true, ctrl: [call[1]], cue: true }, force: 'GF' };
        if (isBid(call) && call[1] === Y && !(r1[1] === Y)) return { shows: { hcp: [18, 37] }, force: 'GF' }; // オープナーのキュービッド＝GFの強い手
        if (r1 === 'X' && isBid(call) && U.includes(call[1])) {
          const jumped = call !== cheap(call[1], before, opp);
          return { shows: { [call[1]]: [4, 5], hcp: levelOf(call) >= 4 ? [18, 21] : jumped ? [15, 17.99] : [11.5, 14.99] } };
        }
        return null;
      }
      if (n === 3 && isBid(call)) {
        // レスポンダーの2回目：3の代のレイズ・2NT＝招待、ゲーム＝ゲームの点数
        if (call === '2N' || (levelOf(call) === 3 && call[1] !== 'N' && call[1] === before[2][1])) return { shows: { hcp: [11, 12.99] } };
        return null;
      }
      return null;
    }
    return { pick, interp, ok };
  })();

  // ===== 敵のテイクアウトダブルの後の3番手（レスポンダー） =====
  //   インビ以上のほとんどの手はリダブルから。例外：1Mへの4枚以上のサポート（フリーランのレイズ）、1mへの5枚以上のサポート
  //   （インビ＝3mのジャンプレイズ、GF＝マイナーのジャンプシフト、弱い＝2NTのプリエンプティブ・レイズ）、5枚以上のメジャー（1M）
  //   2/1（ノンジャンプの2の代のニュースート）＝6枚以上・インビ未満のto play
  const XRESP = (() => {
    const T = s => JA_SUIT[s];
    const other = m => m === 'C' ? 'D' : 'C';
    const jsOf = X => X === 'C' ? '2D' : '3C';             // マイナーのジャンプシフト（1♣-(X)-2♦、1♦-(X)-3♣）
    const twoOne = (X, s) => isBid(cheapest(s, ['1' + X])) && levelOf(cheapest(s, ['1' + X])) === 2 && s !== X && !(X === 'C' && s === 'D') && !(X === 'H' && s === 'S');
    function resp(h, seq, pipeline) {
      const X = seq[0][1], v = h.adj, maj = isMaj(X);
      const R = (call, why) => call && legal(call, seq) ? { call, why } : null;
      let r;
      // 1M：4枚以上のサポートはフリーランの各種レイズ
      if (maj && h.len[X] >= 4) { const f = pipeline(); if (f && f.call !== 'XX') return { call: f.call, why: `テイクアウトダブルの後も、4枚以上のサポートはフリーランのレイズ：${f.why}` }; }
      if (maj && h.len[X] === 3) {
        const dp = h.dp(X, 5);
        if (dp >= 10.5) return { call: 'XX', why: `${T(X)}3枚のサポートでインビテーション以上（ダミーポイント${fmt(dp)}点）なのでリダブルから` };
        if (dp >= 6 && (r = R('2' + X, `${T(X)}3枚のサポートで6〜10点なので2${SYM[X]}`))) return r;
      }
      // 1m：5枚以上のサポート
      if (!maj && h.len[X] >= 5) {
        if (v >= 13 && (r = R(jsOf(X), `${T(X)}5枚以上のサポートでゲームフォーシングなので、マイナーのジャンプシフト（${callText(jsOf(X))}）`))) return r;
        if (v >= 10.5 && (r = R('3' + X, `${T(X)}5枚以上のサポートでインビテーションなので、3${SYM[X]}（ジャンプレイズ）`))) return r;
        if (h.adjNoLen < 6 && (r = R('2N', `${T(X)}5枚以上のサポートで弱いので、2NT（プリエンプティブ・レイズ）`))) return r;
        if ((r = R('2' + X, `${T(X)}5枚以上のサポートで6〜9点なので2${SYM[X]}（シングルレイズ）`))) return r;
      }
      // 5枚以上のメジャー：1の代で言えれば1M（強さにかかわらず）
      for (const M of ['S', 'H']) if (M !== X && h.len[M] >= 5 && v >= 6) { const c = cheapest(M, seq); if (levelOf(c) === 1 && (r = R(c, `${T(M)}5枚以上なので1${SYM[M]}（テイクアウトダブルの後も、5枚以上のメジャーはインビ以上でも1M）`))) return r; }
      // インビテーション以上はリダブル
      if (v >= 10.5) return { call: 'XX', why: `インビテーション以上（${fmt(v)}点）なのでリダブル` };
      // 弱い手：4枚メジャーを先に
      for (const M of ['H', 'S']) if (M !== X && h.len[M] >= 4 && v >= 6) { const c = cheapest(M, seq); if (levelOf(c) === 1 && (r = R(c, `${T(M)}4枚以上・6〜9点なので1${SYM[M]}`))) return r; }
      if (!maj && h.len[X] >= 4 && v >= 6 && (r = R('2' + X, `${T(X)}4枚以上のサポートで6〜9点なので2${SYM[X]}（シングルレイズ）`))) return r;
      for (const s of SUITS.filter(s => twoOne(X, s)).sort((a, b) => h.len[b] - h.len[a])) {
        if (h.len[s] >= 6 && v >= 4 && (r = R('2' + s, `${T(s)}6枚以上でインビテーション未満なので、to playの2${SYM[s]}（テイクアウトダブルの後の2/1）`))) return r;
      }
      if (X === 'C' && h.len.D >= 4 && v >= 6 && (r = R('1D', 'ダイヤ4枚以上・6〜9点なので1♦'))) return r;
      if (v >= 6 && (r = R('1N', `6〜9点でほかに適当なビッドがないので1NT`))) return r;
      return { call: 'P', why: 'テイクアウトダブルされて、ビッドする強さ・形がないのでパス' };
    }
    // フリーランと同様に続ける流れ：1の代のスートの応答、メジャーのレイズ
    function freeAfter(seq) {
      const X = seq[0][1], r1 = seq[1];
      if (!isBid(r1)) return false;
      if (levelOf(r1) === 1 && r1[1] !== 'N') return true;
      if (isMaj(X) && r1 !== 'XX' && !(r1[0] === '2' && twoOne(X, r1[1]) && r1[1] !== X) && r1 !== '1N') return true;
      return false;
    }
    function later(h, seq) {
      const X = seq[0][1], r1 = seq[1], v = h.adj, n = seq.length;
      const P = why => ({ call: 'P', why });
      const R = (call, why) => call && legal(call, seq) ? { call, why } : null;
      if (n !== 2) return null;
      if (r1 === 'XX') return P('パートナーのリダブル（インビテーション以上）。敵の動きを待ってパス');
      if (isBid(r1) && r1[0] === '2' && twoOne(X, r1[1]) && r1[1] !== X) return P('パートナーの2/1はto play（6枚以上・インビ未満）なのでパス');
      if (r1 === '2N' && !isMaj(X)) return v >= 19 ? R('5' + X, '強いのでゲーム') || P('パス') : R('3' + X, `パートナーの2NTはプリエンプティブ・レイズなので3${SYM[X]}`) || P('パス');
      if (r1 === '3' + X) return v >= 14 ? (h.balanced ? R('3N', '招待を受けて3NT') : R('5' + X, '招待を受けて5' + SYM[X])) || P('パス') : P('招待を断ってパス');
      if (r1 === jsOf(X)) return h.balanced ? R('3N', `パートナーは${T(X)}5枚以上のサポートでGF。バランスハンドなので3NT`) || R('5' + X, 'ゲーム') : R('5' + X, `パートナーは${T(X)}5枚以上のサポートでGF。5${SYM[X]}`) || P('パス');
      if (r1 === '2' + X) return v >= 18 ? (h.balanced ? R('3N', 'シングルレイズに対して強いので3NT') : R('3' + X, '強いので招待')) || P('パス') : P('シングルレイズに対してゲームの点数がないのでパス');
      if (r1 === '1N') { if (v >= 19) return R('3N', '1NT（6〜9点）に対して強いので3NT') || P('パス'); if (v >= 17) return R('2N', '1NT（6〜9点）に対して招待') || P('パス'); if (h.len[X] >= 6) return R(cheapest(X, seq), `${T(X)}6枚以上なのでリビッド`) || P('パス'); return P('1NT（6〜9点）でゲームの可能性が低いのでパス'); }
      return null;
    }
    return { resp, freeAfter, later };
  })();

  // ===== テイクアウトダブルへの応答（4番手）：敵のオープン-(パートナーのX)-パス-自分 =====
  //   パスは敵のスートの内容の良い6枚以上・10点以上だけ。NT＝8〜10／11〜12／13〜15。スート：ノンジャンプ＝8点以下、ジャンプ＝インビ。
  //   メジャーのジャンプは枚数で使い分け（1♣-(X)-P-2♠＝ちょうど4枚の9〜11、3♠＝ちょうど5枚の8〜10、4♠＝6枚以上の6〜10）。
  //   GFはキュービッド。1m-(X)-Pのキュービッドはメジャー4-4ちょうどのインビも含む（ダブルした側は4枚メジャー、なければ2NT）
  const TOX = (() => {
    const T = s => JA_SUIT[s];
    function advance(h, Y, ok, cheapOf) {
      const v = h.adj, minorOpen = !isMaj(Y);
      const B = (call, why) => call && ok(call) ? { call, why } : null;
      const cue = cheapOf(Y);
      const jumpOf = (s, n) => { const c = cheapOf(s); return c ? (levelOf(c) + n) + s : null; };
      let r;
      const good = [...h.hand[Y]].filter(c => 'AKQJT'.includes(c)).length >= 3;
      if (h.len[Y] >= 6 && good && v >= 10) return { call: 'P', why: `${T(Y)}を内容の良い${h.len[Y]}枚持ち10点以上なので、ダブルをパスしてペナルティにする` };
      const Us = ['H', 'S'].filter(M => M !== Y);
      // 1m-(X)-P：メジャーちょうど4-4のインビはキュービッド
      if (minorOpen && h.len.H === 4 && h.len.S === 4 && v >= 9 && v < 12 && (r = B(cue, `メジャーちょうど4-4のインビテーション（${fmt(v)}点）なのでキュービッド（${callText(cue)}）。パートナーは4枚メジャーを示す`))) return r;
      const M = Us.filter(x => h.len[x] >= 4).sort((a, b) => h.len[b] - h.len[a] || (a === 'H' ? -1 : 1))[0];
      if (v >= 12 && M && (r = B(cue, `ゲームフォーシングの強さ（${fmt(v)}点）でメジャー4枚以上なのでキュービッド（${callText(cue)}）`))) return r;
      if (M) {
        const c = cheapOf(M), n = h.len[M];
        const roomy = c && levelOf(c) === 1; // ジャンプを枚数で使い分けられる
        if (roomy) {
          if (n >= 6 && v >= 6 && v < 11 && (r = B('4' + M, `${T(M)}6枚以上・6〜10点なので4${SYM[M]}`))) return r;
          if (n === 5 && v >= 8 && v < 12 && (r = B(jumpOf(M, 2), `${T(M)}ちょうど5枚・8〜10点なのでダブルジャンプの${callText(jumpOf(M, 2))}（3NTか4${SYM[M]}かを判断できる）`))) return r;
          if (n === 4 && v >= 9 && v < 12 && (r = B(jumpOf(M, 1), `${T(M)}ちょうど4枚・9〜11点なのでジャンプの${callText(jumpOf(M, 1))}`))) return r;
          if ((r = B(c, `${T(M)}${n}枚。8点以下（または枚数が足りない）なので1${SYM[M]}`))) return r;
        } else {
          if (n >= 6 && v >= 6 && v < 11 && (r = B('4' + M, `${T(M)}6枚以上・6〜10点なので4${SYM[M]}`))) return r;
          if (v >= 9 && v < 12 && (r = B(jumpOf(M, 1), `${T(M)}${n}枚・9〜11点なのでジャンプの${callText(jumpOf(M, 1))}（インビテーション）`))) return r;
          if (v < 9 && (r = B(c, `${T(M)}${n}枚・8点以下なのでノンジャンプの${callText(c)}`))) return r;
        }
      }
      // NT（ストッパーが必要・私の判断）
      if (h.stopper(Y)) {
        if (v >= 13 && v < 16 && (r = B('3N', `${T(Y)}のストッパーがあり13〜15点なので3NT`))) return r;
        if (v >= 11 && v < 13 && (r = B('2N', `${T(Y)}のストッパーがあり11〜12点なので2NT`))) return r;
        if (v >= 8 && v < 11 && (r = B(cheapOf('N'), `${T(Y)}のストッパーがあり8〜10点なので${callText(cheapOf('N'))}`))) return r;
      }
      if (v >= 12 && (r = B(cue, `ゲームフォーシングの強さ（${fmt(v)}点）なのでキュービッド（${callText(cue)}）`))) return r;
      // マイナーなど：ノンジャンプ＝8点以下、ジャンプ＝インビ
      const L = SUITS.filter(s => s !== Y).sort((a, b) => h.len[b] - h.len[a] || (isMaj(b) ? 1 : 0) - (isMaj(a) ? 1 : 0))[0];
      if (v >= 9 && (r = B(jumpOf(L, 1), `${T(L)}${h.len[L]}枚・9〜11点なのでジャンプの${callText(jumpOf(L, 1))}（インビテーション）`))) return r;
      return B(cheapOf(L), `${T(L)}${h.len[L]}枚。8点以下なのでノンジャンプの${callText(cheapOf(L))}（パートナーのダブルにはパスしない）`) || { call: 'P', why: 'パス' };
    }
    // ビッド-ダブル-ビッドで回ってきた4番手：8点以上で4枚以上のスート（敵のスート以外）、なければNT。
    //   GFはキュービッド、ジャンプはインビ。1m-(X)-2m のダブル＝両メジャー4-4以上、1M-(X)-2M のダブル＝両マイナー4-4以上
    function advanceAfterBid(h, Y, R, ok, cheapOf) {
      const v = h.adj, rS = isBid(R) && R[1] !== 'N' ? R[1] : null, raised = rS === Y;
      const B = (call, why) => call && ok(call) ? { call, why } : null;
      const jumpOf = (s, n) => { const c = cheapOf(s); return c ? (levelOf(c) + n) + s : null; };
      const cue = cheapOf(Y);
      let r;
      if (v < 8) return { call: 'P', why: `敵がビッドしたので、8点未満（${fmt(v)}点）ならパス` };
      if (raised) {
        const pair = isMaj(Y) ? ['C', 'D'] : ['H', 'S'];
        if (h.len[pair[0]] >= 4 && h.len[pair[1]] >= 4 && (r = B('X', `敵のレイズに対して、${isMaj(Y) ? '両マイナー' : '両メジャー'}4-4以上なのでダブル`))) return r;
      }
      if (!isMaj(Y) && !raised && h.len.H === 4 && h.len.S === 4 && v >= 9 && v < 12 && (r = B(cue, `メジャーちょうど4-4のインビテーションなのでキュービッド（${callText(cue)}）`))) return r;
      if (v >= 12 && (r = B(cue, `ゲームフォーシングの強さ（${fmt(v)}点）なのでキュービッド（${callText(cue)}）`))) return r;
      const cands = SUITS.filter(s => s !== Y && s !== rS && h.len[s] >= 4).sort((a, b) => (isMaj(b) ? 1 : 0) - (isMaj(a) ? 1 : 0) || h.len[b] - h.len[a]);
      for (const s of cands) {
        const j = jumpOf(s, 1);
        if (v >= 9 && j && levelOf(j) <= 3 && (r = B(j, `${T(s)}${h.len[s]}枚・9〜11点なのでジャンプの${callText(j)}（インビテーション）`))) return r;
        if ((r = B(cheapOf(s), `8点以上で${T(s)}${h.len[s]}枚なので${callText(cheapOf(s))}`))) return r;
      }
      if (v >= 13 && (r = B('3N', `ビッドできる4枚スートがなく13〜15点なので3NT`))) return r;
      if (v >= 11 && (r = B('2N', `ビッドできる4枚スートがなく11〜12点なので2NT`))) return r;
      const nt = cheapOf('N');
      if (nt && levelOf(nt) <= 2 && (r = B(nt, `8点以上でビッドできる4枚スートがないので${callText(nt)}`))) return r;
      return { call: 'P', why: 'ビッドできる形がないのでパス' };
    }
    // ダブルした側：パートナーのキュービッドへの答え（4枚メジャー、なければ2NT）
    function doublerAfterCue(h, Y, ok, cheapOf) {
      const v = h.adj;
      const M = ['H', 'S'].filter(x => x !== Y && h.len[x] >= 4).sort((a, b) => h.len[b] - h.len[a] || (a === 'H' ? -1 : 1))[0];
      if (M && ok(cheapOf(M))) return { call: cheapOf(M), why: `パートナーのキュービッドに、4枚の${T(M)}を示す（${M === 'S' ? 'ハート4枚なし' : ''}）`.replace('（）', '') };
      if (ok('2N')) return { call: '2N', why: 'パートナーのキュービッドに、4枚メジャーがないので2NT' };
      const L = SUITS.filter(s => s !== Y).sort((a, b) => h.len[b] - h.len[a])[0];
      return { call: cheapOf(L), why: `4枚メジャーがないので${T(L)}を示す` };
    }
    // キュービッドした側の2回目
    function advancerAfterReply(h, Y, reply, ok, cheapOf) {
      const v = h.adj, inv44 = !isMaj(Y) && h.len.H === 4 && h.len.S === 4 && v < 12;
      const B = (call, why) => call && ok(call) ? { call, why } : null;
      if (isBid(reply) && isMaj(reply[1]) && h.len[reply[1]] >= 4) {
        const M = reply[1];
        if (inv44) return B('3' + M, `パートナーの${T(M)}4枚にフィット。メジャー4-4のインビテーションなので3${SYM[M]}（これ以外はGF）`) || B('4' + M, 'ゲーム');
        return B('4' + M, `パートナーの${T(M)}4枚にフィットし、ゲームフォーシングの強さなので4${SYM[M]}`) || { call: 'P', why: 'パス' };
      }
      if (inv44) return { call: 'P', why: 'パートナーに4枚メジャーがない。インビテーションの強さなのでパス' };
      return B('3N', 'ゲームフォーシングの強さなので3NT') || { call: 'P', why: 'パス' };
    }
    // ダブルした側のリビッド（パートナーがキュービッド以外）：基本はパス。インビには答える。
    //   動き直す＝ストロングテイクアウト（18点以上）：NT（ノンジャンプ18〜20、ジャンプ21以上）、レイズ（16〜18はノンジャンプ、19〜21はジャンプ。
    //   強さ＝点数＋シングルトンがあれば1：15点の4441・16点の4432が下限）、ニュースート（ノンジャンプ＝5枚ちょうど18〜20、ワンジャンプ＝5枚20〜21か6枚20まで）、
    //   それを超える2♣オープン級はキュービッド
    function doublerRebid(h, Y, adv, jumpN, ok, cheapOf) {
      const v = h.adj;
      const B = (call, why) => call && ok(call) ? { call, why } : null;
      const P = why => ({ call: 'P', why });
      const jumpOf = (s, n) => { const c = cheapOf(s); return c ? (levelOf(c) + n) + s : null; };
      const cue = cheapOf(Y);
      if (adv === 'P') return P('パートナーはペナルティのパス');
      const as = adv[1], al = levelOf(adv);
      let r;
      // パートナーのインビテーションに答える
      if (as === 'N') {
        if (adv === '3N') return P('パートナーがゲームを決めたのでパス');
        if (adv === '2N') return v >= 14 ? B('3N', '2NT（11〜12点）の招待を受けて3NT') || P('パス') : P('2NT（11〜12点）の招待を断ってパス');
        if (v >= 16.5 && (r = B('3N', `パートナーの1NT（8〜10点）に対して強い（${fmt(v)}点）ので3NT`))) return r;
        if (v >= 15 && (r = B('2N', 'パートナーの1NT（8〜10点）に対して招待'))) return r;
        return P('パートナーの1NTでよいのでパス');
      }
      if (al >= gameLevel(as)) return P('パートナーがゲームを決めたのでパス');
      if (jumpN >= 1) {
        const sup = h.len[as];
        if (isMaj(as)) {
          if ((sup >= 4 || (jumpN >= 2 && sup >= 3)) && v >= 14) return B('4' + as, `パートナーの${T(as)}のジャンプ（インビ）に、${sup}枚のサポートと14点以上で4${SYM[as]}`) || P('パス');
          if (sup < 3 && v >= 15 && h.stopper(Y)) return B('3N', `パートナーの招待に、${T(as)}のサポートはないがストッパーがあり15点以上なので3NT`) || P('パス');
          return P(`パートナーの${T(as)}のジャンプ（インビ）を断ってパス`);
        }
        if (v >= 15 && h.stopper(Y) && (r = B('3N', `パートナーのマイナーのジャンプ（インビ）に、ストッパーがあり15点以上なので3NT`))) return r;
        return P('パートナーの招待を断ってパス');
      }
      // ノンジャンプの応答（0〜8点）：ストロングテイクアウトのときだけ動き直す
      const sc = v + (SUITS.some(x => h.len[x] === 1) ? 1 : 0);
      const stop = h.stopper(Y);
      if (h.len[as] >= 4 && sc >= 16 && sc < 22) {
        if (sc >= 19 && (r = B(jumpOf(as, 1), `パートナーの${T(as)}に4枚のサポートがあり、ストロングテイクアウト（${fmt(v)}点）なのでジャンプレイズ`))) return r;
        if ((r = B(cheapOf(as), `パートナーの${T(as)}に4枚のサポートがあり、16〜18点くらい（${fmt(v)}点）なのでレイズ`))) return r;
      }
      if (sc >= 22 && v >= 20 && (r = B(cue, `2♣オープン級の強い手（${fmt(v)}点）なのでキュービッド（${callText(cue)}）`))) return r;
      if (h.balanced && stop && v >= 18) {
        if (v >= 21 && (r = B(jumpOf('N', 1), `ストロングテイクアウトのバランスハンド21点以上なのでジャンプのNT`))) return r;
        if (v < 21 && (r = B(cheapOf('N'), `ストロングテイクアウトのバランスハンド18〜20点で${T(Y)}のストッパーがあるので、ノンジャンプのNT`))) return r;
      }
      const Z = SUITS.filter(x => x !== Y && x !== as && h.len[x] >= 5).sort((a, b) => h.len[b] - h.len[a])[0];
      if (Z) {
        const n = h.len[Z];
        if (((n === 5 && v >= 20 && v < 22) || (n >= 6 && v >= 18 && v < 21)) && (r = B(jumpOf(Z, 1), `${T(Z)}${n}枚の強い手（${fmt(v)}点）なのでワンジャンプの${callText(jumpOf(Z, 1))}`))) return r;
        if (n === 5 && v >= 18 && v < 20 && (r = B(cheapOf(Z), `${T(Z)}ちょうど5枚で18〜20点なので、ノンジャンプの${callText(cheapOf(Z))}`))) return r;
      }
      if (v >= 21 && (r = B(cue, `2♣オープン級の強い手（${fmt(v)}点）なのでキュービッド（${callText(cue)}）`))) return r;
      return P('ダブルした側は基本的にずっとパス（ストロングテイクアウトではない）');
    }
    // ダブルした側：パートナーの3M（メジャー4-4のインビ）への答え
    function doublerAfterInvite(h, M) {
      return h.adj >= 14.5 ? { call: '4' + M, why: `パートナーのインビテーション（メジャー4-4・${T(M)}フィット）を受けて4${SYM[M]}` } : { call: 'P', why: 'パートナーのインビテーションを断ってパス' };
    }
    return { advance, doublerAfterCue, advancerAfterReply, doublerAfterInvite, doublerRebid, advanceAfterBid };
  })();

  // ===== 4番手（アドバンサー）：敵のオープン-(パートナーのスートのオーバーコール)-敵の応答（パス以外）の後 =====
  //   info = { O: 敵のオープンのスート, oc: パートナーのオーバーコール, Z: そのスート, R: 敵の応答（ビッドかX） }
  //   ok(call) で合法か判断する（オークション全体）
  const ADV = (() => {
    const T = s => JA_SUIT[s];
    function pick(h, info, ok, cheapOf) {
      const { O, oc, Z, R } = info, v = h.adj;
      const P = why => ({ call: 'P', why });
      const B = (call, why) => call && ok(call) ? { call, why } : null;
      const lvOC = levelOf(oc);
      // 示されたスート：オープン・オーバーコール・敵の応答（ナチュラルなスート、またはネガティブ・ダブルのアンビッドのメジャー）
      const rSuit = isBid(R) && R[1] !== 'N' ? R[1] : null;
      const raised = rSuit === O;
      const shown = new Set([O, Z]);
      if (rSuit) shown.add(rSuit);
      if (R === 'X') for (const M of ['H', 'S']) if (!shown.has(M)) shown.add(M);
      const unbidS = SUITS.filter(s => !shown.has(s));
      const caseA = lvOC === 1 && (raised || R === '1N');            // 敵がレイズか1NT
      const fourth = shown.size === 3 ? unbidS[0] : null;
      const caseB = fourth && isMaj(fourth);                          // 4thスートがメジャー
      const caseC = fourth && !isMaj(fourth);                         // 4thスートがマイナー
      const dbl = R === 'X' ? 'XX' : 'X';
      const cue = cheapOf(O);
      const supNeed = isMaj(Z) ? 3 : (lvOC >= 2 ? 3 : 4);
      const dp = h.dp(Z, 5);
      const stopO = h.stopper(O), stopR = !rSuit || rSuit === O || h.stopper(rSuit);
      let r;
      // (c) 4thスートがマイナー：パートナーのスートにAKQのどれかを持つちょうど3枚のサポート（シングルレイズの強さ）
      if (caseC && h.len[Z] === 3 && /[AKQ]/.test(h.hand[Z]) && dp >= 6 && dp < 10.5
        && (r = B(dbl, `パートナーの${T(Z)}にAKQのどれかを持つちょうど3枚のサポートで、シングルレイズくらいの強さなので${callText(dbl)}（ディフェンスで攻めるスートを明確にする）`))) return r;
      const majFirst = !isMaj(Z);
      const tryMaj = () => {
      // (b) 4thスートがメジャー：ダブル＝そのメジャー4枚以上（上限なし）。1の代で言えるなら1M＝5枚以上、2の代以上の6枚以上の弱い手はto play
      if (caseB) {
        const F = fourth, c = cheapOf(F);
        if (h.len[F] >= 5 && c && levelOf(c) === 1 && v >= 8 && (r = B(c, `${T(F)}5枚以上なので1${SYM[F]}（4枚ちょうどならダブル）`))) return r;
        if (h.len[F] >= 6 && v < 10.5 && c && levelOf(c) >= 2 && levelOf(c) <= 3 && (r = B(c, `${T(F)}6枚以上でインビテーション未満なので、to playの${callText(c)}`))) return r;
        if (h.len[F] >= 4 && v >= (c && levelOf(c) >= 2 ? 8 : 6) && (r = B(dbl, `アンビッドの${T(F)}4枚以上なので${callText(dbl)}（強さの上限なし）`))) return r;
      }
      // (a) パートナーが1の代でオーバーコールし、敵がレイズか1NT：ダブル＝アンビッドの2スーター（理想は4-4以上）
      if (caseA && unbidS.length === 2) {
        const [A, Bs] = unbidS;
        const lvl = Math.max(levelOf(cheapOf(A) || '7N'), levelOf(cheapOf(Bs) || '7N'));
        const need = lvl <= 2 ? 8 : lvl === 3 ? 10 : 12;
        const both = h.len[A] >= 4 && h.len[Bs] >= 4;
        const shape = both && h.len[A] + h.len[Bs] >= 9;                       // 5-4以上なら点が足りなくても
        const maj4 = unbidS.find(s => isMaj(s) && h.len[s] >= 4);
        if (((both && v >= need) || (shape && v >= need - 2) || (maj4 && v >= need))
          && (r = B(dbl, both ? `アンビッドの${T(A)}と${T(Bs)}の${h.len[A]}-${h.len[Bs]}で、${lvl}の代に必要な強さ${shape && v < need ? 'には少し足りないが形が良い' : `（${need}点以上）がある`}のでダブル` : `示すべき${T(maj4)}4枚以上と点数（${need}点以上）があるのでダブル`))) return r;
      }
        return null;
      };
      if (majFirst && (r = tryMaj())) return r;
      // サポート
      if (h.len[Z] >= supNeed) {
        if (dp >= 10.5) {
          if (cue && rankOf(cue) < rankOf(gameCall(Z)) && (r = B(cue, `パートナーの${T(Z)}にサポートがあり、インビテーション以上（ダミーポイント${fmt(dp)}点）なので、オープンされた敵のスートのキュービッド（${callText(cue)}）`))) return r;
          if ((r = B(gameCall(Z), `パートナーの${T(Z)}にサポートがあり、インビテーション以上。キュービッドがゲームを超えるのでゲーム`))) return r;
        }
        const single = cheapOf(Z);
        if (h.len[Z] >= 4 && dp < 8) {
          const j = single && levelOf(single) + 1 <= 4 ? (levelOf(single) + 1) + Z : null;
          if (j && (r = B(j, `パートナーの${T(Z)}に4枚以上のサポートがあり弱いので、ジャンプのプリエンプティブ・レイズ（${callText(j)}）`))) return r;
        }
        // メジャー：4枚以上のサポートで8〜10点は、3Mより下のジャンプしたニュースート（1♦-(1♠)-2♦-3♥ など）
        if (isMaj(Z) && h.len[Z] >= 4 && dp >= 8) {
          const fj = SUITS.filter(x => x !== Z && x !== O && x !== rSuit).map(x => { const c = cheapOf(x); return c ? (levelOf(c) + 1) + x : null; })
            .filter(c => c && ok(c) && rankOf(c) < rankOf('3' + Z)).sort((a, b) => rankOf(a) - rankOf(b))[0];
          if (fj && (r = B(fj, `パートナーの${T(Z)}に4枚以上のサポートがあり8〜10点（ダミーポイント${fmt(dp)}点）なので、3${SYM[Z]}より下のジャンプしたニュースート（${callText(fj)}）`))) return r;
        }
        if (dp >= 6 && single && levelOf(single) <= 3 && (r = B(single, `パートナーの${T(Z)}にサポートがあり、6〜10点（ダミーポイント${fmt(dp)}点）なのでシングルレイズ`))) return r;
        // 競り上がって4の代以上でしかレイズできないとき：4枚以上のサポート（か強い3枚）なら、ほかのスートより先にレイズ
        if (single && levelOf(single) >= 4 && levelOf(single) <= 5 && (h.len[Z] >= 4 || dp >= 10) && dp >= 6
          && (r = B(single, `パートナーの${T(Z)}に${h.len[Z]}枚のサポートがある（ダミーポイント${fmt(dp)}点）ので、ほかのスートより先に${callText(single)}`))) return r;
      }
      if (!majFirst && (r = tryMaj())) return r;
      // 1の代のニュースート：ナチュラル4枚以上・8点以上
      for (const s of SUITS.filter(x => !shown.has(x) || (R === 'X' && x !== O && x !== Z))) {
        const c = cheapOf(s);
        if (c && levelOf(c) === 1 && h.len[s] >= 4 && v >= 8 && !(caseB && s === fourth) && (r = B(c, `${T(s)}4枚以上・8点以上なので1${SYM[s]}（ナチュラル）`))) return r;
      }
      // NT：1NT＝8〜12、2NT＝13〜14、3NT＝15点以上（敵のスートのストッパー）
      if (stopO && stopR) {
        if (v >= 15 && (r = B('3N', `${T(O)}${rSuit && rSuit !== O ? `・${T(rSuit)}` : ''}のストッパーがあり15点以上なので3NT`))) return r;
        if (v >= 13 && v < 15 && (r = B('2N', `ストッパーがあり13〜14点なので2NT`))) return r;
        if (v >= 8 && v < 13 && (r = B('1N', `ストッパーがあり8〜12点なので1NT（オーバーコーラーがオープンの強さならパスできない）`))) return r;
      }
      // 2の代以上のジャンプしていないニュースート＝to play（6枚以上・インビテーション未満）
      for (const s of SUITS.filter(x => !shown.has(x)).sort((a, b) => h.len[b] - h.len[a])) {
        const c = cheapOf(s);
        const longOk = h.len[s] >= 8 || (h.len[s] >= 7 && SUITS.some(x => x !== s && h.len[x] >= 4)); // 8枚以上か7-4なら4・5の代でも
        if (c && levelOf(c) >= 2 && (levelOf(c) <= 3 || (levelOf(c) <= 5 && longOk)) && h.len[s] >= 6 && v < 10.5 && (r = B(c, `${T(s)}${h.len[s]}枚${levelOf(c) >= 4 ? '（十分な長さ）' : '以上'}でインビテーション未満なので、to playの${callText(c)}`))) return r;
      }
      // インビ以上でフィットもストッパーもない：キュービッド（私の判断）
      if (v >= 12 && isMaj(Z)) {
        // パートナーがメジャー：ストッパーがなくてもNT
        const nt = v >= 15 ? '3N' : v >= 13 ? '2N' : (ok('1N') ? '1N' : '2N');
        if ((r = B(nt, `インビテーション以上で、パートナーのメジャーにフィットせずストッパーもないが、${callText(nt)}（${fmt(v)}点）`))) return r;
      }
      if (v >= 12 && cue && (r = B(cue, `インビテーション以上の強さだが、パートナーのマイナーにフィットせず${T(O)}のストッパーもないのでキュービッド（${callText(cue)}）`))) return r;
      return P('4番手として、ビッドできる形・強さがないのでパス');
    }
    return { pick };
  })();

  // NTの後の点数：シングルトンのKは1点低く数える（NTでは働きにくい。J942.J87.K.K7653 は1NTにパス）
  const ntPts = h => h.hcp - SUITS.filter(s => h.hand[s] === 'K').length;
  // ===== NTオープン後の仕組み（1NT, 2NT, 2♣-2♦-2NT など共通） =====
  function ntSystem(prefix, lo, hi, L, name) {
    const p = prefix ? prefix + ' ' : '';
    const game = 25 - lo, inv = game - 2, quant = 31 - lo, slam = 33 - lo;
    const mid = (lo + hi) / 2;
    const accept = h => ntPts(h) >= lo + 1;           // 招待を受ける
    const acceptQ = h => ntPts(h) >= hi;              // 4NT（クオンティタティブ）を受ける
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
      return ntPts(h) >= need && ((four && !five) || (h.len.H >= 4 && h.len.S >= 4));
    };
    R(prefix, st, stOk, { hcp: [N2 ? inv : game, 37] }, `4枚メジャーがあり、${N2 ? '招待' : 'ゲーム'}以上の点数があるのでステイマン${ntNote}`, 1);
    R(prefix, tS, h => h.len.S >= 5 && h.len.S >= h.len.H, { S: [5, 13] }, `スペード5枚以上なのでジャコビー・トランスファー（${callText(tS)}→${L}♠）`, 1);
    R(prefix, tH, h => h.len.H >= 5, { H: [5, 13] }, `ハート5枚以上なのでジャコビー・トランスファー（${callText(tH)}→${L}♥）`, 1);
    if (N2 && prefix !== '1N') R(prefix, '2N', h => between(ntPts(h), inv, game - 1), { hcp: [inv, game - 1], S: [0, 3], H: [0, 3] }, `4枚メジャーがなく${inv}〜${game - 1}点なので2NTで招待${ntNote}`);
    // 2NT以上（20点以上）の後は、5枚以上のスートがあれば1点少なくてもゲーム（T43.98.K8652.J62 で3NT）
    R(prefix, '3N', h => between(ntPts(h) + (L === 3 && SUITS.some(s => h.len[s] >= 5) ? 1 : 0), game, quant - 1), { hcp: [game, quant - 1], S: [0, 4], H: [0, 4] }, `メジャーのフィットを探す必要がなく、ゲームの点数（${game}点以上）があるので3NT${ntNote}`);
    R(prefix, '4N', h => between(ntPts(h), quant, slam - 1) && h.balanced, { hcp: [quant, slam - 1] }, `スラムの可能性があるので4NT（クオンティタティブ＝スラムへの招待）${ntNote}`);
    R(prefix, '6N', h => between(ntPts(h), slam, slam + 3) && h.balanced, { hcp: [slam, slam + 3] }, `合計で33点以上あるので6NT${ntNote}`);
    R(prefix, 'P', h => ntPts(h) < (N2 ? inv : game), { hcp: [0, (N2 ? inv : game) - 1] }, `ゲームの可能性が低いのでパス${ntNote}`);

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
      if (N2) R(q, '2N', h => between(ntPts(h), inv, game - 1), { hcp: [inv, game - 1] }, 'メジャーのフィットがなかったので2NTで招待');
      R(q, '3N', h => between(ntPts(h), game, quant - 1), { hcp: [game, quant - 1] }, 'メジャーのフィットがなかったので3NT（もう一方のメジャー4枚を持っている）');
      R(q, '4N', h => between(ntPts(h), quant, slam - 1), { hcp: [quant, slam - 1] }, 'フィットはないがスラムの可能性があるので4NT（クオンティタティブ）');
      R(q, '6N', h => ntPts(h) >= slam, { hcp: [slam, 37] }, '合計33点以上あるので6NT');
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
      if (N2) R(p + tr, '3' + M, h => h.len[M] >= 4 && ntPts(h) >= hi, { [M]: [4, 5], hcp: [hi, hi] }, `最高点で${JA_SUIT[M]}4枚のサポートがあるのでスーパーアクセプト（3${SYM[M]}）`);
      R(p + tr, L + M, () => true, null, `トランスファーに応じて${L}${SYM[M]}`);
      const done = p + tr + ' ' + L + M;
      if (N2) {
        R(done, '2N', h => h.len[M] === 5 && between(ntPts(h), inv, game - 1), { [M]: [5, 5], hcp: [inv, game - 1] }, `${JA_SUIT[M]}5枚で招待の点数なので2NT`);
        R(done, '3' + M, h => h.len[M] >= 6 && between(h.dpLong(M, 3), inv, game - 1), { [M]: [6, 13], hcp: [inv, game - 1] }, `${JA_SUIT[M]}6枚以上で招待の点数なので3${SYM[M]}`);
      }
      R(done, '3N', h => h.len[M] === 5 && between(ntPts(h), game, quant - 1), { [M]: [5, 5], hcp: [game, quant - 1] }, `${JA_SUIT[M]}5枚でゲームの点数なので3NT（パートナーに4${SYM[M]}か3NTを選んでもらう）`);
      R(done, '4' + M, h => h.len[M] >= 6 && h.dpLong(M, 3) >= game, { [M]: [6, 13], hcp: [game, 37] }, `${JA_SUIT[M]}6枚以上でゲームの点数なので4${SYM[M]}`);
      R(done, '4N', h => h.len[M] === 5 && ntPts(h) >= quant, { [M]: [5, 5], hcp: [quant, 37] }, 'スラムの可能性があるので4NT（クオンティタティブ）');
      R(done, 'P', () => true, null, 'ゲームの可能性が低いのでパス（トランスファーでスートを決めた）');
      if (N2) {
        R(p + tr + ' 3' + M, '4' + M, h => ntPts(h) >= inv - 3, null, 'パートナーがスーパーアクセプトしたのでゲームに上がる');
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
    // 2NT（強めの6〜8）やそれより強いレイズは、HCPだけで5点以上ある手。足りなければ3M（弱いレイズ）
    const dpOf = h => h.rawHcp >= 5 ? h.dp(M, 5) : Math.min(h.dp(M, 5), 6.49);
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
      h => h.rawHcp < 5 && h.dp(M, 5) >= 6.5 ? `${name}4枚以上のサポート。ダミーポイントは${fmt(h.dp(M, 5))}点あるが、HCPが5点未満なので${callText(L.weak)}（弱いレイズ）`
        : `${name}4枚以上のサポートで3〜弱めの6点（ダミーポイント）なので${callText(L.weak)}（弱いレイズ）`);
  }
  R('1H', '1S', h => h.len.S >= 4 && ((h.len.H < 3 && h.adj > 4) || (h.len.H === 3 && h.dp('H', 5) >= 11)), { S: [4, 13], hcp: [4, 37] },
    h => h.len.H === 3 ? 'スペード4枚以上。ハート3枚のサポートもあるが11点以上なのでまず1♠' : 'スペード4枚以上・4点を超えるので1♠（1巡フォーシング）', 1);
  // --- 3枚サポート: 1NT=3〜5 / 2M=6〜10 / 1NT→3M=11〜12 / 2/1=13以上 ---
  const pts = (h, c) => h.len[c.b.M] === 3 ? supDp(h, c) : h.adj; // 2/1の強さ
  // パス済みのハンドが2NT以下のGFの意味のビッドをするとインビテーション（2のレベルのニュースート＝6枚以上・9.5〜11点）
  RD(seq => seq.length === 1 && /^1[CDHS]$/.test(seq[0]) ? { X: seq[0][1] } : null, (h, c) => {
    const X = c.b.X;
    if (!c.iPassed || h.adj < 9.5 || h.adj >= 11.5) return null;
    if (isMaj(X) ? h.len[X] >= 3 : (h.len.H >= 4 || h.len.S >= 4)) return null;
    const Y = SUITS.find(y => y !== X && RANK(y) < RANK(X) && h.len[y] >= 6);
    return Y ? { call: '2' + Y, why: 'パス済みなので、2のレベルのニュースート（本来GF）は6枚以上のインビテーション' } : null;
  }, (call, b, before) => null);
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
  // 4枚サポートのレイズ（スプリンター以外）の後のオープナーのニュースート
  //   GFでないレイズ（2NT・3♣・3♦・3♥・3M など）：3Mより低いニュースート＝リインビテーション（ゲームするか微妙な手）
  //                                           3Mより高いニュースート＝ショート（スラムトライ）
  //   GFのレイズ（1♥-2♠・1♠-2NT・1♥-3♠・1♠-3NT）：ノンジャンプのニュースート＝ショート
  const RAISE_INFO = M => {
    const L = LADDER[M];
    return { [L.weak]: { g: 19, lo: 3, hi: 6.5 }, [L.s68]: { g: 17, lo: 6.5, hi: 9 }, [L.r910]: { g: 15, lo: 9, hi: 11 }, [L.r1112]: { g: 14, lo: 11, hi: 12.5 } };
  };
  const GF_RAISE = M => [LADDER[M].gf, LADDER[M].s1215];
  // 3Mより上で、そのスートを示す一番安いビッド（4Mより下）
  const shortCallAbove = (X, M) => { for (const lv of [3, 4]) { const c = lv + X; if (rankOf(c) > rankOf('3' + M) && rankOf(c) < rankOf('4' + M)) return c; } return null; };
  RD(seq => seq.length === 2 && /^1[HS]$/.test(seq[0]) && RAISE_INFO(seq[0][1])[seq[1]] ? { M: seq[0][1], info: RAISE_INFO(seq[0][1])[seq[1]] } : null, (h, c) => {
    const { M, info } = c.b, dp = h.dp(M, 4);
    // ショート（スラムトライ）：パートナーの上限と合わせて32点以上になりうる
    const shorts = SUITS.filter(x => x !== M && h.len[x] <= 1).sort((a, b) => h.len[a] - h.len[b]);
    if (shorts.length && dp + info.hi >= 32) {
      const call = shortCallAbove(shorts[0], M);
      if (call && legal(call, c.seq)) return { call, why: `パートナーの上限と合わせてスラムの可能性がある（ダミーポイント${fmt(dp)}点）。${JA_SUIT[shorts[0]]}が${h.len[shorts[0]] ? 'シングルトン' : 'ボイド'}なので、3${SYM[M]}より上の${callText(call)}でショートを示す（スラムトライ）` };
    }
    // リインビテーション：ゲームするか微妙（ゲームの目安の1.5点下まで）
    if (dp >= info.g - 1.5 && dp < info.g) {
      const call = SUITS.slice().reverse().filter(x => x !== M).map(x => cheapest(x, c.seq)).filter(x => x && rankOf(x) < rankOf('3' + M)).sort((a, b) => rankOf(a) - rankOf(b))[0];
      if (call) return { call, why: `ゲームするか微妙な強さ（ダミーポイント${fmt(dp)}点）なので、3${SYM[M]}より低い${callText(call)}でリインビテーション` };
    }
    return null;
  }, (call, b, before) => {
    if (!isBid(call) || call[1] === 'N' || call[1] === b.M) return null;
    if (rankOf(call) < rankOf('3' + b.M)) return { shows: {}, force: 1 };
    if (rankOf(call) < rankOf('4' + b.M)) return { shows: { [call[1]]: [0, 1], agree: b.M, ctrl: [call[1]], interest: true }, force: 'GF' };
    return null;
  });
  // リインビテーションへのレスポンダー：示した範囲の上半分ならゲーム、下半分なら3M
  RD(seq => seq.length === 3 && /^1[HS]$/.test(seq[0]) && RAISE_INFO(seq[0][1])[seq[1]] && isBid(seq[2]) && seq[2][1] !== 'N' && seq[2][1] !== seq[0][1] && rankOf(seq[2]) < rankOf('3' + seq[0][1])
    ? { M: seq[0][1], info: RAISE_INFO(seq[0][1])[seq[1]] } : null, (h, c) => {
    const { M, info } = c.b, dp = h.dp(M, 5), mid = (info.lo + info.hi) / 2;
    if (dp >= mid) return { call: '4' + M, why: `オープナーのリインビテーション。こちらは示した範囲（${info.lo}〜${fmt(info.hi)}点）の上半分（ダミーポイント${fmt(dp)}点）なので4${SYM[M]}` };
    return { call: '3' + M, why: `オープナーのリインビテーション。こちらは示した範囲（${info.lo}〜${fmt(info.hi)}点）の下半分（ダミーポイント${fmt(dp)}点）なので3${SYM[M]}` };
  }, () => null);
  // GFのレイズの後：ショートがあればノンジャンプのニュースートで示す
  RD(seq => seq.length === 2 && /^1[HS]$/.test(seq[0]) && GF_RAISE(seq[0][1]).includes(seq[1]) ? { M: seq[0][1] } : null, (h, c) => {
    const { M } = c.b;
    const shorts = SUITS.filter(x => x !== M && h.len[x] <= 1).sort((a, b) => h.len[a] - h.len[b]);
    if (!shorts.length || motivation(h, M, c) < 1) return null;
    const call = cheapest(shorts[0], c.seq);
    if (!call || rankOf(call) >= rankOf('4' + M)) return null;
    return { call, why: `GFのレイズに対して、${JA_SUIT[shorts[0]]}が${h.len[shorts[0]] ? 'シングルトン' : 'ボイド'}なので、ノンジャンプの${callText(call)}でショートを示す` };
  }, () => null);
  RULES[RULES.length - 1].pre = true; // スラムの仕組みより先に見る

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
  // 1NT応答へのリバース（1stスーツより高いランクの4枚スート、16点以上）
  RD(seq => seq.length === 2 && /^1[CDH]$/.test(seq[0]) && seq[1] === '1N' ? { A: seq[0][1] } : null, (h, c) => {
    const A = c.b.A;
    if (h.balanced || h.adj < 16 || h.len[A] < 5) return null;
    const Z = SUITS.filter(z => RANK(z) > RANK(A) && h.len[z] >= 4 && h.len[z] < h.len[A]).sort((x, y) => h.len[y] - h.len[x] || RANK(x) - RANK(y))[0];
    if (!Z || levelOf(cheapest(Z, c.seq)) !== 2) return null;
    return { call: '2' + Z, why: `${JA_SUIT[Z]}4枚以上・16点以上なのでリバース（2${SYM[Z]}）` };
  }, (call, b) => isBid(call) && call[0] === '2' && RANK(call[1]) > RANK(b.A) && call[1] !== 'N' ? { shows: { [call[1]]: [4, 13], [b.A]: [5, 13], hcp: [16, 21] }, force: 1 } : null);
  R('1M 1N', '2N', h => h.balanced && between(h.hcp, 18, 19), { hcp: [18, 19], bal: true }, 'バランスハンド18〜19点なので2NT');
  R('1M 1N', 'P', h => h.pattern === '5332' && between(h.hcp, 11, 14), { hcp: [11, 14] }, '5332の最低点なのでパス（セミフォーシングなのでパスしてよい）');
  R('1S 1N', '3H', h => h.len.H >= 4 && h.hcp >= 18, { H: [4, 13], hcp: [18, 21] }, 'ハート4枚以上・18点以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1M 1N', '4M', (h, c) => h.len[c.b.M] >= 6 && h.rebidPts(c.b.M) >= 18, null, 'メジャー6枚以上で18点以上なのでゲーム');
  R('1M 1N', '3M', (h, c) => h.len[c.b.M] >= 6 && h.rebidPts(c.b.M) >= 15.5, (b) => ({ [b.M]: [6, 13], hcp: [15.5, 17.99] }), 'メジャー6枚以上・強い15〜17点なので3メジャーで招待');
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
  R('1M 1N 2m 3M', '4M', (h, c) => h.dp(c.b.M, 3) >= 13, null, 'パートナーは3枚サポートの11〜12点（3〜5点ならジャンプしない）。こちらが上の方なのでゲーム');
  // 1M-1NT-(オープナーの2回目)：6枚以上のスートを持つ11〜12点は、そのスートを3の代で言って招待
  RD(seq => seq.length === 3 && /^1[HS]$/.test(seq[0]) && seq[1] === '1N' && isBid(seq[2]) && seq[2][0] === '2' ? { M: seq[0][1] } : null, (h, c) => {
    const { M } = c.b;
    if (h.len[M] >= 3 || (c.seq[2] === '2' + M && h.len[M] >= 2)) return null; // オープナーの6枚のメジャーにフィットがあればそちら
    const s = SUITS.find(x => x !== M && h.len[x] >= 6);
    if (!s || h.adjWith(s) < 10.5 || h.adjWith(s) >= 13 || !legal('3' + s, c.seq)) return null;
    return { call: '3' + s, why: `${JA_SUIT[s]}6枚以上（6枚目からの加点込みで${fmt(h.adjWith(s))}点）で11〜12点なので、${JA_SUIT[s]}を示しながら3${SYM[s]}で招待` };
  }, (call, b, before) => isBid(call) && call[0] === '3' && call[1] !== b.M && call[1] !== 'N' ? { shows: { [call[1]]: [6, 13], hcp: [10.5, 12.99] } } : null);
  R('1M 1N 2m', '3M', (h, c) => h.len[c.b.M] >= 3 && between(supDp(h, c), 11, 12), (b) => ({ [b.M]: [3, 3], hcp: [11, 12.99] }), 'メジャー3枚のサポートで11〜12点（ダミーポイント）なので3メジャーにジャンプ');
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

  // ===== スプリンター（ビッドしたスートが1枚以下。4枚以上のサポートを示すこともある） =====
  //   1. 2/1GFに対するジャンプシフト：レスポンダーのスートに4枚以上・そのスートが1枚以下（やる気に依らない）
  //   2. フィットが決まった後のジャンプシフト：スラムトライ（スラムの可能性があるときだけ）
  //   3. 1Mレスポンスに対するダブルジャンプシフト：Mに4枚以上・1枚以下のスラムトライ（スラムの可能性があるときだけ）
  const jumpIn = (s, seq, n) => { const ch = cheapest(s, seq); return ch && (levelOf(ch) + n) + s; };
  function findSplinter(h, seq, T, excl, n) {
    const cands = SUITS.filter(s => s !== T && !excl.includes(s) && h.len[s] <= 1)
      .sort((a, b) => h.len[a] - h.len[b]);
    for (const s of cands) {
      const call = jumpIn(s, seq, n);
      if (call && levelOf(call) <= 5 && rankOf(call) < rankOf(gameCall(T))) return { s, call };
    }
    return null;
  }
  const isSplinterCall = (call, seq, T, excl, n) => isBid(call) && call[1] !== 'N' && call[1] !== T && !excl.includes(call[1]) &&
    call === jumpIn(call[1], seq, n) && rankOf(call) < rankOf(gameCall(T));
  // 1. 2/1に対するジャンプシフト
  const twoOneSeq = seq => seq.length === 2 && /^1[HS]$/.test(seq[0]) && isBid(seq[1]) && seq[1][0] === '2' && seq[1][1] !== 'N' &&
    seq[1][1] !== seq[0][1] && seq[1] === cheapest(seq[1][1], [seq[0]]) ? { M: seq[0][1], X: seq[1][1] } : null;
  RD(twoOneSeq, (h, c) => {
    const { M, X } = c.b;
    if (h.len[X] < 4) return null;
    const sp = findSplinter(h, c.seq, X, [M], 1);
    return sp && { call: sp.call, why: `${JA_SUIT[X]}に4枚以上のサポートがあり、${JA_SUIT[sp.s]}が1枚以下なのでスプリンター（${callText(sp.call)}。GFなのでやる気に依らない）` };
  }, (call, b, before) => isSplinterCall(call, before, b.X, [b.M], 1)
    ? { shows: { [b.X]: [4, 13], [call[1]]: [0, 1], agree: b.X, ctrl: [call[1]] }, force: 'GF' } : null);
  // 2. フィットが決まった後のジャンプシフト
  const NONGF_RAISE = { H: ['2H', LADDER.H.weak, LADDER.H.s68, LADDER.H.r910, LADDER.H.r1112], S: ['2S', LADDER.S.weak, LADDER.S.s68, LADDER.S.r910, LADDER.S.r1112] };
  const fitDoneSeq = seq => {
    if (seq.length === 2 && /^1[HS]$/.test(seq[0]) && NONGF_RAISE[seq[0][1]].includes(seq[1])) return { T: seq[0][1], excl: [] };
    if (seq.length === 3 && seq[0][0] === '1' && /^1[HS]$/.test(seq[1]) && seq[2] === '2' + seq[1][1]) return { T: seq[1][1], excl: [seq[0][1]] };
    return null;
  };
  RD(fitDoneSeq, (h, c) => {
    const { T, excl } = c.b, p = c.partner.hcp;
    if (strengthFor(h, T, c) + (p[0] + Math.min(p[1], p[0] + 8)) / 2 < 31) return null;
    const sp = findSplinter(h, c.seq, T, excl, 1);
    return sp && { call: sp.call, why: `${JA_SUIT[T]}のフィットが決まり、スラムの可能性があるので、${JA_SUIT[sp.s]}が1枚以下を示すスプリンター（${callText(sp.call)}）でスラムトライ` };
  }, (call, b, before) => isSplinterCall(call, before, b.T, b.excl, 1)
    ? { shows: { [call[1]]: [0, 1], agree: b.T, ctrl: [call[1]], interest: true }, force: 'GF' } : null);
  // 3. 1Mレスポンスに対するダブルジャンプシフト
  RD(seq => seq.length === 2 && /^1[CDH]$/.test(seq[0]) && /^1[HS]$/.test(seq[1]) && seq[0] !== seq[1] ? { X: seq[0][1], M: seq[1][1] } : null, (h, c) => {
    const { X, M } = c.b;
    // オープナーのスラムトライ：パートナーのA2枚と切り札のQくらいでスモールスラムがほぼメイクする強さ（21点以上）
    if (h.len[M] < 4 || h.dp(M, 4) < 21) return null;
    const sp = findSplinter(h, c.seq, M, [X], 2);
    return sp && { call: sp.call, why: `${JA_SUIT[M]}に4枚以上のフィットがあり、${JA_SUIT[sp.s]}が1枚以下でスラムの可能性があるので、ダブルジャンプのスプリンター（${callText(sp.call)}）` };
  }, (call, b, before) => isSplinterCall(call, before, b.M, [b.X], 2)
    ? { shows: { [b.M]: [4, 13], [call[1]]: [0, 1], hcp: [21, 24.99], agree: b.M, ctrl: [call[1]], interest: true }, force: 'GF' } : null);

  // 1H-1S のオープナー
  R('1H 1S', '4S', h => h.len.S >= 4 && h.dp('S', 4) >= 18, null, 'スペード4枚のサポートで18点以上なので4♠');
  R('1H 1S', '3S', h => h.len.S >= 4 && between(h.dp('S', 4), 15, 17), { S: [4, 4], hcp: [15, 17] }, 'スペード4枚のサポートで15〜17点なので3♠');
  R('1H 1S', '2S', h => h.len.S >= 4, { S: [4, 4], hcp: [11, 14] }, 'スペード4枚のサポートがあるので2♠');
  R('1H 1S', '1N', h => h.balanced && h.hcp < 15, { hcp: [11.5, 14.99], bal: true, S: [0, 3] }, 'バランスハンドの最低点なので1NT');
  R('1H 1S', '2N', h => h.balanced && between(h.hcp, 18, 19), { hcp: [18, 19], bal: true, S: [0, 3] }, 'バランスハンド18〜19点なので2NT');
  R('1H 1S', '4H', h => h.len.H >= 6 && h.rebidPts('H') >= 18, { H: [6, 13], hcp: [18, 21.99] }, 'ハート6枚以上で18点以上なので4♥');
  R('1H 1S', '3H', h => h.len.H >= 6 && h.rebidPts('H') >= 15.5, { H: [6, 13], hcp: [15.5, 17.99] }, 'ハート6枚以上・強い15〜17点なので3♥');
  R('1H 1S', '3C', h => h.len.C >= 4 && h.hcp >= 18, { C: [4, 13], hcp: [18, 21] }, '18点以上でクラブ4枚以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1H 1S', '3D', h => h.len.D >= 4 && h.hcp >= 18, { D: [4, 13], hcp: [18, 21] }, '18点以上でダイヤ4枚以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1H 1S', '2H', h => h.len.H >= 6, { H: [6, 13], hcp: [11, 14] }, 'ハート6枚以上なので2♥');
  R('1H 1S', '2D', h => h.len.D >= 4 && h.len.D > h.len.C, { D: [4, 13], hcp: [11.5, 17.99] }, 'ダイヤ4枚以上なので2♦（低いランクのニュースート：15点まで、強い15〜17点は3回目に招待）');
  R('1H 1S', '2C', h => h.len.C >= 4, { C: [4, 13], hcp: [11.5, 17.99] }, 'クラブ4枚以上なので2♣（低いランクのニュースート：15点まで、強い15〜17点は3回目に招待）');
  R('1H 1S', '2D', h => h.len.D >= 4, { D: [4, 13], hcp: [11.5, 17.99] }, 'ダイヤ4枚以上なので2♦（低いランクのニュースート：15点まで、強い15〜17点は3回目に招待）');
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
  // 4点を超えたら応答。ただし6点未満でA・Kが1枚もない（コントロール0）なら4Mのチャンスが薄いのでパス
  // 1のレベルのスートの応答：点数＋形（ボイド+3、シングルトン+1、4枚を超える1枚ごとに+1）が6以上。
  //   A・Kが1枚もない手は、シングルトンかボイドがあるときだけ
  const respPts = h => h.adj + SUITS.reduce((t, s) => t + (h.len[s] === 0 ? 3 : h.len[s] === 1 ? 1 : 0) + Math.max(0, h.len[s] - 4), 0);
  const resp4 = h => respPts(h) >= 6 && (SUITS.some(s => /[AK]/.test(h.hand[s])) || SUITS.some(s => h.len[s] <= 1));
  // 1♣-1NTは♣4枚以上を保証（♣3枚以下の手はほかの応答をする）。♦4枚・♣4枚以上の弱い手は1NTを選ぶことがある
  R('1C', '1N', h => !bidMajorFirst(h) && h.len.C >= 4 && h.len.D === 4 && h.adj >= 6 && h.adj < 11, { hcp: [6, 10.99], C: [4, 13], S: [0, 3], H: [0, 3] },
    '4枚メジャーがなく、♣4枚以上・♦4枚の6〜10点なので1NT（1♣-1NTは♣4枚以上を保証し、♣のレイズとして働く）');
  R('1C', '1D', h => h.adj >= 6 && h.len.D >= 4 && (!bidMajorFirst(h) || (h.len.D >= 5 && h.hcp >= 11 && h.len.D > h.len.H && h.len.D > h.len.S)),
    { D: [4, 13], hcp: [6, 37] }, 'ダイヤ4枚以上（4枚メジャーがないか、ダイヤがずっと長く強い）なので1♦', 1);
  R('1m', '1S', h => resp4(h) && h.len.S >= 4 && (h.len.S > h.len.H || (h.len.S === h.len.H && h.len.S >= 5)), { S: [4, 13], hcp: [6, 37] }, 'スペード4枚以上（ハートより長い）なので1♠', 1);
  R('1m', '1H', h => resp4(h) && h.len.H >= 4, { H: [4, 13], hcp: [6, 37] }, 'ハート4枚以上なので1♥（4-4のメジャーはハートから）', 1);
  R('1m', '1S', h => resp4(h) && h.len.S >= 4, { S: [4, 13], hcp: [6, 37] }, 'スペード4枚以上なので1♠', 1);
  R('1D', '2C', h => h.hcp >= 12 && h.len.C >= 5, { C: [5, 13], hcp: [12, 37], S: [0, 3], H: [0, 3] }, 'クラブ5枚以上・12点以上なので2♣（2/1ゲームフォーシング）', 'GF');
  R('1m', '2m', (h, c) => h.adj >= 13 && h.len[c.b.m] >= (c.b.m === 'C' ? 5 : 4), (b) => ({ [b.m]: [b.m === 'C' ? 5 : 4, 13], hcp: [13, 37], S: [0, 3], H: [0, 3] }),
    '4枚メジャーがなくマイナーのサポートがあり13点以上なのでインバーテッド・マイナーレイズ（ゲームフォーシング）', 'GF');
  R('1m', '2H', (h, c) => h.len[c.b.m] >= 4 && h.adj >= 10.5 && h.adj < 13, (b) => ({ [b.m]: [4, 13], hcp: [10, 12], S: [0, 3], H: [0, 3] }), 'マイナー4枚以上のサポートで強めの10〜12点なので2♥（GFではないレイズ）', 1);
  R('1m', '2S', (h, c) => (h.len[c.b.m] >= 6 || (h.len[c.b.m] === 5 && (SUITS.some(s => s !== c.b.m && h.len[s] >= 5) || SUITS.some(s => h.len[s] <= 1)))) && h.adj >= 7 && h.adj < 10.5, (b) => ({ [b.m]: [5, 13], hcp: [7, 10], S: [0, 3], H: [0, 3] }), 'マイナー6枚以上（5枚なら5-5や1345のような形）のサポートで7〜9点（弱めの10点まで）なので2♠（GFではないレイズ）', 1);
  R('1m', '3m', (h, c) => h.len[c.b.m] >= 5 && h.adj >= 3 && h.adj < 7, (b) => ({ [b.m]: [5, 13], hcp: [3, 6], S: [0, 3], H: [0, 3] }), 'マイナー5枚以上のサポートでとても弱いので3マイナー（プリエンプティブ・レイズ）');
  R('1m', '3N', h => h.balanced && between(h.hcp, 13, 15), { hcp: [13, 15], bal: true, S: [0, 3], H: [0, 3] }, '4枚メジャーがないバランスハンド13〜15点なので3NT');
  R('1m', '2N', h => h.balanced && between(h.hcp, 11, 12), { hcp: [11, 12], bal: true, S: [0, 3], H: [0, 3] }, '4枚メジャーがないバランスハンド11〜12点なので2NTで招待');
  R('1m', '1N', h => h.adj >= 6 && h.adj < 11, (b) => ({ hcp: [6, 10], S: [0, 3], H: [0, 3], ...(b.m === 'C' ? { C: [4, 13] } : {}) }), '4枚メジャーがなく6〜10点なので1NT');
  R('1m', '2m', (h, c) => h.adj >= 13 && h.len[c.b.m] >= 4, (b) => ({ [b.m]: [4, 13], hcp: [13, 37] }), '強いがほかに適当なビッドがないのでインバーテッド・マイナーレイズ（ゲームフォーシング）', 'GF');
  R('1m', 'P', () => true, { hcp: [0, 5] }, '5点以下なのでパス');

  // 1m-1M のオープナー
  R('1m 1M', '4M', (h, c) => h.len[c.b.M] >= 4 && h.dp(c.b.M, 4) >= 18, null, 'メジャー4枚のサポートで18点以上なのでゲーム');
  R('1m 1M', '3M', (h, c) => h.len[c.b.M] >= 4 && between(h.dp(c.b.M, 4), 15, 17), (b) => ({ [b.M]: [4, 4], hcp: [15, 17] }), 'メジャー4枚のサポートで15〜17点なのでジャンプレイズ');
  R('1m 1M', '2M', (h, c) => h.len[c.b.M] >= 4, (b) => ({ [b.M]: [4, 4], hcp: [11, 14] }), 'メジャー4枚のサポートがあるので2メジャー');
  R('1m 1H', '1S', h => !h.balanced && h.len.S >= 4 && h.hcp < 18, { S: [4, 4], H: [0, 3], hcp: [11.5, 17.99] }, 'スペード4枚があるアンバランスハンドなので1♠（3つ目のスート。バランスハンドなら1NT）');
  R('1m 1M', '1N', h => h.balanced && h.hcp < 15, (b) => ({ hcp: [11.5, 14.99], bal: true, [b.M]: [2, 3] }), 'バランスハンドの最低点なので1NT（4枚スートがあってもバランスハンドは1NT）');
  R('1m 1M', '2N', h => h.balanced && between(h.hcp, 18, 19), (b) => ({ hcp: [18, 19], bal: true, [b.M]: [2, 3] }), 'バランスハンド18〜19点なので2NT');
  R('1D 1M', '2H', (h, c) => c.b.M === 'S' && h.len.H >= 4 && h.len.D >= 5 && h.hcp >= 16, { H: [4, 4], D: [5, 13], hcp: [16, 21] }, 'ハート4枚・16点以上なのでリバース（2♥）', 1);
  R('1C 1S', '2H', h => h.len.H >= 4 && h.len.C >= 5 && h.hcp >= 16, { H: [4, 13], C: [5, 13], hcp: [16, 21] }, 'ハート4枚・16点以上なのでリバース（2♥）', 1);
  R('1C 1M', '2D', h => h.len.D >= 4 && h.len.C >= 5 && h.hcp >= 16, { D: [4, 13], C: [5, 13], hcp: [16, 21] }, 'ダイヤ4枚・16点以上なのでリバース（2♦）', 1);
  // 6枚スートのリビッド：弱い15点以下＝2の代、強い15〜17点＝3の代、それより強い＝3NT
  R('1m 1M', '3N', (h, c) => h.len[c.b.m] >= 6 && h.rebidPts(c.b.m) >= 18, (b) => ({ [b.m]: [6, 13], hcp: [18, 21.99] }), 'マイナー6枚以上で18点以上なので3NT（6枚スートのリビッド：15点以下＝2、強い15〜17＝3、それより強い＝3NT）');
  R('1m 1M', '3m', (h, c) => h.len[c.b.m] >= 6 && h.rebidPts(c.b.m) >= 15.5 && h.rebidPts(c.b.m) < 18, (b) => ({ [b.m]: [6, 13], hcp: [15.5, 17.99] }), 'マイナー6枚以上・強い15〜17点なので3マイナー');
  R('1m 1M', '2N', (h, c) => h.pattern === '4441' && h.len[c.b.M] <= 1 && h.adj >= 18 && h.adj < 20, (b) => ({ hcp: [18, 19.99] }),
    '18〜19点の4441で、パートナーのスートが1枚。リバースには1stスーツ5枚以上が必要なので2NT');
  R('1D 1M', '3C', h => h.len.C >= 4 && h.hcp >= 18, { C: [4, 13], hcp: [18, 21] }, '18点以上でクラブ4枚以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1D 1M', '2C', h => h.len.C >= 4 && h.len.D < 6, { C: [4, 13], hcp: [11.5, 17.99] }, 'クラブ4枚以上のアンバランスハンドなので2♣（低いランクのニュースート：15点まで、強い15〜17点は3回目に招待）');
  R('1m 1M', '2m', (h, c) => h.len[c.b.m] >= 6 && h.rebidPts(c.b.m) < 15.5, (b) => ({ [b.m]: [6, 13], hcp: [11.5, 15.49] }), 'マイナー6枚以上なので2マイナー（2mのリビッドは6枚以上）');
  R('1m 1M', '2M', (h, c) => h.len[c.b.M] >= 3 && h.hcp < 15, null, 'メジャー3枚サポートで形が悪いので2メジャー');
  R('1m 1M', '1N', h => h.hcp < 15, (b) => ({ hcp: [11, 14] }), 'ほかに適当なビッドがないので1NT（6枚以上を誤魔化すよりバランスハンドを誤魔化す方が良い）');
  R('1m 1M', '2N', () => true, (b) => ({ hcp: [18, 19] }), '18点以上でほかに適当なビッドがないので2NT');
  // 1m-1M-2m のレスポンダー（2のレベルのニュースートはインビテーション以上）
  //   1♣-1♠-2♣：2♦＝インビ以上（♦と無関係・♥4枚なし）／ 2♥＝♥ちょうど4枚・インビ以上 ／ 2♠＝6枚以上のサインオフ
  //     （2♠はニュースートではない。GFは♥の有無で2♦か2♥から）
  //   1♣-1♥-2♣：2♦＝インビ以上（♦と無関係）／ 2♥＝6枚以上のサインオフ ／ 2♠＝GF（♠と無関係。オープナーは♠4枚なし）
  //   1♦-1♥-2♦：2♥＝6枚以上のサインオフ（ニュースートではない）／ 2♠＝GF（♠と無関係）／ 3♣＝♥と♣の5-5以上・インビ
  //   1♦-1♠-2♦：2♥＝♥ちょうど4枚・インビ以上 ／ 2♠＝6枚以上のサインオフ ／ 3♣＝♣と無関係、♥4枚なしのGF
  //   それ以外の3のレベルのニュースート＝5-5以上のインビ
  const M2 = {
    'C S': { inv: '2D', four: '2H', gf: null, sign: '2S' },
    'C H': { inv: '2D', four: null, gf: '2S', sign: '2H' },
    'D H': { inv: null, four: null, gf: '2S', sign: '2H' },
    'D S': { inv: null, four: '2H', gf: '3C', sign: '2S' },
  };
  RD(seq => seq.length === 3 && /^1[CD]$/.test(seq[0]) && /^1[HS]$/.test(seq[1]) && seq[2] === '2' + seq[0][1]
    ? { m: seq[0][1], M: seq[1][1], O: seq[1][1] === 'H' ? 'S' : 'H', t: M2[seq[0][1] + ' ' + seq[1][1]] } : null, (h, c) => {
    const { m, M, O, t } = c.b;
    // オープナーのリビッドしたマイナーに1枚以下（ミスフィット）なら1点低く評価し、6枚目以降の加点も入れない
    const v = h.len[m] <= 1 ? h.adjNoLen - 1 : h.adj;
    // もう一方のメジャーちょうど4枚は、別のフィットの可能性があるのでミスフィットでも示す
    if (h.adj >= 10.5 && t.four && h.len[O] === 4) return { call: t.four, why: `${JA_SUIT[O]}ちょうど4枚でインビテーション以上なので${callText(t.four)}` };
    if (v < 10.5) {
      if (t.sign && h.len[M] >= 6) return { call: t.sign, why: `${JA_SUIT[M]}6枚以上で弱い${h.len[m] <= 1 ? `（パートナーの${JA_SUIT[m]}に1枚以下なので低く評価）` : ''}ので${callText(t.sign)}（サインオフ）` };
      return null;
    }
    if (v >= 13 && m === 'C' && M === 'H') {
      // 1♣-1♥-2♣：GFは2♦からでも2♠からでも示せる。ストッパーがある方、両方あるなら低い方
      const call = !h.stopper('D') && h.stopper('S') ? '2S' : '2D';
      return { call, why: `ゲームの点数がある。GFは2♦でも2♠でも示せるので、${h.stopper('D') && h.stopper('S') ? '両方ストッパーがあるので低い方の2♦' : `ストッパーがある${callText(call)}`}` };
    }
    if (v >= 13 && t.gf) return { call: t.gf, why: `ゲームの点数があるので${callText(t.gf)}（スートに関係ないゲームフォーシング）` };
    if (v >= 13 && t.inv) return { call: t.inv, why: `ゲームの点数があるので、まずインビテーション以上の${callText(t.inv)}（スートに関係ない）から` };
    const X = SUITS.find(x => x !== M && x !== m && h.len[x] >= 5);
    if (h.len[M] >= 5 && X) { const x3 = cheapest(X, c.seq); if (levelOf(x3) === 3 && x3 !== t.gf) return { call: x3, why: `${JA_SUIT[M]}と${JA_SUIT[X]}の5-5以上でインビテーションなので${callText(x3)}` }; }
    if (t.inv) return { call: t.inv, why: `インビテーション以上の点数なので${callText(t.inv)}（スートに関係ないインビテーション以上）` };
    if (h.len[M] >= 6) return { call: '3' + M, why: `${JA_SUIT[M]}6枚以上でインビテーションなので3${SYM[M]}` };
    if (h.len[m] >= 4) return { call: '3' + m, why: `${JA_SUIT[m]}のサポートがありインビテーションなので3${SYM[m]}` };
    return { call: '2N', why: 'インビテーションの点数なので2NT' };
  }, (call, b) => {
    const t = b.t;
    if (call === t.four) return { shows: { [b.O]: [4, 4], hcp: [10.5, 37] }, force: 1 };
    if (call === t.inv) return { shows: { hcp: [10.5, 37] }, force: 1 };
    if (call === t.gf) return { shows: { hcp: [13, 37] }, force: 'GF' };
    if (call === t.sign) return { shows: { [b.M]: [6, 13], hcp: [0, 10.49] } };
    if (isBid(call) && call[0] === '3' && call[1] !== 'N' && call[1] !== b.m && call[1] !== b.M) return { shows: { [b.M]: [5, 13], [call[1]]: [5, 13], hcp: [10.5, 12.99] } };
    return null;
  });
  // 1x-1M-2M-3M（招待）：オープナーは上の方（ダミーポイント13点以上）なら受ける。パートナーがパス済みかどうかは考えない
  R(seq => seq.length === 4 && seq[0][0] === '1' && /^1[HS]$/.test(seq[1]) && seq[2] === '2' + seq[1][1] && seq[3] === '3' + seq[1][1] ? { M: seq[1][1] } : null,
    '4M', (h, c) => h.dp(c.b.M, 4) >= 13, null, (h, c) => `招待に対して上の方（ダミーポイント${fmt(h.dp(c.b.M, 4))}点）なのでゲーム`);
  R(seq => seq.length === 4 && seq[0][0] === '1' && /^1[HS]$/.test(seq[1]) && seq[2] === '2' + seq[1][1] && seq[3] === '3' + seq[1][1] ? { M: seq[1][1] } : null,
    'P', () => true, null, '招待に対して最低点なのでパス');
  // 1m-x-2m-4m：♣のサポートの招待は3mがあるので、4mはスラムトライ（パスできない）
  R(seq => seq.length === 3 && /^1[CD]$/.test(seq[0]) && seq[1][0] === '1' && seq[2] === '2' + seq[0][1] ? { m: seq[0][1] } : null,
    '4m', () => false, (b) => ({ [b.m]: [3, 13], agree: b.m, interest: true }), 'スラムトライ', 'GF');
  // オープナー：インビ以上・GFの人工的なビッドに対して、パートナーのMの3枚サポートを最優先で示す
  RD(seq => {
    if (seq.length !== 4 || !/^1[CD]$/.test(seq[0]) || !/^1[HS]$/.test(seq[1]) || seq[2] !== '2' + seq[0][1]) return null;
    const t = M2[seq[0][1] + ' ' + seq[1][1]];
    return seq[3] === t.inv || seq[3] === t.gf || seq[3] === t.four ? { m: seq[0][1], M: seq[1][1], t } : null;
  }, (h, c) => {
    const { M } = c.b;
    if (h.len[M] >= 3) { const call = cheapest(M, c.seq); return { call, why: `パートナーの${JA_SUIT[M]}に3枚サポートがあるので、フィットの可能性を最優先で示す（${callText(call)}）` }; }
    return null;
  }, (call, b) => isBid(call) && call[1] === b.M ? { shows: { [b.M]: [3, 3] } } : null);
  // フィットが決まった後（ジャンプレイズの後など）、別のスートのビッドはより上を目指す：ノンジャンプの4のレベルはコントロール
  RD(seq => seq.length === 3 && /^1[CDH]$/.test(seq[0]) && /^1[HS]$/.test(seq[1]) && seq[2] === '3' + seq[1][1] ? { M: seq[1][1] } : null, (h, c) => {
    const { M } = c.b;
    // ジャンプレイズ（15〜17）を受けて、合計が29点ぐらいあればコントロールでスラムトライ
    const p = c.partner.hcp;
    if (h.adj + (p[0] + Math.min(p[1], p[0] + 8)) / 2 < 29 || motivation(h, M, c) < 2) return null;
    for (let r = rankOf('3' + M) + 1; r < rankOf('4' + M); r++) {
      const s = STRAINS[r % 5], call = (Math.floor(r / 5) + 1) + s;
      if (s !== 'N' && s !== M && hasControl(h, s, c)) return { call, why: `フィットが決まり、2人の強さを合わせるとスラムの可能性があるので${callText(call)}：${JA_SUIT[s]}のコントロールを示す` };
    }
    return null;
  }, (call, b, before) => isBid(call) && call[1] !== 'N' && call[1] !== b.M && rankOf(call) < rankOf('4' + b.M)
    ? { shows: { agree: b.M, interest: true, ctrl: [call[1]] }, force: 'GF' } : null);
  // 1C-1D のオープナー
  R('1C 1D', '1H', h => !h.balanced && h.len.H >= 4, { H: [4, 13], hcp: [11.5, 17.99] }, 'ハート4枚があるアンバランスハンドなので1♥（3つ目のスート。バランスハンドなら1NT）');
  R('1C 1D', '1S', h => !h.balanced && h.len.S >= 4, { S: [4, 13], H: [0, 3], hcp: [11.5, 17.99] }, 'スペード4枚があるアンバランスハンドなので1♠（3つ目のスート）');
  R('1C 1D', '1N', h => h.balanced && h.hcp < 15, { hcp: [11.5, 14.99], bal: true }, 'バランスハンドの最低点なので1NT');
  R('1C 1D', '2N', h => h.balanced && between(h.hcp, 18, 19), { hcp: [18, 19], bal: true }, 'バランスハンド18〜19点なので2NT');
  R('1C 1D', '2D', h => h.len.D >= 4, { D: [4, 13] }, 'ダイヤ4枚以上のサポートがあるので2♦');
  R('1C 1D', '2C', h => h.len.C >= 6, { C: [6, 13] }, 'クラブ6枚以上なので2♣（2mのリビッドは6枚以上）');
  R('1C 1D', '1N', () => true, null, 'ほかに適当なビッドがないので1NT');
  // 1m-1NT, 1m-2NT, 1m-3NT, 1m-3m
  R('1C 1N', '2C', h => h.len.C >= 4 && h.adj < 18, null, 'パートナーは♣4枚以上を持っているので、1NTより2♣の方がプレイしやすい');
  R('1D 1N', '3C', h => h.len.C >= 4 && h.adj >= 18, { C: [4, 13], hcp: [18, 21] }, '18点以上でクラブ4枚以上なのでジャンプシフト（ゲームフォーシング）', 'GF');
  R('1m 1N', '3N', (h, c) => h.len[c.b.m] >= 7 && h.top5(c.b.m) >= 4 && h.adj >= 16, null, '長く強いマイナーがトリックになるので3NTをプレイしたい');
  R('1m 1N', 'P', h => h.balanced && h.hcp < 15, null, 'バランスハンドの最低点なのでパス');
  R('1m 1N', '3N', h => h.balanced && h.hcp >= 18, null, 'バランスハンド18〜19点。1m-1NTの後だけは2NTでなく3NT');
  R('1m 1N', '3N', (h, c) => h.len[c.b.m] >= 6 && h.rebidPts(c.b.m) >= 18, null, 'マイナー6枚以上で18点以上なので3NT');
  R('1m 1N', '3m', (h, c) => h.len[c.b.m] >= 6 && h.rebidPts(c.b.m) >= 15.5, null, 'マイナー6枚以上・強い15〜17点なので3マイナー');
  R('1C 1N 2C', 'P', () => true, null, 'オープナーが♣でのプレイを選んだのでパス');
  R('1D 1N 2C 2N', '3N', h => h.adj >= 16, null, '強いので招待を受けて3NT');
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

  // ===== オープナーの2回目：1stスーツより低いランクのニュースートとリバース =====
  //   ランク：♣<♦<♥<♠
  //   低いランクのニュースート：ノンジャンプ＝15点まで（強い15〜17は3回目に招待）、ジャンプ＝18点以上（GF）
  //   高いランクのニュースート（2のレベル）＝リバース：16点以上
  const RANK = s => 'CDHS'.indexOf(s);
  // [1A, 1B(スートか1NT), 2Z]：Zが1stスーツより低いランクのノンジャンプ
  function lowSuitSeq(seq) {
    if (seq.length !== 3 || !seq.every(isBid)) return null;
    const [o1, r1, o2] = seq;
    if (o1[0] !== '1' || r1[0] !== '1' || o2[0] !== '2') return null;
    const A = o1[1], B = r1[1], Z = o2[1];
    if (A === 'N' || Z === 'N' || Z === A || Z === B || RANK(Z) >= RANK(A)) return null;
    if (o2 !== cheapest(Z, [o1, r1])) return null;
    return { A, B, Z };
  }
  // [1A, 1B(スート), 2Z]：Zが1stスーツより高いランクのノンジャンプ（リバース）
  function revSeq(seq) {
    if (seq.length !== 3 || !seq.every(isBid)) return null;
    const [o1, r1, o2] = seq;
    if (o1[0] !== '1' || r1[0] !== '1' || o2[0] !== '2') return null;
    const A = o1[1], B = r1[1], Z = o2[1];
    if (A === 'N' || Z === 'N' || new Set([A, B, Z]).size !== 3 || RANK(Z) <= RANK(A)) return null;
    if (o2 !== cheapest(Z, [o1, r1])) return null;
    // W：アンビッドスート（1NT応答の後で2つあるときは低い方）
    const unbid = SUITS.filter(s => ![A, B, Z].includes(s)).sort((x, y) => RANK(x) - RANK(y));
    const W = unbid[0];
    const wCall = cheapest(W, seq);
    const lowRelay = rankOf(wCall) < rankOf('2N') ? wCall : '2N';
    const highRelay = lowRelay === '2N' ? wCall : '2N';
    return { A, B, Z, W, unbid, lowRelay, highRelay };
  }
  // [1A, 1B(スート), 3Z]：低いランクのニュースートへのジャンプ（18点以上、GF）
  function jumpShiftSeq(seq) {
    if (seq.length !== 3 || !seq.every(isBid)) return null;
    const [o1, r1, o2] = seq;
    if (o1[0] !== '1' || r1[0] !== '1' || o2[0] !== '3') return null;
    const A = o1[1], B = r1[1], Z = o2[1];
    if ([A, B, Z].includes('N') || new Set([A, B, Z]).size !== 3 || RANK(Z) >= RANK(A)) return null;
    if (levelOf(cheapest(Z, [o1, r1])) !== 2) return null;
    return { A, B, Z, W: SUITS.find(s => ![A, B, Z].includes(s)) };
  }
  const ext = (base, n, tail) => seq => {
    if (seq.length !== n + tail.length) return null;
    const b = base(seq.slice(0, n));
    if (!b) return null;
    for (let i = 0; i < tail.length; i++) {
      const t = tail[i], c = seq[n + i];
      if (typeof t === 'function' ? !t(c, b) : (t !== '*' && t !== c)) return null;
    }
    return b;
  };

  // --- 低いランクのニュースートの後：オープナーの3回目（強い15〜17点は招待） ---
  RD(ext(lowSuitSeq, 3, [(c, b) => isBid(c) && levelOf(c) === 2 && (c[1] === b.A || c[1] === b.B) && c !== '2N']), (h, c) => {
    const { A, B } = c.b, r = c.seq[3];
    // パートナーが自分のスートをリビッドしたとき、3枚以上あればダミーポイントで数える
    const fitB = r[1] === B && B !== 'N' && h.len[B] >= 3;
    const v = fitB ? h.dp(B, c.partner[B][0]) : h.adj;
    if (fitB && isMaj(B) && v >= 18) return { call: '4' + B, why: `パートナーの${JA_SUIT[B]}に3枚以上あり、ダミーポイント${fmt(v)}点なのでゲーム` };
    if (v < 15.5) return { call: 'P', why: '2回目のノンジャンプのニュースートは15点までで、こちらは弱い方なのでパス' };
    if (v >= 18) return null;
    if (r[1] === A) {
      // 1stスーツに戻されたとき：a. 1Mレスポンスに3枚 → 2M ／ b. 1stスーツ6枚 → 3にレイズ ／
      //   c. アンビッドスートに1つ以上ストッパー → 2NT ／ d. アンビッドスート（2つなら低い方）
      const s = c.seq, unbid = SUITS.filter(x => x !== A && x !== B && x !== c.b.Z).sort((x, y) => RANK(x) - RANK(y));
      if (isMaj(B) && h.len[B] === 3 && legal(cheapest(B, s), s) && levelOf(cheapest(B, s)) === 2)
        return { call: cheapest(B, s), why: `強い15〜17点。パートナーの${JA_SUIT[B]}に3枚あるので${callText(cheapest(B, s))}` };
      if (h.len[A] >= 6) return { call: '3' + A, why: `強い15〜17点で${JA_SUIT[A]}6枚以上なので3${SYM[A]}に上げて招待` };
      if (unbid.some(x => h.stopper(x)) && legal('2N', s)) return { call: '2N', why: `強い15〜17点で、アンビッドスートにストッパーがあるので2NTで招待` };
      const u = cheapest(unbid[0], s);
      return { call: u, why: `強い15〜17点。アンビッドスートにストッパーがないので${callText(u)}（アンビッドスート${unbid.length > 1 ? 'の低い方' : ''}）` };
    }
    if (h.len[B] >= 2) return { call: '3' + B, why: `強い15〜17点で、パートナーの${JA_SUIT[B]}に2枚以上あるので3${SYM[B]}で招待` };
    return { call: '2N', why: '強い15〜17点なので2NTで招待' };
  }, (call, b, before) => {
    if (call === '3' + b.A || call === '3' + b.B || call === '2N') return { shows: { hcp: [15.5, 17.99] } };
    if (call === 'P') return { shows: { hcp: [11.5, 15.49] } };
    if (isBid(call) && call[1] === b.B) return { shows: { hcp: [15.5, 17.99], [b.B]: [3, 3] } };
    if (isBid(call) && call[1] !== b.A && call[1] !== b.Z && call[1] !== 'N') return { shows: { hcp: [15.5, 17.99] } };
    return null;
  });

  // --- ジャンプ（18点以上・GF）の後のレスポンダー ---
  RD(jumpShiftSeq, (h, c) => {
    const { A, B, Z, W } = c.b, s = c.seq;
    if (h.len[A] >= 3) return { call: cheapest(A, s), why: `${JA_SUIT[A]}（オープナーの1stスーツ）に3枚以上のサポートがあるので3のレベルで示す` };
    if (h.len[B] >= 5) return { call: cheapest(B, s), why: `${JA_SUIT[B]}が5枚以上あるのでリビッド` };
    if (h.stopper(W)) return { call: '3N', why: `${JA_SUIT[W]}（アンビッドスート）にストッパーがあるので3NT` };
    if (h.len[Z] >= 4 && rankOf(cheapest(Z, s)) < rankOf('3N')) return { call: cheapest(Z, s), why: `${JA_SUIT[Z]}に4枚以上のサポートがあるのでレイズ` };
    const w = cheapest(W, s);
    if (rankOf(w) < rankOf('3N')) return { call: w, why: `3NTを目指しているが、${JA_SUIT[W]}のストッパーがなくて困っているので${callText(w)}（ストッパーアスキング）` };
    return { call: '3N', why: 'ほかに示すものがないので3NT' };
  }, (call, b) => {
    if (!isBid(call)) return null;
    const t = call[1];
    if (t === b.A) return { shows: { [b.A]: [3, 13], agree: b.A } };
    if (t === b.B) return { shows: { [b.B]: [5, 13] } };
    if (t === b.Z) return { shows: { [b.Z]: [4, 13], agree: b.Z } };
    if (call === '3N') return { shows: { stop: [b.W] } };
    if (t === b.W) return { shows: {} };
    return null;
  });
  RD(ext(jumpShiftSeq, 3, [(c, b) => isBid(c) && c[1] === b.W]), (h, c) => {
    const { W } = c.b;
    if (h.stopper(W)) return { call: cheapest('N', c.seq), why: `パートナーは${JA_SUIT[W]}のストッパーを聞いている。ストッパーがあるのでNT` };
    return null;
  }, (call, b) => call[1] === 'N' ? { shows: { stop: [b.W] } } : null);

  // --- リバースの後のレスポンダー ---
  //   1stスーツ＝3枚以上サポートFG ／ 2ndスーツのレイズ＝4枚以上サポートFG ／ 自分の1stスーツ＝5枚以上・8点以下
  //   2NTと4つ目のスートのうち低い方＝8点以下、高い方＝強い8点以上（GF）
  RD(revSeq, (h, c) => {
    const { A, B, Z, W, lowRelay, highRelay } = c.b, s = c.seq;
    if (B === 'N') {
      // 1NT応答の後のリバース：アンビッドの低い方と2NTのうち低い方＝GFでない、高い方＝GF。
      //   ノンジャンプで3のレベルのニュースート＝5枚以上GF
      if (h.adj < 8.5) return { call: lowRelay, why: `8点以下なので、2NTと${JA_SUIT[W]}のうち低い方の${callText(lowRelay)}（ゲームフォーシングでない）` };
      const five = c.b.unbid.find(x => h.len[x] >= 5 && levelOf(cheapest(x, s)) === 3 && cheapest(x, s) !== highRelay && cheapest(x, s) !== lowRelay);
      if (five) return { call: cheapest(five, s), why: `${JA_SUIT[five]}5枚以上なので3のレベルのニュースート（ゲームフォーシング）` };
      return { call: highRelay, why: `強い8点以上なので、2NTと${JA_SUIT[W]}のうち高い方の${callText(highRelay)}（ゲームフォーシング）` };
    }
    if (h.adj < 8.5) {
      if (h.len[B] >= 5) return { call: cheapest(B, s), why: `${JA_SUIT[B]}5枚以上で8点以下なのでリビッド` };
      return { call: lowRelay, why: `8点以下なので、2NTと${JA_SUIT[W]}のうち低い方の${callText(lowRelay)}` };
    }
    if (h.len[A] >= 3) return { call: cheapest(A, s), why: `${JA_SUIT[A]}（オープナーの1stスーツ）に3枚以上のサポートがあり、強い8点以上なのでゲームフォーシング` };
    if (h.len[Z] >= 4) return { call: cheapest(Z, s), why: `${JA_SUIT[Z]}（オープナーの2ndスーツ）に4枚以上のサポートがあるのでレイズ（ゲームフォーシング）` };
    return { call: highRelay, why: `強い8点以上なので、2NTと${JA_SUIT[W]}のうち高い方の${callText(highRelay)}（ゲームフォーシング）` };
  }, (call, b) => {
    if (!isBid(call)) return null;
    if (call === b.lowRelay) return { shows: { hcp: [0, 8.49] }, force: 1 };
    if (call === b.highRelay) return { shows: { hcp: [8.5, 37] }, force: 'GF' };
    if (b.B === 'N') return b.unbid.includes(call[1]) && levelOf(call) === 3 ? { shows: { [call[1]]: [5, 13], hcp: [8.5, 37] }, force: 'GF' } : null;
    if (call[1] === b.B) return { shows: { [b.B]: [5, 13], hcp: [0, 8.49] }, force: 1 };
    if (call[1] === b.A) return { shows: { [b.A]: [3, 13], hcp: [8.5, 37], agree: b.A }, force: 'GF' };
    if (call[1] === b.Z) return { shows: { [b.Z]: [4, 13], hcp: [8.5, 37], agree: b.Z }, force: 'GF' };
    return null;
  });
  // --- リバースの後のオープナーの3回目（レスポンダーの答えはパスできない） ---
  RD(ext(revSeq, 3, ['*']), (h, c) => {
    const { A, B, Z, W, lowRelay, highRelay } = c.b, s = c.seq, r = s[3];
    const weak = r === lowRelay || (isBid(r) && r[1] === B);
    const unbidStopped = c.b.unbid.every(x => h.stopper(x));
    if (weak) {
      const partnerFive = isBid(r) && r[1] === B && B !== 'N';
      if (h.adj < 18) {
        if (partnerFive && h.len[B] >= 3) return { call: cheapest(B, s), why: `パートナーは${JA_SUIT[B]}5枚以上で8点以下。18点ないので${JA_SUIT[B]}をレイズ` };
        if (h.len[A] < 6 && legal('2N', s)) return { call: '2N', why: 'パートナーは8点以下。18点ないので2NT' };
        const a3 = cheapest(A, s);
        return { call: a3, why: `パートナーは8点以下。18点ないので${callText(a3)}（3のレベルの1stスーツ）` };
      }
      if (partnerFive && h.len[B] >= 3 && isMaj(B)) return { call: '4' + B, why: `パートナーは${JA_SUIT[B]}5枚以上。18点以上あるのでゲーム` };
      if (unbidStopped) return { call: '3N', why: `18点以上あり、アンビッドスートにストッパーがあるので3NT` };
      const z3 = cheapest(Z, s);
      return { call: z3, why: `18点以上あるので${callText(z3)}（ゲームフォーシング）` };
    }
    if (r === highRelay) {
      if (unbidStopped) return { call: cheapest('N', s), why: `パートナーは強い8点以上（GF）。アンビッドスートにストッパーがあるのでNT` };
      if (B !== 'N' && h.len[B] >= 3) return { call: cheapest(B, s), why: `パートナーは強い8点以上（GF）。${JA_SUIT[W]}のストッパーはないが、${JA_SUIT[B]}に3枚あるので示す` };
      if (h.len[A] >= 6) return { call: cheapest(A, s), why: `パートナーは強い8点以上（GF）。${JA_SUIT[A]}6枚以上` };
      if (h.len[Z] >= 5) return { call: cheapest(Z, s), why: `パートナーは強い8点以上（GF）。${JA_SUIT[Z]}5枚以上` };
      const w = cheapest(W, s);
      if (rankOf(w) < rankOf('3N')) return { call: w, why: `パートナーは強い8点以上（GF）。${JA_SUIT[W]}のストッパーがないので${callText(w)}（ストッパーアスキング）` };
    }
    return null;
  }, (call, b, before) => {
    const r = before[3], weak = r === b.lowRelay || (isBid(r) && r[1] === b.B && b.B !== 'N');
    if (!isBid(call)) return null;
    if (weak) {
      if (call === '2N' || call === cheapest(b.A, before) || (call === cheapest(b.B, before) && levelOf(call) <= 3)) return { shows: { hcp: [16, 17.99] } };
      return { shows: { hcp: [18, 21.99] }, force: 'GF' };
    }
    if (r === b.highRelay) {
      if (call[1] === 'N') return { shows: { stop: [b.W] } };
      if (call[1] === b.B) return { shows: { [b.B]: [3, 3] } };
      return { shows: {} };
    }
    return null;
  });
  RD(ext(revSeq, 3, ['*', '*']), (h, c) => !c.gf && !c.forcing ? { call: 'P', why: 'オープナーは18点ないことを示したので、弱いこちらはパス' } : null, () => null);

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
    if (!ask3 && !slam && h.stopper(W)) {
      if (gf) { const nt = gfNT(h, c.seq); return { call: nt, why: `${JA_SUIT[W]}（4つ目のスート）にストッパーがあり、ほかに聞きたいこともない。GFなので${nt === '3N' ? 'ジャンプの3NT＝15〜17点' : '2NT＝12〜14点（18点以上も2NTから）'}` }; }
      return { call: '3N', why: `${JA_SUIT[W]}（4つ目のスート）にストッパーがあり、ほかに聞きたいこともないので3NTに直行` };
    }
    // GFでスラムの可能性があるとき：3NT（15〜17）か4つ目のスートかを手で使い分ける
    //   3NT：自分の1stスーツが4枚（5枚ならAKQのうち1枚以下）で、パートナーのスートが2枚以下（メジャーなら1枚以下）
    if (gf && slam && !ask3 && legal('2N', c.seq)) {
      const myOk = h.len[Y] === 4 || (h.len[Y] === 5 && h.top3(Y) <= 1);
      const pOk = [X, Z].every(s => h.len[s] <= (isMaj(s) ? 1 : 2));
      if (myOk && pOk) return { call: '3N', why: `スラムの可能性がある。自分の${JA_SUIT[Y]}が${h.len[Y]}枚${h.len[Y] === 5 ? '（AKQは1枚以下）' : ''}で、パートナーのスートが短いので、4つ目のスートでなくジャンプの3NT（15〜17点）` };
    }
    const need = [!h.stopper(W) && `${JA_SUIT[W]}のストッパー`, ask3 && `${JA_SUIT[Y]}の3枚サポート`, slam && 'スラムの可能性'].filter(Boolean).join('・');
    return { call: fsf, why: `ゲームの点数があり、${need}を知りたいのでフォース・スート（${callText(fsf)}：4つ目のスート、ゲームフォーシング）` };
  }, (call, b, before) => {
    if (call === b.fsf) return { shows: { hcp: [13, 37] }, force: 'GF' };
    if (!b.gf && isBid(call) && call[1] === b.Z && levelOf(call) <= 3) return { shows: { [b.Z]: [4, 13] } };
    if (!b.gf && isBid(call) && call[1] === b.Y && levelOf(call) <= 3) return { shows: { [b.Y]: [6, 13] } };
    if (call === '3N') return { shows: { hcp: b.gf && legal('2N', before) ? [15, 17.99] : [13, 37], stop: [b.W] } };
    if (b.gf && call === '2N') return { shows: { stop: [b.W] } };
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
      const nt = gfNT(h, c.seq);
      return { call: nt, why: `メジャーのフィットがなく、${JA_SUIT[W]}にストッパーがある（${a === 'N' ? 'オープナーが示した' : '自分が持っている'}）。GFなので${nt === '3N' ? 'ジャンプの3NT＝15〜17点' : 'NT（2NT＝12〜14点、18点以上も2NTから）'}` };
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
    // 6枚以上の1スーターは、パートナーの平均2.5枚と合わせてショートを加点して判断
    const slam1 = h.len[Y] >= 6 && h.dpLong(Y, 2.5) + (c.partner.hcp[0] + Math.min(c.partner.hcp[1], c.partner.hcp[0] + 8)) / 2 >= 31;
    if ((slam || slam1) && h.len[Y] >= 6 && !others.some(s => h.len[s] >= 5))
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
    if (h.len.D >= 6 && h.adj < 8) return { call: '2C', why: 'ダイヤ6枚以上でとても弱いので、2♣（2♦を強制）を使って2♦で止める' };
    const O = Y === 'S' ? 'H' : null; // ♠5枚・♥4枚以上の弱い手の2♥（低いランクへ下りるサインオフ）
    if (O && h.len[Y] >= 5 && h.len[O] >= 4 && legal('2' + O, c.seq)) return { call: '2' + O, why: `${JA_SUIT[Y]}5枚・${JA_SUIT[O]}4枚以上の弱い手なので2${SYM[O]}（5-4以上のサインオフ）` };
    if (h.len[Y] >= 6 && Y !== 'D') return { call: '2' + Y, why: `${JA_SUIT[Y]}6枚以上で弱いので2${SYM[Y]}で止める` };
    return { call: 'P', why: 'ゲームの可能性がないのでパス' };
  }, (call, b) => {
    if (call === '2C') return { shows: { hcp: [0, 12.99] }, force: 1 };
    if (call === '2D') return { shows: { hcp: [13, 37] }, force: 'GF' };
    if (call === '3' + b.Y) return { shows: { [b.Y]: [6, 13], hcp: [17, 37], agree: b.Y, interest: true }, force: 'GF' };
    if (isBid(call) && call[0] === '3' && call[1] !== b.X && call[1] !== 'N') return { shows: { [b.Y]: [5, 13], [call[1]]: [5, 13], hcp: [17, 37] }, force: 'GF' };
    if (call === '2' + b.Y) return { shows: { [b.Y]: [6, 13], hcp: [0, 10.99] } };
    return null;
  });
  R(seq => seq.length === 4 && nt1Seq(seq.slice(0, 3)) && (seq[3] === '2' + seq[1][1] && seq[1][1] !== 'D' || (seq[1] === '1S' && seq[3] === '2H')) ? {} : null,
    'P', () => true, null, 'レスポンダーのサインオフ（インビテーションの強さはない）なのでパス');
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
  R('2M', '4M', (h, c) => h.len[c.b.M] >= 3 && h.dp(c.b.M, 6) >= 14, null, 'サポートがありゲームの点数があるので4メジャー');
  R('2X', '4X', (h, c) => c.b.X !== 'C' && h.len[c.b.X] >= 4, null, 'サポート4枚以上で10枚フィットなので4のレベルにレイズ（プリエンプティブ）');
  R('2X', '3X', (h, c) => c.b.X !== 'C' && h.len[c.b.X] >= 3, null, 'サポート3枚で9枚フィットなので3のレベルにレイズ（プリエンプティブ）');
  R('2X', 'P', () => true, null, 'ゲームの可能性が低いのでパス');
  const ogMax = h => h.adjNoLen >= 8; // ウィーク2は6枚が前提なので、6枚目の加点は入れない
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
    if (X === 'D') R('2D 4D', 'P', () => true, null, 'プリエンプティブ・レイズなのでパス');
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
  // 実際のオークション全体で合法か（敵のビッドも含める。ダブルは直前の敵のビッドに対してだけ）
  function legalInAuction(call, auction, dealer) {
    if (call === 'P') return true;
    const d = SEATS.indexOf(dealer);
    const bids = auction.filter(isBid);
    const lb = bids.length ? bids[bids.length - 1] : null;
    if (call === 'X' || call === 'XX') {
      let i = auction.length - 1; while (i >= 0 && auction[i] === 'P') i--;
      if (i < 0) return false;
      if (call === 'X' ? !isBid(auction[i]) : auction[i] !== 'X') return false;
      const seatOf = j => SEATS[(d + j) % 4], me = seatOf(auction.length);
      const sameSide = (a, b) => ((SEATS.indexOf(a) - SEATS.indexOf(b)) % 2 === 0);
      return !sameSide(seatOf(i), me);
    }
    return isBid(call) && (!lb || rankOf(call) > rankOf(lb));
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
    if (COMP_OPP && seqBefore.length >= 1) {
      const x = COMP.interp(seqBefore, call, COMP_OPP);
      if (x) return { shows: x.shows || null, force: x.force || 0, rule: null };
    }
    if (seqBefore[0] === '1N') {
      const x = NT1.interp(seqBefore.slice(1), call);
      if (x) return { shows: x.shows || null, force: x.force || 0, rule: null };
    }
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
    if (isBid(call) && call[1] !== 'N' && ctx.gf && rankOf(call) < rankOf('3N')) {
      // GFでのアンビッドスート：2スートしか出ていなければストッパーショーイング、3スートならストッパーアスキング
      const bid = new Set(seqBefore.filter(c => isBid(c) && c[1] !== 'N').map(c => c[1]));
      if (!bid.has(call[1])) {
        const unbid = SUITS.filter(x => !bid.has(x));
        if (unbid.length === 2) return { shows: { stop: [call[1]] }, force: 0, rule: null };
        if (unbid.length === 1) return { shows: {}, force: 0, rule: null };
      }
    }
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
      if (slam.active) {
        // 1M-GFのレイズ-ノンジャンプのニュースート＝ショート
        if (i === 2 && /^1[HS]$/.test(seq[0]) && GF_RAISE(seq[0][1]).includes(seq[1]) && isBid(seq[2]) && seq[2][1] !== 'N' && seq[2][1] !== seq[0][1] && seq[2] === cheapest(seq[2][1], seq.slice(0, 2))) {
          know[me][seq[2][1]] = [know[me][seq[2][1]][0], 1];
          slam.splShort = seq[2][1]; slam.splBy = me;
        }
        slamInterpret(slam, seq.slice(0, i), seq[i], me); forcing = false; continue;
      }
      const r = interpret(seq.slice(0, i), seq[i], { self: know[me], partner: know[1 - me], gf });
      // ルールにない4NT：直前のパートナーのスートのビッド（3の代以上）を切り札にしたRKCB
      if (seq[i] === '4N' && !r.rule && i >= 1 && isBid(seq[i - 1]) && seq[i - 1][1] !== 'N' && levelOf(seq[i - 1]) >= 3) {
        Object.assign(slam, { T: seq[i - 1][1], active: true, agreeIdx: i, rk: { asker: me } });
        gf = true; forcing = false;
        continue;
      }
      merge(know[me], r.shows);
      const passedResp = respPassed && i === 1 && isBid(seq[i]) && levelOf(seq[i]) <= 2; // パス済みの2のレベル以下の応答はフォーシングでない
      if (passedResp) know[1].hcp = [Math.min(know[1].hcp[0], 9.5), 11.49];
      if (r.force === 'GF' && !passedResp) gf = true;
      forcing = !!r.force && !passedResp;
      const sh = r.shows;
      if (sh && sh.agree && gf) {
        Object.assign(slam, { T: sh.agree, active: true, agreeIdx: i });
        if (sh.rk) slam.rk = { asker: me };
        if (sh.interest) slam.interest[me]++;
        if (sh.ctrl) { slam.ctrl[me].push(...sh.ctrl); if (!sh.cue) { slam.splShort = sh.ctrl[0]; slam.splBy = me; } } // cue＝A・Kのコントロール（ショートではない）
        // 示したやる気：3Mなど＝1、スラムトライのスプリンター・コントロール＝それまでに示したやる気+2
        if (sh.interest) slam.shown[me] = sh.ctrl ? slam.shown[me] + 2 : Math.max(slam.shown[me], 1);
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
  // パートナーのスートのショートは加点しない
  function strengthFor(h, T, c) {
    let v = h.dp(T, c.partner[T][0]);
    const base = h.dpBonus(T, c.partner[T][0]) > 0;
    if (base) for (const s of SUITS) if (s !== T && c.partner[s][0] >= 3 && h.len[s] <= 1) {
      const t = h.dp(T, c.partner[T][0]) - h.adj; // ショートの点の目安を戻す
      v -= h.len[s] === 0 ? Math.min(t, 3) : Math.min(t, 1);
    }
    return v;
  }
  // スラムに有効な点数：次の点数は数えない
  //   パートナーのスートでない：シングルトンのK、2枚以下のスートのQ、A・K・Qと一緒でない単独のJ
  //   パートナーが1枚以下と示したスート：K・Q・Jすべて
  function slamUsefulHcp(h, c) {
    let t = 0;
    for (const s of SUITS) {
      const x = h.hand[s], n = x.length;
      const pSuit = c && c.partner && c.partner[s][0] >= 3;
      const pShort = c && c.partner && c.partner[s][1] <= 1;
      for (const card of x) {
        const v = HCP[card] || 0;
        if (!v) continue;
        if (pShort && card !== 'A') continue;
        if (!pSuit) {
          if (card === 'K' && n === 1) continue;
          if (card === 'Q' && n <= 2) continue;
          if (card === 'J' && !/[AKQ]/.test(x)) continue;
        }
        t += v;
      }
    }
    return t;
  }
  function motivation(h, T, c) {
    const spare = Math.max(0, Math.floor((strengthFor(h, T, c) - c.self.hcp[0]) / 2));
    const m = keycards(h, T) + spare;
    return slamUsefulHcp(h, c) < 11 ? Math.max(0, m - 1) : m; // 有効な点数が11点未満ならやる気-1
  }
  // パートナーの推定点数の中央と合わせて31点以上ならスラムの可能性あり
  // スラムの可能性：パートナーの強い方（下限＋6点まで）を想定して、合計32点以上になりうるか
  //   （下限11.5〜上限14点という想定はインビテーションの判断だけに使う）
  function slamPossible(h, c) {
    const p = c.partner.hcp;
    return h.adj + Math.min(p[1], p[0] + 6) >= 32;
  }
  // FGでフィットを示す：やる気があれば安く（3Mなど）、なければゲーム
  function agreeCall(h, c, T) {
    const g = gameCall(T), ch = cheapest(T, c.seq);
    if (ch && rankOf(ch) < rankOf(g) && motivation(h, T, c) >= 1) return ch;
    return legal(g, c.seq) ? g : ch;
  }
  // GFの局面でのNT：2NT＝12〜14（18点以上も2NTから4NT）、ジャンプの3NT＝15〜17
  function gfNT(h, seq) {
    if (!legal('2N', seq)) return '3N';
    return h.adj >= 15 && h.adj < 18 ? '3N' : '2N';
  }
  function hasControl(h, s, c) {
    if (h.hand[s].includes('A') || h.hand[s].includes('K')) return true;
    return h.len[s] <= 1 && !(c && c.partner && c.partner[s][0] >= 3); // パートナーのスートのショートはコントロールにしない
  }
  function freshSlam() {
    return { T: null, active: false, interest: [0, 0], shown: [0, 0], ctrl: [[], []], deny: [[], []], rk: null, ntSign: false, agreeIdx: -1, splShort: null };
  }
  // フィットが決まった後のビッドの意味を記録する
  function slamInterpret(st, before, call, me) {
    if (call === 'P') return;
    const T = st.T, G = gameCall(T);
    if (st.rk && st.rk.asker !== me && !st.rk.resp) { st.rk.resp = call; return; }
    if (st.rk && st.rk.resp && st.rk.asker === me && !st.rk.placed) { st.rk.placed = call; return; }
    if (call === '4N') { st.rk = { asker: me }; return; }
    if (call[1] === 'N') { st.ntSign = true; return; }
    if (call[1] === T) { if (rankOf(call) < rankOf(G)) { st.interest[me]++; st.shown[me] = Math.max(st.shown[me], 1); } return; }
    if (rankOf(call) < rankOf(G)) {
      st.interest[me]++;
      st.shown[me] += 2; // コントロール紹介1回あたり、それまでより2多いやる気を示す
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
    // 自分がスラムトライ（ショート・コントロール）をした後、パートナーがゲームで止めたら従う（合計33点以上確実なら3回目以降の見直しで続ける）
    if (seq[seq.length - 1] === G && st.interest[me] > 0) return P(`スラムトライに対してパートナーが${callText(G)}で止めたのでパス`);
    // マイナーのスプリンターに対して、ショートのスートに点が多いなら3NT
    if (!isMaj(T) && st.splShort && seq.length === st.agreeIdx + 1 && h.sHcp[st.splShort] >= 3 && h.stopper(st.splShort) && legal('3N', seq))
      return { call: '3N', why: `パートナーのショートの${JA_SUIT[st.splShort]}に点がある（無駄になりやすい）のでノートランプを選ぶ` };
    const mot = motivation(h, T, c);
    // パートナーのやる気：これまでのビッドで示した分（3Mなど＝1、コントロール1回ごとに+2）
    const pMot = st.shown[pa];
    const side = SUITS.filter(s => s !== T);
    const covered = side.every(s => hasControl(h, s, c) || st.ctrl[pa].includes(s));
    const hole = side.find(s => !hasControl(h, s, c) && st.deny[pa].includes(s));
    const motTxt = `自分のやる気${mot}・パートナーのやる気${pMot}以上`;
    if (covered && mot + pMot >= 7) {
      if (legal('4N', seq)) return { call: '4N', why: `全スートにコントロールがあり、2人のやる気の合計が7以上（${motTxt}）なので4NT（RKCB：キーカードを聞く）` };
      const six = '6' + T;
      if (legal(six, seq)) return { call: six, why: `全スートにコントロールがあり、やる気も十分（${motTxt}）だが4NTが使えないので${callText(six)}` };
    }
    const signoff = why => legal(G, seq) ? { call: G, why } : P(why.replace(/[^、]*で止める$/, 'パス'));
    if (hole) return signoff(`${JA_SUIT[hole]}に2人ともコントロールがないと分かったので${callText(G)}で止める`);
    if (mot === 0) return signoff(`スラムへのやる気がない（${motTxt}）ので${callText(G)}で止める`);
    const ch = cheapest(T, seq);
    if (isMaj(T) && st.interest[0] + st.interest[1] === 0 && ch && rankOf(ch) < rankOf(G))
      return { call: ch, why: `スラムに興味がある（${motTxt}）ので${callText(ch)}（フィットを確かめてスラムに興味を示す）` };
    // コントロール紹介は、自分がそれまでに示したやる気より2多いやる気が必要
    const need = st.shown[me] + 2;
    if (mot < need) return signoff(`コントロールを示すにはやる気${need}以上が必要（すでにやる気${st.shown[me]}以上を示している。${motTxt}）なので${callText(G)}で止める`);
    for (let r = lb ? rankOf(lb) + 1 : 0; r < rankOf(G); r++) {
      const s = STRAINS[r % 5], call = (Math.floor(r / 5) + 1) + s;
      if (s === 'N' || s === T || st.ctrl[me].includes(s)) continue;
      if (hasControl(h, s, c)) return { call, why: `スラムに興味がある（${motTxt}）ので${callText(call)}：${JA_SUIT[s]}のコントロール（A・K・ショートのどれか）を示す` };
    }
    return signoff(`ゲームより下でコントロールを示せるビッドがないので${callText(G)}で止める`);
  }

  // ------------------------------------------------------------------
  // 汎用判断（ルール表にない流れ）
  // ------------------------------------------------------------------
  function fallback(h, seq, ctx) {
    const p = ctx.partner, self = ctx.self;
    // オープンしたパートナーの下限が11.5なら上限は14点と考える（強ければオープナーが招待する）
    const pMin = p.hcp[0], pMax = Math.min(p.hcp[1], p.hcp[0] + 10, pMin === 11.5 ? 14.99 : 99);
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

    // ストッパー（Mのフィットがないと分かったGF）：
    //   3スートが出ている → 4つ目のスートのストッパーがあればNT、なければそのスート（ストッパーアスキング）
    //   2スートが出ている → アンビッドスートの両方が止まればNT、でなければ内容の良い方（ストッパーショーイング）
    if (ctx.gf && !major && totMin < 33 && lb && rankOf(lb) < rankOf('3N')) {
      const bidS = new Set(seq.filter(c => isBid(c) && c[1] !== 'N').map(c => c[1]));
      const unbid = SUITS.filter(s => !bidS.has(s));
      const stopped = s => h.stopper(s) || p.stop.includes(s);
      const nt = gfNT(h, seq);
      if (unbid.length === 1) {
        const W = unbid[0];
        if (stopped(W)) return { call: nt, why: `${JA_SUIT[W]}（4つ目のスート）のストッパーが${h.stopper(W) ? 'ある' : 'パートナーにある'}のでNT（${notes.join('、')}）` };
        const w = cheapest(W, seq);
        if (rankOf(w) < rankOf('3N')) return { call: w, why: `${JA_SUIT[W]}（4つ目のスート）のストッパーがないので${callText(w)}（ストッパーアスキング）` };
      } else if (unbid.length === 2) {
        if (unbid.every(stopped)) return { call: nt, why: `アンビッドスート（${unbid.map(s => JA_SUIT[s]).join('・')}）が両方止まっているのでNT` };
        const cand = unbid.filter(s => !p.stop.includes(s)).sort((a, b) => (h.stopper(b) - h.stopper(a)) || (h.sHcp[b] - h.sHcp[a]))
          .map(s => cheapest(s, seq)).filter(c => c && rankOf(c) < rankOf('3N'));
        if (cand.length) return { call: cand[0], why: `アンビッドスートのうち内容の良い${JA_SUIT[cand[0][1]]}をビッド（ストッパーショーイング）` };
      }
    }
    // GFで2NT（18点以上を含む）と言った後、パートナーが3NTなら、18点以上は4NT（6NTへの招待）
    if (ctx.gf && !major && lb === '3N' && seq.length >= 3 && seq[seq.length - 2] === '2N' && h.adj >= 18)
      return { call: '4N', why: '18点以上なので、2NTの後に4NTで6NTへ招待（GFで2NT＝12〜14、3NT＝15〜17、18以上は2NTから4NT）' };
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
    // プリファレンス：パートナーの最後のスートより前のスートの方が長ければ、同じレベルで戻す
    if (!mustBid && lb && lb[1] !== 'N' && seq.length >= 3) {
      const pSuits = seq.filter((c, i) => (seq.length - 1 - i) % 2 === 0 && isBid(c) && c[1] !== 'N').map(c => c[1]);
      const first = pSuits[0];
      if (first && first !== lb[1] && h.len[first] > h.len[lb[1]] && levelOf(cheapest(first, seq)) === levelOf(lb))
        return { call: cheapest(first, seq), why: `ゲームの可能性が低い。パートナーの1つ目のスートの${JA_SUIT[first]}の方が長いので戻す（プリファレンス）（${notes.join('、')}）` };
    }
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
    // メジャーの枚数（4枚・5枚など）が違う手は、ビッドの意味が変わるので参考にしない
    if (h.len.S !== ex.len.S || h.len.H !== ex.len.H) return Infinity;
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
  // 3回目以降のビッドの見直し（一般原則）：
  //   自分の点数＋パートナーの下限でゲームが確定しているのにゲーム未満で止まろうとしたら、ゲームへ
  //   合計33点以上でスラムがほぼ確定なのに、ゲームで止まろうとしたら（パートナーがゲームで止めても）、RKCB（4NT）か6へ
  function guard(h, seq, ctx, res) {
    if (seq.length < 4) return null;
    const lb = lastBid(seq);
    if (!lb || levelOf(lb) >= 6) return null;
    const st = ctx.slam, p = ctx.partner;
    if (st.rk || st.ntSign) return null;
    // フィット：自分の枚数＋パートナーが示した枚数で8枚以上（パートナーが今ビッドしたスートに自分が6枚以上も）
    let fit = st.active ? st.T : null;
    if (!fit) for (const s of ['S', 'H', 'D', 'C']) {
      const ok = h.len[s] + p[s][0] >= 8 || (lb[1] === s && h.len[s] >= 6);
      if (ok && (!fit || (isMaj(s) && !isMaj(fit)))) fit = s;
    }
    const pMin = p.hcp[0];
    // フィットの強さ：ダミーポイント（パートナーのスートのショートは加点しない）
    // 自分がショートを示した後にパートナーがゲームで止めたら、ショートの点は数えない（パートナーの点が無駄になっている）
    const declined = st.active && st.splBy === seq.length % 2 && seq[seq.length - 1] === gameCall(st.T);
    const myFit = fit && !declined ? Math.max(h.adj, strengthFor(h, fit, ctx)) : h.adj;
    const totFit = myFit + pMin, totNT = h.adj + pMin;
    const call = res.call;
    // 止まろうとしている：パス、または切り札（フィット）のゲーム〜5の代・3NT・5m
    const stops = call === 'P' || (isBid(call) && levelOf(call) < 6 && call !== '4N' && levelOf(call) >= gameLevel(strainOf(call)) && (call[1] === fit || call[1] === 'N' || !st.active));
    const txt = (t, m) => `自分${fmt(m)}点＋パートナーの下限${fmt(pMin)}点＝${fmt(t)}点`;
    // スラム（合計33点以上）
    if (stops) {
      if (fit && totFit >= 33) {
        const rk = legal('4N', seq) && (st.active || (lb[1] === fit && levelOf(lb) >= 3));
        if (rk) return { call: '4N', why: `${txt(totFit, myFit)}でスラムがほぼ確定なので、${JA_SUIT[fit]}を切り札に4NT（RKCB）` };
        if (isMaj(fit) && legal('6' + fit, seq)) return { call: '6' + fit, why: `${txt(totFit, myFit)}でスラムがほぼ確定なので6${SYM[fit]}` };
      }
      if (totNT >= 33 && (!fit || !isMaj(fit)) && legal('6N', seq)) return { call: '6N', why: `${txt(totNT, h.adj)}でスラムがほぼ確定なので6NT` };
    }
    // ゲーム：メジャーのフィット25点以上→4M、NT（ダミーポイントなし）25点以上→3NT、マイナーのフィット28点以上→5m
    if (call === 'P' && levelOf(lb) < gameLevel(strainOf(lb))) {
      if (fit && isMaj(fit) && totFit >= 25 && legal('4' + fit, seq)) return { call: '4' + fit, why: `${txt(totFit, myFit)}でゲームが確定しているので4${SYM[fit]}` };
      if (totNT >= 25 && legal('3N', seq)) return { call: '3N', why: `${txt(totNT, h.adj)}でゲームが確定しているので3NT` };
      if (fit && !isMaj(fit) && totFit >= 28 && legal('5' + fit, seq)) return { call: '5' + fit, why: `${txt(totFit, myFit)}でゲームが確定しているので5${SYM[fit]}` };
    }
    return null;
  }

  let COMP_OPP = null; // buildContext中の解釈で使う（敵のオーバーコール）
  function chooseCall(hand, auction, dealer, examples) {
    const h = evaluate(hand);
    const { seq, seqSeats, passedSeats } = analyze(auction, dealer);
    const d = SEATS.indexOf(dealer);
    const mySeat = SEATS[(d + auction.length) % 4];
    if (mySeat === 'E' || mySeat === 'W') return { call: 'P', why: '相手はパス（今は競り合いなし）', source: 'rule' };
    // 相手のビッドがあるとき：今は「敵のオープンの直後の介入（オーバーコール）」だけに対応
    let compOpp = null; // 敵のオーバーコールの後（3番手・オープナーのリビッド）
    let compX = null;   // 敵のテイクアウトダブルの後
    let ntOC = 0; // 1NTオーバーコールの後：1NTオープンの仕組みを、点数を1点ずらして使う
    {
      const oppIdx = auction.findIndex((c, i) => c !== 'P' && (SEATS[(d + i) % 4] === 'E' || SEATS[(d + i) % 4] === 'W'));
      // 敵の1のレベルのオープン → すぐに自分たちの1NT → その後は敵がずっとパス
      const isOC = oppIdx >= 0 && /^1[CDHS]$/.test(auction[oppIdx]) && auction[oppIdx + 1] === '1N'
        && auction.slice(0, oppIdx).every(c => c === 'P')
        && auction.every((c, i) => i <= oppIdx + 1 || c === 'P' || SEATS[(d + i) % 4] === 'N' || SEATS[(d + i) % 4] === 'S');
      if (isOC && auction.length > oppIdx + 2) ntOC = SEATS[(d + oppIdx + 1) % 4] === mySeat ? -1 : 1;
      // 自分たちの1の代のスートのオープン → 敵のナチュラルなオーバーコール（スート） → その後は敵がずっとパス
      const ourIdx = auction.findIndex((c, i) => c !== 'P' && (SEATS[(d + i) % 4] === 'N' || SEATS[(d + i) % 4] === 'S'));
      if (ourIdx >= 0 && oppIdx === ourIdx + 1 && /^1[CDHS]$/.test(auction[ourIdx]) && isBid(auction[oppIdx]) && auction[oppIdx][1] !== 'N'
        && auction.every((c, i) => i === oppIdx || c === 'P' || SEATS[(d + i) % 4] === 'N' || SEATS[(d + i) % 4] === 'S'))
        compOpp = { s: auction[oppIdx][1], call: auction[oppIdx] };
      // テイクアウトダブルへの応答：敵の1の代のオープン → パートナーのX → 敵のパス → 自分（その後も敵がパスしている間の流れ）
      {
        const i0 = auction.findIndex(c => c !== 'P');
        const seatAt = i => SEATS[(d + i) % 4], ew = i => seatAt(i) === 'E' || seatAt(i) === 'W';
        const bidX = i0 >= 0 && isBid(auction[i0 + 2] || '');  // ビッド-ダブル-ビッド
        if (i0 >= 0 && ew(i0) && /^1[CDHS]$/.test(auction[i0]) && auction[i0 + 1] === 'X' && auction.length >= i0 + 3
          && auction.every((c, i) => i <= i0 + 1 || (bidX && i === i0 + 2) || !ew(i) || c === 'P')) {
          const Y = auction[i0][1], k = auction.length - i0; // 3＝4番手の1回目、5＝ダブルした側の2回目…
          const okA = c => legalInAuction(c, auction, dealer);
          const cheapOf = s => { for (let lv = 1; lv <= 7; lv++) if (okA(lv + s)) return lv + s; return null; };
          const hh = evaluate(hand), cueC = (c) => isBid(c) && c[1] === Y;
          let x = null;
          try {
            if (k === 3) x = bidX ? TOX.advanceAfterBid(hh, Y, auction[i0 + 2], okA, cheapOf) : TOX.advance(hh, Y, okA, cheapOf);
            else if (k === 5 && cueC(auction[i0 + 3])) x = TOX.doublerAfterCue(hh, Y, okA, cheapOf);
            else if (k === 5 && bidX) x = null;
            else if (k === 5) {
              // パートナーの応答が何段ジャンプしたか（ダブルの直後の一番安いビッドとの差）
              const adv = auction[i0 + 3], pre = auction.slice(0, i0 + 3);
              let jumpN = 0;
              if (isBid(adv)) { for (let lv = 1; lv <= 7; lv++) if (legalInAuction(lv + adv[1], pre, dealer)) { jumpN = levelOf(adv) - lv; break; } }
              x = TOX.doublerRebid(hh, Y, adv, jumpN, okA, cheapOf);
            }
            else if (k === 7 && cueC(auction[i0 + 3])) x = TOX.advancerAfterReply(hh, Y, auction[i0 + 5], okA, cheapOf);
            else if (k === 9 && cueC(auction[i0 + 3]) && /^3[HS]$/.test(auction[i0 + 7])) x = TOX.doublerAfterInvite(hh, auction[i0 + 7][1]);
          } catch (e) { x = null; }
          if (x && okA(x.call)) return { call: x.call, why: x.why, source: 'rule', ruleId: 'tox' };
          if (k >= 4) return { call: 'P', why: 'テイクアウトダブルの後の流れ（まだ決めていないところ）：パス', source: 'rule', ruleId: 'tox' };
        }
      }
      // 4番手（アドバンサー）：敵の1の代のオープン → パートナーのスートのオーバーコール → 敵の応答（パス以外） → 自分
      {
        const i0 = auction.findIndex(c => c !== 'P');
        const seatAt = i => SEATS[(d + i) % 4], ew = i => seatAt(i) === 'E' || seatAt(i) === 'W';
        if (i0 >= 0 && ew(i0) && /^1[CDHS]$/.test(auction[i0]) && isBid(auction[i0 + 1] || '') && auction[i0 + 1][1] !== 'N'
          && auction[i0 + 2] && auction[i0 + 2] !== 'P' && auction.length === i0 + 3) {
          const info = { O: auction[i0][1], oc: auction[i0 + 1], Z: auction[i0 + 1][1], R: auction[i0 + 2] };
          const okA = c => legalInAuction(c, auction, dealer);
          const cheapOf = s => { for (let lv = 1; lv <= 7; lv++) if (okA(lv + s)) return lv + s; return null; };
          let x = null;
          try { x = ADV.pick(evaluate(hand), info, okA, cheapOf); } catch (e) { x = null; }
          if (x && okA(x.call)) return { call: x.call, why: x.why, source: 'rule', ruleId: 'adv' };
          return { call: 'P', why: '4番手：パス', source: 'rule', ruleId: 'adv' };
        }
      }
      // 自分たちの1の代のスートのオープン → 敵のテイクアウトダブル → その後は敵がずっとパス
      if (ourIdx >= 0 && oppIdx === ourIdx + 1 && auction[oppIdx] === 'X' && /^1[CDHS]$/.test(auction[ourIdx])
        && auction.every((c, i) => i === ourIdx + 1 || c === 'P' || SEATS[(d + i) % 4] === 'N' || SEATS[(d + i) % 4] === 'S'))
        compX = { s: auction[ourIdx][1] };
      if (oppIdx >= 0 && !ntOC && !compOpp && !compX) {
        const ourBid = auction.some((c, i) => c !== 'P' && (SEATS[(d + i) % 4] === 'N' || SEATS[(d + i) % 4] === 'S'));
        const direct = !ourBid && oppIdx === auction.length - 1 && auction.slice(0, oppIdx).every(c => c === 'P');
        if (direct && api.overcall) {
          const r = api.overcall.decide(hand, auction[oppIdx]);
          return { call: r.call, why: r.why, source: 'rule', ruleId: 'overcall', overcall: r };
        }
        return { call: 'P', why: '相手が入った競り合いは、まだ直後の介入しか対応していないのでパス', source: 'rule', ruleId: 'competitive' };
      }
    }
    // 1NTオーバーコールは16〜18点なので、レスポンダーは1点多く、オーバーコールした人は1点少なく数えて1NTオープンと同じに扱う
    if (ntOC) { h.adj += ntOC; h.hcp += ntOC; h.adjNoLen += ntOC; }
    const passedBeforeMe = false; // 将来：パス済みハンドを区別する
    const respSeat = seqSeats.length ? (seqSeats[0] === 'N' ? 'S' : 'N') : null;
    const respPassed = !!respSeat && passedSeats.includes(respSeat);
    COMP_OPP = compOpp;
    let ctx;
    try { ctx = buildContext(seq, respPassed); } finally { COMP_OPP = null; }
    ctx.pos = seq.length ? null : auction.length;   // オープンの何番手か（0〜3）
    ctx.respPassed = respPassed;
    ctx.iPassed = passedSeats.includes(mySeat);

    // ルール表による判断（1NT後の仕組み・スラム・ルール表・汎用判断・3回目以降の見直し）
    const pipeline = () => {
      let res = null;
      // 1NTオープン（・オーバーコール）の後の仕組み（スラムの仕組みより先に見る）
      if (seq[0] === '1N') {
        let x = null;
        try { x = NT1.pick(h, seq.slice(1), ctx, seq); } catch (e) { x = null; }
        if (x && x.call && legal(x.call, seq)) res = { call: x.call, why: x.why, source: 'rule', ruleId: 'nt1' };
      }
      if (!res && ctx.slam.active) for (const r of RULES) {
        if (!r.pre) continue;
        const b = matchRule(r, seq);
        if (!b) continue;
        let x = null;
        try { x = r.pick(h, { b, ...ctx, seq }); } catch (e) { x = null; }
        if (x && x.call && legal(x.call, seq)) { res = { call: x.call, why: x.why, source: 'rule', ruleId: r.id }; break; }
      }
      if (!res && ctx.slam.active) {
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
      { const g = guard(h, seq, ctx, res); if (g) res = { call: g.call, why: g.why, source: 'rule', ruleId: 'guard', ruleCall: res.call, ruleWhy: res.why }; }
      return res;
    };
    let res = null;
    // 敵のテイクアウトダブルの後
    if (compX) {
      const X = compX.s;
      if (seq.length === 1) { const x = XRESP.resp(h, seq, pipeline); if (x) return { ...x, source: 'rule', ruleId: 'xresp' }; }
      // 1の代のスートの応答・メジャーのレイズの後は、フリーランと同様（4番手がパスしていれば）
      if (XRESP.freeAfter(seq)) return pipeline();
      const x = XRESP.later(h, seq);
      if (x) return { ...x, source: 'rule', ruleId: 'xresp' };
      return { call: 'P', why: 'テイクアウトダブルの後の流れ：パス', source: 'rule', ruleId: 'xresp' };
    }
    // 1m-(1x)-1M のように1の代のニュースートで応答した後は、フリーランの1Mレスポンスと同じ（NTは敵のスートのストッパーが必要）
    const compFree = compOpp && seq.length >= 2 && isBid(seq[1]) && levelOf(seq[1]) === 1 && seq[1][1] !== 'N' && seq[1][1] !== compOpp.s;
    // パートナーが2回目以降に敵のスートをビッド（キュービッド＝GFの強い手で、ストッパーを探している）
    if (compOpp && seq.length >= 3 && isBid(seq[seq.length - 1]) && seq[seq.length - 1][1] === compOpp.s && !ctx.slam.active) {
      const Y = compOpp.s, mine = seq.filter((c, i) => i % 2 === seq.length % 2 && isBid(c) && c[1] !== 'N' && c[1] !== Y).map(c => c[1]);
      const pSuit = seq.filter((c, i) => i % 2 !== seq.length % 2 && isBid(c) && c[1] !== 'N' && c[1] !== Y).map(c => c[1])[0];
      const okC = c => c && COMP.ok(c, seq, compOpp);
      let call = null, why = '';
      if (h.stopper(Y) && okC('3N')) { call = '3N'; why = `パートナーのキュービッド（GF・ストッパーを探している）。${JA_SUIT[Y]}のストッパーがあるので3NT`; }
      else if (pSuit && h.len[pSuit] >= (isMaj(pSuit) ? 3 : 4)) { call = isMaj(pSuit) ? '4' + pSuit : cheapest(pSuit, seq); why = `パートナーのキュービッド。${JA_SUIT[Y]}のストッパーはないが、${JA_SUIT[pSuit]}にフィットするので${callText(isMaj(pSuit) ? '4' + pSuit : cheapest(pSuit, seq))}`; }
      else { const my = mine.sort((a, b) => h.len[b] - h.len[a])[0] || SUITS.filter(s => s !== Y).sort((a, b) => h.len[b] - h.len[a])[0]; call = cheapest(my, seq); why = `パートナーのキュービッド。${JA_SUIT[Y]}のストッパーがないので、${JA_SUIT[my]}を示す`; }
      if (okC(call)) return { call, why, source: 'rule', ruleId: 'comp' };
    }
    if (compFree) {
      const oppBid = compOpp;
      compOpp = null;
      const r0 = pipeline();
      const Y = oppBid.s;
      if (r0 && /^[12]N$/.test(r0.call) && !h.stopper(Y)) {
        const X = seq[seq.length % 2 === 0 ? 0 : 1][1];
        if (h.adj >= 18) { const cq = cheapest(Y, seq); if (cq) return { call: cq, why: `18点以上の強い手だが${JA_SUIT[Y]}のストッパーがないので、キュービッド（${callText(cq)}。GF、ストッパーを探す。ルールでは${callText(r0.call)}）`, source: 'rule', ruleId: 'comp' }; }
        const alt = cheapest(X, seq);
        return { call: alt, why: `${JA_SUIT[Y]}のストッパーがないのでNTではなく${callText(alt)}（ルールでは${callText(r0.call)}）`, source: 'rule', ruleId: 'comp' };
      }
      return r0;
    }
    if (compOpp) {
      // 敵のオーバーコールの後：フリーランの取り決めは使わない
      let x = null;
      try { x = COMP.pick(h, seq, compOpp, ctx); } catch (e) { x = null; }
      if (x && x.call && COMP.ok(x.call, seq, compOpp)) res = { call: x.call, why: x.why, source: 'rule', ruleId: 'comp' };
      if (!res && ctx.slam.active) { const s2 = slamDecide(h, seq, ctx); if (s2 && COMP.ok(s2.call, seq, compOpp)) res = { call: s2.call, why: s2.why, source: 'rule', ruleId: 'slam' }; }
      if (!res) { const f = fallback(h, seq, ctx); res = COMP.ok(f.call, seq, compOpp) ? { call: f.call, why: '【汎用判断】' + f.why, source: 'fallback', ruleId: null } : { call: 'P', why: '【汎用判断】パス', source: 'fallback', ruleId: null }; }
      // パートナーのゲーム以上の自然なビッドは「それをプレイしたい」なので、見直しでスラムに進めない
      const lp = seq[seq.length - 1];
      const toPlay = isBid(lp) && lp[1] !== compOpp.s && levelOf(lp) >= gameLevel(lp[1]) && !ctx.slam.active;
      const g = toPlay ? null : guard(h, seq, ctx, res);
      if (g && COMP.ok(g.call, seq, compOpp)) res = { call: g.call, why: g.why, source: 'rule', ruleId: 'guard', ruleCall: res.call, ruleWhy: res.why };
      return res;
    }
    res = pipeline();
    if (ntOC) res.why += '（1NTオーバーコールは16〜18点なので、1NTオープンの仕組みを点数を1点ずらして使う）';
    // あなたの回答例
    const key = seqKeyOf(seq, passedBeforeMe);
    let near = nearestExample(h, key, examples, seq);
    // 例のビッドが示す枚数（5枚メジャーなど）をこの手が満たさないときは使わない
    // パスの手で回答例のオープンを使うのは、オープンの強さ（11.5点など）があるときだけ
    if (near && !seq.length) near = null; // オープンはルールで決める（回答例でオープンを変えない）
    if (near && near.ex.call !== res.call) {
      const sh = interpret(seq, near.ex.call, { self: ctx.self, partner: ctx.partner }).shows || {};
      if (SUITS.some(s => Array.isArray(sh[s]) && (h.len[s] < sh[s][0] || h.len[s] > sh[s][1]))) near = null;
    }
    // 過去の回答に合わせるのは、ルールがなく汎用判断になったときだけ（ルールがある所はルールを優先。
    // 点数と枚数だけが近い手に合わせると、4枚メジャーの有無やスートの内容の違いで致命的な間違いが出た）
    if (near && near.d <= NEAR && near.ex.call !== res.call && res.source === 'fallback') {
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
  // どの席でもAIのビッドを決める（東西は席を回して同じAIで）
  function callFor(hands, seat, auction, dealer, examples) {
    const d = SEATS.indexOf(dealer);
    if (seat === 'N' || seat === 'S') return chooseCall(hands[seat], auction, dealer, examples);
    return chooseCall(hands[seat], auction, SEATS[(d + 3) % 4], null);
  }
  // オークションの最終コントラクト：{ level, strain, doubled: 0|1|2, declarer } または null（パスアウト）
  function contractOf(auction, dealer) {
    const d = SEATS.indexOf(dealer), seatAt = i => SEATS[(d + i) % 4];
    let li = -1; for (let i = auction.length - 1; i >= 0; i--) if (isBid(auction[i])) { li = i; break; }
    if (li < 0) return null;
    const bid = auction[li], strain = bid[1];
    let dbl = 0; for (let i = li + 1; i < auction.length; i++) { if (auction[i] === 'X') dbl = 1; if (auction[i] === 'XX') dbl = 2; }
    const side = SEATS.indexOf(seatAt(li)) % 2;
    let declarer = seatAt(li);
    for (let i = 0; i <= li; i++) if (isBid(auction[i]) && auction[i][1] === strain && SEATS.indexOf(seatAt(i)) % 2 === side) { declarer = seatAt(i); break; }
    return { level: Number(bid[0]), strain, doubled: dbl, declarer };
  }
  // opts.oppOvercall：自分たちの1の代のスートのオープンの直後に、敵がナチュラルなオーバーコール（スート）をする
  function autoAuction(hands, dealer, examples, maxCalls = 40, opts = {}) {
    const auction = [], steps = [];
    const d = SEATS.indexOf(dealer);
    while (!isOver(auction) && auction.length < maxCalls) {
      const seat = SEATS[(d + auction.length) % 4];
      let r;
      const prev = auction.length ? auction[auction.length - 1] : null;
      const ourOpen = prev && /^1[CDHS]$/.test(prev) && auction.slice(0, -1).every(c => c === 'P');
      if ((seat === 'E' || seat === 'W') && opts.full4) {
        // 4人ともAI：東西も席を回して同じAIでビッドする
        const rd = SEATS[(d + 3) % 4]; const x = chooseCall(hands[seat], auction, rd, null); r = { call: x.call, why: x.why, source: x.source };
      } else if ((seat === 'E' || seat === 'W') && opts.oppOpenResp) {
        // 敵（東西）のオープンと、ダブルの後の応答（席を回してこのAIで決める）。それ以降はパス
        const i0 = auction.findIndex(c => c !== 'P');
        if (i0 < 0 || auction.length === i0 + 2) { const rd = SEATS[(d + 3) % 4]; const x = chooseCall(hands[seat], auction, rd, examples); r = { call: x.call, why: x.why, source: 'opp' }; }
        else r = { call: 'P', why: '相手はパス', source: 'opp' };
      } else if ((seat === 'E' || seat === 'W') && opts.oppOpenOnly) {
        // 敵（東西）はオープンだけ（席を回してこのAIで決める）、それ以降はパス
        const i0 = auction.findIndex(c => c !== 'P');
        if (i0 < 0) { const rd = SEATS[(d + 3) % 4]; const x = chooseCall(hands[seat], auction, rd, examples); r = { call: x.call, why: x.why, source: 'opp' }; }
        else r = { call: 'P', why: '相手はパス', source: 'opp' };
      } else if ((seat === 'E' || seat === 'W') && opts.oppOpen) {
        // 敵（東西）のオープンと、こちらのオーバーコールの後の応答だけ、席を回してこのAIで決める（それ以外はパス）
        const i0 = auction.findIndex(c => c !== 'P');
        const early = i0 < 0 || auction.length <= i0 + 2;
        if (early) { const rd = SEATS[(d + 3) % 4]; const x = chooseCall(hands[seat], auction, rd, examples); r = { call: x.call, why: x.why, source: 'opp' }; }
        else r = { call: 'P', why: '相手はパス', source: 'opp' };
      } else if ((seat === 'E' || seat === 'W') && opts.oppTakeout && ourOpen && api.overcall) {
        const o = api.overcall.decide(hands[seat], prev);
        r = o && o.call === 'X' ? { call: 'X', why: o.why, source: 'opp' } : { call: 'P', why: '相手はパス', source: 'opp' };
      } else if ((seat === 'E' || seat === 'W') && opts.oppOvercall && ourOpen && api.overcall) {
        const o = api.overcall.decide(hands[seat], prev);
        r = o && isBid(o.call) && o.call[1] !== 'N' ? { call: o.call, why: o.why, source: 'opp' } : { call: 'P', why: '相手はパス', source: 'opp' };
      } else if (seat === 'E' || seat === 'W') r = { call: 'P', why: '相手はパス', source: 'opp' };
      else r = chooseCall(hands[seat], auction, dealer, examples);
      steps.push({ seat, ...r, index: auction.length });
      auction.push(r.call);
    }
    return { auction, steps };
  }

  const api = {
    ENGINE_VERSION, SUITS, SEATS, SYM, JA_SUIT, RULES,
    evaluate, chooseCall, autoAuction, analyze, isOver, legal, lastBid, isBid, rankOf, legalInAuction, callFor, contractOf,
    callText, callPbn, parseCall, deal, dealToPbn, pbnToDeal, handToPbn, pbnToHand,
    exampleFeatures, seqKeyOf, buildContext, matchSeq, ntShape: (h, c) => ntShape(h, c),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BridgeEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

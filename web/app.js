/* app.js — 画面の動き（出題・回答の保存・記録・PBN書き出し） */
(function () {
  'use strict';
  const E = window.BridgeEngine;
  const $ = id => document.getElementById(id);
  const SEAT_JA = { N: '北', E: '東', S: '南', W: '西' };
  // 思わぬエラーが起きたら、画面の上に原因を出す（止まったままにしない）
  function showFatal(where, e) {
    const note = document.getElementById('store-note');
    if (!note) return;
    note.hidden = false; note.className = 'notice warn';
    note.textContent = `${where}でエラーが起きました：${e && e.message || e}。この文面をClaudeに伝えてください。`;
  }
  window.addEventListener('error', ev => showFatal('ページ', ev.error || ev.message));
  window.addEventListener('unhandledrejection', ev => showFatal('ページ', ev.reason));
  const ROT = { N: 'S', S: 'N', E: 'W', W: 'E' };

  // ---------------------------------------------------------------
  // 保存先：claude.ai上では共有データベース、それ以外はこのブラウザ
  // ---------------------------------------------------------------
  const LS_KEY = 'bidquiz.answers.v1';
  const store = {
    mode: 'local', db: null, answers: [], listeners: [],
    onChange(fn) { this.listeners.push(fn); },
    emit() { this.answers.sort((a, b) => (a.created || '').localeCompare(b.created || '')); this.listeners.forEach(f => { try { f(); } catch (e) { showFatal('記録の表示', e); } }); },
    loadLocal() {
      try { this.answers = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { this.answers = []; }
      this.emit();
    },
    saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.answers)); } catch (e) { /* 保存できない環境 */ } },
    async init() {
      this.loadLocal();
      const note = $('store-note');
      if (!window.claude || typeof window.claude.use !== 'function') {
        note.hidden = false;
        note.textContent = 'このページは記録をこのブラウザの中だけに保存しています。Claudeに記録を読ませるには、claude.ai上のページで回答してください。';
        return;
      }
      let db = null;
      try { db = await window.claude.use('db'); } catch (e) { db = null; }
      if (!db) {
        note.hidden = false;
        note.textContent = '共有の保存場所に接続できないため、このブラウザの中に保存しています（サインインすると共有の保存場所を使えます）。';
        return;
      }
      this.db = db; this.mode = 'db';
      ocStore.attach(db);
      const timer = setTimeout(() => { note.hidden = false; note.textContent = '記録を読み込めていません。通信状態を確認してください。'; }, 10000);
      db.collection('answers').onSnapshot(snap => {
        if (!snap.metadata.fromCache) { clearTimeout(timer); note.hidden = true; }
        this.answers = snap.docs.map(d => ({ ...d.data(), id: d.id }));
        this.emit();
      }, err => {
        clearTimeout(timer);
        note.hidden = false; note.className = 'notice warn';
        note.textContent = '記録の読み込みが止まりました（' + err.code + '）。ページを開き直してください。';
      });
    },
    async add(doc) {
      if (this.mode === 'db') {
        const ref = this.db.collection('answers').doc(doc.id);
        await ref.set(doc);
      } else { this.answers.push(doc); this.saveLocal(); this.emit(); }
    },
    async update(id, patch) {
      if (this.mode === 'db') { await this.db.collection('answers').doc(id).update(patch); }
      else { const a = this.answers.find(x => x.id === id); if (a) Object.assign(a, patch); this.saveLocal(); this.emit(); }
    },
    async remove(id) {
      if (this.mode === 'db') { await this.db.collection('answers').doc(id).delete(); }
      else { this.answers = this.answers.filter(x => x.id !== id); this.saveLocal(); this.emit(); }
    },
  };

  // あなたの回答 → AIが参照する例
  function examplesFrom(answers, excludeId) {
    return answers.filter(a => a.status !== 'withdrawn' && a.id !== excludeId && a.features).map(a => ({
      ...a.features, call: a.userCall, reason: a.reason || '', id: a.id, created: a.created,
    }));
  }

  // ---------------------------------------------------------------
  // 表示の部品
  // ---------------------------------------------------------------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function callHtml(c) {
    if (c === 'P') return 'パス';
    if (c === 'X') return 'ダブル';
    if (c === 'XX') return 'リダブル';
    if (!E.isBid(c)) return esc(c);
    const s = c[1];
    if (s === 'N') return c[0] + 'NT';
    const cls = (s === 'H' || s === 'D') ? 'r' : 'b';
    return c[0] + `<span class="${cls}">${E.SYM[s]}</span>`;
  }
  const rankDisp = r => (r === 'T' ? '10' : r);
  function handHtml(hand) {
    return E.SUITS.map(s => {
      const cls = (s === 'H' || s === 'D') ? 'r' : 'b';
      const cards = hand[s] ? [...hand[s]].map(rankDisp).join(' ') : '<span class="void">—</span>';
      return `<div class="suitrow"><span class="sym ${cls}">${E.SYM[s]}</span><span class="cards">${cards}</span></div>`;
    }).join('');
  }
  function handShort(hand) {
    return E.SUITS.map(s => `<span class="${(s === 'H' || s === 'D') ? 'r' : 'b'}">${E.SYM[s]}</span>${hand[s] ? [...hand[s]].map(rankDisp).join('') : '—'}`).join(' ');
  }
  function auctionRows(auction, dealer, withQ) {
    // 列は 西・北・東・南
    const order = ['W', 'N', 'E', 'S'];
    const cells = [];
    const start = order.indexOf(dealer);
    for (let i = 0; i < start; i++) cells.push('<td class="dash"></td>');
    auction.forEach(c => cells.push(`<td>${callHtml(c)}</td>`));
    if (withQ) cells.push('<td class="q">？</td>');
    while (cells.length % 4) cells.push('<td></td>');
    let html = '';
    for (let i = 0; i < cells.length; i += 4) html += '<tr>' + cells.slice(i, i + 4).join('') + '</tr>';
    return html;
  }
  function auctionText(auction, dealer) {
    if (!auction.length) return `${SEAT_JA[dealer]}ディーラー・最初のコール`;
    return `${SEAT_JA[dealer]}から: ` + auction.map(c => c === 'P' ? '–' : E.callText(c)).join(' ');
  }
  const SOURCE_JA = { rule: 'ルール表', fallback: '汎用判断', example: 'あなたの過去の回答' };

  // ---------------------------------------------------------------
  // 出題
  // ---------------------------------------------------------------
  function category(seq) {
    if (!seq.length) return 'open';
    const o = seq[0];
    if (o === '1N' || o === '2N') return 'nt';
    if (o === '1H' || o === '1S') return 'major';
    if (o === '1C' || o === '1D') return 'minor';
    if (o === '2C') return '2c';
    if (o === '2D' || o === '2H' || o === '2S') return 'weak';
    return 'other';
  }
  // 敵の介入が入った場面か（自分たちの1の代のオープンの直後に敵がビッド）
  function compAuction(auction, dealer, takeout) {
    const d = E.SEATS.indexOf(dealer), seat = i => E.SEATS[(d + i) % 4];
    const i0 = auction.findIndex(c => c !== 'P');
    return i0 >= 0 && (seat(i0) === 'N' || seat(i0) === 'S') && (takeout ? auction[i0 + 1] === 'X' : E.isBid(auction[i0 + 1] || ''));
  }
  // 4番手（アドバンサー）の問題：敵のオープン → パートナーのスートのオーバーコール → 敵の応答（パス以外） → 自分
  function makeAdvQuiz() {
    for (let t = 0; t < 5000; t++) {
      let hands = E.deal();
      let dealer = Math.random() < 0.5 ? 'E' : 'W';
      const { auction } = E.autoAuction(hands, dealer, null, 6, { oppOpen: true });
      const i0 = auction.findIndex(c => c !== 'P');
      if (i0 < 0 || !/^1[CDHS]$/.test(auction[i0])) continue;
      const d = E.SEATS.indexOf(dealer), seat = i => E.SEATS[(d + i) % 4];
      if (seat(i0) !== 'E' && seat(i0) !== 'W') continue;
      const oc = auction[i0 + 1], rr = auction[i0 + 2];
      if (!oc || !E.isBid(oc) || oc[1] === 'N' || !rr) continue;
      if (rr === 'P' && Math.random() < 0.5) continue; // 敵がパスした場面も半分くらい
      if (auction.length < i0 + 3) continue;
      const qSeat = seat(i0 + 3);
      if (qSeat === 'N') { const h2 = {}; for (const k of E.SEATS) h2[ROT[k]] = hands[k]; hands = h2; dealer = ROT[dealer]; }
      return { hands, dealer, auction: auction.slice(0, i0 + 3), vul: 'None' };
    }
    return null;
  }
  // テイクアウトダブルへの応答の問題：敵のオープン → パートナーのX → 敵のパス → 自分（キュービッドの後の流れも）
  function makeToxQuiz() {
    for (let t = 0; t < 6000; t++) {
      let hands = E.deal();
      let dealer = Math.random() < 0.5 ? 'E' : 'W';
      // 半分は敵（3番手）がビッドする場面（ビッド-ダブル-ビッド）
      const withBid = Math.random() < 0.5;
      const { auction, steps } = E.autoAuction(hands, dealer, null, 14, withBid ? { oppOpenResp: true } : { oppOpenOnly: true });
      const i0 = auction.findIndex(c => c !== 'P');
      if (i0 < 0 || !/^1[CDHS]$/.test(auction[i0]) || auction[i0 + 1] !== 'X') continue;
      if (withBid && !E.isBid(auction[i0 + 2] || '')) continue;
      const d = E.SEATS.indexOf(dealer), seat = i => E.SEATS[(d + i) % 4];
      if (seat(i0) !== 'E' && seat(i0) !== 'W') continue;
      // 4番手の1回目。キュービッドの流れなら、その後の場面も出題する
      const cands = [i0 + 3];
      if (auction[i0 + 3] && E.isBid(auction[i0 + 3]) && auction[i0 + 3][1] === auction[i0][1]) cands.push(i0 + 5, i0 + 7);
      // ダブルした側のリビッド（パスばかりにならないよう、パスの場面は少なめ）
      else if (auction[i0 + 3] && auction[i0 + 3] !== 'P' && (auction[i0 + 5] !== 'P' || Math.random() < 0.3)) cands.push(i0 + 5);
      const idx = cands.filter(i => i < auction.length)[Math.floor(Math.random() * cands.filter(i => i < auction.length).length)];
      if (idx === undefined) continue;
      if (seat(idx) === 'N') { const h2 = {}; for (const k of E.SEATS) h2[ROT[k]] = hands[k]; hands = h2; dealer = ROT[dealer]; }
      return { hands, dealer, auction: auction.slice(0, idx), vul: 'None' };
    }
    return null;
  }
  // バランシングの問題：敵のビッド（2の代以下）がパス-パスで回ってきた席（AI4体でビッドして場面を探す）
  function makeBalQuiz() {
    for (let t = 0; t < 4000; t++) {
      let hands = E.deal();
      let dealer = E.SEATS[Math.floor(Math.random() * 4)];
      const { auction } = E.autoAuction(hands, dealer, null, 40, { full4: true });
      const d = E.SEATS.indexOf(dealer), seat = i => E.SEATS[(d + i) % 4];
      const pts = [];
      for (let i = 3; i <= auction.length; i++) {
        const me = seat(i); if (me !== 'N' && me !== 'S') continue;
        let li = -1; for (let j = i - 1; j >= 0; j--) if (auction[j] !== 'P') { li = j; break; }
        if (li < 0 || i - li !== 3 || !E.isBid(auction[li]) || auction[li][1] === 'N' || Number(auction[li][0]) > 2) continue;
        if (seat(li) !== 'E' && seat(li) !== 'W') continue;
        pts.push(i);
      }
      if (!pts.length) continue;
      const idx = pts[Math.floor(Math.random() * pts.length)];
      if (seat(idx) === 'N') { const h2 = {}; for (const k of E.SEATS) h2[ROT[k]] = hands[k]; hands = h2; dealer = ROT[dealer]; }
      return { hands, dealer, auction: auction.slice(0, idx), vul: 'None' };
    }
    return null;
  }
  function makeQuiz(filter) {
    if (filter === 'bal') return makeBalQuiz();
    if (filter === 'adv') return makeAdvQuiz();
    if (filter === 'tox') return makeToxQuiz();
    const examples = examplesFrom(store.answers);
    const xr = filter === 'xresp';
    const comp = filter === 'comp' || xr;
    for (let t = 0; t < (comp ? 4000 : 800); t++) {
      let hands = E.deal();
      let dealer = E.SEATS[Math.floor(Math.random() * 4)];
      const { auction, steps } = E.autoAuction(hands, dealer, examples, 40, xr ? { oppTakeout: true } : { oppOvercall: comp });
      if (comp && !compAuction(auction, dealer, xr)) continue;
      const allPass = auction.every(c => c === 'P');
      if (allPass && Math.random() < 0.85) continue;
      let points = steps.filter(s => s.seat === 'N' || s.seat === 'S');
      points = points.filter(s => {
        const { seq } = E.analyze(auction.slice(0, s.index), dealer);
        if (xr) return seq.length >= 1 && seq.length <= 2 && !(s.call === 'P' && Math.random() < 0.6);
        if (comp) return seq.length >= 1 && seq.length <= 3 && !(s.call === 'P' && seq.length === 1 && Math.random() < 0.5);
        if (filter !== 'all' && category(seq) !== filter) return false;
        // 最初のコール以外で、パスしかない場面ばかりにならないように
        if (seq.length === 0 && s.call === 'P' && Math.random() < 0.6) return false;
        return true;
      });
      if (!points.length) continue;
      const pt = points[Math.floor(Math.random() * points.length)];
      // 答える人がいつも南になるように回転
      if (pt.seat === 'N') {
        const h2 = {}; for (const k of E.SEATS) h2[ROT[k]] = hands[k];
        hands = h2; dealer = ROT[dealer];
      }
      return { hands, dealer, auction: auction.slice(0, pt.index), vul: 'None' };
    }
    return null;
  }

  let quiz = null, chosen = null, lastSavedId = null;
  function newQuiz() {
    quiz = makeQuiz($('filter').value);
    chosen = null; lastSavedId = null;
    $('reason').value = ''; $('doubt').checked = false;
    $('result-card').hidden = true; $('answer-card').hidden = false; $('partner').hidden = true;
    $('show-partner').textContent = 'パートナーの手を見る';
    if (!quiz) { $('board-info').textContent = 'この条件の問題が作れませんでした。場面を変えてください。'; return; }
    const n = store.answers.length + 1;
    $('board-info').textContent = `第${n}問 ・ ディーラー ${SEAT_JA[quiz.dealer]} ・ バル なし`;
    $('auction-body').innerHTML = auctionRows(quiz.auction, quiz.dealer, true);
    const ev = E.evaluate(quiz.hands.S);
    $('hand').innerHTML = handHtml(quiz.hands.S);
    $('hand-meta').textContent = `${ev.rawHcp}点（HCP）・補正込み${Math.round(ev.adj * 10) / 10}点 ・ ${E.SUITS.map(s => ev.len[s]).join('-')}`;
    renderBox();
  }
  function renderBox() {
    let html = '';
    for (let lv = 1; lv <= 7; lv++) for (const s of ['C', 'D', 'H', 'S', 'N']) {
      const c = lv + s;
      const ok = E.legalInAuction(c, quiz.auction, quiz.dealer);
      html += `<button class="bid" data-call="${c}" aria-pressed="${chosen === c}" ${ok ? '' : 'disabled'} aria-label="${E.callText(c)}">${callHtml(c)}</button>`;
    }
    html += `<button class="bid pass" data-call="P" aria-pressed="${chosen === 'P'}">パス</button>`;
    if (E.legalInAuction('X', quiz.auction, quiz.dealer)) html += `<button class="bid pass" data-call="X" aria-pressed="${chosen === 'X'}">ダブル</button>`;
    if (E.legalInAuction('XX', quiz.auction, quiz.dealer)) html += `<button class="bid pass" data-call="XX" aria-pressed="${chosen === 'XX'}">リダブル</button>`;
    $('bbox').innerHTML = html;
    const btn = $('submit');
    btn.disabled = !chosen;
    btn.innerHTML = chosen ? `${callHtml(chosen)} で決定` : 'ビッドを選んでください';
  }
  $('bbox').addEventListener('click', e => {
    const b = e.target.closest('.bid'); if (!b || b.disabled) return;
    chosen = b.dataset.call; renderBox();
  });

  function newId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  $('submit').addEventListener('click', async () => {
    if (!quiz || !chosen) return;
    const examples = examplesFrom(store.answers);
    const ai = E.chooseCall(quiz.hands.S, quiz.auction, quiz.dealer, examples);
    const doc = {
      id: newId(), created: new Date().toISOString(), engine: E.ENGINE_VERSION,
      dealer: quiz.dealer, vul: quiz.vul, deal: E.dealToPbn(quiz.hands, 'N'), auction: quiz.auction.slice(), seat: 'S',
      userCall: chosen, reason: $('reason').value.trim(), doubt: $('doubt').checked,
      aiCall: ai.call, aiWhy: ai.why, aiSource: ai.source, aiRule: ai.ruleId || null,
      features: E.exampleFeatures(quiz.hands.S, quiz.auction, quiz.dealer), status: 'active',
    };
    $('submit').disabled = true;
    try { await store.add(doc); lastSavedId = doc.id; }
    catch (err) { showSaveError(err); $('submit').disabled = false; return; }
    showResult(doc, ai);
  });
  function showSaveError(err) {
    const note = $('store-note'); note.hidden = false; note.className = 'notice warn';
    note.textContent = '保存できませんでした（' + (err && err.code || '不明なエラー') + '）。もう一度「決定」を押してください。';
  }
  function showResult(doc, ai) {
    const same = doc.userCall === ai.call;
    let html = `<div class="result ${same ? 'same' : 'diff'}">`;
    html += `<div class="row"><span class="pill ${same ? 'same' : 'diff'}">${same ? 'AIと同じ' : 'AIと違う'}</span>`;
    html += `<span class="pill ex">AIの根拠：${SOURCE_JA[ai.source] || ai.source}</span></div>`;
    html += `<div class="compare"><div><div class="label">あなた</div><div class="bigcall">${callHtml(doc.userCall)}</div><div class="muted">${esc(doc.reason || '（理由なし）')}</div></div>`;
    html += `<div><div class="label">AI</div><div class="bigcall">${callHtml(ai.call)}</div><div class="muted">${esc(ai.why)}</div></div></div>`;
    if (ai.source === 'example' && ai.ruleCall) html += `<p class="muted" style="margin:0">ルール表だけなら ${callHtml(ai.ruleCall)}：${esc(ai.ruleWhy)}</p>`;
    if (!same) {
      html += `<p style="margin:0">あなたの答えを記録しました。「回答を取り込んで分析して」と頼むと、AIのルールを直す材料に使います。</p>`;
      html += `<div class="row"><button id="adopt-ai" class="btn small">AIの答えの方が良い（自分の答えを${esc(E.callText(ai.call))}に変える）</button></div>`;
    }
    html += '</div>';
    $('result').innerHTML = html;
    $('answer-card').hidden = true; $('result-card').hidden = false;
    const adopt = $('adopt-ai');
    if (adopt) adopt.addEventListener('click', async () => {
      try {
        await store.update(doc.id, { userCall: ai.call, adoptedAI: true, reason: doc.reason ? doc.reason + '（AIの答えに変更）' : 'AIの答えに変更' });
        adopt.outerHTML = '<span class="pill same">自分の答えをAIの答えに変えました</span>';
      } catch (err) { showSaveError(err); }
    });
    $('auction-body').innerHTML = auctionRows(quiz.auction.concat([doc.userCall]), quiz.dealer, false);
  }
  $('next').addEventListener('click', newQuiz);
  $('filter').addEventListener('change', newQuiz);
  $('show-partner').addEventListener('click', () => {
    const p = $('partner');
    if (p.hidden) {
      const ev = E.evaluate(quiz.hands.N);
      p.innerHTML = `<div class="label">北（パートナー）の手 ・ ${ev.rawHcp}点（補正込み${Math.round(ev.adj * 10) / 10}点）</div><div class="hand">${handHtml(quiz.hands.N)}</div>`;
      p.hidden = false; $('show-partner').textContent = 'パートナーの手を隠す';
    } else { p.hidden = true; $('show-partner').textContent = 'パートナーの手を見る'; }
  });

  // ---------------------------------------------------------------
  // 記録
  // ---------------------------------------------------------------
  let editing = null;
  function renderRecords() {
    const list = store.answers.filter(a => a.status !== 'withdrawn');
    let agree = 0, ruleAgree = 0;
    const rows = list.map(a => {
      const hands = E.pbnToDeal(a.deal);
      const now = E.chooseCall(hands.S, a.auction, a.dealer, examplesFrom(store.answers, a.id));
      const rule = E.chooseCall(hands.S, a.auction, a.dealer, []);
      if (now.call === a.userCall) agree++;
      if (rule.call === a.userCall) ruleAgree++;
      return { a, hands, now };
    });
    $('st-count').textContent = list.length;
    $('st-agree').textContent = list.length ? Math.round(100 * agree / list.length) + '%' : '–';
    $('st-rule').textContent = list.length ? Math.round(100 * ruleAgree / list.length) + '%' : '–';
    const onlyDiff = $('only-diff').checked;
    const shown = rows.filter(r => !onlyDiff || r.now.call !== r.a.userCall).reverse();
    if (!shown.length) {
      $('records').innerHTML = `<p class="muted" style="margin:0">${list.length ? 'AIと答えが違う記録はありません。' : 'まだ回答がありません。「問題」タブで1問答えると、ここに記録が並びます。'}</p>`;
      return;
    }
    $('records').innerHTML = shown.map(({ a, hands, now }) => {
      const idx = store.answers.indexOf(a) + 1;
      const same = now.call === a.userCall;
      let h = `<div class="rec" data-id="${esc(a.id)}">`;
      h += `<div class="row spread"><b>第${idx}問</b><span class="pill ${same ? 'same' : 'diff'}">${same ? '一致' : '不一致'}</span></div>`;
      h += `<div class="seq">${auctionText(a.auction, a.dealer)}</div>`;
      h += `<div class="seq">${handShort(hands.S)}</div>`;
      h += `<div class="compare"><div><div class="label">あなた</div><div class="bigcall">${callHtml(a.userCall)}</div><div class="muted">${esc(a.reason || '（理由なし）')}</div></div>`;
      h += `<div><div class="label">今のAI</div><div class="bigcall">${callHtml(now.call)}</div><div class="muted">${esc(now.why)}</div></div></div>`;
      if (editing === a.id) {
        const { seq } = E.analyze(a.auction, a.dealer);
        const opts = ['P'];
        for (let lv = 1; lv <= 7; lv++) for (const s of ['C', 'D', 'H', 'S', 'N']) if (E.legal(lv + s, seq)) opts.push(lv + s);
        h += `<div class="row"><label class="label" for="ed-call">ビッド</label><select id="ed-call">${opts.map(c => `<option value="${c}" ${c === a.userCall ? 'selected' : ''}>${E.callText(c)}</option>`).join('')}</select></div>`;
        h += `<label class="label" for="ed-reason">理由</label><textarea id="ed-reason">${esc(a.reason || '')}</textarea>`;
        h += `<div class="row"><button class="btn small primary" data-act="save">保存</button><button class="btn small" data-act="cancel">やめる</button><button class="btn small" data-act="delete">この記録を消す</button></div>`;
      } else {
        h += `<div class="row"><button class="btn small" data-act="edit">直す</button></div>`;
      }
      return h + '</div>';
    }).join('');
  }
  $('records').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('.rec').dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'edit') { editing = id; renderRecords(); }
      else if (act === 'cancel') { editing = null; renderRecords(); }
      else if (act === 'save') {
        const patch = { userCall: $('ed-call').value, reason: $('ed-reason').value.trim(), edited: new Date().toISOString() };
        editing = null; await store.update(id, patch);
        if (store.mode === 'db') renderRecords();
      } else if (act === 'delete') {
        if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'もう一度押すと消えます'; return; }
        editing = null; await store.remove(id);
      }
    } catch (err) { showSaveError(err); }
  });
  $('only-diff').addEventListener('change', renderRecords);

  // ---------------------------------------------------------------
  // PBN書き出し
  // ---------------------------------------------------------------
  const tag = (k, v) => `[${k} "${String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"]`;
  function toPbn(answers) {
    const out = ['% PBN 2.1', '% EXPORT', '% ビッド練習帳 — 「次のビッドは？」の回答記録', '% Auctionは問題の時点まで（* = 続きあり）。答えは Answer タグ。', ''];
    answers.filter(a => a.status !== 'withdrawn').forEach((a, i) => {
      const date = (a.created || '').slice(0, 10).replace(/-/g, '.');
      out.push(tag('Event', 'Bidding quiz'), tag('Site', ''), tag('Date', date), tag('Board', i + 1),
        tag('West', 'Pass'), tag('North', 'AI'), tag('East', 'Pass'), tag('South', 'You'),
        tag('Dealer', a.dealer), tag('Vulnerable', a.vul || 'None'), tag('Deal', a.deal),
        tag('Scoring', ''), tag('Declarer', ''), tag('Contract', ''), tag('Result', ''));
      out.push(tag('Auction', a.dealer));
      const calls = a.auction.map(E.callPbn);
      for (let k = 0; k < calls.length; k += 4) out.push(calls.slice(k, k + 4).join(' '));
      out.push('*');
      out.push(tag('QuizSeat', a.seat || 'S'), tag('Answer', E.callPbn(a.userCall)), tag('AnswerReason', a.reason || ''),
        tag('AIBid', E.callPbn(a.aiCall)), tag('AIReason', a.aiWhy || ''), tag('AISource', a.aiSource || ''),
        tag('AuctionDoubt', a.doubt ? 'yes' : 'no'), tag('Created', a.created || ''), tag('QuizId', a.id), tag('EngineVersion', a.engine || ''));
      out.push('');
    });
    return out.join('\n');
  }
  function ocPbn(items) {
    const out = ['', '% 介入（オーバーコール）の回答。Auctionは東のオープンまで。OvercallDecision＝介入する(yes)／しない(no)', ''];
    items.forEach((r, i) => {
      out.push(tag('Event', 'Overcall quiz'), tag('Site', ''), tag('Date', (r.created || '').slice(0, 10).replace(/-/g, '.')), tag('Board', i + 1),
        tag('West', 'Opp'), tag('North', 'Partner'), tag('East', 'Opp'), tag('South', 'You'),
        tag('Dealer', r.dealer), tag('Vulnerable', r.vul || 'None'), tag('Deal', r.deal),
        tag('Scoring', ''), tag('Declarer', ''), tag('Contract', ''), tag('Result', ''), tag('Auction', r.dealer));
      out.push(r.auction.map(E.callPbn).join(' '), '*');
      const isX = r.type === 'X';
      out.push(tag('QuizSeat', 'S'), tag('OvercallType', r.type), tag('OvercallBid', E.callPbn(r.call)), tag('OvercallDecision', r.decision ? 'yes' : 'no'),
        tag('OvercallAction', r.action || (r.decision ? (isX ? 'double' : 'overcall') : 'pass')),
        tag('LeadDirecting', isX ? '' : r.params.lead), tag('GameChance', isX ? '' : r.params.game), tag('Competing', isX ? '' : r.params.compete), tag('Preemptive', isX ? '' : OC.preemptOf(r.call)),
        tag('AnswerReason', r.reason || ''), tag('AIBid', E.callPbn(r.ai && r.ai.call || '')), tag('Created', r.created || ''), tag('QuizId', r.id), tag('EngineVersion', r.engine || ''), '');
    });
    return out.join('\n');
  }
  function renderExport() { $('pbn').textContent = toPbn(store.answers) + (ocStore.items.length ? ocPbn(ocStore.items) : ''); }
  $('copy-pbn').addEventListener('click', () => {
    const text = $('pbn').textContent;
    const done = () => { $('copy-msg').textContent = 'コピーしました'; };
    const fail = () => {
      const r = document.createRange(); r.selectNodeContents($('pbn'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      $('copy-msg').textContent = '選択しました。長押しでコピーしてください';
    };
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
  });
  (async () => {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    let dl = null; try { dl = await window.claude.use('downloads'); } catch (e) { dl = null; }
    if (!dl) return;
    const b = $('dl-pbn'); b.hidden = false;
    b.addEventListener('click', async () => {
      try {
        const r = await dl.save({ filename: 'bidding-quiz.pbn', data: toPbn(store.answers) + (ocStore.items.length ? ocPbn(ocStore.items) : '') });
        $('copy-msg').textContent = r && r.status === 'saved' ? '保存しました' : '';
      } catch (e) { $('copy-msg').textContent = e && e.code === 'unavailable' ? 'ここでは保存できません' : ''; }
    });
  })();

  // ---------------------------------------------------------------
  // 介入（オーバーコール）の練習：パラメータを1〜5で評価して、介入する／しないを答える
  // ---------------------------------------------------------------
  const OC = E.overcall;
  const OC_KEY = 'bidquiz.overcalls.v1';
  const ocStore = {
    mode: 'local', db: null, items: [], listeners: [],
    onChange(fn) { this.listeners.push(fn); },
    emit() {
      this.items.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
      try { OC.train(this.items.filter(r => r && r.deal && r.open && r.call && r.params)); } catch (e) { showFatal('介入の学習', e); }
      this.listeners.forEach(f => { try { f(); } catch (e) { showFatal('介入の表示', e); } });
    },
    loadLocal() { try { this.items = JSON.parse(localStorage.getItem(OC_KEY) || '[]'); } catch (e) { this.items = []; } this.emit(); },
    saveLocal() { try { localStorage.setItem(OC_KEY, JSON.stringify(this.items)); } catch (e) { /* 保存できない環境 */ } },
    attach(db) {
      this.db = db; this.mode = 'db';
      db.collection('overcalls').onSnapshot(snap => { this.items = snap.docs.map(d => ({ ...d.data(), id: d.id })); this.emit(); },
        err => showFatal('介入の記録の読み込み', err && (err.code || err.message) || err));
    },
    async add(doc) { if (this.mode === 'db') await this.db.collection('overcalls').doc(doc.id).set(doc); else { this.items.push(doc); this.saveLocal(); this.emit(); } },
    async remove(id) { if (this.mode === 'db') await this.db.collection('overcalls').doc(id).delete(); else { this.items = this.items.filter(x => x.id !== id); this.saveLocal(); this.emit(); } },
  };
  ocStore.loadLocal();

  // 出題：東がオープンし、南（あなた）がすぐ次の手番。回答の少ない種類を優先して出す
  function makeOcQuiz() {
    const ALL = OC.TYPES.concat(['X']);
    const counts = Object.fromEntries(ALL.map(t => [t, 0]));
    for (const r of ocStore.items) if (counts[r.type] != null) counts[r.type]++;
    const min = Math.min(...Object.values(counts));
    const want = ALL.filter(t => counts[t] === min);
    const filter = $('oc-filter').value;
    let target = filter === 'auto' ? want[Math.floor(Math.random() * want.length)] : filter;
    // ウィークの代：weak2／weak3を選んだときはその代、weak（両方）なら回答の少ない方
    let level = null;
    if (target === 'weak2' || target === 'weak3') { level = target[4]; target = 'weak'; }
    else if (target === 'weak') {
      const n2 = ocStore.items.filter(r => r.type === 'weak' && r.call[0] === '2').length;
      const n3 = ocStore.items.filter(r => r.type === 'weak' && r.call[0] === '3').length;
      level = n2 < n3 ? '2' : n3 < n2 ? '3' : (Math.random() < 0.5 ? '2' : '3');
    }
    const fixed = filter !== 'auto';
    let fallback = null;
    const want4D = target === '1D' && Math.random() < 0.5; // 1♦は♦4枚の手も半分くらい出す
    for (let t = 0; t < 30000; t++) {
      const hands = E.deal();
      const open = E.chooseCall(hands.E, [], 'N').call; // 東の手で1番手のオープンを決める
      if (!/^1[CDHS]$/.test(open)) continue;
      if (OC.ntOvercall(hands.S, open)) continue; // 1NTオーバーコールはルールで決めるので出題しない
      let cand = OC.candidate(hands.S, open);
      const dbl = OC.doubleShape(hands.S, open);
      // ダブルだけの問題：オーバーコールの候補がなく、ダブルの形で8〜17点の手
      if (!cand && dbl) { const a = E.evaluate(hands.S).adj; if (a >= 8 && a < 18) cand = { type: 'X', call: 'X' }; }
      if (!cand) continue;
      const q = { hands, dealer: 'E', auction: [open], open, cand, dbl };
      if (cand.type === target && (!want4D || hands.S.D.length === 4) && (!level || cand.call[0] === level)) return q;
      if (fixed && cand.type !== target) continue; // 種類を選んだときはほかの種類を出さない
      if (!fallback) fallback = q;
    }
    return fallback;
  }
  let oq = null, oAns = null;
  function ocNew() {
    oq = makeOcQuiz();
    oAns = { params: {}, action: null };
    $('oc-reason').value = ''; $('oc-result').hidden = true; $('oc-answer').hidden = false;
    if (!oq) { $('oc-info').textContent = '問題を作れませんでした。もう一度開いてください。'; return; }
    $('oc-info').textContent = `介入の第${ocStore.items.length + 1}問 ・ 東のオープンの直後 ・ バル なし`;
    $('oc-auction').innerHTML = auctionRows(oq.auction, oq.dealer, true);
    const ev = E.evaluate(oq.hands.S);
    $('oc-hand').innerHTML = handHtml(oq.hands.S);
    $('oc-meta').textContent = `${ev.rawHcp}点（HCP）・補正込み${Math.round(ev.adj * 10) / 10}点 ・ ${E.SUITS.map(s => ev.len[s]).join('-')}`;
    $('oc-cand').innerHTML = oq.cand.type === 'X' ? '候補：<b>ダブル</b>（ダブルの形：敵のスートが3枚以下、ほかのメジャーが3〜4枚）'
      : `候補：<b>${callHtml(oq.cand.call)}</b>（${esc(OC.TYPE_JA[oq.cand.type])}）${oq.dbl ? '・ダブルの形でもある' : ''}`;
    renderOcInputs();
  }
  function renderOcInputs() {
    const isX = oq.cand.type === 'X';
    $('oc-params-label').hidden = isX; $('oc-params').hidden = isX;
    // 選択肢：オーバーコール（候補がオーバーコールのとき）、ダブル（ダブルの形のとき）、パス
    const acts = [];
    if (!isX) acts.push(['overcall', `${E.callText(oq.cand.call)}（オーバーコール）`]);
    if (isX || oq.dbl) acts.push(['double', 'ダブル']);
    acts.push(['pass', 'パス']);
    $('oc-yn').innerHTML = acts.map(([a, t]) => `<button class="btn" data-act="${a}" aria-pressed="${oAns.action === a}">${esc(t)}</button>`).join('');
    if (isX) { const ready = !!oAns.action; $('oc-submit').disabled = !ready; $('oc-submit').textContent = ready ? `${oAns.action === 'double' ? 'ダブル' : 'パス'}で決定` : '判断を入れてください'; return; }
    $('oc-params').innerHTML = OC.RATED.map(k => `<div class="prow"><span>${esc(OC.PARAM_JA[k])}</span><div class="seg" data-param="${k}">${
      [1, 2, 3, 4, 5].map(v => `<button aria-pressed="${oAns.params[k] === v}" data-v="${v}" aria-label="${esc(OC.PARAM_JA[k])} ${v}">${v}</button>`).join('')}</div></div>`).join('')
      + `<div class="prow"><span>プリエンプト性 <span class="muted">（${esc(E.callText(oq.cand.call))}で決まる）</span></span><b style="padding-right:8px">${OC.preemptOf(oq.cand.call)}</b></div>`;
    const ready = OC.RATED.every(k => oAns.params[k]) && !!oAns.action;
    $('oc-submit').disabled = !ready;
    $('oc-submit').textContent = ready ? ({ overcall: `${E.callText(oq.cand.call)}で決定`, double: 'ダブルで決定', pass: 'パスで決定' })[oAns.action] : '評価と判断を入れてください';
  }
  $('oc-params').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    oAns.params[b.closest('.seg').dataset.param] = Number(b.dataset.v); renderOcInputs();
  });
  $('oc-yn').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    oAns.action = b.dataset.act; renderOcInputs();
  });
  $('oc-submit').addEventListener('click', async () => {
    if (!oq) return;
    const ai = OC.decide(oq.hands.S, oq.open); // 保存の前（この回答を学習する前）のAIの判断
    const doc = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), created: new Date().toISOString(), engine: E.ENGINE_VERSION,
      kind: 'overcall', dealer: oq.dealer, vul: 'None', deal: E.dealToPbn(oq.hands, 'N'), auction: oq.auction.slice(), seat: 'S',
      open: oq.open, type: oq.cand.type, call: oq.cand.call,
      params: oq.cand.type === 'X' ? {} : { ...oAns.params, preempt: OC.preemptOf(oq.cand.call) },
      // decision：その候補（オーバーコール、ダブルの問題ならダブル）をしたか。action：実際に選んだもの
      decision: oq.cand.type === 'X' ? oAns.action === 'double' : oAns.action === 'overcall', action: oAns.action, doubleShape: !!oq.dbl,
      reason: $('oc-reason').value.trim(),
      ai: { call: ai.call, params: ai.params ? Object.fromEntries(OC.PARAMS.map(k => [k, Math.round(ai.params[k] * 10) / 10])) : null, p: ai.p != null ? Math.round(ai.p * 100) / 100 : null },
    };
    $('oc-submit').disabled = true;
    try { await ocStore.add(doc); } catch (err) { showSaveError(err); $('oc-submit').disabled = false; return; }
    const yourCall = doc.action === 'double' ? 'X' : doc.action === 'overcall' ? doc.call : 'P', same = yourCall === ai.call;
    let html = `<div class="result ${same ? 'same' : 'diff'}"><div class="row"><span class="pill ${same ? 'same' : 'diff'}">${same ? 'AIと同じ判断' : 'AIと違う判断'}</span></div>`;
    html += `<div class="compare"><div><div class="label">あなた</div><div class="bigcall">${callHtml(yourCall)}</div></div><div><div class="label">AI${ai.p != null ? `（${ai.call === 'X' || (ai.cand && ai.cand.type === 'X') ? 'ダブル' : '介入'}する確率${Math.round(ai.p * 100)}%）` : ''}</div><div class="bigcall">${callHtml(ai.call)}</div></div></div>`;
    if (doc.type !== 'X') html += '<table class="ptable"><tr><th>パラメータ</th><th>あなた</th><th>AIの推定</th></tr>' + OC.PARAMS.map(k =>
      `<tr><td>${esc(OC.PARAM_JA[k])}${k === 'preempt' ? '（ビッドで決まる）' : ''}</td><td class="num">${doc.params[k]}</td><td class="num">${ai.params ? (k === 'preempt' ? ai.params[k] : ai.params[k].toFixed(1)) : '–'}</td></tr>`).join('') + '</table>';
    html += '<p class="muted" style="margin:0">この回答はすぐ学習に使われ、下の分析とAIの判断に反映されます。</p></div>';
    $('oc-res').innerHTML = html; $('oc-answer').hidden = true; $('oc-result').hidden = false;
    $('oc-auction').innerHTML = auctionRows(oq.auction.concat([yourCall]), oq.dealer, false);
  });
  $('oc-next').addEventListener('click', ocNew);
  $('oc-filter').addEventListener('change', ocNew);

  function renderOcAnalysis() {
    const rows = OC.analysis();
    const dm = OC.doubleModel;
    $('oc-count').textContent = `回答 ${ocStore.items.length}件`;
    $('oc-analysis').innerHTML = rows.map(r => {
      const maxW = Math.max(0.5, ...OC.PARAMS.map(k => Math.abs(r.weights[k])));
      const tbl = OC.PARAMS.map(k => {
        const w = r.weights[k], wpx = Math.round(Math.abs(w) / maxW * 60);
        const my = r.meanYes[k], mn = r.meanNo[k];
        return `<tr><td>${esc(OC.PARAM_JA[k])}</td><td><span class="wbar ${w < 0 ? 'neg' : ''}" style="width:${wpx}px"></span> ${w.toFixed(2)}</td><td class="num">${my == null ? '–' : my.toFixed(1)}</td><td class="num">${mn == null ? '–' : mn.toFixed(1)}</td></tr>`;
      }).join('');
      return `<div class="octype"><div class="row spread"><b>${esc(r.name)}</b><span class="muted">${r.n}件（する${r.yes}・しない${r.n - r.yes}）</span></div>
        <div class="muted">重視：${r.order.map(k => esc(OC.PARAM_JA[k])).join(' ＞ ')}${r.n < 5 ? '（回答が少ないので暫定）' : ''}</div>
        <table class="ptable"><tr><th>パラメータ</th><th>重み</th><th>するの平均</th><th>しないの平均</th></tr>${tbl}</table>${
        r.majorGame != null ? `<div class="muted">アンビッドのメジャー4枚（ゲームの可能性3以上で効く）の重み：${r.majorGame.toFixed(2)}（マイナスほど、しない寄り）</div>` : ''}</div>`;
    }).join('') + `<div class="octype"><div class="row spread"><b>ダブル</b><span class="muted">ダブルの形の手 ${dm.n}件（ダブル${dm.yes}・ほか${dm.n - dm.yes}）</span></div>
      <div class="muted">形：敵のスートが3枚以下で、ほかのメジャーが3〜4枚。ダブルする確率が半々になる点数（補正込み）：${dm.half ? [3, 2, 1].map(n => `敵のスート${n}枚なら${Math.round(dm.half[n] * 10) / 10}点`).join('、') : '–'}。敵のスートのA以外のアナー（KQx・AJx・AQ10など）1枚ごとに、半々の点数が${dm.honW != null && dm.w[1] > 0.05 ? (Math.round(-dm.honW / dm.w[1] * 10) / 10) : '–'}点上がる${dm.n < 5 ? '（回答が少ないので暫定）' : ''}</div></div>`;
    const recent = ocStore.items.slice().reverse().slice(0, 30);
    $('oc-records').innerHTML = recent.length ? recent.map(r => {
      const h = E.pbnToDeal(r.deal).S;
      return `<div class="rec" style="border-bottom:1px solid var(--line);padding:8px 0;display:grid;gap:4px">
        <div class="row spread"><span>(${callHtml(r.open)}) → ${r.action === 'double' || (r.type === 'X' && r.decision) ? 'ダブル' : r.decision ? callHtml(r.call) : 'パス'} <span class="muted">${esc(r.type === 'X' ? 'ダブルの問題' : OC.TYPE_JA[r.type])}</span></span>
        <button class="btn small" data-ocdel="${esc(r.id)}">消す</button></div>
        <div class="mono">${handShort(h)}</div>
        <div class="muted">${r.type === 'X' ? '' : OC.PARAMS.map(k => esc(OC.PARAM_JA[k]) + (k === 'preempt' ? OC.preemptOf(r.call) : r.params[k])).join('・')}${r.reason ? '　「' + esc(r.reason) + '」' : ''}</div></div>`;
    }).join('') : '<p class="muted" style="margin:0">まだ記録がありません。</p>';
  }
  $('oc-records').addEventListener('click', async e => {
    const b = e.target.closest('button[data-ocdel]'); if (!b) return;
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'もう一度押すと消えます'; return; }
    try { await ocStore.remove(b.dataset.ocdel); } catch (err) { showSaveError(err); }
  });
  ocStore.onChange(() => { if (view === 'oc') renderOcAnalysis(); if (view === 'export') renderExport(); });

  // ---------------------------------------------------------------
  // タブ
  // ---------------------------------------------------------------
  var view = 'quiz';
  function show(v) {
    view = v;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === v));
    for (const name of ['quiz', 'oc', 'match', 'records', 'export', 'help']) $('view-' + name).hidden = name !== v;
    if (v === 'match' && !match) matchStart();
    if (v === 'oc') { if (!oq) ocNew(); renderOcAnalysis(); }
    if (v === 'records') renderRecords();
    if (v === 'export') renderExport();
  }
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) show(b.dataset.view); });
  store.onChange(() => {
    if (view === 'records' && !editing) renderRecords();
    if (view === 'export') renderExport();
    if (quiz && $('result-card').hidden) $('board-info').textContent = `第${store.answers.length + 1}問 ・ ディーラー ${SEAT_JA[quiz.dealer]} ・ バル なし`;
  });

  // ---------------------------------------------------------------
  // 対戦：AI3体（北＝相方、東・西＝敵）を相手にビッドする
  // ---------------------------------------------------------------
  let match = null;
  function matchStart() {
    const hands = E.deal(), dealer = E.SEATS[Math.floor(Math.random() * 4)];
    match = { hands, dealer, auction: [], log: [], done: false, saved: false };
    $('m-save-msg').textContent = '';
    matchAdvance();
  }
  function matchAdvance() {
    const d = E.SEATS.indexOf(match.dealer);
    while (!E.isOver(match.auction) && match.auction.length < 60) {
      const seat = E.SEATS[(d + match.auction.length) % 4];
      if (seat === 'S') break;
      let r;
      try { r = E.callFor(match.hands, seat, match.auction, match.dealer, seat === 'N' ? examplesFrom(store.answers) : null); }
      catch (e) { r = { call: 'P', why: 'エラーのためパス' }; }
      if (!E.legalInAuction(r.call, match.auction, match.dealer)) r = { call: 'P', why: '（合法でないビッドになったのでパス）' };
      match.log.push({ seat, call: r.call, why: r.why });
      match.auction.push(r.call);
    }
    match.done = E.isOver(match.auction);
    renderMatch();
  }
  function matchBid(call) {
    let ai = null;
    try { ai = E.callFor(match.hands, 'S', match.auction, match.dealer, examplesFrom(store.answers)); } catch (e) { ai = { call: '?', why: '' }; }
    match.log.push({ seat: 'S', call, ai: ai.call, aiWhy: ai.why, aiSource: ai.source, before: match.auction.slice() });
    match.auction.push(call);
    matchAdvance();
  }
  function contractText(c) {
    if (!c) return 'パスアウト';
    return `${c.level}${c.strain === 'N' ? 'NT' : E.SYM[c.strain]}${c.doubled === 2 ? ' リダブル' : c.doubled ? ' ダブル' : ''}（${SEAT_JA[c.declarer]}がディクレアラー）`;
  }
  function renderMatch() {
    $('m-info').textContent = `ディーラー ${SEAT_JA[match.dealer]} ・ バル なし`;
    $('m-auction').innerHTML = auctionRows(match.auction, match.dealer, !match.done);
    const ev = E.evaluate(match.hands.S);
    $('m-hand').innerHTML = handHtml(match.hands.S);
    $('m-meta').textContent = `${ev.rawHcp}点（HCP）・補正込み${Math.round(ev.adj * 10) / 10}点 ・ ${E.SUITS.map(s => ev.len[s]).join('-')}`;
    $('m-answer').hidden = match.done;
    $('m-result').hidden = !match.done;
    if (!match.done) {
      let html = '';
      for (let lv = 1; lv <= 7; lv++) for (const s of ['C', 'D', 'H', 'S', 'N']) {
        const c = lv + s, ok = E.legalInAuction(c, match.auction, match.dealer);
        html += `<button class="bid" data-call="${c}" ${ok ? '' : 'disabled'} aria-label="${E.callText(c)}">${callHtml(c)}</button>`;
      }
      html += `<button class="bid pass" data-call="P">パス</button>`;
      if (E.legalInAuction('X', match.auction, match.dealer)) html += `<button class="bid pass" data-call="X">ダブル</button>`;
      if (E.legalInAuction('XX', match.auction, match.dealer)) html += `<button class="bid pass" data-call="XX">リダブル</button>`;
      $('m-bbox').innerHTML = html;
      return;
    }
    const c = E.contractOf(match.auction, match.dealer);
    const box = (seat, cls) => `<div class="${cls}"><div class="seat">${SEAT_JA[seat]}${seat === 'S' ? '（自分）' : seat === 'N' ? '（相方AI）' : '（AI）'} ${E.evaluate(match.hands[seat]).rawHcp}点</div>${handShort(match.hands[seat])}</div>`;
    let html = `<p style="margin:0 0 8px"><b>最終コントラクト：</b>${contractText(c)}</p>`;
    html += `<div class="compass">${box('N', 'n')}${box('W', 'w')}${box('E', 'e')}${box('S', 's')}</div>`;
    html += '<p class="label" style="margin:10px 0 4px">ビッドの流れ</p><div class="mlog">';
    for (const x of match.log) {
      if (x.seat === 'S') {
        const same = x.ai === x.call;
        html += `<div class="${same ? '' : 'diff'}"><b>南（自分）</b> ${callHtml(x.call)}${same ? '（AIと同じ）' : ` ／ AIなら ${callHtml(x.ai)}：${esc(x.aiWhy || '')}`}</div>`;
      } else html += `<div><b>${SEAT_JA[x.seat]}</b> ${callHtml(x.call)}：${esc(x.why || '')}</div>`;
    }
    html += '</div>';
    $('m-result-body').innerHTML = html;
    $('m-save').disabled = match.saved || !match.log.some(x => x.seat === 'S');
    matchScore(match);
  }
  // 採点：ダブルダミー（敵の手の配り直し・ルールのオープニングリード・ぎりぎりのコントラクトの成功率の割引）
  let ddsLoading = null;
  function loadDDS() {
    if (window.create_dds_module) return Promise.resolve();
    if (!ddsLoading) ddsLoading = new Promise((ok, ng) => { window.DDS_BASE = 'vendor/'; const sc = document.createElement('script'); sc.src = 'vendor/dds.js'; sc.onload = ok; sc.onerror = () => ng(new Error('ソルバーを読み込めませんでした')); document.head.appendChild(sc); });
    return ddsLoading;
  }
  async function matchScore(m) {
    if (m.scored || !window.BridgeScore || !window.BridgeDDS) { if (!window.BridgeScore) $('m-score').textContent = ''; return; }
    m.scored = true;
    const box = $('m-score');
    box.textContent = '採点中…（ダブルダミー。敵の手を配り直して平均します）';
    try {
      await loadDDS();
      const S = window.BridgeScore, solve = window.BridgeDDS.solve, opts = { layouts: 8 };
      const c = E.contractOf(m.auction, m.dealer);
      const decSide = c ? (c.declarer === 'N' || c.declarer === 'S' ? 'NS' : 'EW') : 'NS';
      const actual = c ? await S.evalContract(solve, m.hands, c, m.auction, m.dealer, opts) : { exp: 0, pMake: 0, tricks: 0 };
      const best = await S.bestFor(solve, m.hands, decSide, m.auction, m.dealer, opts);
      if (match !== m) return;
      const bestExp = Math.max(best.exp, 0), same = c && best.c && best.c.level === c.level && best.c.strain === c.strain;
      const loss = same ? 0 : S.imps(bestExp - actual.exp);
      const nsSign = decSide === 'NS' ? 1 : -1, ours = decSide === 'NS';
      const ct = x => x ? `${x.level}${x.strain === 'N' ? 'NT' : E.SYM[x.strain]}${x.doubled === 2 ? 'XX' : x.doubled ? 'X' : ''}（${SEAT_JA[x.declarer]}）` : 'パスアウト';
      box.innerHTML = `<b>採点</b>（${ours ? '南北' : '東西'}から見て）：${c ? `${ct(c)} の期待得点 ${Math.round(actual.exp)}、成功率${Math.round(actual.pMake * 100)}%、平均${actual.tricks.toFixed(1)}トリック` : 'パスアウト'}。`
        + (best.c ? `一番良いのは ${ct(best.c)}（期待得点 ${Math.round(bestExp)}）。` : '')
        + (loss > 0 ? `<b>${ours ? '南北' : '東西'}は約${loss}IMP損</b>` : ' ほぼ最善')
        + `<br><span class="muted">南北の得点で：${Math.round(nsSign * actual.exp)}</span>`;
    } catch (e) { box.textContent = '採点できませんでした（' + (e.message || e) + '）'; }
  }
  $('m-bbox').addEventListener('click', e => { const b = e.target.closest('.bid'); if (!b || b.disabled || !match || match.done) return; matchBid(b.dataset.call); });
  $('m-new').addEventListener('click', () => matchStart());
  $('m-next').addEventListener('click', () => matchStart());
  $('m-save').addEventListener('click', async () => {
    if (!match || match.saved) return;
    $('m-save').disabled = true;
    try {
      for (const x of match.log.filter(x => x.seat === 'S')) {
        const doc = {
          id: newId(), created: new Date().toISOString(), engine: E.ENGINE_VERSION, from: 'match',
          dealer: match.dealer, vul: 'None', deal: E.dealToPbn(match.hands, 'N'), auction: x.before, seat: 'S',
          userCall: x.call, reason: '', doubt: false, aiCall: x.ai, aiWhy: x.aiWhy || '', aiSource: x.aiSource || '', aiRule: null,
          features: E.exampleFeatures(match.hands.S, x.before, match.dealer), status: 'active',
        };
        await store.add(doc);
      }
      match.saved = true;
      $('m-save-msg').textContent = '自分のビッドを記録に保存しました（「回答を取り込んで分析して」で使えます）';
    } catch (e) { $('m-save-msg').textContent = '保存できませんでした：' + (e.message || e); $('m-save').disabled = false; }
  });

  // 最初の問題作りは画面を出してから行う（読み込み中に止まって見えないように）
  $('board-info').textContent = '問題を作っています…';
  setTimeout(() => { try { newQuiz(); } catch (e) { showFatal('問題の作成', e); } }, 0);
  store.init().catch(e => showFatal('記録の読み込み', e));
})();

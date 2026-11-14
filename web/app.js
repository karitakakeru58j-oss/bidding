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
  function makeQuiz(filter) {
    const examples = examplesFrom(store.answers);
    for (let t = 0; t < 800; t++) {
      let hands = E.deal();
      let dealer = E.SEATS[Math.floor(Math.random() * 4)];
      const { auction, steps } = E.autoAuction(hands, dealer, examples);
      const allPass = auction.every(c => c === 'P');
      if (allPass && Math.random() < 0.85) continue;
      let points = steps.filter(s => s.seat === 'N' || s.seat === 'S');
      points = points.filter(s => {
        const { seq } = E.analyze(auction.slice(0, s.index), dealer);
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
    const { seq } = E.analyze(quiz.auction, quiz.dealer);
    let html = '';
    for (let lv = 1; lv <= 7; lv++) for (const s of ['C', 'D', 'H', 'S', 'N']) {
      const c = lv + s;
      const ok = E.legal(c, seq);
      html += `<button class="bid" data-call="${c}" aria-pressed="${chosen === c}" ${ok ? '' : 'disabled'} aria-label="${E.callText(c)}">${callHtml(c)}</button>`;
    }
    html += `<button class="bid pass" data-call="P" aria-pressed="${chosen === 'P'}">パス</button>`;
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
      html += `<p style="margin:0">あなたの答えを記録しました。次からは、同じ流れで点数と形がほぼ同じ手なら、AIはあなたの答えに合わせます。</p>`;
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
      out.push(tag('QuizSeat', 'S'), tag('OvercallType', r.type), tag('OvercallBid', E.callPbn(r.call)), tag('OvercallDecision', r.decision ? 'yes' : 'no'),
        tag('LeadDirecting', r.params.lead), tag('GameChance', r.params.game), tag('Competing', r.params.compete), tag('Preemptive', OC.preemptOf(r.call)),
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
    const counts = Object.fromEntries(OC.TYPES.map(t => [t, 0]));
    for (const r of ocStore.items) if (counts[r.type] != null) counts[r.type]++;
    const min = Math.min(...Object.values(counts));
    const want = OC.TYPES.filter(t => counts[t] === min);
    const target = want[Math.floor(Math.random() * want.length)];
    let fallback = null;
    const want4D = target === '1D' && Math.random() < 0.5; // 1♦は♦4枚の手も半分くらい出す
    for (let t = 0; t < 6000; t++) {
      const hands = E.deal();
      const open = E.chooseCall(hands.E, [], 'N').call; // 東の手で1番手のオープンを決める
      if (!/^1[CDHS]$/.test(open)) continue;
      if (OC.ntOvercall(hands.S, open)) continue; // 1NTオーバーコールはルールで決めるので出題しない
      const cand = OC.candidate(hands.S, open);
      if (!cand) continue;
      const q = { hands, dealer: 'E', auction: [open], open, cand };
      if (cand.type === target && (!want4D || hands.S.D.length === 4)) return q;
      if (!fallback) fallback = q;
    }
    return fallback;
  }
  let oq = null, oAns = null;
  function ocNew() {
    oq = makeOcQuiz();
    oAns = { params: {}, decision: null };
    $('oc-reason').value = ''; $('oc-result').hidden = true; $('oc-answer').hidden = false;
    if (!oq) { $('oc-info').textContent = '問題を作れませんでした。もう一度開いてください。'; return; }
    $('oc-info').textContent = `介入の第${ocStore.items.length + 1}問 ・ 東のオープンの直後 ・ バル なし`;
    $('oc-auction').innerHTML = auctionRows(oq.auction, oq.dealer, true);
    const ev = E.evaluate(oq.hands.S);
    $('oc-hand').innerHTML = handHtml(oq.hands.S);
    $('oc-meta').textContent = `${ev.rawHcp}点（HCP）・補正込み${Math.round(ev.adj * 10) / 10}点 ・ ${E.SUITS.map(s => ev.len[s]).join('-')}`;
    $('oc-cand').innerHTML = `候補：<b>${callHtml(oq.cand.call)}</b>（${esc(OC.TYPE_JA[oq.cand.type])}）`;
    renderOcInputs();
  }
  function renderOcInputs() {
    $('oc-params').innerHTML = OC.RATED.map(k => `<div class="prow"><span>${esc(OC.PARAM_JA[k])}</span><div class="seg" data-param="${k}">${
      [1, 2, 3, 4, 5].map(v => `<button aria-pressed="${oAns.params[k] === v}" data-v="${v}" aria-label="${esc(OC.PARAM_JA[k])} ${v}">${v}</button>`).join('')}</div></div>`).join('')
      + `<div class="prow"><span>プリエンプト性 <span class="muted">（${esc(E.callText(oq.cand.call))}で決まる）</span></span><b style="padding-right:8px">${OC.preemptOf(oq.cand.call)}</b></div>`;
    for (const b of document.querySelectorAll('.yn button')) b.setAttribute('aria-pressed', String(oAns.decision === (b.dataset.yn === '1')));
    const ready = OC.RATED.every(k => oAns.params[k]) && oAns.decision !== null;
    $('oc-submit').disabled = !ready;
    $('oc-submit').textContent = ready ? (oAns.decision ? `介入する（${E.callText(oq.cand.call)}）で決定` : '介入しない（パス）で決定') : '評価と判断を入れてください';
  }
  $('oc-params').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    oAns.params[b.closest('.seg').dataset.param] = Number(b.dataset.v); renderOcInputs();
  });
  document.querySelector('.yn').addEventListener('click', e => {
    const b = e.target.closest('button[data-yn]'); if (!b) return;
    oAns.decision = b.dataset.yn === '1'; renderOcInputs();
  });
  $('oc-submit').addEventListener('click', async () => {
    if (!oq) return;
    const ai = OC.decide(oq.hands.S, oq.open); // 保存の前（この回答を学習する前）のAIの判断
    const doc = {
      id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), created: new Date().toISOString(), engine: E.ENGINE_VERSION,
      kind: 'overcall', dealer: oq.dealer, vul: 'None', deal: E.dealToPbn(oq.hands, 'N'), auction: oq.auction.slice(), seat: 'S',
      open: oq.open, type: oq.cand.type, call: oq.cand.call, params: { ...oAns.params, preempt: OC.preemptOf(oq.cand.call) }, decision: oAns.decision,
      reason: $('oc-reason').value.trim(),
      ai: { call: ai.call, params: ai.params ? Object.fromEntries(OC.PARAMS.map(k => [k, Math.round(ai.params[k] * 10) / 10])) : null, p: ai.p != null ? Math.round(ai.p * 100) / 100 : null },
    };
    $('oc-submit').disabled = true;
    try { await ocStore.add(doc); } catch (err) { showSaveError(err); $('oc-submit').disabled = false; return; }
    const yourCall = doc.decision ? doc.call : 'P', same = yourCall === ai.call;
    let html = `<div class="result ${same ? 'same' : 'diff'}"><div class="row"><span class="pill ${same ? 'same' : 'diff'}">${same ? 'AIと同じ判断' : 'AIと違う判断'}</span></div>`;
    html += `<div class="compare"><div><div class="label">あなた</div><div class="bigcall">${callHtml(yourCall)}</div></div><div><div class="label">AI（介入する確率${Math.round((ai.p || 0) * 100)}%）</div><div class="bigcall">${callHtml(ai.call)}</div></div></div>`;
    html += '<table class="ptable"><tr><th>パラメータ</th><th>あなた</th><th>AIの推定</th></tr>' + OC.PARAMS.map(k =>
      `<tr><td>${esc(OC.PARAM_JA[k])}${k === 'preempt' ? '（ビッドで決まる）' : ''}</td><td class="num">${doc.params[k]}</td><td class="num">${ai.params ? (k === 'preempt' ? ai.params[k] : ai.params[k].toFixed(1)) : '–'}</td></tr>`).join('') + '</table>';
    html += '<p class="muted" style="margin:0">この回答はすぐ学習に使われ、下の分析とAIの判断に反映されます。</p></div>';
    $('oc-res').innerHTML = html; $('oc-answer').hidden = true; $('oc-result').hidden = false;
    $('oc-auction').innerHTML = auctionRows(oq.auction.concat([yourCall]), oq.dealer, false);
  });
  $('oc-next').addEventListener('click', ocNew);

  function renderOcAnalysis() {
    const rows = OC.analysis();
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
    }).join('');
    const recent = ocStore.items.slice().reverse().slice(0, 30);
    $('oc-records').innerHTML = recent.length ? recent.map(r => {
      const h = E.pbnToDeal(r.deal).S;
      return `<div class="rec" style="border-bottom:1px solid var(--line);padding:8px 0;display:grid;gap:4px">
        <div class="row spread"><span>(${callHtml(r.open)}) → ${r.decision ? callHtml(r.call) : 'パス'} <span class="muted">${esc(OC.TYPE_JA[r.type])}</span></span>
        <button class="btn small" data-ocdel="${esc(r.id)}">消す</button></div>
        <div class="mono">${handShort(h)}</div>
        <div class="muted">${OC.PARAMS.map(k => esc(OC.PARAM_JA[k]) + (k === 'preempt' ? OC.preemptOf(r.call) : r.params[k])).join('・')}${r.reason ? '　「' + esc(r.reason) + '」' : ''}</div></div>`;
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
    for (const name of ['quiz', 'oc', 'records', 'export', 'help']) $('view-' + name).hidden = name !== v;
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

  // 最初の問題作りは画面を出してから行う（読み込み中に止まって見えないように）
  $('board-info').textContent = '問題を作っています…';
  setTimeout(() => { try { newQuiz(); } catch (e) { showFatal('問題の作成', e); } }, 0);
  store.init().catch(e => showFatal('記録の読み込み', e));
})();

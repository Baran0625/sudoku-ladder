/* =========================================================================
 * app.js — 数独アプリのUI/進行ロジック（B版: localStorage + Sheets同期）
 *  依存: sudoku.js（window.Sudoku）
 *
 *  保存するもの（盤面は保存しない。番号からseed再生成）:
 *   sudoku:clearedUpTo        … クリア済みの最大番号（次の未クリア＝+1）
 *   sudoku:records            … { [番号]: {cleared, bestMs, bestMistakes, bestHints, plays} }
 *   sudoku:userKey            … 合い言葉（端末間で進捗を共有するキー）
 *
 *  同期方針:
 *   - 起動時: doGet で取得 → ローカルとマージ（進んでる方・良い方を採用）
 *     → ローカル保存＋リモートへも書き戻し
 *   - クリア時: ローカル保存に加え doPost 送信（失敗してもゲームは止めない）
 *   - オフラインでも通常プレイ可。同期は「できたら反映」。
 * ======================================================================= */
(function () {
  "use strict";
  const S = window.Sudoku;

  /* ---- 同期設定 ------------------------------------------------------- */
  const API_URL = "https://script.google.com/macros/s/AKfycbyx5rzJkTJ2NYC6I95zp5nVoS7AS8RQkTD4tbfS9_pl8z1MKX5CjH8mck-JLSZ1od_b/exec";

  const LS_CLEARED = "sudoku:clearedUpTo";
  const LS_RECORDS = "sudoku:records";
  const LS_USERKEY = "sudoku:userKey";
  const SCHEMA = "B1";

  /* ---- 合い言葉（ユーザーキー）--------------------------------------- */
  function getUserKey() { return localStorage.getItem(LS_USERKEY) || ""; }
  function setUserKey(k) { localStorage.setItem(LS_USERKEY, k); }
  function isValidKey(k) { return /^[A-Za-z0-9-]{1,40}$/.test(k || ""); }

  /* ---- 保存の読み書き（壊れていても落ちない） -------------------------- */
  function loadRecords() {
    try { return JSON.parse(localStorage.getItem(LS_RECORDS) || "{}"); }
    catch { return {}; }
  }
  function saveRecords(r) { localStorage.setItem(LS_RECORDS, JSON.stringify(r)); }
  function clearedUpTo() {
    const n = parseInt(localStorage.getItem(LS_CLEARED) || "0", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  function setClearedUpTo(n) { localStorage.setItem(LS_CLEARED, String(n)); }

  /* ---- マージ（Nodeで検証済み: 進捗は最大, 記録はベストを採用）-------- */
  function mergeRecords(a, b) {
    const out = {}, keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const x = (a || {})[k], y = (b || {})[k];
      if (!x) { out[k] = y; continue; }
      if (!y) { out[k] = x; continue; }
      out[k] = {
        cleared: !!(x.cleared || y.cleared),
        bestMs: Math.min(x.bestMs ?? Infinity, y.bestMs ?? Infinity),
        bestMistakes: Math.min(x.bestMistakes ?? Infinity, y.bestMistakes ?? Infinity),
        bestHints: Math.min(x.bestHints ?? Infinity, y.bestHints ?? Infinity),
        plays: Math.max(x.plays || 0, y.plays || 0),
      };
    }
    return out;
  }

  /* ---- リモート通信（失敗しても throw しない）----------------------- */
  async function remoteLoad(key) {
    if (!API_URL || !isValidKey(key)) return null;
    try {
      const res = await fetch(`${API_URL}?u=${encodeURIComponent(key)}`, { method: "GET" });
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch { return null; }
  }
  async function remotePush(key) {
    if (!API_URL || !isValidKey(key)) return false;
    const payload = { u: key, clearedUpTo: clearedUpTo(), records: loadRecords() };
    try {
      // CORSプリフライト回避のため text/plain で送る（GAS側でJSONパース）
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return !!(data && data.ok);
    } catch { return false; }
  }

  /* ---- 起動時同期: リモート取得 → マージ → ローカル保存 → 書き戻し ---- */
  async function syncOnStart(key) {
    const remote = await remoteLoad(key);
    if (remote) {
      const mergedCleared = Math.max(clearedUpTo(), remote.clearedUpTo | 0);
      const mergedRecords = mergeRecords(loadRecords(), remote.records || {});
      setClearedUpTo(mergedCleared);
      saveRecords(mergedRecords);
    }
    // ローカル(またはマージ結果)をリモートへ書き戻し（ローカルだけ進んでいた分を反映）
    await remotePush(key);
  }

  /* ---- 状態 ----------------------------------------------------------- */
  let cur = null; // { number, puzzle, solution, given[], grid[], notes[], mistakes, hints, startMs, timerId, solved }
  let selected = -1;
  let noteMode = false;

  /* ---- DOM ------------------------------------------------------------ */
  const $ = sel => document.querySelector(sel);
  const boardEl = $("#board");
  const padEl = $("#pad");
  const timerEl = $("#timer");
  const mistakesEl = $("#mistakes");
  const hintsEl = $("#hints");
  const bandEl = $("#band");
  const puzzleNoEl = $("#puzzleNo");
  const progressEl = $("#progress");
  const noteBtn = $("#noteBtn");
  const toastEl = $("#toast");

  /* ---- ユーティリティ -------------------------------------------------- */
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function toast(msg, ms = 1800) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  /* ---- パズルを開く ---------------------------------------------------- */
  function openPuzzle(number) {
    if (cur && cur.timerId) clearInterval(cur.timerId);
    const gen = S.generatePuzzle(number);
    cur = {
      number,
      puzzle: gen.puzzle,
      solution: gen.solution,
      given: gen.puzzle.map(v => v !== 0),
      grid: gen.puzzle.slice(),
      notes: Array.from({ length: 81 }, () => new Set()),
      mistakes: 0, hints: 0,
      startMs: Date.now(), timerId: null, solved: false,
    };
    selected = -1; noteMode = false; noteBtn.classList.remove("on");
    bandEl.textContent = gen.band;
    puzzleNoEl.textContent = "#" + number;
    mistakesEl.textContent = "0";
    hintsEl.textContent = "0";
    cur.timerId = setInterval(() => {
      if (!cur.solved) timerEl.textContent = fmtTime(Date.now() - cur.startMs);
    }, 250);
    timerEl.textContent = "00:00";
    renderBoard();
    renderPad();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---- 盤面描画 -------------------------------------------------------- */
  function renderBoard() {
    boardEl.innerHTML = "";
    for (let i = 0; i < 81; i++) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.dataset.i = i;
      const r = Math.floor(i / 9), c = i % 9;
      if (c % 3 === 2 && c !== 8) cell.classList.add("br");
      if (r % 3 === 2 && r !== 8) cell.classList.add("bb");
      cell.addEventListener("click", () => selectCell(i));
      boardEl.appendChild(cell);
    }
    paintBoard();
  }

  function paintBoard() {
    const cells = boardEl.children;
    const selVal = selected >= 0 ? cur.grid[selected] : 0;
    for (let i = 0; i < 81; i++) {
      const el = cells[i];
      const v = cur.grid[i];
      el.classList.toggle("given", cur.given[i]);
      el.classList.toggle("selected", i === selected);
      // 関連（同じ行/列/箱）ハイライト
      const related = selected >= 0 &&
        (Math.floor(i / 9) === Math.floor(selected / 9) ||
         i % 9 === selected % 9 ||
         (Math.floor(Math.floor(i / 9) / 3) === Math.floor(Math.floor(selected / 9) / 3) &&
          Math.floor((i % 9) / 3) === Math.floor((selected % 9) / 3)));
      el.classList.toggle("related", related && i !== selected);
      // 同じ数字を強調
      el.classList.toggle("same", selVal !== 0 && v === selVal);
      // 競合（同ピアに同値）
      el.classList.toggle("conflict", v !== 0 && hasConflict(i));

      if (v !== 0) {
        el.textContent = v;
        el.classList.remove("has-notes");
      } else if (cur.notes[i].size) {
        el.textContent = "";
        el.classList.add("has-notes");
        const grid = document.createElement("div");
        grid.className = "notes";
        for (let n = 1; n <= 9; n++) {
          const s = document.createElement("span");
          s.textContent = cur.notes[i].has(n) ? n : "";
          grid.appendChild(s);
        }
        el.appendChild(grid);
      } else {
        el.textContent = "";
        el.classList.remove("has-notes");
      }
    }
  }

  function hasConflict(i) {
    const v = cur.grid[i];
    if (v === 0) return false;
    const r = Math.floor(i / 9), c = i % 9;
    for (let j = 0; j < 81; j++) {
      if (j === i || cur.grid[j] !== v) continue;
      const rr = Math.floor(j / 9), cc = j % 9;
      if (rr === r || cc === c ||
          (Math.floor(rr / 3) === Math.floor(r / 3) && Math.floor(cc / 3) === Math.floor(c / 3)))
        return true;
    }
    return false;
  }

  function selectCell(i) { selected = i; paintBoard(); }

  /* ---- 数字入力 -------------------------------------------------------- */
  function inputValue(v) {
    if (selected < 0 || cur.given[selected] || cur.solved) return;
    if (noteMode && v !== 0) {
      const set = cur.notes[selected];
      set.has(v) ? set.delete(v) : set.add(v);
      cur.grid[selected] = 0;
    } else {
      cur.notes[selected].clear();
      if (v === 0) {
        cur.grid[selected] = 0;
      } else {
        cur.grid[selected] = v;
        // 誤り数のカウント（解と違えばミス）— 学習用の軽い判定
        if (v !== cur.solution[selected]) {
          cur.mistakes++; mistakesEl.textContent = cur.mistakes;
        }
      }
    }
    paintBoard();
    checkSolved();
  }

  /* ---- ヒント（選択セルに正解を1つ入れる）----------------------------- */
  function giveHint() {
    if (selected < 0 || cur.given[selected] || cur.solved) {
      toast("空きマスを選んでからヒントを押してください"); return;
    }
    cur.notes[selected].clear();
    cur.grid[selected] = cur.solution[selected];
    cur.hints++; hintsEl.textContent = cur.hints;
    paintBoard();
    checkSolved();
  }

  /* ---- クリア判定 ------------------------------------------------------ */
  function checkSolved() {
    for (let i = 0; i < 81; i++) if (cur.grid[i] !== cur.solution[i]) return;
    cur.solved = true;
    clearInterval(cur.timerId);
    const ms = Date.now() - cur.startMs;
    recordClear(cur.number, ms, cur.mistakes, cur.hints);
    const next = cur.number + 1;
    toast(`#${cur.number} クリア！  ${fmtTime(ms)} / ミス${cur.mistakes} / ヒント${cur.hints}`, 3200);
    renderProgress();
  }

  function recordClear(number, ms, mistakes, hints) {
    const recs = loadRecords();
    const key = String(number);
    const prev = recs[key] || { cleared: false, bestMs: Infinity, bestMistakes: Infinity, bestHints: Infinity, plays: 0 };
    recs[key] = {
      cleared: true,
      bestMs: Math.min(prev.bestMs ?? Infinity, ms),
      bestMistakes: Math.min(prev.bestMistakes ?? Infinity, mistakes),
      bestHints: Math.min(prev.bestHints ?? Infinity, hints),
      plays: (prev.plays || 0) + 1,
    };
    saveRecords(recs);
    if (number > clearedUpTo()) setClearedUpTo(number); // 連番アンロック
    // リモート保存（失敗してもローカルには残るのでゲームは止めない）
    const uKey = getUserKey();
    if (uKey) remotePush(uKey).then(ok => { if (!ok) toast("同期に失敗（進捗はこの端末に保存済み）"); });
  }

  /* ---- 進捗グリッド（クリア済み＝再挑戦可 / 次の1問＝解放）------------- */
  function renderProgress() {
    const recs = loadRecords();
    const done = clearedUpTo();
    const next = done + 1;
    const showUpTo = Math.max(next, done + 1);
    progressEl.innerHTML = "";
    for (let n = 1; n <= showUpTo; n++) {
      const rec = recs[String(n)];
      const tile = document.createElement("button");
      tile.className = "ptile";
      const band = S.bandFor(n);
      if (rec && rec.cleared) {
        tile.classList.add("cleared");
        tile.innerHTML = `<span class="pn">#${n}</span><span class="pb">${band.name}</span>` +
          `<span class="pt">${fmtTime(rec.bestMs)}</span>`;
        tile.title = `ベスト ${fmtTime(rec.bestMs)} / ミス${rec.bestMistakes} / ヒント${rec.bestHints} / ${rec.plays}回`;
        tile.addEventListener("click", () => openPuzzle(n));
      } else if (n === next) {
        tile.classList.add("current");
        tile.innerHTML = `<span class="pn">#${n}</span><span class="pb">${band.name}</span><span class="pt">挑戦する</span>`;
        tile.addEventListener("click", () => openPuzzle(n));
      } else {
        tile.classList.add("locked");
        tile.innerHTML = `<span class="pn">#${n}</span><span class="pb">🔒</span>`;
        tile.disabled = true;
      }
      progressEl.appendChild(tile);
    }
  }

  /* ---- 数字パッド ------------------------------------------------------ */
  function renderPad() {
    padEl.innerHTML = "";
    for (let v = 1; v <= 9; v++) {
      const b = document.createElement("button");
      b.className = "key"; b.textContent = v;
      b.addEventListener("click", () => inputValue(v));
      padEl.appendChild(b);
    }
    const erase = document.createElement("button");
    erase.className = "key erase"; erase.textContent = "消す";
    erase.addEventListener("click", () => inputValue(0));
    padEl.appendChild(erase);
  }

  /* ---- キーボード操作 -------------------------------------------------- */
  function onKey(e) {
    if (!cur) return;
    if (e.key >= "1" && e.key <= "9") { inputValue(parseInt(e.key, 10)); return; }
    if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") { inputValue(0); return; }
    if (e.key === "n" || e.key === "N") { toggleNote(); return; }
    const move = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (move !== undefined && selected >= 0) {
      const t = selected + move;
      if (t >= 0 && t < 81 &&
         !(move === -1 && selected % 9 === 0) && !(move === 1 && selected % 9 === 8)) {
        selectCell(t); e.preventDefault();
      }
    }
  }

  function toggleNote() {
    noteMode = !noteMode;
    noteBtn.classList.toggle("on", noteMode);
  }

  /* ---- 合い言葉のUI（ヘッダー表示＋入力/変更）------------------------ */
  function refreshKeyUI() {
    const el = $("#keyLabel");
    if (!el) return;
    const k = getUserKey();
    el.textContent = k ? `🔑 ${k}` : "🔑 未設定";
  }
  function promptKey(initial) {
    const cur = getUserKey();
    const msg = initial
      ? "端末間で進捗を共有する合い言葉を入力してください。\n（別の端末でも同じ合い言葉を入れると進捗が引き継がれます）\n英数字とハイフン, 1〜40文字。"
      : "合い言葉を変更します。新しい合い言葉を入力してください。";
    const input = window.prompt(msg, cur);
    if (input === null) return false;       // キャンセル
    const k = input.trim();
    if (!isValidKey(k)) { toast("英数字とハイフンのみ・1〜40文字で入力してください"); return false; }
    setUserKey(k);
    refreshKeyUI();
    return true;
  }
  async function changeKeyFlow() {
    if (!promptKey(false)) return;
    toast("合い言葉を変更しました。進捗を同期します…");
    await syncOnStart(getUserKey());
    setClearedUpTo(clearedUpTo());
    renderProgress();
    openPuzzle(clearedUpTo() + 1);
  }

  /* ---- 起動 ------------------------------------------------------------ */
  async function init() {
    noteBtn.addEventListener("click", toggleNote);
    $("#hintBtn").addEventListener("click", giveHint);
    $("#restartBtn").addEventListener("click", () => { if (cur) openPuzzle(cur.number); });
    const keyBtn = $("#keyBtn");
    if (keyBtn) keyBtn.addEventListener("click", changeKeyFlow);
    document.addEventListener("keydown", onKey);

    // 合い言葉が未設定なら初回入力を促す（未設定でもオフラインでは遊べる）
    if (!getUserKey()) promptKey(true);
    refreshKeyUI();

    // まず今の進捗で描画（オフラインでも即プレイ可）
    renderProgress();
    openPuzzle(clearedUpTo() + 1);

    // 合い言葉があれば裏で同期し、済んだら反映
    const key = getUserKey();
    if (key) {
      await syncOnStart(key);
      renderProgress();
      // 同期で解放数が増えていたら、次の未クリアへ開き直す（未着手時のみ）
      if (cur && !cur.solved && cur.grid.every((v, i) => v === cur.puzzle[i])) {
        openPuzzle(clearedUpTo() + 1);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
  window.__sudokuApp = { openPuzzle, loadRecords, clearedUpTo, syncOnStart, getUserKey }; // デバッグ用
})();

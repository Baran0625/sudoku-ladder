/* =========================================================================
 * app.js — 数独アプリのUI/進行ロジック（A版: localStorage保存）
 *  依存: sudoku.js（window.Sudoku）
 *
 *  保存するもの（盤面は保存しない。番号からseed再生成）:
 *   sudoku:clearedUpTo        … クリア済みの最大番号（次の未クリア＝+1）
 *   sudoku:records            … { [番号]: {cleared, bestMs, bestMistakes, bestHints, plays} }
 * ======================================================================= */
(function () {
  "use strict";
  const S = window.Sudoku;
  const LS_CLEARED = "sudoku:clearedUpTo";
  const LS_RECORDS = "sudoku:records";
  const SCHEMA = "A1"; // 保存形式のバージョン（将来のB移行の目印）

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

  /* ---- 起動 ------------------------------------------------------------ */
  function init() {
    noteBtn.addEventListener("click", toggleNote);
    $("#hintBtn").addEventListener("click", giveHint);
    $("#restartBtn").addEventListener("click", () => { if (cur) openPuzzle(cur.number); });
    document.addEventListener("keydown", onKey);
    renderProgress();
    openPuzzle(clearedUpTo() + 1); // 次の未クリアを開く
  }

  document.addEventListener("DOMContentLoaded", init);
  window.__sudokuApp = { openPuzzle, loadRecords, clearedUpTo }; // デバッグ用
})();

/* =========================================================================
 * sudoku.js  —  生成 + 一意解チェック + 難易度判定 + 番号→難易度帯
 *
 * 設計方針:
 *  - 盤面は保存しない。seed = f(パズル番号) から決定論的に再生成する。
 *    → 同じ番号は常に同じ問題（再挑戦で完全一致）。
 *  - 難易度は「ヒント数」ではなく「必要な解法テクニック」で決める。
 *    v1 は軽量判定（single だけで解けるか）＋ヒント数。あとで強化可能。
 *  - 番号→難易度は BANDS テーブルに外出し。
 *    問題追加 = 番号を伸ばすだけ / カーブ調整 = このテーブルを編集するだけ。
 *
 * Node でもブラウザでも動く（末尾の export 参照）。
 * ======================================================================= */

/* ---- 難易度帯テーブル（ここだけ編集すればカーブが変わる）---------------
 * from: この帯が始まるパズル番号（1始まり, 昇順）
 * name: 表示名
 * tech: 到達すべき難易度クラス
 *        'single' = naked/hidden single だけで解ける
 *        'beyond' = single だけでは解けない（locked candidates 以上が必要）
 * clues: 目標ヒント数の範囲 [min, max]（目安。一意解を優先し多少ずれても可）
 *
 * 「急カーブ・各帯5問前後」。最後の帯は from 以降すべてを担当（上限なし）。
 * → 問題を無限に足せる。帯を増やしたければ行を追加するだけ。
 * --------------------------------------------------------------------- */
const BANDS = [
  { from: 1,  name: "入門",   tech: "single", clues: [40, 45] },
  { from: 6,  name: "易",     tech: "single", clues: [36, 40] },
  { from: 11, name: "中",     tech: "beyond", clues: [32, 36] },
  { from: 16, name: "難",     tech: "beyond", clues: [28, 32] },
  { from: 21, name: "上級",   tech: "beyond", clues: [24, 30] },
  // 例: さらに足すなら → { from: 41, name: "鬼", tech: "beyond", clues: [22, 26] },
];

function bandFor(number) {
  let b = BANDS[0];
  for (const cand of BANDS) if (number >= cand.from) b = cand;
  return b;
}

/* ---- 決定論的乱数（seedあり）------------------------------------------ */
function hashString(str) {
  let h = 2166136261 >>> 0;               // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---- 盤面ユーティリティ（81要素の配列, 0=空）------------------------- */
const IDX = { row: i => (i / 9) | 0, col: i => i % 9, box: i => (((i / 9) | 0 / 3) | 0) };
function rowOf(i) { return (i / 9) | 0; }
function colOf(i) { return i % 9; }
function boxOf(i) { return Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3); }

// 各セルの「同じ行/列/箱」に属するピア一覧（前計算）
const PEERS = (() => {
  const peers = Array.from({ length: 81 }, () => new Set());
  for (let i = 0; i < 81; i++) {
    for (let j = 0; j < 81; j++) {
      if (i === j) continue;
      if (rowOf(i) === rowOf(j) || colOf(i) === colOf(j) || boxOf(i) === boxOf(j)) {
        peers[i].add(j);
      }
    }
  }
  return peers.map(s => Array.from(s));
})();

function canPlace(grid, i, v) {
  for (const p of PEERS[i]) if (grid[p] === v) return false;
  return true;
}

/* ---- 完成解の生成（バックトラック, seed順）--------------------------- */
function generateSolution(rng) {
  const grid = new Array(81).fill(0);
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  function fill(pos) {
    if (pos === 81) return true;
    if (grid[pos] !== 0) return fill(pos + 1);
    const order = shuffleInPlace(nums.slice(), rng);
    for (const v of order) {
      if (canPlace(grid, pos, v)) {
        grid[pos] = v;
        if (fill(pos + 1)) return true;
        grid[pos] = 0;
      }
    }
    return false;
  }
  fill(0);
  return grid;
}

/* ---- 解の個数を数える（2つ見つけたら打ち切り = 一意解判定用）--------- */
function countSolutions(puzzle, limit = 2) {
  const grid = puzzle.slice();
  let count = 0;
  function pickCell() {
    // 候補数が最小の空セルを選ぶ（枝刈り）
    let best = -1, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (grid[i] !== 0) continue;
      let n = 0;
      for (let v = 1; v <= 9; v++) if (canPlace(grid, i, v)) n++;
      if (n < bestN) { bestN = n; best = i; if (n <= 1) break; }
    }
    return best;
  }
  function solve() {
    const i = pickCell();
    if (i === -1) { count++; return; }
    for (let v = 1; v <= 9 && count < limit; v++) {
      if (canPlace(grid, i, v)) {
        grid[i] = v;
        solve();
        grid[i] = 0;
      }
    }
  }
  solve();
  return count;
}

/* ---- single だけで解けるか（v1の難易度判定コア）----------------------
 * naked single: 候補が1つのセルを埋める
 * hidden single: ある行/列/箱で、その値を置ける空セルが1つだけ
 * 進まなくなったら終了。全部埋まれば true。
 * -------------------------------------------------------------------- */
function solvableBySingles(puzzle) {
  const grid = puzzle.slice();
  function candidates(i) {
    const c = [];
    for (let v = 1; v <= 9; v++) if (canPlace(grid, i, v)) c.push(v);
    return c;
  }
  let progress = true;
  while (progress) {
    progress = false;
    // naked single
    for (let i = 0; i < 81; i++) {
      if (grid[i] !== 0) continue;
      const c = candidates(i);
      if (c.length === 0) return false;         // 矛盾（起きない想定だが安全に）
      if (c.length === 1) { grid[i] = c[0]; progress = true; }
    }
    if (progress) continue;
    // hidden single（行・列・箱の3種のユニットで）
    const units = [];
    for (let r = 0; r < 9; r++) units.push([...Array(9)].map((_, c) => r * 9 + c));
    for (let c = 0; c < 9; c++) units.push([...Array(9)].map((_, r) => r * 9 + c));
    for (let b = 0; b < 9; b++) {
      const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3, cells = [];
      for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) cells.push((br + dr) * 9 + (bc + dc));
      units.push(cells);
    }
    for (const unit of units) {
      for (let v = 1; v <= 9; v++) {
        let spot = -1, cnt = 0;
        for (const i of unit) {
          if (grid[i] === 0 && canPlace(grid, i, v)) { spot = i; cnt++; }
          else if (grid[i] === v) { cnt = -1; break; }   // 既に確定
        }
        if (cnt === 1) { grid[spot] = v; progress = true; }
      }
    }
  }
  return grid.every(v => v !== 0);
}

/* ---- パズル生成（一意解を保ちながらセルを掘る）---------------------- */
function digPuzzle(solution, targetClues, rng) {
  const puzzle = solution.slice();
  const order = shuffleInPlace([...Array(81).keys()], rng);
  let clues = 81;
  for (const i of order) {
    if (clues <= targetClues) break;
    const backup = puzzle[i];
    if (backup === 0) continue;
    puzzle[i] = 0;
    if (countSolutions(puzzle, 2) !== 1) puzzle[i] = backup; // 一意でなくなるなら戻す
    else clues--;
  }
  return puzzle;
}

/* ---- 番号 → その番号の問題（決定論的・帯の難易度に合わせる）--------- */
function generatePuzzle(number) {
  const band = bandFor(number);
  const [cmin, cmax] = band.clues;
  const targetClues = Math.round((cmin + cmax) / 2);

  const MAX_ATTEMPTS = 60;
  let fallback = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = mulberry32(hashString(`sudoku-v1|#${number}|a${attempt}`));
    const solution = generateSolution(rng);
    const puzzle = digPuzzle(solution, targetClues, rng);
    const isSingle = solvableBySingles(puzzle);
    const clues = puzzle.filter(v => v !== 0).length;
    const ok = (band.tech === "single") ? isSingle : !isSingle;

    if (fallback === null) fallback = { puzzle, solution, clues, isSingle };
    if (ok && clues >= cmin && clues <= cmax) {
      return { number, band: band.name, tech: band.tech, clues,
               solvableBySingles: isSingle, puzzle, solution, attempt };
    }
  }
  // 目標に完全一致しなくても、決定論的な最善解を返す（v1は破綻させない）
  return { number, band: band.name, tech: band.tech, clues: fallback.clues,
           solvableBySingles: fallback.isSingle, puzzle: fallback.puzzle,
           solution: fallback.solution, attempt: -1 };
}

/* ---- export（Node / ブラウザ両対応）--------------------------------- */
const API = { BANDS, bandFor, generatePuzzle, generateSolution, countSolutions,
              solvableBySingles, hashString, mulberry32 };
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof window !== "undefined") window.Sudoku = API;

/*
 * app.js
 * Wires together: chess.js (rules/PGN) + a Stockfish Worker (MultiPV eval)
 * + classification.js (Book/Correct/Good/Brilliant/Mistake/Blunder) + the DOM.
 *
 * See README.md for why this needs to run from a local server (not
 * double-clicked as a file://) and where to put the engine file.
 */

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const pgnInput = el("pgnInput");
const analyzeBtn = el("analyzeBtn");
const cancelBtn = el("cancelBtn");
const resetBtn = el("resetBtn");
const settingsBtn = el("settingsBtn");
const settingsPanel = el("settingsPanel");
const progressRow = el("progressRow");
const progressFill = el("progressFill");
const progressLabel = el("progressLabel");
const engineStatus = el("engineStatus");
const boardEl = el("board");
const evalBarWhite = el("evalBarWhite");
const evalBarLabel = el("evalBarLabel");
const moveListEl = el("moveList");
const statsBody = el("statsBody");
const legendList = el("legendList");
const turnIndicator = el("turnIndicator");
const filesLabel = el("filesLabel");
const ranksLabel = el("ranksLabel");
const candidatesList = el("candidatesList");
const candidatesTitle = el("candidatesTitle");

const PIECE_GLYPHS = {
  p: "\u265F", n: "\u265E", b: "\u265D", r: "\u265C", q: "\u265B", k: "\u265A",
};

// ---------- Engine wrapper ----------
// Loaded from a local file (see README.md) so there are no cross-origin
// worker/wasm issues. Adjust the path here if you name the file differently.
const ENGINE_PATH = "engine/stockfish-18-lite-single.js";

class EngineClient {
  constructor() {
    this.worker = null;
    this.ready = false;
  }

  async init() {
    return new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(ENGINE_PATH);
      } catch (e) {
        reject(new Error("Could not create engine worker: " + e.message));
        return;
      }
      const onMsg = (e) => {
        const line = e.data;
        if (typeof line === "string" && line.includes("uciok")) {
          this.worker.removeEventListener("message", onMsg);
          this.ready = true;
          resolve();
        }
      };
      this.worker.addEventListener("message", onMsg);
      this.worker.onerror = (err) => reject(new Error("Engine worker error: " + err.message));
      this.worker.postMessage("uci");
    });
  }

  setOption(name, value) {
    this.worker.postMessage(`setoption name ${name} value ${value}`);
  }

  /**
   * Analyze one FEN, returning up to `multipv` candidate moves sorted
   * best-first, each { moveUci, cp, mate }.
   */
  analyze(fen, depth, multipv) {
    return new Promise((resolve) => {
      const lines = new Map(); // multipv index -> {cp, mate, moveUci}
      const onMsg = (e) => {
        const text = e.data;
        if (typeof text !== "string") return;

        if (text.startsWith("info") && text.includes(" pv ")) {
          const mpvMatch = text.match(/multipv (\d+)/);
          const cpMatch = text.match(/score cp (-?\d+)/);
          const mateMatch = text.match(/score mate (-?\d+)/);
          const pvMatch = text.match(/ pv (.+)$/);
          if (mpvMatch && pvMatch) {
            const idx = parseInt(mpvMatch[1], 10);
            const moveUci = pvMatch[1].trim().split(" ")[0];
            const entry = { moveUci };
            if (cpMatch) entry.cp = parseInt(cpMatch[1], 10);
            if (mateMatch) entry.mate = parseInt(mateMatch[1], 10);
            lines.set(idx, entry);
          }
        }

        if (text.startsWith("bestmove")) {
          this.worker.removeEventListener("message", onMsg);
          const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
          resolve(sorted);
        }
      };
      this.worker.addEventListener("message", onMsg);
      this.setOption("MultiPV", multipv);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${depth}`);
    });
  }

  /**
   * Get the exact evaluation of one specific move (used when the played
   * move wasn't among the top MultiPV candidates already collected, so
   * we don't have to guess its win% — see classification.js).
   */
  evaluateMove(fen, moveUci, depth) {
    return new Promise((resolve) => {
      let lastScore = null;
      const onMsg = (e) => {
        const text = e.data;
        if (typeof text !== "string") return;
        if (text.startsWith("info") && text.includes(" pv ")) {
          const cpMatch = text.match(/score cp (-?\d+)/);
          const mateMatch = text.match(/score mate (-?\d+)/);
          if (cpMatch) lastScore = { cp: parseInt(cpMatch[1], 10) };
          if (mateMatch) lastScore = { mate: parseInt(mateMatch[1], 10) };
        }
        if (text.startsWith("bestmove")) {
          this.worker.removeEventListener("message", onMsg);
          resolve(lastScore);
        }
      };
      this.worker.addEventListener("message", onMsg);
      // MultiPV 1 here: we only want this single move's own line, not a
      // ranked list, so restrict the search to it directly.
      this.setOption("MultiPV", 1);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${depth} searchmoves ${moveUci}`);
    });
  }

  stopAndTerminate() {
    if (this.worker) {
      try { this.worker.postMessage("stop"); } catch (_) {}
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
}

// ---------- Game-phase detection (material on the board) ----------
// Used to smoothly scale the Brilliant chain length between "early
// game" and "endgame" settings, instead of a move-number cutoff: move
// number alone doesn't reliably say how many pieces are left.
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 }; // kings excluded
const STARTING_MATERIAL = 2 * (8 * 1 + 2 * 3 + 2 * 3 + 2 * 5 + 1 * 9); // = 78

function materialRatioFromFen(fen) {
  const placement = fen.split(" ")[0];
  let total = 0;
  for (const ch of placement) {
    const value = PIECE_VALUES[ch.toLowerCase()];
    if (value) total += value;
  }
  return total / STARTING_MATERIAL;
}

// ---------- Opening explorer (Book detection) ----------// Uses lichess's public Masters explorer. If the network call fails
// (offline, blocked), we fall back to a simple "first few low-eval
// plies" heuristic and say so in the engine status line.
let explorerAvailable = true;

async function isBookPosition(fen, minGames) {
  if (!explorerAvailable) return null; // null = "unknown, use fallback"
  try {
    const url = `https://explorer.lichess.org/masters?fen=${encodeURIComponent(fen)}&topGames=0&moves=0`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("explorer HTTP " + res.status);
    const data = await res.json();
    const total = (data.white || 0) + (data.draws || 0) + (data.black || 0);
    return total >= minGames;
  } catch (e) {
    explorerAvailable = false;
    return null;
  }
}

// ---------- State ----------
let chess = new Chess();
let plies = [];          // { fenBefore, moveUci, moveSan, color, moveNumber, toSquare, fromSquare }
let classified = [];     // parallel array, one Classification result per ply
let fenAtPly = [];       // fenAtPly[i] = fen AFTER ply i is played (fenAtPly[-1] = start)
let gameHeaders = {};    // PGN header tags from the loaded game, for export
let currentPlyView = -1; // -1 = start position
let engine = null;
let cancelRequested = false;

function readSettings() {
  return {
    depth: parseInt(el("depthInput").value, 10) || 18,
    multipv: parseInt(el("multipvInput").value, 10) || 5,
    mistake: parseInt(el("mistakeInput").value, 10) || 10,
    blunder: parseInt(el("blunderInput").value, 10) || 20,
    goodGain: parseInt(el("goodGainInput").value, 10) || 8,
    brilliantEarly: parseInt(el("brilliantEarlyInput").value, 10) || 2,
    brilliantLate: parseInt(el("brilliantLateInput").value, 10) || 2,
    topChainLength: parseInt(el("topChainLengthInput").value, 10) || 2,
    topChainGain: parseInt(el("topChainGainInput").value, 10) || 10,
    minBookGames: 50,
  };
}

// ---------- PGN -> ply list ----------
function buildPlyListFromPgn(pgn) {
  const c = new Chess();
  const ok = c.load_pgn(pgn, { sloppy: true });
  if (!ok) throw new Error("Could not parse this PGN.");
  const history = c.history({ verbose: true });
  const headers = c.header(); // {Event, White, Black, Result, ...} - whatever was present

  const replay = new Chess();
  const list = [];
  const fens = [];
  history.forEach((m, i) => {
    const fenBefore = replay.fen();
    replay.move({ from: m.from, to: m.to, promotion: m.promotion });
    const moveUci = m.from + m.to + (m.promotion || "");
    list.push({
      fenBefore,
      moveUci,
      moveSan: m.san,
      color: m.color, // 'w' | 'b'
      moveNumber: Math.floor(i / 2) + 1,
      fromSquare: m.from,
      toSquare: m.to,
    });
    fens.push(replay.fen());
  });
  return { plies: list, fens, headers };
}

// ---------- Analysis pipeline ----------
async function runAnalysis() {
  const pgn = pgnInput.value.trim();
  if (!pgn) { alert("Paste a PGN first."); return; }

  let parsed;
  try {
    parsed = buildPlyListFromPgn(pgn);
  } catch (e) {
    alert(e.message);
    return;
  }
  plies = parsed.plies;
  fenAtPly = parsed.fens;
  gameHeaders = parsed.headers;
  classified = new Array(plies.length).fill(null);
  cancelRequested = false;

  setBusy(true);
  progressRow.hidden = false;
  explorerAvailable = true;

  const settings = readSettings();

  try {
    engineStatus.textContent = "Engine: loading...";
    engineStatus.className = "engine-status";
    engine = new EngineClient();
    await engine.init();
    engine.setOption("MultiPV", settings.multipv);
    engineStatus.textContent = "Engine: ready";
    engineStatus.className = "engine-status ready";
  } catch (e) {
    engineStatus.textContent = "Engine: failed to load (see README.md)";
    engineStatus.className = "engine-status error";
    alert(e.message + "\n\nSee README.md — you likely need to download the engine file into /engine and serve this folder over http, not open it directly as a file.");
    setBusy(false);
    return;
  }

  let stillInBook = true;

  for (let i = 0; i < plies.length; i++) {
    if (cancelRequested) break;

    progressFill.style.width = `${Math.round((i / plies.length) * 100)}%`;
    progressLabel.textContent = `Move ${i + 1} / ${plies.length}`;

    const ply = plies[i];

    // A position with exactly one legal move (e.g. the only way out of
    // check) involves no real decision, so it's never Book, never
    // engine-analyzed, and never eligible for Good/Brilliant.
    const isForced = new Chess(ply.fenBefore).moves().length === 1;

    let isBook = false;
    if (!isForced && stillInBook) {
      const bookResult = await isBookPosition(ply.fenBefore, settings.minBookGames);
      if (bookResult === true) {
        isBook = true;
      } else if (bookResult === false) {
        stillInBook = false;
      } else {
        // explorer unreachable: fall back to "first 6 plies count as book"
        isBook = i < 6;
        if (i >= 6) stillInBook = false;
      }
    }

    let multipv = [];
    let playedScore = null;
    let matchedCandidate = true; // book/forced default to "reasonable"; see below
    if (!isForced && !isBook) {
      multipv = await engine.analyze(ply.fenBefore, settings.depth, settings.multipv);
      matchedCandidate = multipv.some(m => m.moveUci === ply.moveUci);
      if (!matchedCandidate) {
        // Query the played move's own evaluation directly instead of
        // guessing it, then put MultiPV back for the next position.
        playedScore = await engine.evaluateMove(ply.fenBefore, ply.moveUci, settings.depth);
        engine.setOption("MultiPV", settings.multipv);
      }
    }

    // This player's own win% right after their previous move (2 plies
    // back), used so a "Good" move must be a genuine gain over where
    // they already stood, not just the least-bad option available now.
    // Defaults to a neutral 50 at the very start of the game or right
    // after leaving book (book positions are ~equal by definition).
    const prevOwn = classified[i - 2];
    const baselineWinPercent = (prevOwn && prevOwn.playedWinPercent !== undefined)
      ? prevOwn.playedWinPercent
      : 50;

    const result = Classification.classifyMove(
      { multipv, playedMoveUci: ply.moveUci, isBook, isForced, moverColor: ply.color, playedScore, baselineWinPercent },
      settings
    );

    classified[i] = {
      color: ply.color,
      moveNumber: ply.moveNumber,
      materialRatio: materialRatioFromFen(ply.fenBefore),
      matchedCandidate,
      label: result.label,
      dropPoints: result.dropPoints,
      clusterSize: result.clusterSize,
      gain: result.gain,
      isTopMove: result.isTopMove,
      bestWinPercent: result.bestWinPercent,
      playedWinPercent: result.playedWinPercent,
      // Kept for the "candidates considered here" panel; null for book
      // and forced moves since we didn't run the engine on them.
      candidates: (isBook || isForced) ? null : multipv.map(m => ({
        moveUci: m.moveUci,
        winPercent: Classification.winPercentFromScore(m),
      })),
    };

    renderMoveListRow(i);
  }

  if (!cancelRequested) {
    Classification.upgradeBrilliants(classified, { early: settings.brilliantEarly, late: settings.brilliantLate });
    Classification.markTopMoveChains(classified, { chainLength: settings.topChainLength, minGain: settings.topChainGain });
    renderMoveList();
    renderStats();
    progressFill.style.width = "100%";
    progressLabel.textContent = `Done: ${plies.length} / ${plies.length}`;
    el("exportPgnBtn").disabled = false;
  }

  engine.stopAndTerminate();
  setBusy(false);
  goToPly(plies.length - 1);
}

function setBusy(isBusy) {
  analyzeBtn.disabled = isBusy;
  cancelBtn.disabled = !isBusy;
  pgnInput.disabled = isBusy;
}

function cancelAnalysis() {
  cancelRequested = true;
  if (engine) engine.stopAndTerminate();
  setBusy(false);
  engineStatus.textContent = "Engine: cancelled";
}

function resetAll() {
  cancelAnalysis();
  pgnInput.value = "";
  plies = [];
  classified = [];
  fenAtPly = [];
  gameHeaders = {};
  currentPlyView = -1;
  chess = new Chess();
  progressRow.hidden = true;
  progressFill.style.width = "0%";
  moveListEl.innerHTML = "";
  statsBody.innerHTML = "";
  renderBoard(chess.fen());
  updateEvalBar(null);
  renderCandidates(-1);
  el("exportPgnBtn").disabled = true;
  engineStatus.textContent = "Engine: not loaded";
  engineStatus.className = "engine-status";
}

// ---------- Rendering: board ----------
function renderBoard(fen, lastMove) {
  boardEl.innerHTML = "";
  const rows = fen.split(" ")[0].split("/");
  for (let r = 0; r < 8; r++) {
    let fileIdx = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < parseInt(ch, 10); k++) {
          placeSquare(r, fileIdx, null, lastMove);
          fileIdx++;
        }
      } else {
        placeSquare(r, fileIdx, ch, lastMove);
        fileIdx++;
      }
    }
  }
}

function placeSquare(row, col, pieceChar, lastMove) {
  const square = document.createElement("div");
  const isLight = (row + col) % 2 === 0;
  square.className = `square ${isLight ? "light" : "dark"}`;

  const fileLetter = "abcdefgh"[col];
  const rankNumber = 8 - row;
  const squareName = `${fileLetter}${rankNumber}`;
  if (lastMove) {
    if (squareName === lastMove.fromSquare) square.classList.add("last-from");
    if (squareName === lastMove.toSquare) square.classList.add("last-to");
  }

  if (pieceChar) {
    const isWhite = pieceChar === pieceChar.toUpperCase();
    const glyph = PIECE_GLYPHS[pieceChar.toLowerCase()];
    const span = document.createElement("span");
    span.className = `piece ${isWhite ? "white-piece" : "black-piece"}`;
    span.textContent = glyph;
    square.appendChild(span);
  }

  if (lastMove && squareName === lastMove.toSquare && lastMove.badge) {
    const badge = document.createElement("div");
    badge.className = "badge-overlay";
    badge.style.background = lastMove.badge.color;
    badge.textContent = lastMove.badge.symbol;
    square.appendChild(badge);
  }

  boardEl.appendChild(square);
}

function renderCoordinates() {
  filesLabel.innerHTML = "";
  "abcdefgh".split("").forEach(f => {
    const s = document.createElement("span");
    s.textContent = f;
    filesLabel.appendChild(s);
  });
  ranksLabel.innerHTML = "";
  for (let r = 1; r <= 8; r++) {
    const s = document.createElement("span");
    s.textContent = r;
    ranksLabel.appendChild(s);
  }
}

// ---------- Rendering: eval bar ----------
function updateEvalBar(entry) {
  if (!entry) {
    evalBarWhite.style.height = "50%";
    evalBarLabel.textContent = "0.0";
    return;
  }
  // Convert the mover-perspective win% back to a White-perspective one.
  const whiteWinPercent = entry.color === "w" ? entry.playedWinPercent : 100 - entry.playedWinPercent;
  evalBarWhite.style.height = `${whiteWinPercent}%`;
  evalBarLabel.textContent = `${Math.round(whiteWinPercent)}%`;
}

// ---------- Rendering: move list ----------
function renderMoveList() {
  moveListEl.innerHTML = "";
  for (let i = 0; i < plies.length; i += 2) {
    moveListEl.appendChild(buildMoveRow(i));
  }
}

function renderMoveListRow(i) {
  // incremental render used during analysis (keeps the list live)
  if (i % 2 === 0) {
    moveListEl.appendChild(buildMoveRow(i));
  } else {
    const rows = moveListEl.children;
    const row = rows[rows.length - 1];
    if (row) {
      const blackCell = row.querySelector(".black-ply");
      if (blackCell) fillPlyCell(blackCell, i);
    }
  }
}

function buildMoveRow(i) {
  const li = document.createElement("li");
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = plies[i].moveNumber + ".";
  li.appendChild(num);

  const whiteCell = document.createElement("span");
  whiteCell.className = "ply white-ply";
  fillPlyCell(whiteCell, i);
  li.appendChild(whiteCell);

  const blackCell = document.createElement("span");
  blackCell.className = "ply black-ply";
  if (plies[i + 1]) fillPlyCell(blackCell, i + 1);
  li.appendChild(blackCell);

  return li;
}

function fillPlyCell(cellEl, index) {
  const ply = plies[index];
  const cls = classified[index];
  cellEl.innerHTML = "";
  if (cls) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.style.background = cls.label.color;
    badge.textContent = cls.label.symbol;
    cellEl.appendChild(badge);
  }
  cellEl.appendChild(document.createTextNode(ply.moveSan));
  cellEl.dataset.index = index;
  cellEl.onclick = () => goToPly(index);
}

// ---------- Navigation ----------
function goToPly(index) {
  currentPlyView = index;
  const fen = index < 0 ? new Chess().fen() : fenAtPly[index];
  const ply = index < 0 ? null : plies[index];
  const cls = index < 0 ? null : classified[index];

  const lastMove = ply ? {
    fromSquare: ply.fromSquare,
    toSquare: ply.toSquare,
    badge: cls ? cls.label : null,
  } : null;

  renderBoard(fen, lastMove);
  updateEvalBar(cls);
  renderCandidates(index);

  document.querySelectorAll(".move-list .ply").forEach(elm => elm.classList.remove("active"));
  if (index >= 0) {
    const activeCell = document.querySelector(`.move-list .ply[data-index="${index}"]`);
    if (activeCell) activeCell.classList.add("active");
  }

  const toMove = index < 0 ? "w" : (ply.color === "w" ? "b" : "w");
  turnIndicator.textContent = toMove === "w" ? "White to move" : "Black to move";
}

// Converts a UCI move (e.g. "e2e4", "e7e8q") into SAN (e.g. "e4",
// "e8=Q") for display, using the FEN the move was played from.
function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen);
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
    const move = c.move({ from, to, promotion });
    return move ? move.san : uci;
  } catch (_) {
    return uci;
  }
}

// Shows the candidate moves the engine considered at the position
// BEFORE the currently-viewed ply, so it's clear why a move was scored
// the way it was (e.g. "only these two moves kept an advantage here").
function renderCandidates(index) {
  candidatesList.innerHTML = "";
  if (index < 0 || !plies[index]) {
    candidatesTitle.textContent = "Candidate moves here";
    return;
  }
  const ply = plies[index];
  const cls = classified[index];
  candidatesTitle.textContent = `Candidates before ${ply.moveNumber}${ply.color === "w" ? "." : "..."} ${ply.moveSan}`;

  if (!cls || !cls.candidates) {
    const li = document.createElement("li");
    li.className = "candidate-note";
    if (cls && cls.label.key === "BOOK") li.textContent = "Book move — not engine-analyzed.";
    else if (cls && cls.label.key === "FORCED") li.textContent = "Forced move — only one legal move on the board.";
    else li.textContent = "No data.";
    candidatesList.appendChild(li);
    return;
  }

  cls.candidates.forEach(cand => {
    const li = document.createElement("li");
    li.className = "candidate-row";
    if (cand.moveUci === ply.moveUci) li.classList.add("played");
    const san = document.createElement("span");
    san.className = "candidate-san";
    san.textContent = uciToSan(ply.fenBefore, cand.moveUci);
    const pct = document.createElement("span");
    pct.className = "candidate-pct";
    pct.textContent = `${cand.winPercent.toFixed(1)}%`;
    li.appendChild(san);
    li.appendChild(pct);
    candidatesList.appendChild(li);
  });
}

// ---------- Rendering: stats ----------
const STAT_ORDER = ["BRILLIANT", "GOOD", "CORRECT", "BOOK", "FORCED", "MISTAKE", "BLUNDER"];

function renderStats() {
  const counts = {};
  STAT_ORDER.forEach(k => counts[k] = { w: 0, b: 0 });
  classified.forEach(c => {
    if (!c) return;
    counts[c.label.key][c.color]++;
  });

  statsBody.innerHTML = "";
  STAT_ORDER.forEach(key => {
    const info = Classification.LABELS[key];
    const tr = document.createElement("tr");

    const tdWhite = document.createElement("td");
    tdWhite.textContent = counts[key].w;

    const tdLabel = document.createElement("td");
    tdLabel.className = "label";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = info.color;
    tdLabel.appendChild(dot);
    tdLabel.appendChild(document.createTextNode(`${info.symbol} ${info.name}`));

    const tdBlack = document.createElement("td");
    tdBlack.textContent = counts[key].b;

    tr.appendChild(tdWhite);
    tr.appendChild(tdLabel);
    tr.appendChild(tdBlack);
    statsBody.appendChild(tr);
  });
}

function renderLegend() {
  legendList.innerHTML = "";
  STAT_ORDER.forEach(key => {
    const info = Classification.LABELS[key];
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = info.color;
    li.appendChild(dot);
    li.appendChild(document.createTextNode(`${info.symbol}  ${info.name}`));
    legendList.appendChild(li);
  });
}

// ---------- Export ----------
// Every annotation is wrapped in a standard PGN comment ({ ... }), which
// any compliant PGN parser simply ignores if it doesn't care about it -
// so the exported file stays fully re-importable elsewhere (or back into
// this same tool) while still carrying the classification for reference.
function buildAnnotatedPgn() {
  const lines = [];
  const headers = { ...gameHeaders };
  if (!headers.Event) headers.Event = "?";
  Object.entries(headers).forEach(([k, v]) => lines.push(`[${k} "${v}"]`));
  lines.push("");

  let movetext = "";
  plies.forEach((ply, i) => {
    const cls = classified[i];
    const tag = cls ? ` {${cls.label.symbol} ${cls.label.name}}` : "";
    if (ply.color === "w") {
      movetext += `${ply.moveNumber}. ${ply.moveSan}${tag} `;
    } else {
      movetext += `${ply.moveSan}${tag} `;
    }
  });
  movetext += headers.Result || "*";
  lines.push(movetext.trim());
  return lines.join("\n");
}

function exportAnnotatedPgn() {
  if (plies.length === 0 || classified.some(c => c === null)) {
    alert("Run an analysis first.");
    return;
  }
  const pgnText = buildAnnotatedPgn();
  const blob = new Blob([pgnText], { type: "application/x-chess-pgn" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "analyzed-game.pgn";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Wire up events ----------
analyzeBtn.addEventListener("click", runAnalysis);
cancelBtn.addEventListener("click", cancelAnalysis);
resetBtn.addEventListener("click", resetAll);
settingsBtn.addEventListener("click", () => { settingsPanel.hidden = !settingsPanel.hidden; });
el("exportPgnBtn").addEventListener("click", exportAnnotatedPgn);

el("navStart").addEventListener("click", () => goToPly(-1));
el("navPrev").addEventListener("click", () => goToPly(Math.max(-1, currentPlyView - 1)));
el("navNext").addEventListener("click", () => goToPly(Math.min(plies.length - 1, currentPlyView + 1)));
el("navEnd").addEventListener("click", () => goToPly(plies.length - 1));

// Left/right arrow keys step through the game, except while the user is
// actually typing (PGN box or a settings number field).
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    goToPly(Math.max(-1, currentPlyView - 1));
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    goToPly(Math.min(plies.length - 1, currentPlyView + 1));
  }
});

// ---------- Init ----------
renderCoordinates();
renderLegend();
renderBoard(new Chess().fen());
updateEvalBar(null);
renderCandidates(-1);

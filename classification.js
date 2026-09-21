/*
 * classification.js
 *
 * Implements the move-classification proposal:
 *   Book      - matches known opening theory (Lichess Masters explorer)
 *   Correct   - after book, 3+ moves give practically the same win%,
 *               OR the position was merely defended back to parity
 *               (see "genuine gain" below)
 *   Good      - only 1-2 moves give a significant advantage, AND playing
 *               one of them actually improved the mover's position
 *               relative to where it stood before the opponent's last
 *               move (not just "the least-bad option available now").
 *               This is what keeps a forced-but-obvious retreat (a
 *               hanging knight with only one safe square) from being
 *               scored the same as a genuinely spotted opportunity: if
 *               the position only returns to where it already was, the
 *               opponent's move cost them nothing and there was nothing
 *               to "convert".
 *   Brilliant - the first "Good" move that opens a window (configurable
 *               length, can differ between opening and endgame) in
 *               which the same scarcity keeps holding for that player,
 *               checked in retrospect
 *   Mistake / Blunder - classic win% drop from the best available move
 *
 * This file has NO dependency on the engine or the UI: it just takes
 * already-computed MultiPV data and returns labels. That keeps it easy
 * to unit-test and to tune independently of the rest of the app.
 */

const Classification = (() => {

  const LABELS = {
    BOOK:      { key: "BOOK",      symbol: "\u{1F4D6}", name: "Book",      color: "#88A17F" },
    CORRECT:   { key: "CORRECT",   symbol: "\u2713",     name: "Correct",   color: "#81C45D" },
    GOOD:      { key: "GOOD",      symbol: "!",          name: "Good",      color: "#4CA2E3" },
    BRILLIANT: { key: "BRILLIANT", symbol: "!!",         name: "Brilliant", color: "#8A6CEF" },
    MISTAKE:   { key: "MISTAKE",   symbol: "?",          name: "Mistake",   color: "#EF8B33" },
    BLUNDER:   { key: "BLUNDER",   symbol: "??",         name: "Blunder",   color: "#C31D1D" },
  };

  // Lichess's own centipawn -> win% curve (used for its Accuracy stat).
  // Keeping the same curve means our thresholds are directly comparable
  // to numbers people already see on lichess.
  function winPercentFromCp(cp) {
    const clamped = Math.max(-1000, Math.min(1000, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
  }

  // Mate scores are converted to a near-100/0 win% rather than being
  // treated as an ordinary centipawn value.
  function winPercentFromScore(score) {
    if (score.mate !== undefined && score.mate !== null) {
      return score.mate > 0 ? 99.9 : 0.1;
    }
    return winPercentFromCp(score.cp);
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Decide the "top cluster" size at a position: how many candidate
   * moves sit clearly above the median win% of all candidates returned
   * by MultiPV. This stands in for "how many legal moves are actually
   * good here" without needing to search every legal move individually,
   * matching the "compare against the median, not a % of legal moves"
   * refinement discussed.
   *
   * gapPoints: how many win% points above the median a move needs to
   * count as part of the top cluster (filters out noise between
   * genuinely-similar moves).
   */
  function topClusterSize(candidateWinPercents, gapPoints = 5) {
    if (candidateWinPercents.length === 0) return 0;
    const m = median(candidateWinPercents);
    const above = candidateWinPercents.filter(w => w - m > gapPoints).length;
    // If nothing clears the gap, no move stands out from the pack: the
    // whole set is effectively "equally good", which is the Correct
    // case, not a scarce Good one. Only fall back to a single-move
    // cluster when there's truly just one candidate to begin with.
    return above > 0 ? above : candidateWinPercents.length;
  }

  /**
   * Classify a single move.
   *
   * @param {Object} position
   *   { multipv: [{cp|mate, moveUci}], playedMoveUci, isBook, moverColor,
   *     playedScore?, baselineWinPercent? }
   *   multipv is already sorted best-first, from the mover's perspective.
   *   playedScore ({cp|mate}) is optional: pass it whenever the played
   *   move's own evaluation was actually queried from the engine (e.g.
   *   via "go searchmoves") instead of being guessed, which is the
   *   normal case whenever the played move isn't one of the top MultiPV
   *   lines. Without it, a rough guess is used as a last resort.
   *   baselineWinPercent is this same player's own win% right after
   *   their own previous move (i.e. before the opponent's intervening
   *   move) - used to check whether this move is a genuine gain, not
   *   just a return to a position that was already fine. Pass 50 (or
   *   omit) when there's no earlier move of theirs to compare against.
   * @param {Object} thresholds { mistake, blunder, gapPoints, goodGain }
   * @returns {Object} { label, dropPoints, clusterSize, gain, bestWinPercent, playedWinPercent }
   */
  function classifyMove(position, thresholds) {
    const { mistake, blunder, gapPoints } = thresholds;
    const goodGain = thresholds.goodGain ?? 8;

    if (position.isBook) {
      return { label: LABELS.BOOK, dropPoints: 0, clusterSize: null };
    }

    const winPercents = position.multipv.map(m => winPercentFromScore(m));
    const bestWinPercent = winPercents[0];

    let playedIndex = position.multipv.findIndex(m => m.moveUci === position.playedMoveUci);
    let playedWinPercent;
    if (playedIndex !== -1) {
      playedWinPercent = winPercents[playedIndex];
    } else if (position.playedScore) {
      playedWinPercent = winPercentFromScore(position.playedScore);
    } else {
      // Last-resort guess: no exact eval available for the played move,
      // so treat it conservatively as clearly worse than the weakest
      // reported candidate. Prefer passing playedScore instead of
      // relying on this branch (see app.js: evaluateMove()).
      playedWinPercent = winPercents[winPercents.length - 1] - Math.max(gapPoints * 2, blunder);
    }

    const dropPoints = bestWinPercent - playedWinPercent;

    if (dropPoints >= blunder) {
      return { label: LABELS.BLUNDER, dropPoints, clusterSize: null, bestWinPercent, playedWinPercent };
    }
    if (dropPoints >= mistake) {
      return { label: LABELS.MISTAKE, dropPoints, clusterSize: null, bestWinPercent, playedWinPercent };
    }

    const clusterSize = topClusterSize(winPercents, gapPoints);
    const baseline = position.baselineWinPercent ?? 50;
    const gain = playedWinPercent - baseline;

    // Scarce AND an actual improvement over where this player already
    // stood -> Good. Scarce but merely restoring/holding what was
    // already there (e.g. saving a piece that was hanging) -> Correct,
    // same as when there were plenty of equally-fine options: nothing
    // was "converted" either way.
    const label = (clusterSize <= 2 && gain > goodGain) ? LABELS.GOOD : LABELS.CORRECT;
    return { label, dropPoints, clusterSize, gain, bestWinPercent, playedWinPercent };
  }

  /**
   * Brilliant window length, in the number of the ORIGIN PLAYER'S OWN
   * subsequent moves to check (not total plies). Configurable and
   * allowed to differ between the opening and the endgame, per
   * Carlsen's comment that his own calculation ranges roughly from 2 to
   * 20 moves ahead depending on the moment of the game - exact meaning
   * of "moves" there (full moves vs. plies) isn't something we could
   * pin down to a precise source, so treat these as tunable knobs
   * rather than a strict quote.
   */
  function brilliantWindow(moveNumber, earlyLength, lateLength) {
    return moveNumber < 15 ? earlyLength : lateLength;
  }

  /**
   * Second pass over an already-classified game: upgrade the first
   * "Good" move of a scarcity chain to "Brilliant" if the same player's
   * following moves (within the configured window) keep landing in a
   * scarce top cluster (<=2) without the advantage collapsing.
   *
   * @param {Array} classifiedMoves  in game order, each item:
   *   { color: 'w'|'b', moveNumber, label, clusterSize, bestWinPercent, playedWinPercent }
   *   (as produced by classifyMove, one entry per ply)
   * @param {Object} windowSettings { early, late } - see brilliantWindow()
   */
  function upgradeBrilliants(classifiedMoves, windowSettings = { early: 2, late: 2 }) {
    for (let i = 0; i < classifiedMoves.length; i++) {
      const origin = classifiedMoves[i];
      if (origin.label.key !== "GOOD") continue;

      const window = brilliantWindow(origin.moveNumber, windowSettings.early, windowSettings.late);
      const sameColorFollowing = [];
      for (let j = i + 1; j < classifiedMoves.length && sameColorFollowing.length < window; j++) {
        if (classifiedMoves[j].color === origin.color) sameColorFollowing.push(classifiedMoves[j]);
      }

      if (sameColorFollowing.length === 0) continue;

      const advantageHeld = sameColorFollowing.every(m =>
        (m.label.key === "GOOD" || m.label.key === "CORRECT") &&
        m.clusterSize !== null && m.clusterSize <= 2 &&
        m.playedWinPercent >= origin.playedWinPercent - 3 // small tolerance for engine noise
      );

      if (advantageHeld) {
        origin.label = LABELS.BRILLIANT;
      }
    }
    return classifiedMoves;
  }

  return { LABELS, winPercentFromScore, winPercentFromCp, median, topClusterSize, classifyMove, brilliantWindow, upgradeBrilliants };
})();

// Allow this file to be required from Node for testing, while staying a
// plain global (`Classification`) when loaded via <script> in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = Classification;
}

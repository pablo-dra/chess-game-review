/*
 * classification.js
 *
 * Implements the move-classification proposal:
 *   Book      - matches known opening theory (Lichess Masters explorer)
 *   Forced    - exactly one legal move, no real decision, not analyzed
 *   Mistake / Blunder - win% drop from the best available move
 *                (10 / 20 points by default)
 *
 *   For every other move, the engine's top ~5 candidates (MultiPV) are
 *   converted to win% (Lichess's own centipawn curve) and their MEAN
 *   is used as the single reference point for everything below:
 *
 *   - If 2 or fewer candidates sit clearly above that mean (a "scarce"
 *     position - a critical moment where only a couple of moves keep
 *     things going), the played move is:
 *       Good    - it's one of those scarce standouts, AND it's a
 *                 genuine gain (8+ win% by default) over where this
 *                 same player stood two of their own moves ago (i.e.
 *                 before the opponent's intervening move). This is
 *                 what keeps an obvious, forced-looking retreat (a
 *                 hanging knight with only one safe square) from
 *                 scoring the same as a real find: moving the knight
 *                 back doesn't improve on where White already was, it
 *                 just avoids losing what was already fine.
 *       Correct - scarce, but no genuine gain (the forced-retreat case
 *                 above), or just not one of the standouts.
 *   - If the position is NOT scarce (3+ candidates close together - a
 *     standard, unremarkable position), the played move is:
 *       Solid   - at or above the mean of that set: found one of the
 *                 better options even though the difference barely
 *                 mattered.
 *       Correct - below the mean, or not among the analyzed candidates
 *                 at all (but not a big enough drop to be a Mistake).
 *
 *   Brilliant - NOT a separate per-move check: a single retrospective
 *               pass over the finished game. The first Good move opens
 *               a window of that same player's own subsequent moves.
 *               If every one of them is also Good or Solid, AND the
 *               opponent's moves across that same span were never a
 *               Mistake or Blunder (otherwise it's their error being
 *               converted, not a demonstrated combo), the origin move
 *               is upgraded to Brilliant. The window length scales
 *               with game phase - see brilliantWindow().
 *
 * This file has NO dependency on the engine or the UI: it just takes
 * already-computed MultiPV data and returns labels. That keeps it easy
 * to unit-test and to tune independently of the rest of the app.
 */

const Classification = (() => {

  const LABELS = {
    BOOK:      { key: "BOOK",      symbol: "\u{1F4D6}", name: "Book",      color: "#88A17F" },
    FORCED:    { key: "FORCED",    symbol: "\u2192",     name: "Forced",    color: "#EAC566" },
    SOLID:     { key: "SOLID",     symbol: "\u2605",     name: "Solid",     color: "#287112" },
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

  function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Decide the "scarce cluster" size at a position: how many candidate
   * moves sit clearly above the MEAN win% of all candidates returned
   * by MultiPV. This stands in for "how many legal moves are actually
   * good here" without needing to search every legal move individually.
   * The mean is also the single reference point used for the separate
   * Solid/Correct split in the non-scarce case (see classifyMove) -
   * one consistent statistic for both decisions, rather than mixing
   * median and mean.
   *
   * gapPoints: how many win% points above the mean a move needs to
   * count as part of the scarce cluster (filters out noise between
   * genuinely-similar moves). Examples this reproduces:
   *   [18, 35, 45, 60, 85] -> mean ~48.6 -> only 60 and 85 clear a
   *     +5 gap above it -> cluster of 2 ("critical moment")
   *   [40, 43, 44, 45, 48] -> mean 44 -> nothing clears +5 above it ->
   *     whole set counts as the cluster -> NOT scarce ("standard play")
   */
  function scarceClusterSize(candidateWinPercents, gapPoints = 5) {
    if (candidateWinPercents.length === 0) return 0;
    const m = mean(candidateWinPercents);
    const above = candidateWinPercents.filter(w => w - m > gapPoints).length;
    // If nothing clears the gap, no move stands out from the pack: the
    // whole set is effectively "equally good" - not scarce. Only fall
    // back to a single-move cluster when there's truly one candidate.
    return above > 0 ? above : candidateWinPercents.length;
  }

  /**
   * Classify a single move.
   *
   * @param {Object} position
   *   { multipv: [{cp|mate, moveUci}], playedMoveUci, isBook, isForced,
   *     moverColor, playedScore?, baselineWinPercent? }
   *   multipv is already sorted best-first, from the mover's perspective.
   *   isForced: true when this was the only legal move on the board
   *   (e.g. a king move that's the only way out of check). Forced moves
   *   short-circuit straight to FORCED and are never engine-analyzed,
   *   never Good, and never eligible to start or extend a Brilliant
   *   chain - there was no decision to reward or penalize.
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
   * @returns {Object} { label, dropPoints, clusterSize, gain, isTopMove, matchedCandidate, bestWinPercent, playedWinPercent }
   */
  function classifyMove(position, thresholds) {
    const { mistake, blunder, gapPoints } = thresholds;
    const goodGain = thresholds.goodGain ?? 8;

    if (position.isForced) {
      return { label: LABELS.FORCED, dropPoints: 0, clusterSize: null, isTopMove: false, matchedCandidate: null };
    }
    if (position.isBook) {
      return { label: LABELS.BOOK, dropPoints: 0, clusterSize: null, isTopMove: false, matchedCandidate: null };
    }

    const winPercents = position.multipv.map(m => winPercentFromScore(m));
    const bestWinPercent = winPercents[0];

    let playedIndex = position.multipv.findIndex(m => m.moveUci === position.playedMoveUci);
    const matchedCandidate = playedIndex !== -1;
    let playedWinPercent;
    if (matchedCandidate) {
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
    const isTopMove = playedIndex === 0;

    const dropPoints = bestWinPercent - playedWinPercent;

    if (dropPoints >= blunder) {
      return { label: LABELS.BLUNDER, dropPoints, clusterSize: null, isTopMove, matchedCandidate, bestWinPercent, playedWinPercent };
    }
    if (dropPoints >= mistake) {
      return { label: LABELS.MISTAKE, dropPoints, clusterSize: null, isTopMove, matchedCandidate, bestWinPercent, playedWinPercent };
    }

    // A move the engine's top-N candidates never even listed is treated
    // as Correct outright (never Good or Solid), regardless of where its
    // own searched eval happens to land - it wasn't one of the position's
    // standout or above-average options as far as the analysis goes.
    if (!matchedCandidate) {
      return { label: LABELS.CORRECT, dropPoints, clusterSize: null, isTopMove, matchedCandidate, bestWinPercent, playedWinPercent };
    }

    const clusterSize = scarceClusterSize(winPercents, gapPoints);
    const baseline = position.baselineWinPercent ?? 50;
    const gain = playedWinPercent - baseline;

    let label;
    if (clusterSize <= 2 && gain > goodGain) {
      // Scarce (a critical moment) AND an actual improvement over where
      // this player already stood -> Good.
      label = LABELS.GOOD;
    } else if (clusterSize <= 2) {
      // Scarce but merely restoring/holding what was already there
      // (e.g. saving a piece that was hanging) - nothing was
      // "converted", so this stays Correct rather than Good.
      label = LABELS.CORRECT;
    } else {
      // Plenty of roughly-equal options (a standard, unremarkable
      // position) - distinguish picking one of the better ones from
      // picking one of the weaker ones, using the same mean already
      // computed for the scarcity check above.
      const m = mean(winPercents);
      label = playedWinPercent >= m ? LABELS.SOLID : LABELS.CORRECT;
    }
    return { label, dropPoints, clusterSize, gain, isTopMove, matchedCandidate, bestWinPercent, playedWinPercent };
  }

  /**
   * Brilliant window length, in the number of the ORIGIN PLAYER'S OWN
   * subsequent moves to check (not total plies). Scales with game
   * phase: 2 of the player's own moves (= 2 full moves) near the
   * opening, up to 4 of their own moves (= 4 full moves) in the
   * endgame, interpolated smoothly in between rather than switching
   * abruptly at a cutoff.
   *
   * Phase is read from TWO independent signals, taking whichever one
   * indicates the more advanced phase (effectively an "OR"): material
   * left on the board, and the move number itself - a long, slow,
   * piece-heavy game past move 30 should count as late-game too, even
   * if material hasn't dropped much yet, and a sharp line that sheds
   * material fast should count as late-game even before move 10.
   *
   * @param {number} materialRatio  total non-king material still on
   *   the board, divided by the starting total (1.0 = full material,
   *   0.0 = bare kings). See app.js: materialRatioFromFen().
   * @param {number} moveNumber  the full move number this position is at.
   */
  function brilliantWindow(materialRatio, moveNumber, earlyLength, lateLength) {
    // Material: 100-80% -> early, 80-30% -> mid, <=30% -> late.
    const MATERIAL_HIGH = 0.8, MATERIAL_LOW = 0.3;
    const materialPhase = materialRatio === undefined || materialRatio === null
      ? 0
      : 1 - Math.max(0, Math.min(1, (materialRatio - MATERIAL_LOW) / (MATERIAL_HIGH - MATERIAL_LOW)));

    // Moves: up to move 10 -> early, up to move 30 -> mid, after -> late.
    const MOVE_EARLY = 10, MOVE_LATE = 30;
    const movePhase = moveNumber === undefined || moveNumber === null
      ? 0
      : Math.max(0, Math.min(1, (moveNumber - MOVE_EARLY) / (MOVE_LATE - MOVE_EARLY)));

    const phase = Math.max(materialPhase, movePhase); // 0 = early, 1 = late
    const interpolated = earlyLength + phase * (lateLength - earlyLength);
    return Math.max(1, Math.round(interpolated));
  }

  // Used by upgradeBrilliants: a chain only reflects the origin
  // player's own skill if the opponent was putting up real resistance
  // throughout its span - not simply handing over material or position
  // (e.g. dropping a queen onto a square that gets naturally recaptured
  // move after move). If the opponent played a Mistake or Blunder
  // anywhere in the span, that's their error being converted, not a
  // demonstrated combo, so the chain is disqualified. Book and Forced
  // opponent moves are exempt (no real choice either way). The origin
  // player's own intermediate moves within the span are skipped here -
  // those are judged by the chain-quality check in upgradeBrilliants,
  // not by this opponent-facing one.
  function opponentHeldUp(classifiedMoves, fromIndex, toIndex, originColor) {
    for (let j = fromIndex + 1; j <= toIndex; j++) {
      const m = classifiedMoves[j];
      if (m.color === originColor) continue;
      if (m.label.key === "FORCED" || m.label.key === "BOOK") continue;
      if (m.label.key === "MISTAKE" || m.label.key === "BLUNDER") return false;
    }
    return true;
  }

  /**
   * Second pass over an already-classified game: upgrade the first
   * "Good" move of a chain to "Brilliant" if the same player's
   * following moves (within the phase-scaled window) are also Good or
   * Solid, AND the opponent held up their end across that same span
   * (see opponentHeldUp() above). Forced moves of the origin player in
   * between don't count toward the window and don't break the chain,
   * since they weren't a real decision either way.
   *
   * Only the first move of a qualifying chain is upgraded; the rest
   * keep whatever label they already had (Good, Solid, or - if a
   * shorter chain starting later also qualifies - Brilliant).
   *
   * @param {Array} classifiedMoves  in game order, each item:
   *   { color: 'w'|'b', moveNumber, materialRatio, label, playedWinPercent }
   *   (as produced by classifyMove + app.js, one entry per ply)
   * @param {Object} windowSettings { early, late } - see brilliantWindow()
   */
  function upgradeBrilliants(classifiedMoves, windowSettings = { early: 2, late: 4 }) {
    for (let i = 0; i < classifiedMoves.length; i++) {
      const origin = classifiedMoves[i];
      if (origin.label.key !== "GOOD") continue;

      const window = brilliantWindow(origin.materialRatio ?? 1, origin.moveNumber, windowSettings.early, windowSettings.late);
      const sameColorFollowing = [];
      let lastFollowingIndex = null;
      for (let j = i + 1; j < classifiedMoves.length && sameColorFollowing.length < window; j++) {
        if (classifiedMoves[j].color === origin.color && classifiedMoves[j].label.key !== "FORCED") {
          sameColorFollowing.push(classifiedMoves[j]);
          lastFollowingIndex = j;
        }
      }

      if (sameColorFollowing.length === 0) continue;

      const chainHeld = sameColorFollowing.every(m =>
        m.label.key === "GOOD" || m.label.key === "SOLID" || m.label.key === "BRILLIANT"
      );

      if (chainHeld && opponentHeldUp(classifiedMoves, i, lastFollowingIndex, origin.color)) {
        origin.label = LABELS.BRILLIANT;
      }
    }
    return classifiedMoves;
  }

  // ---------- Game accuracy % and a rough rating estimate ----------
  // Accuracy uses Lichess's own published win%-based formula (see
  // https://lichess.org/page/accuracy): a move that costs 0 win% is
  // 100% accurate, and accuracy decays exponentially as the win%
  // drop grows. dropPoints here is exactly what classifyMove already
  // returns for every move (0 for Book/Forced).
  function moveAccuracy(dropPoints) {
    const accuracy = 103.1668 * Math.exp(-0.04354 * Math.max(0, dropPoints)) - 3.1669;
    return Math.max(0, Math.min(100, accuracy));
  }

  // Lichess blends the plain average with the harmonic mean so a few
  // bad moves pull the game score down more than a plain average would
  // (documented behavior, exact "volatility weighting" they use isn't
  // public - this is a transparent approximation of it, not a replica).
  function gameAccuracy(moveAccuracies) {
    if (!moveAccuracies || moveAccuracies.length === 0) return null;
    const arithmetic = moveAccuracies.reduce((a, b) => a + b, 0) / moveAccuracies.length;
    const harmonic = moveAccuracies.length / moveAccuracies.reduce((a, b) => a + 1 / Math.max(b, 0.1), 0);
    return (arithmetic + harmonic) / 2;
  }

  // Rough, illustrative rating estimate from a game's accuracy % only.
  // IMPORTANT: there is no validated, public formula for this anywhere
  // - not at Lichess, not at chess.com (both keep their exact method
  // undisclosed), and neither factors in opponent strength, which
  // matters a lot. This is a simple piecewise-linear lookup calibrated
  // loosely against community reference points, meant as a rough,
  // for-fun ballpark - not a real rating. Always show it with a visible
  // caveat, never as a bare, precise-looking number.
  const RATING_ANCHORS = [
    [0, 300], [50, 500], [60, 800], [70, 1100], [80, 1500],
    [88, 1800], [93, 2100], [96, 2400], [98.5, 2700], [100, 3000],
  ];
  function estimateRatingFromAccuracy(accuracy) {
    if (accuracy === null || accuracy === undefined) return null;
    const clamped = Math.max(0, Math.min(100, accuracy));
    for (let i = 0; i < RATING_ANCHORS.length - 1; i++) {
      const [x0, y0] = RATING_ANCHORS[i];
      const [x1, y1] = RATING_ANCHORS[i + 1];
      if (clamped >= x0 && clamped <= x1) {
        const t = (clamped - x0) / (x1 - x0);
        return Math.round((y0 + t * (y1 - y0)) / 50) * 50; // round to nearest 50
      }
    }
    return RATING_ANCHORS[RATING_ANCHORS.length - 1][1];
  }

  return { LABELS, winPercentFromScore, winPercentFromCp, mean, scarceClusterSize, classifyMove, brilliantWindow, upgradeBrilliants, moveAccuracy, gameAccuracy, estimateRatingFromAccuracy };
})();

// Allow this file to be required from Node for testing, while staying a
// plain global (`Classification`) when loaded via <script> in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = Classification;
}

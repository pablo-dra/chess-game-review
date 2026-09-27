/*
 * classification.js
 *
 * Implements the move-classification proposal:
 *   Book      - matches known opening theory (Lichess Masters explorer)
 *   Best      - 3+ moves give practically the same win% (no scarce
 *               standout), AND the played move is above the mean of
 *               that tightly-bunched set - i.e. picked one of the
 *               better ones even though the difference barely matters
 *   Correct   - same "3+ similar moves" situation but picked one of
 *               the below-mean ones, OR a scarce (<=2) move that only
 *               defended back to parity without a genuine gain (see
 *               Good below)
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
    FORCED:    { key: "FORCED",    symbol: "\u2192",     name: "Forced",    color: "#EAC566" },
    BEST:      { key: "BEST",      symbol: "\u2605",     name: "Best",      color: "#287112" },
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
   * @returns {Object} { label, dropPoints, clusterSize, gain, isTopMove, bestWinPercent, playedWinPercent }
   */
  function classifyMove(position, thresholds) {
    const { mistake, blunder, gapPoints } = thresholds;
    const goodGain = thresholds.goodGain ?? 8;

    if (position.isForced) {
      return { label: LABELS.FORCED, dropPoints: 0, clusterSize: null, isTopMove: false };
    }
    if (position.isBook) {
      return { label: LABELS.BOOK, dropPoints: 0, clusterSize: null, isTopMove: false };
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
    const isTopMove = playedIndex === 0;

    const dropPoints = bestWinPercent - playedWinPercent;

    if (dropPoints >= blunder) {
      return { label: LABELS.BLUNDER, dropPoints, clusterSize: null, isTopMove, bestWinPercent, playedWinPercent };
    }
    if (dropPoints >= mistake) {
      return { label: LABELS.MISTAKE, dropPoints, clusterSize: null, isTopMove, bestWinPercent, playedWinPercent };
    }

    const clusterSize = topClusterSize(winPercents, gapPoints);
    const baseline = position.baselineWinPercent ?? 50;
    const gain = playedWinPercent - baseline;

    let label;
    if (clusterSize <= 2 && gain > goodGain) {
      // Scarce AND an actual improvement over where this player already
      // stood -> Good.
      label = LABELS.GOOD;
    } else if (clusterSize <= 2) {
      // Scarce but merely restoring/holding what was already there
      // (e.g. saving a piece that was hanging) - nothing was
      // "converted", so this stays Correct rather than Good.
      label = LABELS.CORRECT;
    } else {
      // Plenty of roughly-equal options (no scarce standout). Rather
      // than lump every one of these together, distinguish picking one
      // of the better ones from picking one of the weaker ones, using
      // the plain mean of the candidates - simpler than the gap-based
      // clustering used elsewhere (see topClusterSize / the opponent
      // gate), which is the right call specifically when everything
      // really is close together: e.g. candidates at 51.95/51.65/50.4/
      // 50.1/49% - playing 51.95 or 51.65 (above the ~50.6% mean) earns
      // Best; playing 50.4, 50.1 or 49 (below it) stays Correct.
      const mean = winPercents.reduce((a, b) => a + b, 0) / winPercents.length;
      label = playedWinPercent > mean ? LABELS.BEST : LABELS.CORRECT;
    }
    return { label, dropPoints, clusterSize, gain, isTopMove, bestWinPercent, playedWinPercent };
  }

  /**
   * Brilliant window length, in the number of the ORIGIN PLAYER'S OWN
   * subsequent moves to check (not total plies). Configurable and
   * allowed to differ between the opening and the endgame - but "game
   * phase" here is driven by how much material is left on the board,
   * not the move number (move 15 doesn't reliably mean anything
   * endgame-like; a queen-less position at move 10 does). The result
   * is smoothly interpolated between the two configured lengths rather
   * than switching abruptly at a cutoff.
   *
   * @param {number} materialRatio  total non-king material still on
   *   the board, divided by the starting total (1.0 = full material,
   *   0.0 = bare kings). See app.js: materialRatioFromFen().
   */
  function brilliantWindow(materialRatio, earlyLength, lateLength) {
    // Above this ratio, treated as fully "opening/early game" (~2-3
    // pawns' worth captured at most). At or below the low ratio -
    // roughly a queen or minor piece plus a couple of pawns left, per
    // the "late game" description discussed - treated as fully
    // "endgame". Linear interpolation in between.
    const HIGH_RATIO = 0.8;
    const LOW_RATIO = 0.13;
    const clamped = Math.max(LOW_RATIO, Math.min(HIGH_RATIO, materialRatio));
    const t = (clamped - LOW_RATIO) / (HIGH_RATIO - LOW_RATIO); // 0 (late) .. 1 (early)
    const interpolated = lateLength + t * (earlyLength - lateLength);
    return Math.max(1, Math.round(interpolated));
  }

  /**
   * Second pass over an already-classified game: upgrade the first
   * "Good" move of a scarcity chain to "Brilliant" if the same player's
   * following moves (within the configured window) keep landing in a
   * scarce top cluster (<=2) without the advantage collapsing, AND the
   * opponent was putting up real resistance throughout that same span
   * - see opponentPlayedReasonably() below. Forced moves in between are
   * skipped (not counted, not required to hold the advantage) since
   * they weren't a real decision either way.
   *
   * @param {Array} classifiedMoves  in game order, each item:
   *   { color: 'w'|'b', moveNumber, materialRatio, label, clusterSize,
   *     bestWinPercent, playedWinPercent, candidates, matchedCandidate }
   *   (as produced by classifyMove + app.js, one entry per ply)
   * @param {Object} windowSettings { early, late } - see brilliantWindow()
   * @param {number} opponentGapRatio - see opponentPlayedReasonably()
   */
  function upgradeBrilliants(classifiedMoves, windowSettings = { early: 2, late: 2 }, opponentGapRatio = 0.3) {
    for (let i = 0; i < classifiedMoves.length; i++) {
      const origin = classifiedMoves[i];
      if (origin.label.key !== "GOOD") continue;

      const window = brilliantWindow(origin.materialRatio ?? 1, windowSettings.early, windowSettings.late);
      const sameColorFollowing = [];
      let lastFollowingIndex = null;
      for (let j = i + 1; j < classifiedMoves.length && sameColorFollowing.length < window; j++) {
        if (classifiedMoves[j].color === origin.color && classifiedMoves[j].label.key !== "FORCED") {
          sameColorFollowing.push(classifiedMoves[j]);
          lastFollowingIndex = j;
        }
      }

      if (sameColorFollowing.length === 0) continue;

      const advantageHeld = sameColorFollowing.every(m =>
        (m.label.key === "GOOD" || m.label.key === "CORRECT" || m.label.key === "BRILLIANT" || m.label.key === "BEST") &&
        m.clusterSize !== null && m.clusterSize <= 2 &&
        m.playedWinPercent >= origin.playedWinPercent - 3 // small tolerance for engine noise
      );

      const opponentHeldUp = opponentPlayedReasonably(classifiedMoves, i, lastFollowingIndex, origin.color, opponentGapRatio);

      if (advantageHeld && opponentHeldUp) {
        origin.label = LABELS.BRILLIANT;
      }
    }
    return classifiedMoves;
  }

  /**
   * Judges whether the OPPONENT'S moves across a chain's span (from
   * just after fromIndex to toIndex, inclusive of toIndex) were
   * reasonable enough for the chain to reflect the origin player's own
   * skill rather than the opponent simply giving material or position
   * away. Used by both Brilliant paths. Two independent gates, checked
   * per opponent move in the span - either one failing disqualifies
   * the whole chain:
   *
   *  Gate 1 - the opponent's move must be one of the engine's analyzed
   *  top-N candidates at all (matchedCandidate). A move so far outside
   *  the shortlist that the engine never even reported it doesn't
   *  count as "resistance", regardless of how small its win% drop
   *  happens to look (this matters most in near-equal positions where
   *  almost anything scores similarly and nothing looks like a
   *  Mistake by the usual drop threshold).
   *
   *  Gate 2 - if it WAS one of the candidates, it also has to be one of
   *  the *good* ones among that specific set, found by scanning the
   *  candidates from best to worst and cutting the "reasonable" group
   *  at the first gap that's large relative to the whole set's spread
   *  (default: a gap over 30% of the top-to-bottom range). This
   *  reproduces two different intuitions with one rule: when there's
   *  one abrupt best move and the rest trail far behind, only that one
   *  move passes; when the candidates are all close together, several
   *  of the top ones pass and only the ones that trail off the group
   *  fail. Example: candidates [9, 4, -1, -1, -1] -> only 9 passes
   *  (the very next value is already a big relative jump down).
   *  Candidates [4, 3.98, 3.96, 3.9, 3.9] -> 4, 3.98 and 3.96 all pass
   *  (tightly bunched together), only the trailing 3.9s fail.
   *
   * Book and Forced opponent moves are exempt from both gates (no real
   * choice, or well-established theory either way). The origin
   * player's own intermediate moves within the span (when the window
   * covers more than one of their own moves) are skipped entirely here
   * - they're judged by the caller's own advantage/scarcity check, not
   * by these opponent-facing gates.
   */
  function opponentPlayedReasonably(classifiedMoves, fromIndex, toIndex, originColor, opponentGapRatio = 0.3) {
    for (let j = fromIndex + 1; j <= toIndex; j++) {
      const m = classifiedMoves[j];
      if (m.color === originColor) continue; // the origin player's own move, judged elsewhere - not the opponent's
      if (m.label.key === "FORCED" || m.label.key === "BOOK") continue;

      // Gate 1
      if (m.matchedCandidate === false) return false;

      // Gate 2 - only meaningful if we actually have the candidate list
      if (!m.candidates || m.candidates.length < 2) continue;
      const values = m.candidates.map(c => c.winPercent).sort((a, b) => b - a);
      const range = values[0] - values[values.length - 1];
      let cutoffValue = values[values.length - 1]; // default: whole set passes
      if (range > 1e-6) {
        for (let k = 0; k < values.length - 1; k++) {
          const gap = values[k] - values[k + 1];
          if (gap / range > opponentGapRatio) {
            cutoffValue = values[k];
            break;
          }
        }
      }
      if (m.playedWinPercent < cutoffValue - 1e-6) return false;
    }
    return true;
  }

  /**
   * Alternative, additive path to Brilliant: instead of requiring
   * scarce alternatives, this rewards simply finding the engine's own
   * #1 move several times in a row for the same player, when doing so
   * builds up a real gain overall AND the opponent was putting up
   * reasonable resistance throughout (not just gifting material) - see
   * opponentPlayedReasonably() above. This is meant to catch a "played
   * a clean forcing sequence" pattern that doesn't necessarily involve
   * any single do-or-die decision - more of a sustained-accuracy combo
   * than a single spotted shot. Only the first move of a qualifying
   * run is upgraded; the rest keep whatever label they already had
   * (often Correct, since picking the objective best move among many
   * similarly-good ones doesn't by itself imply scarcity).
   *
   * Forced and Book moves are excluded from the run entirely (neither
   * count toward the streak nor break it) since they involve no real
   * choice either way.
   *
   * @param {Array} classifiedMoves  in game order (same shape as above)
   * @param {Object} options { chainLength = 2, minGain = 10, opponentGapRatio = 0.3 }
   */
  function markTopMoveChains(classifiedMoves, options = {}) {
    const chainLength = options.chainLength ?? 2;
    const minGain = options.minGain ?? 10;
    const opponentGapRatio = options.opponentGapRatio ?? 0.3;

    ["w", "b"].forEach(color => {
      const ownIndices = [];
      classifiedMoves.forEach((m, i) => {
        if (m.color === color && m.label.key !== "FORCED" && m.label.key !== "BOOK") {
          ownIndices.push(i);
        }
      });

      let streakStart = null;
      let streakLen = 0;

      for (let k = 0; k < ownIndices.length; k++) {
        const idx = ownIndices[k];
        const move = classifiedMoves[idx];

        if (move.isTopMove) {
          if (streakLen === 0) streakStart = k;
          streakLen++;
        } else {
          streakLen = 0;
          streakStart = null;
          continue;
        }

        if (streakLen >= chainLength) {
          const startIdx = ownIndices[streakStart];
          const prevOwnIdx = streakStart > 0 ? ownIndices[streakStart - 1] : null;
          const baseline = prevOwnIdx !== null ? classifiedMoves[prevOwnIdx].playedWinPercent : 50;
          const gain = move.playedWinPercent - baseline;
          const opponentHeldUp = opponentPlayedReasonably(classifiedMoves, startIdx, idx, color, opponentGapRatio);
          if (gain >= minGain && opponentHeldUp) {
            classifiedMoves[startIdx].label = LABELS.BRILLIANT;
          }
        }
      }
    });

    return classifiedMoves;
  }

  return { LABELS, winPercentFromScore, winPercentFromCp, median, topClusterSize, classifyMove, brilliantWindow, upgradeBrilliants, markTopMoveChains };
})();

// Allow this file to be required from Node for testing, while staying a
// plain global (`Classification`) when loaded via <script> in the browser.
if (typeof module !== "undefined" && module.exports) {
  module.exports = Classification;
}

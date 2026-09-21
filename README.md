# Chess Review Prototype

A small local web app that loads a PGN, runs it through Stockfish, and
tags each move as **Book / Correct / Good / Brilliant / Mistake / Blunder**
following the classification proposal discussed for the Lichess feature
request. It's meant as a proof of concept to attach to the GitHub
issue, not a production tool.

## 1. Setup (one-time)

You need two things that aren't bundled in this folder, for licensing
and file-size reasons: the Stockfish engine itself, and a local static
server (browsers block Worker + fetch from a plain double-clicked
`file://` page).

### 1a. Get the engine

1. Download **`stockfish-18-lite-single.js`** and **`stockfish-18-lite-single.wasm`**
   from the official releases page:
   https://github.com/nmrugg/stockfish.js/releases/tag/v18.0.0
   (the "lite single-threaded" flavor — no special CORS/COOP headers
   needed, and still far stronger than any human).
2. Put both files inside the `engine/` folder here, next to this
   README, so you end up with:
   ```
   chess-review/
     engine/
       stockfish-18-lite-single.js
       stockfish-18-lite-single.wasm
     index.html
     style.css
     app.js
     classification.js
   ```
   If you use a different Stockfish build or filename, update
   `ENGINE_PATH` at the top of `app.js` to match.

### 1b. Serve the folder over http

Any static server works. From this folder:

```bash
python3 -m http.server 8000
```

or, in VS Code, right-click `index.html` → "Open with Live Server" (if
you have that extension installed). Then open
`http://localhost:8000` in your browser. Opening `index.html` directly
as a file (`file://...`) will NOT work — Worker creation and the
opening-book lookup both require a real origin.

## 2. Using it

1. Paste a PGN into the text box.
2. Click **Analyze**. The gear icon lets you change search depth,
   MultiPV width, and the Mistake/Blunder thresholds before running.
3. Click through the move list or use the ◀ ▶ buttons to step through
   the game; the badge on the last-moved square and the stats table on
   the right update per move.

Analysis runs entirely in your browser — nothing is sent anywhere
except the opening-book lookups to Lichess's public Masters explorer
(see below).

## 3. How the classification works

This mirrors the proposal, refined during discussion:

- **Book** — while the position matches Lichess's Masters opening
  explorer with at least 50 games behind it (`explorer.lichess.org`,
  called live from your browser). If that call fails (offline, etc.)
  it falls back to a rough heuristic of "the first 6 plies" and says
  so in the engine status line.
- **Correct / Good** — for every non-book position, the engine reports
  the top ~5 candidate moves (MultiPV) at a fixed depth (default 18,
  matching what Lichess's own server analysis already uses). Each
  candidate's centipawn score is converted to a win% using the same
  curve Lichess uses for its Accuracy stat. We take the **median**
  win% across those candidates: any move sitting more than a small gap
  above that median counts as part of the "top cluster". A move only
  becomes **Good** if that cluster has 1-2 moves **and** playing it is
  a genuine gain (by default, 8+ win% points) over where this same
  player already stood two of their own moves ago — i.e. before the
  opponent's intervening move. This is what keeps an obvious,
  forced-looking retreat (e.g. a hanging knight with only one or two
  safe squares) from scoring the same as a real find: moving the
  knight back to safety doesn't improve on where White already was, it
  just avoids losing what was already fine, so it's scored **Correct**
  instead. If the cluster has 3+ moves, or the gain check fails, it's
  Correct.
- **Brilliant** — a second, retrospective pass over the finished game.
  The first "Good" move opens a window of that player's own following
  moves. The window length is configurable separately for the opening
  (before move 15) and the rest of the game, both defaulting to 2 —
  i.e. 2 full moves of your own, matching Carlsen's comment that his
  own calculation ranges roughly 2 to 20 moves ahead depending on the
  moment of the game (exactly what he meant by "moves" there — full
  moves or plies — isn't something we could pin to a precise source,
  so treat the defaults as a starting point to tune, not a strict
  quote). If every one of the player's moves in that window keeps
  landing in a scarce top cluster (≤2) without the advantage
  collapsing, the origin move is upgraded to Brilliant. No
  material-sacrifice detection is required — a Tal-style piece left
  "hanging" while pushing a different plan shows up naturally through
  this same scarcity/depth method.
- **Mistake / Blunder** — the classic win%-drop-from-best check, using
  the two thresholds set in the settings panel (defaults: 10 and 20
  points).

All five thresholds (Mistake drop, Blunder drop, Good's minimum gain,
and the two Brilliant chain lengths) are exposed in the gear-icon
settings panel specifically so they're easy to retune while testing
against real games — nothing about their default values is meant to
be final.

## 4. Known limitations of this prototype

These are simplifications made to keep a first version buildable in a
reasonable amount of code — worth flagging in the GitHub issue rather
than hiding:

- The "median" is computed over the top ~5 MultiPV candidates, not
  over every legal move in the position (evaluating every legal move
  to full depth would multiply the cost far more than the ~2–3x
  estimated in the proposal). This is a reasonable approximation in
  practice but not identical to a true full-width median.
- Mate scores are converted to a fixed near-100%/0% win% rather than
  being ranked among themselves (a mate-in-1 and a mate-in-6 both read
  as ~100%). This never matters for Book/Correct/Good, only in the
  rare case where multiple candidates are all forced mates.
- The opening-book check calls Lichess's public API on every position
  until the game leaves theory; this is fine for reviewing a handful
  of games but would need local caching or a bundled dataset to run
  offline or at scale.
- The Brilliant window length uses fixed cutoffs (move 15 / move 30)
  rather than a more nuanced phase detector (material left on the
  board, etc.).
- No opening/PGN edge cases like variations, NAGs, or annotated
  comments in the PGN are handled — plain mainline PGN only.
- There's no drag-and-drop / click-to-move board for playing out your
  own moves. Adding that means live re-analysis after every manual
  move, handling promotions and illegal-move feedback, and deciding
  what happens to the loaded game's classification once you deviate
  from it — enough extra scope that it felt better left out of a first
  prototype than done halfway.
- Pieces are Unicode chess glyphs (styled a bit, with a subtle outline)
  rather than the actual Lichess/cburnett SVG piece set. Hot-linking
  those SVGs from lila's GitHub repo would be easy in principle, but
  wasn't done here to avoid a fragile external dependency in a
  prototype; if you want them, download the `cburnett` folder from
  https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
  and swap `placeSquare()` in `app.js` to render `<img>` tags instead
  of the `PIECE_GLYPHS` text.

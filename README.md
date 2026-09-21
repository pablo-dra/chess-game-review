# Chess Review Prototype

A small local web app that loads a PGN, runs it through Stockfish, and
tags each move as **Book / Correct / Good / Brilliant / Mistake / Blunder**
following the classification proposal discussed for the Lichess feature
request. It's meant as a proof of concept to attach to the GitHub
issue, not a production tool.

Use the following command on the root folder
npx http-server

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
  above that median counts as part of the "top cluster". If that
  cluster has 1–2 moves, the position was scarce → **Good**. If 3+,
  it's **Correct**. If nothing separates from the median at all
  (every candidate is basically equally good), the whole set counts as
  the cluster → **Correct**.
- **Brilliant** — a second, retrospective pass over the finished game.
  The first "Good" move opens a window of that player's own following
  moves (3 plies near the opening, up to 10 in the endgame — Carlsen
  has described his own calculation depth as ranging roughly 2 to 20
  moves depending on the moment of the game; 10 is used here as the
  practical ceiling). If every one of the player's moves in that
  window keeps landing in a scarce top cluster (≤2) without the
  advantage collapsing, the origin move is upgraded to Brilliant. No
  material-sacrifice detection is required — a Tal-style piece left
  "hanging" while pushing a different plan shows up naturally through
  this same scarcity/depth method.
- **Mistake / Blunder** — the classic win%-drop-from-best check, using
  the two thresholds set in the settings panel (defaults: 10 and 20
  points).

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

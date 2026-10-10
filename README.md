# Chess Game Review

A small web app that loads a PGN (pasted by hand, or fetched straight
from a Lichess username's public games), runs it through Stockfish,
and tags each move as **Book / Forced / Correct / Solid / Good /
Brilliant / Mistake / Blunder** following the classification proposal
discussed for the Lichess feature request. It's meant as a proof of
concept to attach to the GitHub issue, not a production tool. Runs
either locally or hosted for free on GitHub Pages — see below.

## 1. Setup (one-time)

### 1a. Get the engine — and keep it self-hosted

The `engine/` folder needs **`stockfish-18-lite-single.js`** and
**`stockfish-18-lite-single.wasm`**, downloaded from the official
releases page:
https://github.com/nmrugg/stockfish.js/releases/tag/v18.0.0
(the "lite single-threaded" flavor — no special CORS/COOP headers
needed, and still far stronger than any human). Put both files inside
`engine/`, next to this README, so you end up with:

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

**Keep these files committed in the repo itself rather than loaded
from an external CDN.** This isn't just a licensing/size call — it's
the more *reliable* option specifically because of how `engine` gets
loaded as a Web Worker:

- GitHub's own release-asset CDN doesn't send CORS headers at all, so
  a browser refuses to load `.wasm` or create a Worker from those
  URLs directly — confirmed this while checking options, not a
  guess. A CORS-friendly third-party mirror exists on Hugging Face
  specifically for this use case, but using it would still mean
  routing the engine's own Worker creation through a cross-origin URL,
  which browsers are fussier about than a plain CORS-enabled `fetch`
  — it can require fetching the script as text and instantiating the
  Worker from a Blob URL, and even then the engine's own internal
  fetch of its `.wasm` companion file (a relative path) isn't
  guaranteed to resolve correctly once it's running from a Blob URL
  rather than a real directory.
- Self-hosting sidesteps all of that: same origin as the page, so no
  CORS questions, no cross-origin Worker restrictions, and the
  relative path between the `.js` loader and its `.wasm` file always
  resolves correctly. GitHub (and GitHub Pages) has no problem serving
  a ~7 MB binary file as a normal static asset.

### 1b. Get the piece sprite

The board renders pieces with the **cburnett** set (by Colin M. L.
Burnett), via a single sprite image rather than individual files.
Download it from Wikimedia Commons —
https://commons.wikimedia.org/wiki/File:Chess_Pieces_Sprite.svg —
and save it as `assets/cburnett-sprite.svg`, next to this README (a
placeholder `assets/README.md` with the same instructions is already
in the folder). Same reasoning as the engine: self-hosted, not
hotlinked, so there's no CORS/origin question at all once it's
committed.

The sprite is a 270×90px, 6-column × 2-row grid (45px per cell):
columns left to right are King, Queen, Bishop, Knight, Rook, Pawn; the
top row is the white pieces, the bottom row is black. If a piece looks
wrong once deployed, it's a one-line CSS fix — see the comment above
`.square .piece` in `style.css` for exactly which values to swap.

### 1c. Running it

**Locally, while developing:** any static server works, since Worker
creation and the opening-book lookup both need a real origin (opening
`index.html` directly as a `file://` won't work). From this folder:

```bash
python3 -m http.server 8000
```

or, in VS Code, right-click `index.html` → "Open with Live Server" (if
you have that extension installed) — then open `http://localhost:8000`.

**Hosted for free, so you can hand someone a link — GitHub Pages:**

1. Push this folder (with the engine files from 1a and the piece
   sprite from 1b included) to a GitHub repo.
2. Add an empty file named **`.nojekyll`** at the repo root (included
   in this folder already — make sure it actually gets committed and
   pushed, since some Git clients hide dotfiles by default). This
   turns off GitHub's default Jekyll processing, which otherwise can
   mishandle folders starting with an underscore and isn't needed for
   a plain static site like this one.
3. In the repo's **Settings → Pages**, pick the branch and folder to
   serve (root of `main`, typically) and save.
4. GitHub gives you a URL like `https://your-username.github.io/your-repo/`
   — open that, and everything (engine included) loads from the same
   origin automatically, no extra configuration needed. Every path in
   `index.html` and `app.js` is already relative, so it works the same
   whether it's served from the repo root or from that `/your-repo/`
   subpath.

## 2. Using it

The left column has two tabs: **Set** (loading a game and running the
analysis) and **Moves** (the move list once it's ready) — kept
separate so the move list has its own dedicated space instead of
sitting squeezed below everything else.

1. On the **Set** tab, get a game in, one of two ways:
   - Type a **Lichess username** and click **Load games** — this calls
     Lichess's public games API (`/api/games/user/{username}`, no
     login needed, only works for public games) and lists recent
     games with opponent, result and opening. Click one to drop its
     PGN straight into the text box below.
   - Or just paste a PGN directly into the text box yourself.
2. Click **Analyze**. The gear icon lets you change search depth,
   MultiPV width, and the Mistake/Blunder thresholds before running.
   Once analysis finishes, the view switches to the **Moves** tab
   automatically.
3. Click through the move list, or use the ◀ ▶ buttons (or your
   keyboard's left/right arrows) to step through the game; the badge
   on the last-moved square and the stats table on the right update
   per move. **Reset** switches back to the **Set** tab.

Analysis runs entirely in your browser — nothing is sent anywhere
except the opening-book lookups to Lichess's public Masters explorer
(see below).

## 3. How the classification works

This mirrors the proposal, simplified and refined over several rounds
of testing against real games:

- **Book** — while the position matches Lichess's Masters opening
  explorer with at least 50 games behind it (`explorer.lichess.ovh`,
  called live from your browser — note the `.ovh`, confirmed against
  the opening explorer's own official source repo; an earlier version
  of this file pointed at `.org` by mistake, which is why book
  detection used to always fall back to the heuristic below). If the
  call fails (offline, rate-limited, etc.) it falls back to a rough
  heuristic of "the first 6 plies" for that move only, and says so in
  the opening status line and the browser console.
- **Forced** — a position with exactly one legal move (e.g. the only
  way out of check) is labeled Forced and skipped entirely: no engine
  analysis runs on it, and it's never eligible to be Good, Solid, or
  to start/extend a Brilliant chain, since there was no decision to
  judge either way.
- **Mistake / Blunder** — the classic win%-drop-from-the-best-move
  check, using the two thresholds in the settings panel (defaults: 10
  and 20 points).
- **Correct / Solid / Good** — for every other move, the engine
  reports the top ~5 candidates (MultiPV) at a fixed depth (default
  18, matching what Lichess's own server analysis already uses), each
  converted to win% with the same curve Lichess uses for its Accuracy
  stat. The **mean** of those candidates is the single reference point
  used for everything below (deliberately one consistent statistic
  rather than mixing median and mean, which an earlier version did):
  - If 2 or fewer candidates sit clearly above that mean — a gap of
    5+ win% points by default — the position is a **scarce / critical
    moment**: e.g. candidates at win% `18, 35, 45, 60, 85` (mean
    ≈48.6) only `60` and `85` clear the gap, so the cluster is just
    those two. Playing one of them is **Good**, but only if it's also
    a genuine gain (8+ win% points by default) over where this same
    player already stood two of their own moves ago — i.e. before the
    opponent's intervening move. That gain check is what keeps an
    obvious, forced-looking retreat (a hanging knight with only one or
    two safe squares) from scoring the same as a real find: moving the
    knight back to safety doesn't improve on where White already was,
    it just avoids losing what was already fine, so it stays
    **Correct** instead. A scarce move that misses the scarce cluster
    entirely is Correct too.
  - If 3 or more candidates are close together — a standard,
    unremarkable position, e.g. win% `40, 43, 44, 45, 48` (mean 44,
    nothing clears the gap) — there's no standout to chase, so the
    split is simpler: **Solid** for a move at or above that mean (e.g.
    playing 45 or 48), **Correct** for one below it (e.g. 40 or 43).
  - A move that isn't among the analyzed candidates at all is always
    **Correct** (never Good or Solid), regardless of what its own
    searched evaluation happens to be — it wasn't one of the position's
    standout or above-average options as far as the analysis goes.
- **Brilliant** — not a per-move check at all: a single retrospective
  pass over the finished game. The first **Good** move opens a window
  of that same player's own subsequent moves. If every one of them is
  also **Good or Solid**, *and* the opponent's own moves across that
  same span were never a Mistake or Blunder (otherwise it's their
  error being converted, not a demonstrated combo), the origin move is
  upgraded to Brilliant — the rest of the chain keeps whatever label
  it already had. Forced and Book moves inside the span don't count
  toward it and don't break it either, since neither involves a real
  choice. No material-sacrifice detection is needed for this — a
  Tal-style piece left "hanging" while pushing a different plan shows
  up naturally through the same Good/Solid chain.

  The window length is configurable separately for the opening and
  the endgame (defaults: 2 of the player's own moves early, 4 late —
  i.e. 2 full moves vs. 4 full moves), interpolated smoothly between
  the two rather than switching abruptly at a cutoff. The phase that
  drives the interpolation is read from **two signals, taking
  whichever indicates the more advanced phase**: material left on the
  board (100-80% → early, 80-30% → mid, ≤30% → late) and the move
  number itself (≤10 full moves → early, ≤30 → mid, beyond → late). A
  long, slow, piece-heavy game past move 30 counts as late-game even
  if material hasn't dropped much, and a sharp line that sheds material
  fast counts as late-game even before move 10.

All thresholds (Mistake drop, Blunder drop, Good's minimum gain, and
the two Brilliant chain lengths) are exposed in the gear-icon settings
panel so they're easy to retune while testing against real games —
nothing about their defaults is meant to be final. The material/move
breakpoints that drive the phase interpolation aren't yet exposed as
settings (they're constants inside `brilliantWindow()` in
`classification.js`) — worth adding to the panel too if they turn out
to need tuning.

## 4. Exporting the analyzed game

The "Export annotated PGN" button (enabled once an analysis finishes)
downloads the game with every move tagged as a standard PGN comment,
e.g.:

```
1. e4 {📖 Book} e5 {📖 Book} 2. Nf3 {! Good} ...
```

Ticking "Include candidate moves + win% in export" adds each position's
analyzed alternatives to that same comment, e.g.
`{! Good | candidates: Qxc3 56.9%, bxc3 43.6%, g4 10.7%, e4 10.6%, h4 10.6%}`
— useful for debugging a specific classification without having to
step through the board in the UI move by move. If the opening was
matched against Lichess's Masters explorer, the game headers also get
an `[Opening "Name (ECO)"]` tag.

PGN comments in `{ }` are part of the format and are simply ignored by
any PGN reader that doesn't care about them, so this file re-imports
cleanly anywhere (including back into this same tool) — useful for
diffing how the algorithm's output changes as you retune the settings
above, or for pasting into the GitHub issue as a worked example.

## 5. Accuracy and rating estimate

Once an analysis finishes, the panel above the move-count table shows
each player's accuracy % and a rating estimate:

- **Accuracy** uses Lichess's own published formula (win%-drop per
  move, converted with `103.1668 * e^(-0.04354 * drop) - 3.1669`,
  clamped to 0-100), then blends the plain average with the harmonic
  mean across the game the same way Lichess's own accuracy score does
  (their exact "volatility weighting" isn't public, so this is a
  transparent approximation of it, not a byte-for-byte replica). This
  part is on solid, checkable ground — the formula is publicly
  documented and the numbers here match Lichess's own reference values
  (e.g. a single 20-point win% drop mid-game gives ~40% accuracy for
  that move either place).
- The **rating estimate** next to it is a different story: there is no
  validated, public formula anywhere for turning accuracy (or centipawn
  loss) into a rating — Lichess and chess.com both keep their exact
  methods undisclosed, and by their own users' accounts these estimates
  swing wildly and don't account for the opponent's strength at all,
  which matters a lot. What's shown here is a simple, openly-arbitrary
  piecewise-linear lookup from accuracy alone (calibrated loosely
  against community reference points), always prefixed with `~` and
  paired with a visible disclaimer in the UI. Treat it as a fun
  ballpark, not something to cite.

## 6. Known limitations of this prototype

These are simplifications made to keep a first version buildable in a
reasonable amount of code — worth flagging in the GitHub issue rather
than hiding:

- The "mean" used for both the scarcity check and the Solid/Correct
  split is computed over the top ~5 MultiPV candidates, not over every
  legal move in the position (evaluating every legal move to full
  depth would multiply the cost far more than the ~2–3x estimated in
  the proposal). This is a reasonable approximation in practice but
  not identical to a true full-width mean.
- Mate scores are converted to a fixed near-100%/0% win% rather than
  being ranked among themselves (a mate-in-1 and a mate-in-6 both read
  as ~100%). This never matters for Book/Correct/Good/Solid, only in
  the rare case where multiple candidates are all forced mates.
- The "Load games" username lookup calls Lichess's public games API
  directly from the browser, same as the opening-book check — if it
  fails, the error (including an HTTP 429 if you hit a rate limit from
  loading many usernames in a short burst) is logged to the console
  rather than guessed at silently. Games still in progress have no
  PGN yet; clicking one of those shows an alert instead of loading
  nothing silently.
- The opening-book check calls Lichess's public Masters explorer for
  every position while still in book; each request is independent (a
  single failed request only falls back to a heuristic for that one
  move, it no longer disables the check for the rest of the game) and
  any failure is logged to the browser console with its actual cause.
  This is fine for reviewing a handful of games but would need local
  caching or a bundled dataset to run offline or at scale, and if the
  explorer is unreachable for the whole game, book detection falls
  back to "the first 6 plies" for the whole thing — check the console
  if that keeps happening, since it usually means every request is
  failing for the same reason (rate limiting, a network block, etc.)
  rather than theory genuinely ending that early.
- No opening/PGN edge cases like variations, NAGs, or annotated
  comments in the PGN are handled — plain mainline PGN only.
- There's no drag-and-drop / click-to-move board for playing out your
  own moves. Adding that means live re-analysis after every manual
  move, handling promotions and illegal-move feedback, and deciding
  what happens to the loaded game's classification once you deviate
  from it — enough extra scope that it felt better left out of a first
  prototype than done halfway.
- Pieces use the real cburnett sprite (self-hosted, see 1b), but its
  internal grid layout (column order, which row is white) was taken
  from the file's known dimensions and standard convention, not from
  actually opening and inspecting the file — double-check it looks
  right once deployed; see the CSS comment above `.square .piece` in
  `style.css` for the one-line fix if a piece looks wrong.
- There's no local fallback if the sprite file is missing or fails to
  load (a 404 just renders blank squares with no piece visible, rather
  than falling back to text glyphs or an error message).

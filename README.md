# Chess Game Review

A small web app that loads a PGN (pasted by hand, or fetched straight
from a Lichess username's public games), runs it through Stockfish,
and tags each move as **Book / Correct / Best / Good / Brilliant /
Forced / Mistake / Blunder** following the classification proposal
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

### 1b. Running it

**Locally, while developing:** any static server works, since Worker
creation and the opening-book lookup both need a real origin (opening
`index.html` directly as a `file://` won't work). From this folder:

```bash
python3 -m http.server 8000
```

or, in VS Code, right-click `index.html` → "Open with Live Server" (if
you have that extension installed) — then open `http://localhost:8000`.

**Hosted for free, so you can hand someone a link — GitHub Pages:**

1. Push this folder (with the engine files included, per 1a) to a
   GitHub repo.
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

1. Get a game in, one of two ways:
   - Type a **Lichess username** and click **Load games** — this calls
     Lichess's public games API (`/api/games/user/{username}`, no
     login needed, only works for public games) and lists recent
     games with opponent, result and opening. Click one to drop its
     PGN straight into the text box below.
   - Or just paste a PGN directly into the text box yourself.
2. Click **Analyze**. The gear icon lets you change search depth,
   MultiPV width, and the Mistake/Blunder thresholds before running.
3. Click through the move list or use the ◀ ▶ buttons (or your
   keyboard's left/right arrows) to step through the game; the badge
   on the last-moved square and the stats table on the right update
   per move.

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
- **Best / Correct / Good** — for every non-book position, the engine
  reports the top ~5 candidate moves (MultiPV) at a fixed depth
  (default 18, matching what Lichess's own server analysis already
  uses). Each candidate's centipawn score is converted to a win% using
  the same curve Lichess uses for its Accuracy stat. We take the
  **median** win% across those candidates: any move sitting more than
  a small gap above that median counts as part of the "top cluster". A
  move only becomes **Good** if that cluster has 1-2 moves **and**
  playing it is a genuine gain (by default, 8+ win% points) over where
  this same player already stood two of their own moves ago — i.e.
  before the opponent's intervening move. This is what keeps an
  obvious, forced-looking retreat (e.g. a hanging knight with only one
  or two safe squares) from scoring the same as a real find: moving
  the knight back to safety doesn't improve on where White already
  was, it just avoids losing what was already fine, so it's scored
  **Correct** instead (a scarce move that failed the gain check always
  lands here, never in Best — see below for why).

  If the cluster has 3+ moves — i.e. no scarce standout, plenty of
  roughly-equal options — the median-based cluster check doesn't have
  anything more useful to say, so within that group we fall back to a
  much simpler split: the plain **mean** of the candidates' win%. A
  move above that mean is **Best**; at or below it, it's **Correct**.
  Concretely: candidates at 51.95/51.65/50.4/50.1/49% (mean ≈50.62%) —
  playing 51.95% or 51.65% earns Best, playing any of the other three
  stays Correct. This only applies to the "everyone's about equal"
  case; a scarce (≤2) move that merely held its ground never gets
  promoted to Best through this path, since the point of that
  distinction is specifically to flag "you found a genuinely better
  option among many good ones", not to soften the Good/Correct gain
  requirement discussed above.
- **Brilliant** — now has **two independent, additive** paths, either
  of which is enough:
  1. *Scarcity chain* (the original idea): the first "Good" move opens
     a window of that player's own following moves. The window length
     is configurable separately for the opening and the endgame (both
     defaulting to 2 of the player's own moves), and interpolated
     smoothly between the two based on **how much material is left on
     the board**, not the move number — a queen-less middlegame at
     move 10 behaves like an endgame here, and a slow, piece-heavy
     position at move 20 still behaves like the opening. Concretely:
     material ≥80% of the starting total → the "early" length; ≤13%
     (roughly a queen or a minor piece plus a couple of pawns, per the
     "late game" description discussed) → the "late" length; linearly
     interpolated in between. If every one of the player's moves in
     that window keeps landing in a scarce top cluster (≤2) without
     the advantage collapsing, **and the opponent was putting up
     reasonable resistance throughout the same span** (see below), the
     origin move is upgraded to Brilliant.
  2. *Top-move chain* (added after testing against real games): reward
     simply finding the engine's actual #1 move several times in a row
     for the same player — even when the top cluster wasn't scarce at
     each individual step — as long as doing so builds up a real
     advantage over the span, and, same as path 1, the opponent held
     up their end. Default: 2 consecutive own moves, 10+ win% points
     gained overall. Only the *first* move of a qualifying run gets
     upgraded to Brilliant; the rest keep whatever label they already
     had (usually Correct).

  **Judging the opponent's moves** (shared by both paths, found in
  `opponentPlayedReasonably()`): after an early version let a couple of
  false positives through — the opponent's move looked "fine" by a
  plain win%-drop threshold, but only because the position was so flat
  that nothing drops much — this now runs as two sequential gates
  against every opponent move inside the chain's span:
  1. Their move has to be one of the engine's analyzed top-N candidates
     at all. A move so far outside the shortlist that the engine never
     even reported it doesn't count as resistance, no matter how small
     its measured win% drop happens to look.
  2. If it was one of the candidates, it also has to be one of the
     *good* ones among that specific set. This is found by sorting that
     position's candidates best-to-worst and cutting the "reasonable"
     group at the first gap that's large *relative to that set's own
     spread* (default: a drop bigger than 30% of the top-to-bottom
     range disqualifies everything past that point). One rule handles
     two different shapes: candidates `[9, 4, -1, -1, -1]` → only the
     `9` passes (the very next value is already a big relative drop);
     candidates `[4, 3.98, 3.96, 3.9, 3.9]` → `4`, `3.98` and `3.96`
     all pass (tightly bunched together, no real gap yet), only the
     trailing `3.9`s fail.

  Either gate failing on any opponent move in the span disqualifies
  the whole chain for that origin move. The origin player's own moves
  in between (when the window spans more than one) are explicitly
  skipped here — those are judged separately by each path's own
  advantage/scarcity check, not by these opponent-facing gates.

  Both paths ignore Forced and Book moves in between (they don't count
  toward either chain, don't break one, and are exempt from the
  opponent-quality gates above, since none of the three involve a real
  choice under scrutiny). No material-sacrifice detection is required
  for either path — a Tal-style piece left "hanging" while pushing a
  different plan shows up naturally through the scarcity-chain method.
- **Forced** — when a position has exactly one legal move (e.g. the
  only way out of check), it's labeled Forced and skipped entirely:
  no engine analysis is run on it, and it can never be Good or start
  or extend either kind of Brilliant chain, since there was no real
  decision behind it.
- **Mistake / Blunder** — the classic win%-drop-from-best check, using
  the two thresholds set in the settings panel (defaults: 10 and 20
  points).

All thresholds (Mistake drop, Blunder drop, Good's minimum gain, the
two scarcity-chain lengths, the two top-move-chain settings, and the
opponent gap ratio used by both chains' opponent-quality gate) are
exposed in the gear-icon settings panel specifically so they're easy
to retune while testing against real games — nothing about their
default values is meant to be final. The 80%/13% material breakpoints
that drive the early/late interpolation are not yet exposed as
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

- The "median" is computed over the top ~5 MultiPV candidates, not
  over every legal move in the position (evaluating every legal move
  to full depth would multiply the cost far more than the ~2–3x
  estimated in the proposal). This is a reasonable approximation in
  practice but not identical to a true full-width median.
- Mate scores are converted to a fixed near-100%/0% win% rather than
  being ranked among themselves (a mate-in-1 and a mate-in-6 both read
  as ~100%). This never matters for Book/Correct/Good, only in the
  rare case where multiple candidates are all forced mates.
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
- Pieces are Unicode chess glyphs (styled a bit, with a subtle outline)
  rather than the actual Lichess/cburnett SVG piece set. Hot-linking
  those SVGs from lila's GitHub repo would be easy in principle, but
  wasn't done here to avoid a fragile external dependency in a
  prototype; if you want them, download the `cburnett` folder from
  https://github.com/lichess-org/lila/tree/master/public/piece/cburnett
  and swap `placeSquare()` in `app.js` to render `<img>` tags instead
  of the `PIECE_GLYPHS` text.

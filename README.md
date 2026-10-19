# Chanlun Chart (缠论图表)

Deterministic implementation of the Chan Theory pipeline (merging → fractals →
strokes → segments → centers → divergences) plus a real-time cryptocurrency
chart built on KLineChart v10. No build step, no runtime dependencies.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Core Algorithm Pipeline](#core-algorithm-pipeline)
- [Key Technical Implementations](#key-technical-implementations)
  - [Divergence Detection](#divergence-detection)
  - [Real-Time Update Strategy](#real-time-update-strategy)
  - [Incremental Calculation Engine](#incremental-calculation-engine)
  - [Segment Determination](#segment-determination)
  - [Data Layer & Reconnection](#data-layer--reconnection)
- [Visualization Highlights](#visualization-highlights)
- [Configuration & Parameterization](#configuration--parameterization)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Behavior Changes](#behavior-changes)
- [Installation & Usage](#installation--usage)
- [License](#license)

## Features

- **Complete Chan Theory Pipeline**: Merging → Fractals → Strokes → Segments → Centers → Divergences.
- **Real-Time Data Handling**: WebSocket reconnection with exponential backoff, REST backfill after reconnect, and a content-signature based update strategy.
- **Incremental Calculation**: Efficiently processes appended or modified K-lines, with results byte-for-byte identical to a full recalculation.
- **Rich Visualization**:
  - Stroke, segment, and center overlays with distinct styles for stroke vs. segment centers.
  - MACD histogram area highlighting for divergence zones.
  - Volume with MA5, MA10, MA20 lines.
  - Customizable color scheme (Western red/green for up/down, or Chinese style).
- **Fully Parameterized**: Core algorithm thresholds are configurable via `src/config.js`.
- **Zero-Dependency Testing**: Node.js test suite with 130+ tests, including random stress tests and optional live-network integration tests.

## Architecture

```text
index.html         # Main entry, loads scripts in dependency order (no build step)
│
├─ src/                # Core algorithm modules (UMD style, works in browser & Node)
│  ├─ config.js        # All rule parameters
│  ├─ merge.js         # Bar merging (containment) logic
│  ├─ fractal.js       # Fractal identification
│  ├─ stroke.js        # Stroke (bi) state machine
│  ├─ segment.js       # Segment scanning (feature-sequence method)
│  ├─ center.js        # Center/pivot calculation
│  ├─ divergence.js    # Stroke-level divergence with big-level confirmation
│  └─ analyzer.js      # Incremental calculation orchestrator
├─ chanlun.js          # Module assembly layer → window.chanlun / module.exports
├─ data-layer.js       # Data caching, retry logic, WebSocket management, backfill
├─ realtime.js         # Real-time bar update strategy (content-signature based)
├─ main.js             # KLineChart integration, exchange adapters, drawing, UI
├─ style.css           # Layout and theming
└─ tests/              # Zero-dependency test suite
```

## Core Algorithm Pipeline

```text
Raw K-lines → Containment Merging → Fractals → Strokes → Segments → Centers → Divergences
```

## Key Technical Implementations

### Divergence Detection (src/divergence.js)

Divergence is evaluated on two levels to improve reliability.

**Local (stroke-level):**

- Looks backward for the same-direction stroke whose extreme is exceeded.
- Requires a stroke-level center between the two strokes (or a single large center covering both).
- If the current stroke's momentum strength is weaker (ratio < `divergence.minMomentumDrop`) → stroke divergence.
- Comparison candidates with zero same-direction momentum (e.g. an early reversal whose MACD bars are still counter-direction) are skipped; the search continues to an earlier same-direction stroke with real momentum, still bounded by the "extreme must be exceeded" rule.

**Big-level (segment-level) confirmation:**

- Compares the momentum of the current stroke's parent segment against the previous same-direction completed segment.
- Strong divergence (confirmed): big-level momentum is also fading.
- Weak divergence: big-level momentum is expanding or no comparable segment exists.

**Momentum measurement:** `hist = 2*(DIF-DEA)` from MACD(12,26,9). For a window,

```text
momentum = (sum of histogram bars in the move's direction) / windowLength
```

Only same-direction bars are accumulated (up: positive bars; down: absolute value
of negative bars); counter-direction bars contribute zero. This is the same
convention as `rangeMomentum` (which returns the unnormalized area), and it
prevents a net-negative counter-direction window from being treated as strong
momentum. Dividing by window length keeps windows of different lengths comparable.

### Real-Time Update Strategy (realtime.js)

KLineChart reuses and mutates the last bar object in real time. To detect changes
reliably, this module uses a content signature:

```text
barSignature(bar) = timestamp|open|high|low|close|volume|isBarClosed
```

Update logic (`createRealtimeUpdater`):

- `init`: first load, first-bar timestamp change, first-bar signature change, or length shrink.
- `append`: new bars added. If the old last bar was also modified in the same batch, it is processed with `updateLast` before appending.
- `replaceLast`: length unchanged but the last-bar signature changed (intra-bar tick or final close).
- `skip`: no changes.
- `error`: any step threw; the next call self-heals with a full rebuild.

### Incremental Calculation Engine (src/analyzer.js)

`createAnalyzer` performs a full initial analysis. Subsequent updates are incremental:

- `update(newBars)`: appends new bars. Merge, fractal, and stroke layers are updated incrementally. Segments and centers are fully re-scanned from the updated strokes (fast, and avoids anchor drift). MACD is extended incrementally and per-window momentum is reused from a tail-invalidated cache.
- `updateLast(bar)`: replaces the last bar. Handles unmerge → re-merge → re-evaluate fractals and strokes from the affected tail. If the merged tail is unchanged it skips the downstream rescan (but still refreshes divergences when the close changed).
- **Consistency guaranteed**: tested to be byte-for-byte identical to a full `analyze()` on the entire dataset.

### Segment Determination (src/segment.js)

Implements the feature-sequence method as described in Lessons 67/71 of the original Chan Theory.

- Uses a state machine with `pending` (second-type situations/gaps) and negation handling (`negExtreme`).
- Each segment includes a `features` array for visualization: the direction-specific strokes used in the scan.
- Critical fix (2024-08): corrected a bug where `features` incorrectly merged pending features on negation. Regression tests cover seeds 52, 145, and 209.
- Segment destruction (extension rule, not literal Lessons 67/71): while a segment extends, if any stroke's extreme exceeds the segment-start extreme (up: stroke low < start low; down: stroke high > start high), the old segment ends at the breaching stroke's start and a new reversed segment begins there (marked `destroyed: true`). Only applies to established segments (≥3 strokes). Disable via `config.segment.destroyOnBreach = false` to restore the pure literal rule.

### Data Layer & Reconnection (data-layer.js)

- **Caching**: per `(exchange, symbol, period)` with dedup/ascending normalization and LRU eviction.
- **Init catch-up**: re-includes the last cached bar (`afterOf(lastTs - 1)`) so a bar cached while still open receives its final value. If more than one page is missing, it loops until caught up; a detected gap (exchange returns only the newest page) reloads the cache instead of leaving a time hole.
- **WebSocket reconnect**: after a reconnect, message delivery is paused, missed bars are backfilled over REST (paging backward from the newest page until the chart's last bar is covered), then the subscription is re-established and buffered messages are replayed. Stale backfills from superseded sockets are discarded.

## Visualization Highlights

**Centers (pivots):**

- Segment centers (high level): thick solid border, labeled "线段中枢".
- Stroke centers (low level): thin dashed border, labeled "笔中枢".
- Both display upper/lower price tags and are colored by direction (red for up, green for down).

**Divergence markers:**

- Strong (trend divergence): solid triangle/circle.
- Weak (consolidation divergence): hollow circle.
- Up/down arrows, connecting dotted lines, and the momentum ratio.
- The MACD pane highlights the two compared zones with semi-transparent overlays and area labels.

**Feature sequence visualization:**

- `features`: original strokes (raw) as candlestick-like bars.
- `mergedFeatures`: containment-merged feature bars.
- Merged bars are highlighted with yellow dots/overlays.

## Configuration & Parameterization

Pass a config object to `chanlun.analyze(bars, config)` or `chanlun.createAnalyzer(config)`:

```js
{
  bi: { minGap: 4 },              // Minimum merged-bar gap within a stroke
  segment: { method: 'feature-sequence', destroyOnBreach: true },
  center: { minElements: 3 },
  divergence: {
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    minMomentumDrop: 0.9,         // Local divergence threshold
    requireCenter: true           // Must have a center between strokes
  }
}
```

> The legacy top-level `biMinGap` key is still accepted as an alias.

## Project Structure

```text
chanlun/
├── index.html          # Main HTML, loads all scripts
├── style.css           # Global styles (responsive + reduced-motion)
├── main.js             # Chart initialization, exchange adapters, drawing, UI glue
├── chanlun.js          # Public API assembly
├── data-layer.js       # Data fetching, caching, reconnection, backfill
├── realtime.js         # Real-time update handler
├── src/                # Core algorithms (can run in Node)
│   ├── config.js
│   ├── merge.js
│   ├── fractal.js
│   ├── stroke.js
│   ├── segment.js
│   ├── center.js
│   ├── divergence.js
│   └── analyzer.js
├── tests/              # All tests run with `node tests/run.js`
├── package.json        # Test scripts (no dependencies)
├── LICENSE             # MIT
└── .github/workflows/  # CI
```

## Testing

The project includes a comprehensive, zero-dependency test suite.

```bash
# Run all tests (excluding real-network tests)
npm test          # or: node tests/run.js

# Run a single test file
node tests/run.js tests/segment-edge.test.js

# Run real-network tests (requires LIVE_NETWORK=1)
LIVE_NETWORK=1 node tests/run.js tests/live-network.test.js
```

Coverage includes:

- Unit tests for all core modules (merge, fractal, stroke, segment, center, divergence, analyzer).
- Incremental consistency tests (incremental vs. full results).
- Real-time stress tests (5000+ random ticks).
- Data-layer tests (retry, reconnection, backfill, cache catch-up).
- Visualization regression tests.
- Live network integration tests for Binance and OKX (optional).
- Browser smoke tests.

## Behavior Changes

- **Divergence momentum semantics**: momentum now counts only same-direction MACD
  histogram bars (unified with `rangeMomentum`) instead of the absolute value of the
  direction-signed net area. Counter-direction momentum no longer inflates strength,
  so the number of signals is expected to decrease. Divergence comparison also skips
  zero-momentum candidates while the "extreme exceeded" bound still holds.
- **`fractal.mode` removed**: after containment merging, adjacent bars cannot contain
  each other, so the `strict` and `relaxed` modes were equivalent. Only the `strict`
  definition remains.
- **Reconnect backfill**: a WebSocket reconnect now triggers a REST backfill of the
  bars missed while disconnected, preventing time gaps after sleep/network loss.
- **OKX `isBarClosed`**: now derived from the candles channel `confirm` field instead
  of always `false`.

## Installation & Usage

Clone the repository and open `index.html` in a modern browser:

```bash
git clone https://github.com/qiqiqiao/chanlun.git
cd chanlun
# Open index.html in your browser, or serve with any static server
```

All JavaScript is loaded directly from `src/` and local files. No build step or
installation is required. KLineChart is loaded from a CDN with SRI.

## License

MIT. See [LICENSE](LICENSE).

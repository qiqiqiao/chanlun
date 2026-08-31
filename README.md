Chanlun Chart · 缠论图表
A deterministic implementation of Chan's Theory (缠论) with real-time cryptocurrency charts, built on KLineChart v10.

Live Demo: https://chan.61116111.xyz/

Table of Contents
Features

Architecture

Core Algorithm Pipeline

Key Technical Implementations

Divergence Detection

Real-Time Update Strategy

Incremental Calculation Engine

Segment Determination

Visualization Highlights

Multi-Period Linking

Configuration & Parameterization

Project Structure

Testing

Installation & Usage

Features
Complete Chan Theory Pipeline: Merging → Fractals → Strokes → Segments → Centers → Divergences.

Dual-Chart Multi-Period Linking: Main chart with a synchronized higher-timeframe sub-chart for macro-micro analysis.

Real-Time Data Handling: Robust WebSocket reconnection, exponential backoff, and a content-signature based update strategy.

Incremental Calculation: Efficiently processes new or modified K-lines, preserving consistency with full recalculation.

Rich Visualization:

Stroke, segment, and center overlays with distinct styles for pen vs. segment centers.

MACD histogram area highlighting for divergence zones.

Volume with MA5, MA10, MA20 lines.

Customizable color scheme (Western red/green for up/down, or Chinese style).

Fully Parameterized: All core algorithm thresholds are configurable via a single config.js.

Zero-Dependency Testing: Node.js based test suite with over 126 tests, including random stress tests and real-network integration tests.

Architecture
text
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
├─ data-layer.js       # Data caching, retry logic, WebSocket management
├─ realtime.js         # Real-time bar update strategy (content-signature based)
├─ main.js             # KLineChart integration and drawing logic
├─ style.css           # Layout and theming
└─ tests/              # Zero-dependency test suite
Core Algorithm Pipeline
The complete transformation pipeline is:

text
Raw K-lines → Containment Merging → Fractals → Strokes → Segments → Centers → Divergences
Key Technical Implementations
Divergence Detection (src/divergence.js)
Divergence is evaluated on two levels to improve reliability:

Local (Stroke-Level):

Looks backward for the same-direction stroke that exceeds the current stroke's extreme.

Requires a stroke-level center between the two strokes (or a single large center covering both).

If the current stroke's momentum strength is weaker (ratio < divergence.minMomentumDrop) → Stroke Divergence.

Big-Level (Segment-Level) Confirmation:

Compares the momentum of the current stroke's parent segment against the previous same-direction completed segment.

Strong Divergence (confirmed): Big-level momentum is also fading.

Weak Divergence: Big-level momentum is expanding or no comparable segment exists.

Momentum Measurement: Σ(hist) / count, where hist = 2*(DIF-DEA) from MACD(12,26,9). This normalizes for different time lengths.

Real-Time Update Strategy (realtime.js)
KLineChart reuses and mutates the last bar object in real-time. To detect changes reliably, this module uses a content signature:

barSignature(bar) = timestamp|open|high|low|close|volume|isBarClosed

Update logic (createRealtimeUpdater):

init: First load, timestamp change, or signature change of the first bar.

append: New bar added (length increases).

replaceLast: Length unchanged but last bar signature changed (intra-bar tick or final close).

skip: No changes.

Incremental Calculation Engine (src/analyzer.js)
createAnalyzer performs a full initial analysis. Subsequent updates are incremental:

update(newBars): Appends new bars. Only the merge, fractal, and stroke layers are incrementally updated. Segments and centers are fully re-scanned from the updated strokes (which is fast and avoids anchor drift).

updateLast(bar): Replaces the last bar. Handles unmerge → re-merge → re-evaluate fractals and strokes only from the affected tail.

Consistency Guaranteed: Tested to ensure incremental results are byte-for-byte identical to a full analyze() on the entire dataset.

Segment Determination (src/segment.js)
Implements the feature-sequence method as described in Lessons 67/71 of the original Chan Theory.

Uses a state machine with pending (for second-type situations/gaps) and negation handling (negExtreme).

Each segment includes a features array for visualization: the actual, direction-specific strokes used in the scan.

Critical Fix (2024-08): Corrected a bug where features incorrectly merged pending features on negation. Regression tests cover seeds 52, 145, and 209.

Visualization Highlights
Centers (Pivots):

Segment Centers (high-level): Thick solid border, labeled "线段中枢".

Stroke Centers (low-level): Thin dashed border, labeled "笔中枢".

Both display upper/lower price tags and are colored by direction (red for up, green for down).

Divergence Markers:

Strong (Trend Divergence): Solid triangle/circle.

Weak (Consolidation Divergence): Hollow circle.

Up/Down arrows, connecting dotted lines, and momentum ratio displayed.

MACD pane highlights the compared zones with semi-transparent overlays and area labels.

Feature Sequence Visualization:

features: Original strokes (raw) as candlestick-like bars.

mergedFeatures: Containment-merged feature bars.

Merged bars are highlighted with yellow dots/overlays.

Multi-Period Linking:

Sub-chart shows the next higher timeframe.

Bi-directional visual linking: highlighted time range on the sub-chart, and higher-level period boundaries on the main chart.

Multi-Period Linking
A sub-chart panel displays the next higher timeframe (e.g., 4h when main is 1h).

Linkage Toggle: When on (default), the sub-chart period follows the main chart. When off, the sub-chart can be set independently.

Click to Drill: Clicking a bar on the sub-chart scrolls the main chart to that time range.

Visual Anchors:

Sub-chart highlights the main chart's visible time range.

Main chart draws dashed vertical lines at the boundaries of the sub-chart's bars.

Data Isolation: Each chart has its own KLineChart instance, Chan state machine, and display options.

Caching: Both charts share the same klineCache keyed by exchange:symbol:period to prevent duplicate network requests.

Configuration & Parameterization
You can pass a config object to chanlun.analyze(bars, config):

javascript
{
  biMinGap: 4,                    // Minimum bar gap within a stroke
  fractal: { mode: 'strict' },    // 'strict' | 'relaxed'
  segment: { method: 'feature-sequence' },
  center: { minElements: 3 },
  divergence: {
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    minMomentumDrop: 0.9,         // Local divergence threshold
    requireCenter: true           // Must have a center between strokes
  }
}
Project Structure
text
chanlun/
├── index.html          # Main HTML, loads all scripts
├── style.css           # Global styles
├── main.js             # Chart initialization, drawing, and UI glue logic
├── chanlun.js          # Public API assembly
├── data-layer.js       # Data fetching and caching
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
└── tests/              # All tests run with `node tests/run.js`
    ├── *.test.js       # Unit and integration tests
    ├── fixtures.js     # Shared test data
    └── run.js          # Test runner
Testing
The project includes a comprehensive, zero-dependency test suite.

bash
# Run all tests (excluding real-network tests)
node tests/run.js

# Run a single test file
node tests/run.js tests/segment-edge.test.js

# Run real-network tests (requires LIVE_NETWORK=1)
LIVE_NETWORK=1 node tests/run.js tests/live-network.test.js
Test Coverage Includes:

Unit tests for all core modules (merge, fractal, stroke, segment, center, divergence, analyzer).

Incremental consistency tests (comparing incremental vs. full results).

Real-time stress tests (5000+ random ticks).

Visualization regression tests.

Live network integration tests for Binance and OKX (optional).

Browser smoke tests.

Installation & Usage
Simply clone the repository and open index.html in a modern browser.

bash
git clone https://github.com/qiqiqiao/chanlun.git
cd chanlun
# Open index.html in your browser, or serve with any static server
All JavaScript is loaded directly from the src/ and local files. No build step, package manager, or installation is required.

License: This project is open-source. (Please add your chosen license file, e.g., MIT, if not already present.)

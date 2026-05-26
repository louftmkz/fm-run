# FM RUN — Goal Document

> **Purpose of this file:** Compact spec + conventions snapshot so any AI agent (or human dev) can pick up the project without reading the full chat history. Update this file when architecture, conventions, or major mechanics change.

---

## Project

**FM RUN** is a PWA endless-runner game in vanilla HTML/CSS/JS, single-file (`index.html` + `service-worker.js`). Pixel-art aesthetic, Press Start 2P typography. Mobile-first, portrait-locked.

Live at: https://fm-run.vercel.app (deployed via Vercel auto-deploy on push to `main`).
Repo: https://github.com/louftmkz/fm-run (private).

Stack: HTML5 Canvas 2D, CSS, vanilla JS (no framework). Service Worker for PWA offline.

---

## File Layout

```
index.html              ~75kB, single-file game (HTML + CSS + JS in one)
service-worker.js       cache versioning, precache list of all sprites
manifest.json           PWA manifest (orientation: portrait-primary)
sprites/                all pixel-art assets (PNG, palette-quantized)
  lou-run.png           128x128 frames x8, character sprite sheets
  sasch-run.png         (same format)
  shizzo-run.png
  long-run.png
  level-minus-1.png     to level-6.png: per-level background tiles
  button-lou.png        Main-Nav character button face (50x50 source)
  icon-lou.png?v=2      Bottom-right "info" icon per button (16x16)
  name-lou.png          (unused currently)
  coin-1.png            14x13 x6 frames, base coin sprite
  coin-stack.png        15x13 x7 frames, stack of coins (+10)
  coin-bag.png          24x25 x7 frames, money bag (+25)
  coin-case.png         30x18 x7 frames, briefcase (+50)
  coin-pot.png          34x31 x7 frames, pot of gold (+100)
  coin-1up.png          20x18 x8 frames, 1UP power-up
  heart-empty.png       22x22, empty heart UI
  heart-full.png        22x22, full heart UI
  pause.png             24x24, pause icon
  play.png              24x24, play icon
README.md
vercel.json             routing config
```

---

## Game Architecture

### State Machine
```
READY → PLAYING ⇄ SLIDING/FALLING → PLAYING
                                  ↓
                                OVER
```
Additional orthogonal states: `paused` (toggled by pause button, freezes `update()`), `hit-pause` (400ms freeze on life-loss, real-time).

### Levels (8 total, Code Level 0..7)
| Code | Name              | User-facing | Speed | Notes |
|------|-------------------|-------------|-------|-------|
| 0    | Underground       | Ebene -1    | 260   | Random money rarity |
| 1    | Gutter & Ghetto   | Ebene 0     | 235   | 3er coin chain pattern |
| 2    | Training Room     | Ebene 1     | 180   | **START** |
| 3    | Night Club        | Ebene 2     | 195   | 3er coin chain pattern |
| 4    | Battle Ground     | Ebene 3     | 210   | Stack +10 |
| 5    | TV Studio         | Ebene 4     | 235   | Bag +25 |
| 6    | Theater Stage     | Ebene 5     | 260   | Case +50 |
| 7    | Spaceship         | Ebene 6     | 300   | Pot +100, MAX_LEVEL, no level above. Ramps become boost-pads for arc-jumps. |

`currentLevel = 2` at start. `MAX_LEVEL = 7`. Level 0 is the lowest reachable (falling below 0 = game over).

### Characters (`activeCharacter`)
- **Lou** (yellow): slides up ramps (only character that can climb)
- **Sasch** (green): destroys obstacles on contact (no game-over from obstacles)
- **Shizzo** (red/pink): only character that collects coins + 1ups
- **LonG** (blue): auto-jumps over gaps via dynamic physics

Switching is instant via bottom-nav buttons or keys `1`-`4`. Active player draws with no special distinction except behaviors above.

### Coordinate System
- World scrolls left at `speed` (~180-300 px/s level-dependent + distance-multiplier max +75%).
- Player at fixed screen X (constant). World/objects move toward them.
- `levelFloorY(k) = H * 0.65 + slideProgress * LEVEL_GAP - (k - currentLevel) * LEVEL_GAP`
  - At currentLevel: floor sits at `H * 0.65` (65% screen height).
  - `LEVEL_GAP = 192` (constant, no longer H-relative).
  - During SLIDING: `slideProgress` goes 0→1, world drops down → player visually rises.
  - During FALLING: `slideProgress` goes 0→-1, world rises → player visually drops.
- Player AABB: `player.w = 70, player.h = 80` (rendered ~192×192 with sprite).

### Ramps (STRICT PARALLELOGRAM)
**Geometry:**
- `RAMP_WIDTH = 220` (full sprite + spawn footprint)
- `RAMP_SLOPE = 120` (horizontal extent of walking diagonal)
- `RAMP_TRIGGER = 100` (bottom-edge width = trigger zone at ground level)
- Vertices (sprite-local): `A(0,192) B(120,0) C(220,0) D(100,192)`
- Angle: `atan(192/120) = 58°` (golden ratio 8:5 approx)

**Hitbox:**
- Lou's foot-center (`player.x+player.w/2, player.y+player.h`) must lie inside the parallelogram.
- Point-in-test: `dy = ry1 - pcy ; leftX = rp.x + (dy/LEVEL_GAP)*RAMP_SLOPE ; rightX = leftX + RAMP_TRIGGER ; if pcx in [leftX, rightX] → inside`.
- If Lou enters the trigger zone (sprite-local x in [0, 100] at ground): slide starts.
- If Lou misses (sprite-local x in [100, 220] at ground): walks under — no slide.
- Edge-case: Lou falling from above into the parallelogram (dy > 0) also triggers slide.

**Slide:**
- `slideStartX = rp.x` captured at trigger.
- `slideProgress = (slideStartX - rp.x) / RAMP_SLOPE`.
- Slide takes exactly 120 horizontal world-pixels regardless of entry position.

**Render:** procedural parallelogram fill (gradient orange→yellow) + white walking-diagonal accent line. Will be replaced with 220×192 pixel-art sprite once delivered.

### Gaps
- Width 80-130 px (variable per spawn), or fixed 90/100 in pattern definitions.
- `FORCE_GAP_W = 350` (force-fall gap, every 200m on each level to prevent level-camping).
- LonG auto-jumps over non-force gaps via dynamic physics (`tAir` calculated from gap width).
- Force gaps require Lou-ramp combo on Underground (Level 0) or are unjumpable on other levels.

### Money / Coin System
**Kinds + values:**
```js
SPRITE_BY_KIND = { coin: COIN_SPRITE_1, stack: COIN_SPRITE_STACK, bag: ..., case: ..., pot: ... }
VALUE_BY_KIND  = { coin: 1, stack: 10, bag: 25, case: 50, pot: 100 }
COIN_KIND_BY_LEVEL = [null, 'coin', 'coin', 'coin', 'stack', 'bag', 'case', 'pot']
                  // Code Level 0..7. null = Underground = random rarity
```

**Per-level behavior:**
- Underground (0): each spawn rolls rarity (single 25 / 3er 20 / stack 18 / bag 15 / case 12 / pot 10)
- Gutter+Ghetto (1) & Night Club (3): single coin + 3er-Reihe chain pattern (only these 2 levels)
- Training Room (2): single coin
- Battle Ground (4): stack +10
- TV Studio (5): bag +25
- Theater Stage (6): case +50
- Spaceship (7): pot +100

**Render scale:** `COIN_SCALE = 1.5` for all money. `ONEUP_SCALE = 2.0` for 1UP (bigger).
**Hitbox:** AABB at rendered sprite size (1.5x or 2.0x native frame). Only Shizzo collects.
**Glow:** green outer-glow + 1px hard outline via `drawWithGreenGlow()`. Uses offscreen-canvas-with-padding trick so glow extends beyond sprite frame.

### 1UP
- Triggered every 1000m: `nextOneUpAtDistance += 1000`.
- On MAX_LEVEL (Spaceship, Code 7): spawns as `ramp_oneup` pattern (Boost-Rampe + 1up in arc apex).
- On Code 3-6 (Night Club, Battle Ground, TV Studio, Theater Stage): spawns as `gap_air_oneup` (gap + 1up at LonG-jump apex).
- On Code 0-2: skipped (waits until player reaches eligible level).
- `MAX_LIVES = 3`. Collecting 1up at max → +100 bonus.

### Hit-Pause (Life-Loss Feedback)
- Triggered in `loseLifeOrGameOver()`.
- 400ms `update()` freeze (real-time via `performance.now()`).
- 5x player blink during freeze.
- Red screen flash overlay 500ms, pulses 5x, fades.
- Heart-container CSS shake animation 400ms.
- Then 1.5s standard invincibility flicker.

---

## Rendering Conventions

- `ctx.imageSmoothingEnabled = false` always (pixel-perfect).
- All `drawImage` coords integer-snapped (`Math.round`).
- Press Start 2P font for all text (HTML and Canvas). Pre-loaded via `<link rel="preload">`.
- Background gradient + per-level color slab + optional level-bg sprite tile (currently null/transparent).
- Sprites use `image-rendering: pixelated; image-rendering: crisp-edges` CSS for any `<img>`.
- Player rendered with 1.5x scale: source 128×128 → screen 192×192.
- Money rendered with `COIN_SCALE = 1.5`. 1UP with `ONEUP_SCALE = 2.0`.

### Money Glow (`drawWithGreenGlow`)
- Each frame is first drawn into a padded offscreen canvas (`GLOW_PAD = 32`) so shadow can bleed beyond the source frame edges.
- 2-pass soft glow: `shadowBlur=24` then `shadowBlur=10`.
- 4-pass hard outline: `shadowBlur=0`, `shadowOffset` in 4 directions (±OUT pixels).
- `MONEY_GLOW_COLOR = '#8cf0aa'` (bright spring green).
- Same glow used for 1UP and all coin variants.

### Shizzo-Money Visual Link
- Shizzo's `.charbtn` has green border (`rgba(140,240,170,0.45)` default, `var(--money)` when active).
- Active glow + charname text-shadow are green, not yellow.

---

## Conventions for AI Agents

### Git Workflow
- Local working copy: `/tmp/fm-run-fresh` (cloned via PAT to `https://github.com/louftmkz/fm-run.git`).
- Outputs directory (`/sessions/.../outputs/`) is the source of truth for current edits.
- After editing, `cp` files into `/tmp/fm-run-fresh`, `git add -A && git commit -m "..." && git push origin main`.
- Commit messages: "Step N: short title\n\n- bullet list of changes".

### Service Worker Cache Versioning
- **ALWAYS** bump `CACHE_NAME = 'fm-run-vN'` when changing index.html, sprites, or any cached asset.
- Add new sprites to PRECACHE list in service-worker.js.

### Pre-Push Sanity Check
Run via node `new Function(scriptBody)` to parse all `<script>` blocks in index.html. If both blocks parse OK, safe to push:
```bash
cd /sessions/.../outputs
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
let m, i=0;
while((m = re.exec(html))){
  i++;
  const txt = m[1];
  if(!txt.trim()) continue;
  try { new Function(txt); console.log('Block', i, 'OK', txt.length); }
  catch(e){ console.log('Block', i, 'ERR:', e.message); }
}
"
```

### PNG Optimization
When adding new sprites, palette-quantize via PIL FASTOCTREE (RGBA-safe):
```python
img.quantize(colors=64, method=Image.Quantize.FASTOCTREE).save(out, optimize=True)
```
Typically achieves 25-50% size reduction.

### Behavior Preservation
- Never change game balance / spawn rates / speeds without explicit user request.
- Never remove an existing animation, glow, or visual effect without explicit user request.
- When uncertain about UX, ask the user first.
- The user prefers iterative changes with deployable commits, not big rewrites.

### Spawn Conflict Rules
`hasOverlapOnLevel(arr, lvlMatch, x, w)` checks cross-level conflicts. Active rules:
- `spawnGap(lvl)` skips if `lvl-1` has a ramp at same x.
- `spawnRamp(lvl)` skips if `lvl-1` or `lvl+1` has a ramp at same x (no vertical stacking).
- `spawnRamp(lvl)` skips if `lvl+1` has a gap at same x (Lou would fall through after climb).
- `spawnForceFall(lvl)` uses `rightmostEntityInfoForLevel(lvl)` + 60px buffer to avoid overlapping recent spawns.

### Per-Level Spawn Rates
`SPAWN_RATES = { coin, obstacle, gap, ramp }` — each is an 8-element array indexed by Code Level. Events per 100m. Higher values = more frequent.
`PATTERN_RATES` — same shape, controls combo patterns like `coin_sandwich`, `gap_ramp`, `obstacle_gap_obstacle`, `coin_chain`, etc.
Tuning hint: ramps/gaps balanced for spawn pacing — don't blindly increase without testing.

---

## Open Issues / Next Steps

(Updated by maintainer. Leave empty when no specific task is queued.)

- **Pending:** User to deliver 220×192 pixel-art ramp sprite. Once delivered, integrate as `RAMP_SPRITE` and replace procedural parallelogram render.

---

## Quick Reference: Constants

```js
const MAX_LEVEL = 7;
const MAX_LIVES = 3;
const LEVEL_GAP = 192;
const RAMP_WIDTH = 220;      // sprite total
const RAMP_SLOPE = 120;      // slide horizontal extent
const RAMP_TRIGGER = 100;    // bottom-edge width
const COIN_SCALE = 1.5;
const ONEUP_SCALE = 2.0;
const FORCE_FALL_DISTANCE = 200;
const FORCE_GAP_W = 350;
const LOU_ARC_HEIGHT = 200;
const LOU_ARC_AIR_TIME = 1.4;
const LONG_JUMP_HEIGHT = 90;
const GRAVITY = 2400;
const JUMP_VEL = -880;
const PIXELS_PER_METER = 30;
const MONEY_GLOW_COLOR = '#8cf0aa';
const GLOW_PAD = 32;
```

---

*Last updated: Step 46 (parallelogram ramp hitbox). Bump version + heading when significant changes land.*

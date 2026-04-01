# 001: Board & Gameplay

**Status:** active (mostly done — UX design pass remaining)

## Goal
Core chess board interaction: rendering, legal moves, navigation, highlighting, promotion, and keyboard shortcuts. Includes the overall UX/UI design — layout, visual hierarchy, component arrangement, and interaction patterns.

## What's Built
- Chessground board renders with legal move dots
- Click-to-move and drag-and-drop
- Move history with clickable navigation
- Arrow key navigation (left/right step, Home/End jump)
- Promotion dialog (4-piece picker overlay)
- Board flip
- Dark theme

## UX/UI Design

The overall application layout and interaction design. Spec:002 handles the *technical* migration (Mantine→shadcn, Vite→Next.js); this section defines *what it should look and feel like*.

The design philosophy is a **high-fidelity dashboard** — not a legacy chess app look, but a modern interface with depth, subtle gradients, and clear information hierarchy.

### 1. Global Layout & Theme

- **Architecture:** Single-page `layout.tsx` with `max-h-screen` — no page scrolling
- **Theme:** Force dark mode. Background `#0a0a0a` (`bg-background`) with a subtle `radial-gradient` for depth behind the board
- **Grid:** Three-column layout: `grid-cols-[20%_auto_25%]`
  - Left column: player panel
  - Center column: the board (hero)
  - Right column: game analytics
- **Header:** Fixed top navigation bar
- **Spacing:** Consistent `gap-6` or `gap-8` for a spacious, breathable feel

### 2. Header

shadcn `NavigationMenu` component:
- **Left:** Knight icon (Lucide-React) + bold uppercase app name
- **Center:** `ghost` variant buttons — *Play, Analyze, Learn, Watch*
- **Right:** Bell icon button (with shadcn `Badge` for notifications) + `Avatar` with online status indicator (`animate-pulse` green dot)

### 3. Left Column: Player Panel

Player identity and game state using shadcn `Card` components:

- **Player Profile Cards:** `Card` with `bg-secondary/40` + `backdrop-blur-md` (glassmorphism)
  - **Clocks:** Large `font-mono` for timers (prevents layout shift)
  - **Elo/Name:** `text-muted-foreground` for secondary info
- **Match History:** Custom SVG sparkline or `recharts`. Advantage area with linear gradient fill

### 4. Center Column: The Arena

The focal point — high-precision styling:

- **Board:**
  - `aspect-square` container
  - Square colors: `bg-[#ebecd0]` light, `bg-[#779556]` dark (or wood-grain texture)
  - Pieces: Absolute-positioned SVGs with `drop-shadow-lg` to pop off the board
- **Overlays:**
  - Active piece: `ring-4 ring-white/50` (semi-transparent)
  - Directional arrows: SVG with `marker-end` for arrowheads
- **Control Bar (below board):** Flex row of `Button variant="ghost"` — Undo, Hint, Flip, Analyze icons
- **Piece Animation:** Framer Motion `layoutId` for smooth piece transitions square-to-square

### 5. Right Column: Game Analytics

Data-heavy section using shadcn `ScrollArea` and `Tabs`:

- **Evaluation Bar:** Horizontal `Progress` bar or custom `Slider` (disabled). White-to-dark gradient showing engine "tug-of-war"
- **Move Notation (PGN):**
  - Wrapped in `ScrollArea` for long games
  - Alternating row colors: `even:bg-secondary/20`
- **Live Engine Graph:** Area chart showing centipawn loss/gain. `stroke-primary` for the line
- **Recommended Moves:** List of `Button` components with `hover:bg-accent`, showing move (e.g., "Be2") + numerical evaluation

### 6. Component Mapping

| Section | shadcn/ui Component | Tailwind Strategy |
|:--------|:--------------------|:------------------|
| Containers | `Card` | `bg-card/50 backdrop-blur-sm border-white/10` |
| Typography | `Label`, headings | `tracking-tight` headers, `font-mono` clocks |
| Inputs | `Button`, `DropdownMenu` | `variant="ghost"` nav, `variant="outline"` actions |
| Feedback | `Badge`, `Progress` | Amber/Gold accents for high-priority info |
| Data | `ScrollArea` | Fixed height to keep dashboard static |

### Interaction Patterns
- Click-to-move primary, drag-and-drop secondary
- Right-click reserved for annotations (arrows, square highlights) — no context menus
- Keyboard-first navigation (arrow keys, Home/End, shortcuts)
- Minimal modal usage — prefer inline panels and drawers over popups

### Done When (UX Design)
- [ ] Three-column grid layout implemented (player panel | board | analytics)
- [ ] Header with NavigationMenu, logo, nav buttons, avatar
- [ ] Player cards with glassmorphism styling and monospace clocks
- [ ] Board renders as `aspect-square` with drop-shadow pieces and overlay highlights
- [ ] Control bar below board (Undo, Hint, Flip, Analyze)
- [ ] Right panel: eval bar, PGN scroll area, engine graph, recommended moves
- [ ] Dark theme with `#0a0a0a` background + radial gradient depth
- [ ] Framer Motion piece transitions
- [ ] Consistent `gap-6`/`gap-8` spacing throughout
- [ ] Component mapping follows the shadcn/Tailwind strategy table above

## Done When (Functionality)

### Board & Setup (from spec:001)
- [x] `pnpm tauri dev` launches a window with a Chessground board rendered
- [x] Pieces are draggable and legal moves are highlighted
- [x] Mantine theme provider configured (dark mode default)
- [x] Rust backend compiles, Tauri IPC bridge works

### Navigation (from spec:010)
- [x] Left arrow / Cmd+Z goes back one move
- [x] Right arrow / Cmd+Shift+Z goes forward one move
- [x] Home goes to starting position, End goes to latest
- [x] Board and move list highlight stay in sync
- [x] Playing a move from a past position truncates future moves

### Last Move Highlighting (from spec:014)
- [ ] Last move squares highlighted after playing a move
- [ ] Highlight updates correctly when navigating with arrow keys
- [ ] No highlight shown at initial position

### Promotion (from spec:015)
- [x] Pawn reaching last rank shows a 4-piece picker overlay
- [x] Selecting a piece commits the move with correct promotion
- [ ] Clicking away or pressing Escape cancels the move
- [x] Works for both white and black promotions

### Keyboard Shortcuts (from spec:102)
- [ ] Cmd+V opens PGN paste dialog
- [ ] Cmd+N starts a new game
- [x] F flips the board
- [ ] Cmd+O opens file dialog for PGN
- [ ] Space toggles engine analysis on/off

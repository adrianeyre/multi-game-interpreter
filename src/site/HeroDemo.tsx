import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  Badge,
  Bar,
  Collapse,
  Count,
  Icon,
  Meter,
  Stage,
  States,
  Window,
  type Act,
  type Layout,
  type Point,
} from './kit';
import { PixelScene } from './PixelScene';
import './hero.css';

/*
 * The landing page's hero: MGI, running in a browser, being handed a game.
 *
 * Beneath a Steel Sky's folder sits on the desktop beside the window — the one
 * game here Revolution released as freeware, and the one CI fetches. It is
 * dragged in; the drop zone lights under it; on the drop the two data files
 * read in with the meter, the engine family is named, and the game's first
 * room comes up in the drop zone's place. Boot, the player's own toggle back to
 * the file section, is the reset: the loop ends where it began, with a cause.
 *
 * The scene in the screen is original pixel art, not the game's.
 *
 * Plan, written before the code (stageshow, SKILL.md Workflow):
 *   medium   loop, beside the hero copy, ~720 wide on a dark page
 *   focal    the drop zone, then the game screen in its place
 *   action   a folder dragged in from the desktop
 *   payoff   the engine badge and a running game
 *   omitted  every other title-bar control, the log, the credit row
 */

type Ghost = { on: boolean; dropped: boolean; off: Point; at: Point };
type S = {
  loading: boolean;
  mb: number;
  engine: boolean;
  booted: boolean;
  ghost: Ghost;
};

const NO_GHOST: Ghost = { on: false, dropped: false, off: { x: 0, y: 0 }, at: { x: 0, y: 0 } };
const initial: S = { loading: false, mb: 0, engine: false, booted: false, ghost: NO_GHOST };
const TOTAL_MB = 69.5;
const POSTER: S = { loading: true, mb: TOTAL_MB, engine: true, booted: true, ghost: NO_GHOST };

const FOLDER = 'beneath-a-steel-sky';
/** Where the cursor rests: the start and the end of every loop, so no seam. */
const REST: Record<Layout, Point> = { wide: { x: 650, y: 330 }, compact: { x: 300, y: 400 } };
const URL = 'multi-game-interpreter.adrianeyre.co.uk';

type Geo = {
  win: { x: number; y: number; w: number; h: number };
  desk: { x: number; y: number };
  screen: { w: number; h: number };
};

// Wide: corner bleed. One 40px gutter above the window and left of the folder;
// the window runs off the right and the bottom, the status line whole above
// the crop. Compact: the folder above, the window off the right and bottom.
const GEO: Record<Layout, Geo> = {
  wide: {
    win: { x: 184, y: 40, w: 620, h: 520 },
    desk: { x: 40, y: 150 },
    screen: { w: 432, h: 270 },
  },
  compact: {
    win: { x: 16, y: 112, w: 380, h: 420 },
    desk: { x: 12, y: 14 },
    screen: { w: 310, h: 194 },
  },
};

async function script(a: Act<S>) {
  await a.wait(700);

  // 1. Pick the folder up off the desktop.
  a.mark('grab');
  const icon = a.rect('desk-icon');
  const folder = a.rect('desk-folder');
  const grab = { x: icon.x + icon.width / 2, y: icon.y + icon.height * 0.55 };
  await a.move(grab);
  await a.wait(220);
  const off = { x: grab.x - folder.x, y: grab.y - folder.y };

  // 2. Carry it over the drop zone, which lights under it.
  a.mark('drag');
  const zone = a.rect('drop');
  await a.drag(
    { x: zone.x + zone.width * 0.5, y: zone.y + zone.height * 0.46 },
    (at) => a.put({ ghost: { on: true, dropped: false, off, at } }),
    { duration: 1300, cursor: 'preserve' },
  );

  // 3. Drop: the files read in, the meter fills, the size counts with it.
  a.mark('drop');
  await a.set((s) => ({ loading: true, ghost: { ...s.ghost, dropped: true } }));
  await a.wait(420);
  for (const [mb, ms] of [
    [18.2, 520],
    [41.6, 520],
    [58.9, 480],
    [TOTAL_MB, 520],
  ] as const) {
    await a.set({ mb });
    await a.wait(ms);
  }

  // 4. The files decide the engine: the badge says which.
  a.mark('engine');
  await a.set({ engine: true });
  await a.wait(1100);

  // 5. Payoff: the first room comes up where the drop zone was.
  a.mark('booted');
  await a.move('rest');
  await a.set({ booted: true });
  await a.wait(3200);

  // 6. Boot — the player's own toggle — puts the file section back.
  a.mark('boot');
  await a.move('boot');
  await a.wait(200);
  await a.click();
  await a.set({ booted: false, engine: false, loading: false, ghost: NO_GHOST });
  await a.wait(500);
  await a.snap({ mb: 0 });
  await a.move('rest');
  await a.wait(500);
}

export function HeroDemo() {
  return (
    <Stage<S>
      width={720}
      height={490}
      compact={{ below: 600, width: 358, height: 440 }}
      initial={initial}
      poster={POSTER}
      script={script}
      theme="dark"
      accent="#e2b263"
      cursor={{ at: { wide: REST.wide, compact: REST.compact } }}
      className="mgi-hero mgi-look"
    >
      {(s, _rect, layout) => {
        const g = GEO[layout];
        const lifted = s.ghost.on && !s.ghost.dropped;
        const wide = layout === 'wide';
        return (
          <>
            <div
              className="mh-desk"
              data-target="desk-folder"
              data-lifted={lifted || undefined}
              style={{ left: g.desk.x, top: g.desk.y }}
            >
              <span data-target="desk-icon">
                <FolderGlyph />
              </span>
              <span className="mh-desk__name">{FOLDER}</span>
            </div>

            <Window
              url={URL}
              urlShape="pill"
              className="mh-window"
              style={{ left: g.win.x, top: g.win.y, width: g.win.w, height: g.win.h }}
              body={{ className: 'mh-body', 'data-crop': true }}
            >
              <div className="mh-bar">
                <span className="mh-mark">
                  MGI<span>web</span>
                </span>
                <span className="mh-controls">
                  {wide && <span className="mh-btn">Open game folder…</span>}
                  {wide && <span className="mh-btn">Load</span>}
                  <span
                    className="mh-btn"
                    data-target="boot"
                    data-cursor="pointer"
                    data-on={s.booted || undefined}
                  >
                    Boot
                  </span>
                  <Bar w={64} h={24} r={6} tone={2} />
                  <Bar w={72} h={24} r={6} tone={2} />
                </span>
              </div>

              <div className="mh-main" style={{ width: wide ? 536 : 342 }}>
                <div className="mh-screen" style={{ width: g.screen.w, height: g.screen.h }}>
                  <States
                    value={s.booted ? 'game' : 'files'}
                    states={{
                      files: (
                        <div
                          className="mh-drop"
                          data-target="drop"
                          data-drop
                          data-loading={s.loading || undefined}
                          style={{ width: g.screen.w, height: g.screen.h }}
                        >
                          <span className="mh-drop__icon">
                            <FolderOpen size={22} strokeWidth={1.75} />
                          </span>
                          <span className="mh-drop__title">Drop your game files here</span>
                          <Collapse open={s.loading}>
                            <div className="mh-load">
                              <div className="mh-load__row">
                                <span className="mh-load__name">sky.dnr · sky.dsk</span>
                                <span className="mh-load__size">
                                  <Count value={s.mb} duration={520} format={(n) => n.toFixed(1)} />
                                  {' MB'}
                                </span>
                              </div>
                              <Meter className="mh-meter" value={s.mb / TOTAL_MB} />
                              <span className="mh-engine" data-on={s.engine || undefined}>
                                <Badge
                                  tone="accent"
                                  className="mh-badge"
                                  icon={<Icon name="check" size={12} />}
                                >
                                  Sky · Virtual Theatre v2
                                </Badge>
                              </span>
                            </div>
                          </Collapse>
                        </div>
                      ),
                      game: (
                        <div className="mh-game" style={{ width: g.screen.w, height: g.screen.h }}>
                          <PixelScene />
                        </div>
                      ),
                    }}
                  />
                </div>
                <div className="mh-status" style={{ width: g.screen.w }}>
                  <States
                    value={s.booted ? 'game' : 'none'}
                    align="start"
                    states={{
                      none: <span className="mh-status__faint">No game loaded.</span>,
                      game: <span>Beneath a Steel Sky · room 1</span>,
                    }}
                  />
                  <span className="mh-status__faint">{s.booted ? '60 fps' : ''}</span>
                </div>
              </div>
            </Window>

            <DragImage ghost={s.ghost}>
              <FolderGlyph />
              <span className="mh-drag__name">{FOLDER}</span>
            </DragImage>
            <span
              data-target="rest"
              style={{ position: 'absolute', left: REST[layout].x, top: REST[layout].y }}
            />
          </>
        );
      }}
    </Stage>
  );
}

/** A folder, drawn as the desktop draws one: a tab and a body, flat. */
function FolderGlyph() {
  return (
    <svg className="mh-folder" viewBox="0 0 56 44" width="56" height="44" aria-hidden>
      <path d="M2 6a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v3H2Z" fill="#b8892f" />
      <rect x="2" y="11" width="52" height="31" rx="4" fill="#e2b263" />
    </svg>
  );
}

/**
 * The drag image follows the cursor on the drag's own frame callback and
 * lights whatever `[data-drop]` it is over (after stageshow's `upload` gold).
 */
function DragImage({ ghost, children }: { ghost: Ghost; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const over = useRef<HTMLElement | null>(null);
  const following = ghost.on && !ghost.dropped;
  const { x: ox, y: oy } = ghost.off;
  const { x, y } = ghost.at;
  useLayoutEffect(() => {
    const root = ref.current?.closest<HTMLElement>('.ss-stage');
    let next: HTMLElement | null = null;
    if (following && root) {
      const box = root.getBoundingClientRect();
      const scale = box.width / root.offsetWidth || 1;
      const hit =
        document
          .elementFromPoint(box.left + x * scale, box.top + y * scale)
          ?.closest<HTMLElement>('[data-drop]') ?? null;
      if (hit && root.contains(hit)) next = hit;
    }
    if (next !== over.current) {
      over.current?.removeAttribute('data-over');
      next?.setAttribute('data-over', '');
      over.current = next;
    }
  }, [following, x, y]);
  useLayoutEffect(() => () => over.current?.removeAttribute('data-over'), []);
  return (
    <div
      ref={ref}
      className="mh-drag"
      data-show={following || undefined}
      data-dropped={ghost.dropped || undefined}
      style={{ transform: `translate(${x - ox}px, ${y - oy}px)` }}
      aria-hidden
    >
      <div className="mh-drag__inner" style={{ transformOrigin: `${ox}px ${oy}px` }}>
        {children}
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Lock, MousePointer2, PaintBucket, Square } from 'lucide-react';
import { Badge, Bar, Count, Icon, Stage, States, Window, type Act } from './kit';
import './features.css';

/*
 * The feature grid under the hero (stageshow references/bento.md). Five tiles,
 * hero and strip. The tile list, written before any tile was built:
 *
 *   Tile      Span   Kind        The one thing                     Moves
 *   Editor    2 × 1  Hero UI     a walk box drawn over a room      the box draws in
 *   Engines   1 × 1  Stat        "8" engine families               counts up once
 *   Saves     1 × 1  Component   a save slot, named by you         the slot takes its name
 *   Private   1 × 1  Statement   "Nothing is uploaded."            still
 *   Files     1 × 1  Collection  the file names the engine reads   still
 *
 * One window in the grid (the editor's). Neighbours differ in kind, across
 * and down, and no real string repeats from the hero demo above. Each
 * picture is its own Stage at 1:1; the copy is page text beside it. Each tile
 * plays one beat, once, as the grid scrolls in, 110ms after the one before.
 */

const STEP = 110;
const LEAD = 450;

type Beat = { on: boolean };
const before: Beat = { on: false };
const after: Beat = { on: true };
const beat = (i: number) => async (a: Act<Beat>) => {
  await a.wait(LEAD + i * STEP);
  await a.set({ on: true });
};

function Tile({
  area,
  children,
  picture,
  tone,
}: {
  area: string;
  children: ReactNode;
  picture?: ReactNode;
  tone?: 'accent';
}) {
  return (
    <article className={`mf-tile mf-tile--${area}`} data-tone={tone}>
      <p className="mf-copy">{children}</p>
      {picture}
    </article>
  );
}

/** The tile owns the crop: a picture's Stage takes its slot's measured width. */
function usePictureWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(1, Math.round(node.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, seen] as const;
}

/* ------------------------------------------------------------ Editor (hero) */

const ROOMS = [64, 48, 72];

function EditorWindow({ on, wide }: { on: boolean; wide: boolean }) {
  return (
    <Window
      className="mf-editor"
      title="My Game"
      sidebarWidth={wide ? 168 : 0}
      sidebar={
        wide ? (
          <nav className="mf-side">
            <span className="mf-side__head">Rooms</span>
            <span className="mf-side__row" data-on>
              Rooftop
            </span>
            {ROOMS.map((w, i) => (
              <span key={i} className="mf-side__row">
                <Bar w={w} h={6} tone={2} />
              </span>
            ))}
            <span className="mf-side__head">Actors</span>
            {[56, 40].map((w, i) => (
              <span key={i} className="mf-side__row">
                <Bar w={w} h={6} tone={2} />
              </span>
            ))}
          </nav>
        ) : undefined
      }
      body={{ 'data-crop': true }}
    >
      <div className="mf-tools">
        <span className="mf-tool">
          <MousePointer2 size={14} strokeWidth={1.75} />
        </span>
        <span className="mf-tool">
          <PaintBucket size={14} strokeWidth={1.75} />
        </span>
        <span className="mf-tool" data-on>
          <Square size={14} strokeWidth={1.75} />
          Walk box
        </span>
        <Bar w={52} h={22} r={6} tone={2} />
      </div>
      <div className="mf-canvas">
        <svg
          viewBox="0 0 160 90"
          preserveAspectRatio="none"
          shapeRendering="crispEdges"
          aria-hidden
        >
          <rect width="160" height="54" fill="#2c3e6b" />
          <rect y="10" width="160" height="2" fill="#344a7d" />
          <rect x="18" y="14" width="26" height="30" fill="#1f2c50" />
          <rect x="20" y="16" width="22" height="26" fill="#6a86c4" />
          <rect x="30" y="16" width="2" height="26" fill="#1f2c50" />
          <rect x="20" y="28" width="22" height="2" fill="#1f2c50" />
          <rect x="104" y="20" width="34" height="34" fill="#4a2f2a" />
          <rect x="108" y="24" width="26" height="30" fill="#2a1a17" />
          <rect x="128" y="38" width="3" height="3" fill="#e2b263" />
          <rect y="54" width="160" height="36" fill="#5a4636" />
          <rect y="54" width="160" height="2" fill="#6c5642" />
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={i * 20} y="62" width="1" height="28" fill="#4a3a2d" />
          ))}
          <rect x="62" y="40" width="22" height="16" fill="#3b2c22" />
          <rect x="60" y="38" width="26" height="3" fill="#6c5642" />
        </svg>
        <span className="mf-walkbox" data-on={on || undefined}>
          <span className="mf-walkbox__label">Walk box 0</span>
        </span>
      </div>
    </Window>
  );
}

function Editor() {
  const [picture, width] = usePictureWidth(560);
  const wide = width >= 440;
  return (
    <Tile
      area="editor"
      picture={
        <div ref={picture} className="mf-picture mf-picture--editor">
          <Stage<Beat>
            width={width}
            height={wide ? 300 : 260}
            initial={before}
            poster={after}
            play="once"
            script={beat(0)}
            theme="dark"
            accent="#e2b263"
            className="mf-stage mgi-look"
          >
            {(s) => <EditorWindow on={s.on} wide={wide} />}
          </Stage>
        </div>
      }
    >
      <b>Make one of your own.</b> Paint rooms, draw walk boxes and sprites, and play the compiled
      game without leaving the page.
    </Tile>
  );
}

/* ----------------------------------------------------------- Engines (stat) */

function Engines() {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <article className="mf-tile mf-tile--engines" data-tone="accent">
      <p className="mf-copy">
        <b>Reads</b>
      </p>
      <div ref={ref} className="mf-stat">
        <span className="mf-stat__number">
          <Count value={seen ? 8 : 0} duration={900} />
        </span>
        <span className="mf-stat__label">engine families</span>
      </div>
      <p className="mf-stat__list">
        SCUMM, AGI, SCI, AGOS, Sky, Lure and both Broken Swords — and the files say which.
      </p>
    </article>
  );
}

/* ------------------------------------------------------- Saves (component) */

function SaveCard({ on }: { on: boolean }) {
  return (
    <div className="mf-saves">
      <div className="mf-saves__head">
        <span>Save</span>
        <span className="mf-saves__count">10 slots</span>
      </div>
      <div className="mf-slot" data-on={on || undefined}>
        <span className="mf-slot__n">1</span>
        <States
          value={on ? 'named' : 'empty'}
          align="start"
          className="mf-slot__name"
          states={{
            empty: <span className="mf-slot__empty">Empty slot</span>,
            named: <span>Rooftop, after dark</span>,
          }}
        />
        <span className="mf-slot__badge" data-on={on || undefined}>
          <Badge tone="accent" icon={<Icon name="check" size={12} />}>
            Saved
          </Badge>
        </span>
      </div>
      {[96, 72, 84].map((w, i) => (
        <div key={i} className="mf-slot">
          <span className="mf-slot__n">{i + 2}</span>
          <Bar w={w} h={6} tone={2} />
        </div>
      ))}
    </div>
  );
}

function Saves() {
  return (
    <Tile
      area="saves"
      picture={
        <div className="mf-picture mf-picture--saves">
          <Stage<Beat>
            width={300}
            height={190}
            initial={before}
            poster={after}
            play="once"
            script={beat(1)}
            theme="dark"
            accent="#e2b263"
            className="mf-stage mgi-look"
          >
            {(s) => <SaveCard on={s.on} />}
          </Stage>
        </div>
      }
    >
      <b>Ten named saves.</b> Each slot is called what you call it, and kept in this browser.
    </Tile>
  );
}

/* ------------------------------------------------------ Private (statement) */

function Private() {
  return (
    <article className="mf-tile mf-tile--private">
      <span className="mf-private__icon" aria-hidden>
        <Lock size={20} strokeWidth={1.75} />
      </span>
      <p className="mf-statement">Nothing is uploaded.</p>
      <p className="mf-copy mf-copy--foot">
        Your files are read in the browser and never leave your machine.
      </p>
    </article>
  );
}

/* ------------------------------------------------------ Files (collection) */

const FILES = [
  ['000.LFL', 'DISK01.LEC', 'MONKEY2.000', 'TENTACLE.001'],
  ['RESOURCE.MAP', 'sky.dsk', 'LOGDIR', 'VOL.0', 'GAMEPC'],
  ['SWORD.CLU', 'game.zip', 'SIMON.GME', 'lure.dat'],
];

function Files() {
  return (
    <Tile
      area="files"
      picture={
        <div className="mf-files" aria-hidden>
          {FILES.map((row, i) => (
            <div key={i} className="mf-files__row" style={{ paddingLeft: i === 1 ? 28 : 0 }}>
              {row.map((name) => (
                <span key={name} className="mf-file" data-zip={name.endsWith('.zip') || undefined}>
                  {name}
                </span>
              ))}
            </div>
          ))}
        </div>
      }
    >
      <b>Folders, files or a .zip.</b> The files decide the engine; you never pick one.
    </Tile>
  );
}

export function Features() {
  return (
    <div className="mgi-features">
      <Editor />
      <Engines />
      <Saves />
      <Private />
      <Files />
    </div>
  );
}

/*
 * The game screen in the hero: an original 160 × 100 pixel scene, drawn for
 * this page — a rooftop over a night city — and not taken from any game.
 *
 * Every shape is a whole-pixel rectangle and `crispEdges` keeps it that way
 * when the stage scales, the way the player itself draws with nearest
 * neighbour.
 */

const SKY = ['#120f24', '#181430', '#1f1a3c', '#2a2149', '#382955', '#4a3260'];

/** Towers, back row then front: x, width, top. */
const BACK: Array<[number, number, number]> = [
  [0, 14, 38],
  [12, 10, 30],
  [24, 16, 42],
  [42, 8, 24],
  [52, 18, 36],
  [74, 12, 28],
  [88, 20, 40],
  [110, 9, 22],
  [121, 16, 34],
  [139, 10, 27],
  [150, 10, 39],
];
const FRONT: Array<[number, number, number]> = [
  [0, 22, 54],
  [26, 14, 48],
  [44, 24, 58],
  [96, 18, 50],
  [118, 26, 56],
  [146, 14, 46],
];

/** Lit windows on the front row: x, y. Deterministic, so every loop matches. */
function windows(): Array<[number, number]> {
  const lit: Array<[number, number]> = [];
  FRONT.forEach(([x, w, top], tower) => {
    for (let row = top + 4; row < 78; row += 5) {
      for (let col = x + 2; col < x + w - 2; col += 4) {
        if ((col * 7 + row * 3 + tower * 5) % 11 < 4) lit.push([col, row]);
      }
    }
  });
  return lit;
}

const LIT = windows();

export function PixelScene() {
  return (
    <svg
      className="mh-scene"
      viewBox="0 0 160 100"
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      aria-hidden
    >
      {SKY.map((fill, i) => (
        <rect key={fill} x="0" y={i * 12} width="160" height="12" fill={fill} />
      ))}
      <rect x="0" y="72" width="160" height="28" fill="#4a3260" />

      {/* Stars */}
      {[
        [8, 6],
        [31, 14],
        [52, 4],
        [67, 18],
        [96, 8],
        [104, 20],
        [138, 5],
        [150, 16],
        [20, 24],
        [84, 2],
      ].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#d9d2ff" />
      ))}

      {/* The moon, with a bite out of it */}
      <rect x="122" y="7" width="10" height="2" fill="#f4e3b0" />
      <rect x="120" y="9" width="14" height="8" fill="#f4e3b0" />
      <rect x="122" y="17" width="10" height="2" fill="#f4e3b0" />
      <rect x="127" y="9" width="7" height="6" fill="#120f24" />
      <rect x="129" y="8" width="5" height="1" fill="#120f24" />

      {BACK.map(([x, w, top]) => (
        <rect key={`b${x}`} x={x} y={top} width={w} height={100 - top} fill="#2b2245" />
      ))}
      {FRONT.map(([x, w, top]) => (
        <rect key={`f${x}`} x={x} y={top} width={w} height={100 - top} fill="#17132a" />
      ))}
      {LIT.map(([x, y]) => (
        <rect key={`w${x}-${y}`} x={x} y={y} width="2" height="2" fill="#e2b263" />
      ))}

      {/* A mast with its warning light */}
      <rect x="54" y="44" width="1" height="14" fill="#17132a" />
      <rect x="53" y="42" width="3" height="2" fill="#ff6b5b" />

      {/* The rooftop in the foreground, with its railing and a vent */}
      <rect x="0" y="80" width="160" height="20" fill="#0d0b18" />
      <rect x="0" y="78" width="160" height="2" fill="#2b2245" />
      {Array.from({ length: 20 }, (_, i) => (
        <rect key={`r${i}`} x={i * 8 + 2} y="72" width="1" height="6" fill="#2b2245" />
      ))}
      <rect x="0" y="72" width="160" height="1" fill="#2b2245" />
      <rect x="18" y="84" width="14" height="8" fill="#211b38" />
      <rect x="18" y="84" width="14" height="1" fill="#3a2f5c" />

      {/* Someone on the roof, looking out */}
      <rect x="104" y="66" width="4" height="4" fill="#d8b48c" />
      <rect x="103" y="65" width="6" height="2" fill="#3a2a1e" />
      <rect x="102" y="70" width="8" height="8" fill="#6a4b8c" />
      <rect x="103" y="78" width="2" height="4" fill="#211b38" />
      <rect x="107" y="78" width="2" height="4" fill="#211b38" />
    </svg>
  );
}

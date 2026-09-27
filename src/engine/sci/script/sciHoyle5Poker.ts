/**
 * Hoyle Classic Games' poker opponents: what `PENGIN16.DLL` decides.
 *
 * Hoyle 5 plays draw poker through `kWinDLL`: the game fills one array of
 * 16-bit words with the table — chips, the pot, each hand's five cards — and
 * calls into the DLL with an operation in element 0. The DLL writes its answer
 * back into the same array: whether the acting player checks, folds, calls or
 * raises; who won the showdown; which cards to throw away; what a hand is.
 *
 * Transcribed from ScummVM's reconstruction of that DLL
 * (`engines/sci/engine/hoyle5poker.cpp`, fetched 2026-09-27), which is itself
 * a model of the original's decisions rather than a disassembly of its search;
 * this follows it to the rule, including its random choices, which are drawn
 * from the `random` the caller supplies.
 */

/** The shared array, as the DLL sees it: signed words by index. */
export interface SciPokerTable {
  get(index: number): number;
  set(index: number, value: number): void;
}

/** Operation codes, in element 0. */
export const SCI_POKER_OP = { playerAction: 1, winner: 2, discard: 3, hand: 4 } as const;

/** `Hoyle5HandType`: the hand classes, higher stronger, as bits. */
export const SCI_POKER_HAND = {
  royalFlush: 1 << 8,
  straightFlush: 1 << 7,
  fourOfAKind: 1 << 6,
  fullHouse: 1 << 5,
  flush: 1 << 4,
  straight: 1 << 3,
  threeOfAKind: 1 << 2,
  twoPairs: 1 << 1,
  onePair: 1,
  highCard: 0,
} as const;

/** `Hoyle5PlayerActions`. */
export const SCI_POKER_ACTION = { check: -2, fold: -1, call: 0, raise: 1 } as const;

const AT = {
  totalChipsPlayer1: 4,
  statusPlayer1: 8,
  amountToCall: 16,
  currentPlayer: 17,
  currentPot: 2,
  card0: 19,
  suit0: 20,
  playerAction: 60,
  whatAmIResult: 61,
  winningPlayers: 62,
  discardCard0: 63,
  confidencePlayer1: 68,
  aggressionPlayer1: 72,
} as const;

interface Card {
  rank: number;
  suit: number;
}

interface HandInfo {
  handType: number;
  tieBreak: number[];
}

/** Aces arrive as 1 or 14 and are always high. */
const cardValue = (card: number): number => (card === 1 ? 14 : card);

function readCards(table: SciPokerTable, player: number): Card[] {
  return Array.from({ length: 5 }, (_, i) => ({
    rank: cardValue(table.get(AT.card0 + 10 * player + i * 2)),
    suit: table.get(AT.suit0 + 10 * player + i * 2),
  }));
}

/** `classifyHand`, mirroring the DLL's `PokerHand::whatAmI`. */
export function classifySciPokerHand(input: readonly Card[]): HandInfo {
  const cards = [...input].sort((a, b) => b.rank - a.rank);
  const isFlush = cards.every((card) => card.suit === cards[0].suit);
  const distinct = cards.every((card, i) => i === 0 || card.rank !== cards[i - 1].rank);

  let isStraight = false;
  let straightHigh = 0;
  if (distinct) {
    if (cards[0].rank - cards[4].rank === 4) {
      isStraight = true;
      straightHigh = cards[0].rank;
    } else if (
      cards[0].rank === 14 &&
      cards[1].rank === 5 &&
      cards[2].rank === 4 &&
      cards[3].rank === 3 &&
      cards[4].rank === 2
    ) {
      // The wheel, A-2-3-4-5, is a five-high straight.
      isStraight = true;
      straightHigh = 5;
    }
  }

  const groups: Array<{ rank: number; count: number }> = [];
  for (const card of cards) {
    const group = groups.find((g) => g.rank === card.rank);
    if (group) group.count++;
    else groups.push({ rank: card.rank, count: 1 });
  }
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);
  const largest = groups[0].count;
  const fullHouse = groups.length === 2 && largest === 3;

  let handType: number = SCI_POKER_HAND.highCard;
  if (isStraight && isFlush) {
    handType = straightHigh === 14 ? SCI_POKER_HAND.royalFlush : SCI_POKER_HAND.straightFlush;
  } else if (largest === 4) handType = SCI_POKER_HAND.fourOfAKind;
  else if (fullHouse) handType = SCI_POKER_HAND.fullHouse;
  else if (isFlush) handType = SCI_POKER_HAND.flush;
  else if (isStraight) handType = SCI_POKER_HAND.straight;
  else if (largest === 3) handType = SCI_POKER_HAND.threeOfAKind;
  else if (groups.length === 3 && largest === 2) handType = SCI_POKER_HAND.twoPairs;
  else if (largest === 2) handType = SCI_POKER_HAND.onePair;

  const tieBreak = [0, 0, 0, 0, 0];
  if (isStraight && !fullHouse && largest < 3) {
    for (let i = 0; i < 5; i++) tieBreak[i] = straightHigh - i;
  } else {
    groups.forEach((group, i) => (tieBreak[i] = group.rank));
  }
  return { handType, tieBreak };
}

function compareHands(a: HandInfo, b: HandInfo): number {
  if (a.handType !== b.handType) return a.handType > b.handType ? 1 : -1;
  for (let i = 0; i < 5; i++) {
    if (a.tieBreak[i] !== b.tieBreak[i]) return a.tieBreak[i] > b.tieBreak[i] ? 1 : -1;
  }
  return 0;
}

/** `getWinners`: a bit per winner — more than one on a split pot — folded players aside. */
function winners(table: SciPokerTable): number {
  let found = 0;
  let best: HandInfo | null = null;
  for (let player = 0; player < 4; player++) {
    if (table.get(AT.statusPlayer1 + player) === -1) continue;
    const info = classifySciPokerHand(readCards(table, player));
    if (!best || compareHands(info, best) > 0) {
      best = info;
      found = 1 << player;
    } else if (compareHands(info, best) === 0) {
      found |= 1 << player;
    }
  }
  if (best) table.set(AT.whatAmIResult, best.handType);
  return found;
}

/** `findFlushDrawDiscard`: the odd card of a four-card flush, or -1. */
function flushDrawDiscard(cards: readonly Card[]): number {
  for (let suit = 0; suit < 4; suit++) {
    if (cards.filter((card) => card.suit === suit).length === 4) {
      return cards.findIndex((card) => card.suit !== suit);
    }
  }
  return -1;
}

/** `findStraightDrawDiscard`: the odd card of a straight draw, open-ended first. */
function straightDrawDiscard(cards: readonly Card[]): { index: number; openEnded: boolean } {
  let gutshot = -1;
  for (let drop = 0; drop < 5; drop++) {
    for (const aceLow of [false, true]) {
      const ranks = cards
        .filter((_, i) => i !== drop)
        .map((card) => (aceLow && card.rank === 14 ? 1 : card.rank));
      if (new Set(ranks).size !== 4) continue;
      const span = Math.max(...ranks) - Math.min(...ranks);
      if (span === 3) return { index: drop, openEnded: true };
      if (span === 4 && gutshot === -1) gutshot = drop;
    }
  }
  return { index: gutshot, openEnded: false };
}

/** `handleDiscard`: keep or discard each of the acting player's five cards. */
function discard(table: SciPokerTable, random: (below: number) => number): void {
  const player = table.get(AT.currentPlayer);
  // The acting player's cards are always the first block.
  const cards = readCards(table, 0);
  const info = classifySciPokerHand(cards);
  const counts = cards.map((card) => cards.filter((other) => other.rank === card.rank).length);
  const out = [false, false, false, false, false];

  switch (info.handType) {
    case SCI_POKER_HAND.fourOfAKind:
    case SCI_POKER_HAND.threeOfAKind:
    case SCI_POKER_HAND.twoPairs:
    case SCI_POKER_HAND.onePair:
      counts.forEach((count, i) => (out[i] = count === 1));
      break;
    case SCI_POKER_HAND.highCard: {
      const flush = flushDrawDiscard(cards);
      if (flush >= 0) {
        out[flush] = true;
        break;
      }
      const straight = straightDrawDiscard(cards);
      const confidence = Math.max(0, Math.min(3, table.get(AT.confidencePlayer1 + player)));
      if (straight.index >= 0 && (straight.openEnded || confidence >= 3)) {
        out[straight.index] = true;
        break;
      }
      const highest = Math.max(...cards.map((card) => card.rank));
      const keepOne = highest >= 13 || random(32768) > 0x6000;
      out.fill(true);
      for (let kept = 0; kept < (keepOne ? 1 : 2); kept++) {
        let best = -1;
        cards.forEach((card, i) => {
          if (out[i] && (best === -1 || card.rank > cards[best].rank)) best = i;
        });
        if (best >= 0) out[best] = false;
      }
      break;
    }
    default:
      // A made five-card hand keeps everything.
      break;
  }
  out.forEach((flag, i) => table.set(AT.discardCard0 + i, flag ? 1 : 0));
}

/** `getHandStrength`: a rough win expectation, 0 to 100. */
function strength(info: HandInfo): number {
  switch (info.handType) {
    case SCI_POKER_HAND.royalFlush:
      return 100;
    case SCI_POKER_HAND.straightFlush:
      return 99;
    case SCI_POKER_HAND.fourOfAKind:
      return 96;
    case SCI_POKER_HAND.fullHouse:
      return 92;
    case SCI_POKER_HAND.flush:
      return 82;
    case SCI_POKER_HAND.straight:
      return 72;
    case SCI_POKER_HAND.threeOfAKind:
      return 62;
    case SCI_POKER_HAND.twoPairs:
      return 48;
    case SCI_POKER_HAND.onePair:
      return 26 + (info.tieBreak[0] - 2);
    default:
      return info.tieBreak[0] - 2;
  }
}

/** `handlePlayerAction`: check, fold, call or raise, by strength against pot odds. */
function playerAction(table: SciPokerTable, random: (below: number) => number): void {
  const player = table.get(AT.currentPlayer);
  const chips = table.get(AT.totalChipsPlayer1 + player);
  const toCall = table.get(AT.amountToCall);
  const pot = table.get(AT.currentPot);
  const hand = strength(classifySciPokerHand(readCards(table, 0)));
  const aggression = Math.max(0, Math.min(3, table.get(AT.aggressionPlayer1 + player)));
  const act = (action: number) => table.set(AT.playerAction, action);

  if (toCall > 0 && chips < toCall) {
    act(hand >= 70 ? SCI_POKER_ACTION.call : SCI_POKER_ACTION.fold);
    return;
  }
  const potOdds = toCall > 0 && pot + toCall > 0 ? Math.trunc((toCall * 100) / (pot + toCall)) : 0;
  const effective = hand + aggression * 6;
  const raiseAt = 78 - aggression * 6;

  if (toCall === 0) {
    const bluff = random(100) < aggression * 5;
    act(effective >= raiseAt || bluff ? SCI_POKER_ACTION.raise : SCI_POKER_ACTION.check);
    return;
  }
  if (effective < potOdds) {
    const bluff = random(100) < aggression * 4;
    act(bluff ? SCI_POKER_ACTION.call : SCI_POKER_ACTION.fold);
    return;
  }
  act(effective >= raiseAt ? SCI_POKER_ACTION.raise : SCI_POKER_ACTION.call);
}

/**
 * `hoyle5PokerEngine`: one call into the DLL. Answers false for an operation
 * the DLL does not have, which ScummVM treats as an error.
 */
export function sciHoyle5Poker(table: SciPokerTable, random: (below: number) => number): boolean {
  switch (table.get(0)) {
    case SCI_POKER_OP.playerAction:
      playerAction(table, random);
      return true;
    case SCI_POKER_OP.winner:
      table.set(AT.winningPlayers, winners(table));
      return true;
    case SCI_POKER_OP.discard:
      discard(table, random);
      return true;
    case SCI_POKER_OP.hand:
      table.set(AT.whatAmIResult, classifySciPokerHand(readCards(table, 0)).handType);
      return true;
    default:
      return false;
  }
}

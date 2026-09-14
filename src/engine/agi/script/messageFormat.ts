/**
 * AGI's message format codes, which turn a stored message into what a player
 * reads.
 *
 * Every message in an AGI game is a template. `%v` substitutes a variable,
 * `%s` a string the player typed, `%m` another message in the same Logic, `%g`
 * one from Logic 0, `%0` an inventory item's name and `%w` a word from the
 * parsed line. Without them, a game does not show wrong text — it shows the
 * codes.
 *
 * **What that looked like.** King's Quest III's status line ran
 * `display(0, 20, "%v117:%v116|2:%v115|2 ")`, which is the in-game clock its
 * Special menu switches on. Drawn literally, the twenty-two characters of
 * template overwrote `Sound:on` beside it, so the score line read
 * `Score:0 of 210    So·nd·o·15]`. The clock was not late or wrong; it had
 * never been expanded.
 *
 * Transcribed from ScummVM's `TextMgr::stringPrintf` (`agi/text.cpp`), which is
 * the only place the awkward parts are written down: `%v`'s field width counts
 * from the *right* of a fifteen-digit zero-padded number, `%0` is the digit
 * zero rather than the letter, and `%s` and `%m` expand recursively while the
 * others do not.
 */

/** What the codes resolve against. Values, not a snapshot: a clock ticks. */
export interface AgiMessageContext {
  /** `%v<n>` — variable `n`. */
  variable(number: number): number;
  /** `%s<n>` — string slot `n`, itself formatted. */
  string(number: number): string;
  /** `%0<n>` — inventory item `n - 1`'s name. */
  objectName(item: number): string;
  /** `%w<n>` — the `n - 1`th word of the player's last line. */
  word(index: number): string;
  /**
   * `%m<n>` and `%g<n>` — message `n - 1` of a Logic.
   *
   * `%m` asks the Logic the message came from and `%g` asks Logic 0, which is
   * why the Logic number is a parameter rather than being implied.
   */
  message(logic: number, number: number): string;
}

/** How deep `%m` and `%s` may recurse before it is a loop rather than a nest. */
const MAX_DEPTH = 8;

/**
 * Expands the codes in one message.
 *
 * `logic` is the Logic the message came from, which `%m` resolves against.
 */
export function formatAgiMessage(
  text: string,
  logic: number,
  context: AgiMessageContext,
  depth = 0,
): string {
  // A message with nothing to expand is the common case by a long way, and
  // formatting one costs a scan either way — but a `%` that is a literal
  // percent sign in a message about a percentage should come out unharmed, and
  // the early return is also what stops a runaway `%m` chain.
  if (!text.includes('%') && !text.includes('\\')) return text;
  if (depth > MAX_DEPTH) return text;

  let out = '';
  let at = 0;

  /** The digits at `at`, and how many there were. */
  const digits = (): number => {
    let value = 0;
    while (at < text.length && text[at] >= '0' && text[at] <= '9') {
      value = value * 10 + (text.charCodeAt(at) - 0x30);
      at++;
    }
    return value;
  };

  while (at < text.length) {
    const character = text[at];

    // A backslash escapes whatever follows, so a message can contain a literal
    // `%`. ScummVM drops the backslash and takes the next character as it is.
    if (character === '\\') {
      at++;
      if (at < text.length) out += text[at++];
      continue;
    }

    if (character !== '%') {
      out += character;
      at++;
      continue;
    }

    at++;
    const code = text[at];
    at++;

    switch (code) {
      case 'v': {
        const variable = digits();
        // **The width counts from the right.** ScummVM formats the value into
        // fifteen zero-padded digits and then slices: with no `|`, from the
        // first non-zero digit (never past the last, so 0 prints as "0"); with
        // `|w`, from `15 - w`. So `%v115|2` on 9 is "09" and on 109 is "09" —
        // a field width that truncates rather than overflowing, which is what
        // makes a clock read `1:05:09` instead of `1:5:9`.
        const padded = String(context.variable(variable)).padStart(15, '0');
        let from: number;
        if (text[at] === '|') {
          at++;
          from = 15 - digits();
        } else {
          from = 0;
          while (from < 14 && padded[from] === '0') from++;
        }
        out += padded.slice(Math.max(0, Math.min(15, from)));
        break;
      }
      case '0':
        // The digit zero, not the letter — `%01` is inventory item 0. Getting
        // this backwards costs nothing visible until a game names an item.
        out += context.objectName(digits() - 1);
        break;
      case 'g':
        out += formatAgiMessage(context.message(0, digits() - 1), 0, context, depth + 1);
        break;
      case 'w':
        out += context.word(digits() - 1);
        break;
      case 's':
        out += formatAgiMessage(context.string(digits()), logic, context, depth + 1);
        break;
      case 'm': {
        const number = digits();
        out += formatAgiMessage(context.message(logic, number - 1), logic, context, depth + 1);
        break;
      }
      default:
        // An unknown code is dropped along with its digits, which is what
        // Sierra's own interpreter does: its `switch` has no default arm and
        // the digit skip runs regardless.
        digits();
        break;
    }
  }

  return out;
}

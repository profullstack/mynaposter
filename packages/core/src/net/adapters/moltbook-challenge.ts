/**
 * Moltbook's anti-spam challenge: an obfuscated word problem that has to be
 * answered before a new post becomes visible.
 *
 *   "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE"
 *   → a lobster swims at twenty meters and slows by five → 20 - 5 → "15.00"
 *
 * Two numbers and one operation, hidden behind alternating caps, scattered
 * symbols, doubled letters and words broken in two. This reads it without a
 * model: strip the noise, collapse doubled letters, rejoin broken words
 * against a number vocabulary, then pick the operation from its verb.
 * Returns null when it cannot be sure, so the caller can ask a model instead
 * of submitting a guess (a wrong answer leaves the post unpublished).
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000 };

/** "fifteen" and "fiifteeen" both become "fiften": doubled letters are noise. */
const squash = (word: string): string => word.replace(/(.)\1+/g, "$1");

const VOCAB = new Map<string, { kind: "unit" | "ten" | "scale" | "point"; value: number }>();
for (const [word, value] of Object.entries(UNITS)) VOCAB.set(squash(word), { kind: "unit", value });
for (const [word, value] of Object.entries(TENS)) VOCAB.set(squash(word), { kind: "ten", value });
for (const [word, value] of Object.entries(SCALES)) VOCAB.set(squash(word), { kind: "scale", value });
VOCAB.set("point", { kind: "point", value: 0 });

type Op = "+" | "-" | "*" | "/";

/** Checked in order, longest phrase first, so "slows by" wins over "by". */
const OPS: [RegExp, Op][] = [
  [/\b(divided|splits?|shared|halved|per)\b/, "/"],
  [/\b(times|multipl\w*|doubles|triples|product)\b/, "*"],
  [/\b(minus|slows?|loses?|lost|drops?|decreases?|reduces?|subtract\w*|less|fewer|falls?|sheds?|gives away|eats)\b/, "-"],
  [/\b(plus|adds?|added|gains?|increases?|speeds? up|accelerates?|grows?|more|sum|total|combined|and gets|finds|catches|joins?)\b/, "+"],
];

/** Lowercase words with every symbol gone. Digits survive as their own words. */
function words(challenge: string): string[] {
  return challenge
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, "$1DOT$2")
    .replace(/[^a-z0-9\sDOT]/gi, "")
    .replace(/dot/gi, ".")
    .split(/\s+/)
    .filter(Boolean);
}

interface Token {
  /** A number, or a plain word. */
  number?: { kind: "unit" | "ten" | "scale" | "point" | "digits"; value: number };
  /** As written, symbols removed. */
  word: string;
}

/**
 * Rejoin words the obfuscation broke apart ("fif teen" → fifteen) by trying
 * the longest run of up to four neighbours that spells a number word.
 */
function tokenize(raw: string[]): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < raw.length; ) {
    if (/^\d+(\.\d+)?$/.test(raw[i])) {
      tokens.push({ word: raw[i], number: { kind: "digits", value: Number(raw[i]) } });
      i += 1;
      continue;
    }
    let matched = false;
    for (let span = Math.min(4, raw.length - i); span >= 1; span--) {
      const joined = squash(raw.slice(i, i + span).join(""));
      const hit = VOCAB.get(joined);
      if (hit) {
        tokens.push({ word: raw.slice(i, i + span).join(""), number: hit });
        i += span;
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ word: raw[i] });
      i += 1;
    }
  }
  return tokens;
}

/** Fold runs of number words into values: "twenty five" → 25, "three point five" → 3.5. */
function numbers(tokens: Token[]): number[] {
  const found: number[] = [];
  let current: number | null = null;
  let total = 0;
  let decimal: string | null = null;

  const flush = () => {
    if (current === null && decimal === null) return;
    let value = total + (current ?? 0);
    if (decimal) value = Number(`${value}.${decimal}`);
    found.push(value);
    current = null;
    total = 0;
    decimal = null;
  };

  for (const [index, token] of tokens.entries()) {
    const n = token.number;
    // "one hundred and twelve": an "and" after the hundreds continues the number.
    const continues = token.word === "and" && current !== null && current % 100 === 0 && current > 0 && tokens[index + 1]?.number;
    if (continues) continue;
    if (!n) {
      flush();
      continue;
    }
    if (n.kind === "digits") {
      flush();
      found.push(n.value);
    } else if (n.kind === "point") {
      if (current === null) flush();
      else decimal = "";
    } else if (decimal !== null) {
      decimal += String(n.value);
    } else if (n.kind === "scale") {
      if (n.value === 1000) {
        total = (total + (current ?? 1)) * 1000;
        current = null;
      } else current = (current ?? 1) * n.value;
    } else if (n.kind === "ten") {
      if (current !== null && current % 100 !== 0) flush();
      current = (current ?? 0) + n.value;
    } else {
      // A unit after a unit ("five three") starts a new number; after a ten it completes it.
      if (current !== null && (current % 10 !== 0 || current === 0)) flush();
      current = (current ?? 0) + n.value;
    }
  }
  flush();
  return found;
}

export function solveChallenge(challenge: string): string | null {
  const tokens = tokenize(words(challenge));
  const values = numbers(tokens);
  if (values.length !== 2) return null;

  // Doubled letters hide the verb too ("sloows"), and squashing mangles a
  // real double ("accelerates"), so look for it both ways.
  const plain = tokens.map((token) => token.word).join(" ");
  const squashed = tokens.map((token) => squash(token.word)).join(" ");
  const op = OPS.find(([pattern]) => pattern.test(plain) || pattern.test(squashed))?.[1];
  if (!op) return null;

  const [a, b] = values;
  const result = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : b === 0 ? NaN : a / b;
  return Number.isFinite(result) ? result.toFixed(2) : null;
}

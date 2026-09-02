/** bech32 decoding, just enough to read Nostr's nsec/npub keys. */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const char of hrp) {
    high.push(char.charCodeAt(0) >> 5);
    low.push(char.charCodeAt(0) & 31);
  }
  return [...high, 0, ...low];
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error("Invalid value while converting bits");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxValue);
  } else if (bits >= from || ((acc << (to - bits)) & maxValue) !== 0) {
    throw new Error("Invalid padding while converting bits");
  }
  return out;
}

export function bech32Decode(input: string): { prefix: string; bytes: Uint8Array } {
  const value = input.trim().toLowerCase();
  const separator = value.lastIndexOf("1");
  if (separator < 1 || separator + 7 > value.length) throw new Error("Not a bech32 string");

  const prefix = value.slice(0, separator);
  const dataPart = value.slice(separator + 1);
  const data: number[] = [];
  for (const char of dataPart) {
    const index = CHARSET.indexOf(char);
    if (index === -1) throw new Error(`Invalid bech32 character "${char}"`);
    data.push(index);
  }
  if (polymod([...hrpExpand(prefix), ...data]) !== 1) throw new Error("bech32 checksum does not match");

  return { prefix, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

export function bech32Encode(prefix: string, bytes: Uint8Array): string {
  const data = convertBits([...bytes], 8, 5, true);
  const checksum = polymod([...hrpExpand(prefix), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail: number[] = [];
  for (let i = 0; i < 6; i++) tail.push((checksum >> (5 * (5 - i))) & 31);
  return `${prefix}1${[...data, ...tail].map((value) => CHARSET[value]).join("")}`;
}

import { expect, test } from "bun:test";
import { mp4Dimensions } from "../src/net/adapters/bluesky.ts";

// A minimal tkhd box (version 0, 92 bytes) with width/height as 16.16 fixed point.
function tkhd(width: number, height: number): Uint8Array {
  const box = new Uint8Array(92);
  const v = new DataView(box.buffer);
  v.setUint32(0, 92);
  box.set([0x74, 0x6b, 0x68, 0x64], 4);
  v.setUint32(84, width << 16);
  v.setUint32(88, height << 16);
  return box;
}

test("reads the video size from an MP4 tkhd box, so Bluesky sizes the player", () => {
  const audio = tkhd(0, 0); // an audio track's tkhd has no size
  const file = new Uint8Array([...new Uint8Array(16), ...audio, ...tkhd(1920, 1080)]);
  expect(mp4Dimensions(file)).toEqual({ width: 1920, height: 1080 });
  expect(mp4Dimensions(tkhd(1080, 1920))).toEqual({ width: 1080, height: 1920 });
  expect(mp4Dimensions(new Uint8Array(200))).toBeNull();
});

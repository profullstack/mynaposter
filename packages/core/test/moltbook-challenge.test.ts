import { test, expect } from "bun:test";
import { solveChallenge } from "../src/net/adapters/moltbook-challenge.ts";

test("the documented example: twenty, slows by five", () => {
  const challenge = "A] lO^bSt-Er S[wImS aT/ tW]eNn-Tyy mE^tE[rS aNd] SlO/wS bY^ fI[vE, wH-aTs] ThE/ nEw^ SpE[eD?";
  expect(solveChallenge(challenge)).toBe("15.00");
});

test("compound numbers and broken words", () => {
  expect(solveChallenge("a lObStEr hAs tHiR tY- fIvE cLaWs aNd gAiNs sEv/En mOrE")).toBe("42.00");
  expect(solveChallenge("oNe hUnDrEd aNd tWeLvE sHeLlS, lOsEs fOrTy")).toBe("72.00");
});

test("multiplication and division", () => {
  expect(solveChallenge("a reef of six lobsters times eight claws")).toBe("48.00");
  expect(solveChallenge("ninety meters divided between four lobsters")).toBe("22.50");
});

test("digits pass through", () => {
  expect(solveChallenge("a lobster at 12.5 m/s accelerates by 3")).toBe("15.50");
});

test("refuses rather than guesses", () => {
  expect(solveChallenge("a lobster swims somewhere")).toBeNull();
  expect(solveChallenge("one two three lobsters add")).toBeNull();
  expect(solveChallenge("five lobsters and seven crabs")).toBeNull();
});

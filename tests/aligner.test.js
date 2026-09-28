import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeScript, tokenizeHypothesis, align, similarity } from "../web/aligner.js";

const EN = `Good evening everyone, and thank you for coming.
A year ago the club had twelve active members under forty and a court that sat empty four nights a week. Tonight there are sixty of us. The court is booked until ten.
I want to spend ten minutes on three things. First, what we learned about getting new players to stay. Second, what it cost us.`;

const DA = `Godaften alle sammen, og tak fordi I kom.
For et år siden havde klubben tolv aktive medlemmer under fyrre og en bane, der stod tom fire aftener om ugen. I aften er vi tres. Banen er booket til klokken ti.

Jeg vil bruge ti minutter på tre ting.`;

const en = tokenizeScript(EN);
const da = tokenizeScript(DA);
const idx = (toks, word, nth = 0) => {
  let seen = 0;
  for (let i = 0; i < toks.length; i++) if (toks[i].norm === word) { if (seen++ === nth) return i; }
  throw new Error("not found " + word);
};

test("tokenizer keeps æøå and maps spans", () => {
  const t = tokenizeScript("Fire aftener, ping-pong.");
  assert.deepEqual(t.map((x) => x.norm), ["fire", "aftener", "pingpong"]);
  assert.equal(t[1].start, 5);
  assert.equal("Fire aftener, ping-pong.".slice(t[2].start, t[2].end), "ping-pong");
});

test("similarity tolerates inflection and small typos", () => {
  assert.ok(similarity("players", "player") >= 0.7);
  assert.ok(similarity("tennisklubben", "tennis klubben".replace(" ", "")) >= 0.7);
  assert.ok(similarity("evening", "evenning") >= 0.7);
  assert.ok(similarity("morning", "evening") < 0.7);
});

test("exact reading advances the cursor", () => {
  const hyp = tokenizeHypothesis("good evening everyone and thank you");
  const r = align(en, hyp, -1);
  assert.equal(r.cursor, idx(en, "you"));
});

test("misrecognized words still track", () => {
  // "twelve" -> "twelf", "members" -> "member"
  const hyp = tokenizeHypothesis("the club had twelf active member under");
  const r = align(en, hyp, idx(en, "ago"));
  assert.equal(r.cursor, idx(en, "under"));
});

test("skipping a line jumps forward", () => {
  const hyp = tokenizeHypothesis("I want to spend ten minutes on three things");
  const r = align(en, hyp, idx(en, "week"));
  assert.equal(r.cursor, idx(en, "things"));
});

test("re-reading the previous sentence moves back", () => {
  const cur = idx(en, "week");
  const hyp = tokenizeHypothesis("a year ago the club had");
  const r = align(en, hyp, cur);
  assert.equal(r.cursor, idx(en, "had"));
});

test("single noise word does not move", () => {
  const cur = idx(en, "members");
  assert.equal(align(en, tokenizeHypothesis("checklist"), cur), null);
  assert.equal(align(en, tokenizeHypothesis("uh"), cur), null);
});

test("unrelated speech does not move", () => {
  const cur = idx(en, "members");
  const r = align(en, tokenizeHypothesis("the weather in copenhagen is terrible today"), cur);
  assert.equal(r, null);
});

test("empty hypothesis (silence) does not move", () => {
  assert.equal(align(en, [], 5), null);
});

test("danish with æøå and compounds", () => {
  let r = align(da, tokenizeHypothesis("for et år siden havde klubben tolv"), idx(da, "kom"));
  assert.equal(r.cursor, idx(da, "tolv"));
  r = align(da, tokenizeHypothesis("aktive medlemmer under fyrre og en bane"), r.cursor);
  assert.equal(r.cursor, idx(da, "bane"));
  r = align(da, tokenizeHypothesis("i aften er vi tres"), r.cursor);
  assert.equal(r.cursor, idx(da, "tres"));
});

test("does not overshoot on a repeated phrase", () => {
  // "court" occurs twice. From the start, the near one wins.
  const hyp = tokenizeHypothesis("under forty and a court");
  const r = align(en, hyp, idx(en, "ago"));
  assert.equal(r.cursor, idx(en, "court", 0));
});

test("does not land one word past a matched phrase (split must beat the plain match)", () => {
  const r = align(en, tokenizeHypothesis("good evening everyone"), -1);
  assert.equal(r.cursor, idx(en, "everyone"));
  const r2 = align(da, tokenizeHypothesis("en bane der stod tom fire aftener om ugen"), idx(da, "fyrre"));
  assert.equal(r2.cursor, idx(da, "ugen"));
});

test("trailing half-spoken word advances to the last matched word", () => {
  const r = align(en, tokenizeHypothesis("about getting new players to sit"), idx(en, "learned"));
  assert.equal(r.cursor, idx(en, "to", 1));
  const r2 = align(da, tokenizeHypothesis("jeg vil bruge ti minutter på tre bolde"), idx(da, "klokken"));
  assert.equal(r2.cursor, idx(da, "tre"));
});

test("whisper-style compound split still tracks", () => {
  // Whisper writes "Godaften" as two words and glues "alle sammen" together.
  const r = align(da, tokenizeHypothesis("god aften allesammen og tak for at se"), -1);
  assert.equal(r.cursor, idx(da, "tak"));
});

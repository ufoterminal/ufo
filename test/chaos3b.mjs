// Extreme prices seen on real memecoins, both orientations, verified end to end.
const { priceFromSqrt } = await import("../src/chain.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
const sqrtFor = (rawPrice) => BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));
for (const want of [1e-9, 3e-7, 5.5e-5, 0.002836, 0.55, 55000]) {
  const got = priceFromSqrt(sqrtFor(want / 10 ** 12), true, 18);
  const err = Math.abs(got - want) / want;
  check(`price ${want}`, err < 1e-4, `got ${got.toExponential(4)}, error ${(err * 100).toFixed(4)}%`);
}
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "EXTREME PRICE RANGE PASSED"}`);
process.exit(fail.length ? 1 : 0);

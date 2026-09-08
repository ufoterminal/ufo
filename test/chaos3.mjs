// Price maths. A wrong sqrtPriceX96 conversion would make every number on the site wrong, so it is
// checked against values worked out by hand, in both token orientations and at extreme decimals.
const { priceFromSqrt } = await import("../src/chain.js");
const fail = [];
const near = (a, b, tol = 1e-6) => Math.abs(a - b) / (b || 1) < tol;
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
const Q96 = 2n ** 96n;
const sqrtFor = (rawPrice) => BigInt(Math.floor(Math.sqrt(rawPrice) * 2 ** 96));

// token0 = token (18 dp), token1 = USDC (6 dp). raw = USDC_raw per token_raw
for (const want of [2.5, 0.000001, 1234.5]) {
  const raw = want / 10 ** (18 - 6);
  const got = priceFromSqrt(sqrtFor(raw), true, 18);
  check(`token0 price ${want}`, near(got, want, 1e-4), `got ${got}`);
}
// token1 = token (18 dp), token0 = USDC (6 dp). raw = token_raw per USDC_raw, so price inverts
for (const want of [2.5, 0.01]) {
  const raw = 10 ** (18 - 6) / want;
  const got = priceFromSqrt(sqrtFor(raw), false, 18);
  check(`token1 price ${want}`, near(got, want, 1e-3), `got ${got}`);
}
// 6 decimal token, both orientations
{
  const want = 3;
  check("6dp token0", near(priceFromSqrt(sqrtFor(want / 10 ** (6 - 6)), true, 6), want, 1e-4));
  check("6dp token1", near(priceFromSqrt(sqrtFor(10 ** (6 - 6) / want), false, 6), want, 1e-3));
}
check("zero sqrt is zero", priceFromSqrt(0n, true, 18) === 0);
check("huge sqrt finite", Number.isFinite(priceFromSqrt(2n ** 160n, true, 18)));
check("tiny sqrt finite", Number.isFinite(priceFromSqrt(1n, true, 18)));
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL PRICE CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);

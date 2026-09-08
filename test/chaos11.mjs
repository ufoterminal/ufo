// Contract code grouping: tokens deployed from one template share a hash, and what is known about one
// of them spreads to its siblings without inventing anything for unrelated tokens.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/talons";
const { init, q, insertMany } = await import("../src/db.js");
const { spreadLaunchpadByCode, logoHostForGroup, codeGroups } = await import("../src/codehash.js");
const fail = [];
const check = (n, c, d = "") => { if (!c) fail.push(`${n} ${d}`); console.log(`${c ? "ok  " : "FAIL"} ${n} ${d}`); };
await q("DROP TABLE IF EXISTS swaps, pools, tokens, sources, nonpools, meta_events, lp_endpoints, token_images, image_patterns, meta CASCADE").catch(() => {});
await init();
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const LP = A(900), OTHER_LP = A(901);

await insertMany("tokens", ["address", "name", "symbol", "decimals", "total_supply"],
  [[A(1), "One", "ONE", 18, "1"], [A(2), "Two", "TWO", 18, "1"], [A(3), "Three", "THREE", 18, "1"],
   [A(4), "Lonely", "LONE", 18, "1"], [A(5), "NoCode", "NC", 18, "1"]]);
// one, two and three came out of the same template; only one of them has a known launchpad
await q("UPDATE tokens SET code_hash = 'aaa111', launchpad = $1 WHERE address = $2", [LP, A(1)]);
await q("UPDATE tokens SET code_hash = 'aaa111' WHERE address IN ($1, $2)", [A(2), A(3)]);
await q("UPDATE tokens SET code_hash = 'bbb222', launchpad = $1 WHERE address = $2", [OTHER_LP, A(4)]);
await q("UPDATE tokens SET code_hash = '' WHERE address = $1", [A(5)]);

const filled = await spreadLaunchpadByCode();
check("siblings inherit the launchpad", filled === 2, `${filled}`);
const rows = await q("SELECT address, launchpad FROM tokens ORDER BY address");
check("token two labelled", rows[1].launchpad === LP, rows[1].launchpad);
check("token three labelled", rows[2].launchpad === LP, rows[2].launchpad);
check("other group untouched", rows[3].launchpad === OTHER_LP, rows[3].launchpad);
check("token without code untouched", !rows[4].launchpad, String(rows[4].launchpad));
const again = await spreadLaunchpadByCode();
check("second pass changes nothing", again === 0, `${again}`);

// a sibling's image host becomes the first guess for the others in the group
await q("INSERT INTO token_images (address, ctype, bytes, src, fetched) VALUES ($1,'image/png','\\x00',$2,$3)",
  [A(1), `https://api.example.fun/token-image/${A(1)}.png`, Date.now()]);
const hosts = await logoHostForGroup(A(2));
check("sibling host found", hosts.length === 1 && hosts[0].includes("example.fun"), hosts[0] || "none");
check("unrelated token gets no host", (await logoHostForGroup(A(4))).length === 0);
const guess = hosts[0].replace(/0x[0-9a-fA-F]{40}/, A(2));
check("address swapped into the sibling url", guess.includes(A(2)) && !guess.includes(A(1)), guess);

const groups = await codeGroups();
check("groups reported largest first", groups[0].code_hash === "aaa111" && groups[0].tokens === 3, JSON.stringify(groups[0]));
console.log(`\n${fail.length ? "FAILURES:\n- " + fail.join("\n- ") : "ALL CODE GROUP CHECKS PASSED"}`);
process.exit(fail.length ? 1 : 0);

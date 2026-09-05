// The exact block a contract was deployed in, found by binary search over eth_getCode against an
// archive node. Twenty four calls, no guessing, and the answer is cached. Everything about a token's
// launch (its metadata event, its real age) lives in that block, so this is the anchor for both.
import { ARCHIVE_RPC } from "./config.js";

let archiveOk = null; // null unknown, false the node has no history

async function rpc(method, params, ms = 9000) {
  const r = await fetch(ARCHIVE_RPC, {
    method: "POST", signal: AbortSignal.timeout(ms),
    headers: { "content-type": "application/json", "user-agent": "talons-scan/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
const codeAt = async (addr, block) => rpc("eth_getCode", [addr, `0x${block.toString(16)}`]);
const has = (code) => typeof code === "string" && code.length > 2;

// Confirm the node really serves history before spending calls on a search that cannot work.
export async function archiveAvailable() {
  if (archiveOk !== null) return archiveOk;
  try {
    await rpc("eth_getBalance", ["0x0000000000000000000000000000000000000000", "0x1"], 8000);
    archiveOk = true;
  } catch { archiveOk = false; }
  console.log(`[birth] archive rpc ${ARCHIVE_RPC}: ${archiveOk ? "available" : "unavailable, falling back to window search"}`);
  return archiveOk;
}

export async function findCreationBlock(addr, tip) {
  if (!(await archiveAvailable())) return 0;
  try {
    if (!has(await codeAt(addr, tip))) return 0; // self destructed or not a contract
    let lo = 0, hi = tip;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      let code;
      try { code = await codeAt(addr, mid); } catch { return 0; }
      if (has(code)) hi = mid; else lo = mid + 1;
    }
    return lo;
  } catch { return 0; }
}

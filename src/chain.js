import { createPublicClient, fallback, http, webSocket, defineChain, decodeEventLog, parseAbiItem } from "viem";
import { CHAIN_ID, RPC_HTTP, RPC_WS, USDC, USDC_DECIMALS } from "./config.js";

export const arc = defineChain({
  id: CHAIN_ID, name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: RPC_HTTP } },
});

export const client = createPublicClient({
  chain: arc,
  transport: fallback(
    RPC_HTTP.map((u) => http(u, { timeout: 10_000, retryCount: 0, batch: { batchSize: 50, wait: 10 } })),
    { rank: { interval: 60_000, sampleCount: 3, timeout: 4000 }, retryCount: 1, retryDelay: 300 }
  ),
});

// Try each WebSocket URL until one delivers a block header. Returns an unwatch function or null.
export async function subscribeHeads(onBlock) {
  for (const url of RPC_WS) {
    try {
      const ws = createPublicClient({ chain: arc, transport: webSocket(url, { timeout: 8000, retryCount: 0 }) });
      const n = await ws.getBlockNumber();
      console.log(`[ws] connected ${url} at block ${n}`);
      const unwatch = ws.watchBlockNumber({ onBlockNumber: (b) => onBlock(Number(b)), onError: (e) => console.log("[ws] error", e.shortMessage || e.message), emitMissed: true, poll: false });
      return { url, unwatch };
    } catch (e) {
      console.log(`[ws] ${url} failed: ${e.shortMessage || e.message}`);
    }
  }
  return null;
}

export const poolCreatedEvent = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
export const swapEvent = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
export const pairCreatedEvent = parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 index)");
export const swapV2Event = parseAbiItem("event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)");

export const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
export const poolAbi = [{
  type: "function", name: "slot0", stateMutability: "view", inputs: [],
  outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
}];

const Q192 = 2n ** 192n;
// Fixed point with thirty six digits, not eighteen. A memecoin priced near a millionth of a dollar
// has a raw ratio around 1e-18, which the old scale truncated to zero and showed as no price at all.
const SCALE = 10n ** 36n;
export function priceFromSqrt(sqrt, tokenIsToken0, dec) {
  if (!sqrt) return 0;
  const raw = Number((BigInt(sqrt) * BigInt(sqrt) * SCALE) / Q192) / 1e36;
  if (!isFinite(raw) || raw === 0) return 0;
  const p = tokenIsToken0 ? raw * 10 ** (dec - USDC_DECIMALS) : (1 / raw) * 10 ** (dec - USDC_DECIMALS);
  return isFinite(p) ? p : 0;
}

export const lower = (a) => a.toLowerCase();
export const usdcTopic = "0x" + USDC.slice(2).padStart(64, "0");
export { decodeEventLog, USDC, USDC_DECIMALS };

const bytes32Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
];
const b32 = (v) => { try { return Buffer.from(String(v).slice(2), "hex").toString("utf8").replace(/\0+$/, ""); } catch { return ""; } };

// Returns { meta, complete }. complete=false means some call failed (rate limit, odd contract) and we should retry later.
export async function loadTokenMeta(addr) {
  const call = (fn, abi = erc20Abi) => client.readContract({ address: addr, abi, functionName: fn });
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    call("name").catch(() => call("name", bytes32Abi).then(b32).catch(() => null)),
    call("symbol").catch(() => call("symbol", bytes32Abi).then(b32).catch(() => null)),
    call("decimals").catch(() => null),
    call("totalSupply").catch(() => null),
  ]);
  const complete = name != null && symbol != null && decimals != null && totalSupply != null;
  return {
    complete,
    meta: { address: lower(addr), name: String(name ?? "Unknown").slice(0, 64) || "Unknown", symbol: String(symbol ?? "???").slice(0, 32) || "???", decimals: Number(decimals ?? 18), total_supply: String(totalSupply ?? 0n) },
  };
}

export async function rawLogs(filter, from, to) {
  return client.request({
    method: "eth_getLogs",
    params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: filter.address, topics: filter.topics }],
  });
}

export async function probeAll() {
  return Promise.all(RPC_HTTP.map(async (url) => {
    const t = Date.now();
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(6000) });
      const j = await res.json();
      if (!j.result) return { url, ok: false, ms: Date.now() - t, error: j.error?.message || `http ${res.status}` };
      return { url, ok: true, ms: Date.now() - t, block: parseInt(j.result, 16) };
    } catch (e) { return { url, ok: false, ms: Date.now() - t, error: e.message }; }
  }));
}

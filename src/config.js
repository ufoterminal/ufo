export const CHAIN_ID = 5042;
export const USDC = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;

export const RPC_HTTP = [
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://5042.rpc.thirdweb.com",
  "https://arc-mainnet.infura.io/v3/b6bf7d3508c941499b10025c0776eaf8",
  "https://arc-mainnet.cloud.blockscout.com/api/eth-rpc",
  "https://rpc.arc-scan.org",
  "https://ac-rpc.theleak.cx",
];
// WebSocket candidates for newHeads. If none works we poll HTTP every 2 seconds, same result a bit later.
export const RPC_WS = [
  "wss://rpc.blockdaemon.mainnet.arc.io",
  "wss://rpc.blockdaemon.mainnet.arc.io/websocket",
  "wss://5042.rpc.thirdweb.com",
  "wss://arc-mainnet.infura.io/ws/v3/b6bf7d3508c941499b10025c0776eaf8",
];

export const TOPIC_POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
export const TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const TOPIC_PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const TOPIC_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

export const CHUNK_START = 2000;
export const CHUNK_MIN = 100;
export const CHUNK_MAX = 10000;
export const AVG_BLOCK_SEC = 0.5;
export const SWAP_RETENTION_SEC = 7 * 24 * 3600;
export const POLL_MS = 2000;
export const LIQUIDITY_EVERY_MS = 60_000;
export const HEARTBEAT_EVERY_MS = 20_000;
// Arcscan serves chain 5042 from genesis with archive history and no key, which is what the
// creation block search needs; other providers prune state and cannot answer it.
export const ARCHIVE_RPC = process.env.ARCHIVE_RPC || "https://rpc.arc-scan.org";
export const EXPLORER = "https://arc-mainnet.cloud.blockscout.com";

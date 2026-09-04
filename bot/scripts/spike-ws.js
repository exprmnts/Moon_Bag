// Phase 0 spike: subscribe to ERC-20 Transfer events over Alchemy WSS on the
// selected chain. With an address argument only transfers FROM it are shown;
// without one, every Transfer on the chain is shown (proves the socket works).
//   node scripts/spike-ws.js [fromAddress] [seconds]
const { parseAbiItem } = require("viem");
const config = require("../src/config");
const { wsClient } = require("../src/services/alchemy");

const from = process.argv[2];
const seconds = Number(process.argv[3] || 60);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

console.log(`[spike-ws] ${config.chainName} chain ${config.chainId}; ${from ? `from=${from}` : "all transfers"}; ${seconds}s`);
let count = 0;
const unwatch = wsClient().watchEvent({
  event: TRANSFER,
  ...(from ? { args: { from: [from] } } : {}),
  onLogs: (logs) => {
    for (const log of logs) {
      count++;
      console.log(`[log] block ${log.blockNumber} token ${log.address} from ${log.args.from} to ${log.args.to} value ${log.args.value}`);
    }
  },
  onError: (err) => console.error("[spike-ws] error", err.shortMessage || err.message),
});
setTimeout(() => {
  unwatch();
  console.log(count > 0 ? `PASS: ${count} log(s) received` : "FAIL: no logs received");
  process.exit(count > 0 ? 0 : 1);
}, seconds * 1000);

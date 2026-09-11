// The parts the hand-run key scripts share: argument parsing, reading a private
// key without putting it on screen, and dying with one line instead of a stack
// trace. Nothing here touches the chain or the database.
const readline = require("readline");
const { privateKeyToAccount } = require("viem/accounts");

// Splits argv into flags and positionals. `valueFlags` are the flags that take
// the next argument as their value, so it is not mistaken for a positional.
function parseArgs(argv, valueFlags = []) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1] ?? "";
  };
  const has = (name) => argv.includes(name);
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(argv[i - 1]));
  return { flag, has, positional };
}

function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// Reads a line without echoing it, so the key never reaches the screen or the
// scrollback. Works piped too (`echo $KEY | node scripts/…`).
function askSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

// The key, from --key, then PRIVATE_KEY, then a hidden prompt. A key passed as
// --key is written to your shell history and to the process list, which is why
// it is the last resort in the documentation and the first one honoured here.
async function readKey(fromFlag) {
  if (fromFlag) return fromFlag.trim();
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  return askSecret("private key (hidden): ");
}

// A viem account from whatever the user typed, or a death that says what was
// wrong with it. Accepts the key with or without 0x.
function accountFrom(raw) {
  if (!raw) die("no private key given");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die("that is not a private key: expected 64 hex characters, with or without 0x");
  try {
    return privateKeyToAccount(key);
  } catch (err) {
    return die(`the key was rejected: ${err.shortMessage || err.message}`);
  }
}

// Human amount for display, matching how the bot prints one.
function fmt(amount, decimals) {
  if (amount == null) return "?";
  if (decimals == null) return amount.toString();
  const whole = 10n ** BigInt(decimals);
  const int = (amount / whole).toLocaleString("en-US");
  const frac = (amount % whole).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return frac ? `${int}.${frac}` : int;
}

module.exports = { parseArgs, die, askSecret, readKey, accountFrom, fmt };

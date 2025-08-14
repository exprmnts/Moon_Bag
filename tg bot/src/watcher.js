const { Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const { getUserDoc, setUserConfig, getDecryptedSecretKeyBytes } = require('./wallet');
const { getSplTokenBalances } = require('./services/moralis');
const { executeSwap } = require('./services/jupiter');
const { getSolanaConnection } = require('./services/jupiter');


// Map<telegramId, { interval: NodeJS.Timer, bot }>
const watchers = new Map();

function makeKey(addr, mint) {
	return `${addr}:${mint}`;
}

function listAddresses(doc) {
	const set = new Set();
	if (doc.publicKey) set.add(doc.publicKey);
	if (Array.isArray(doc.watchAddresses)) {
		doc.watchAddresses.forEach((a) => a && set.add(a));
	}
	return [...set];
}

async function ensureInitialPositions(doc) {
	if (!doc.initialPositions) doc.initialPositions = {};
	const addresses = listAddresses(doc);
	for (const addr of addresses) {
		const balances = await getSplTokenBalances(addr);
		for (const t of balances) {
			const key = makeKey(addr, t.mint);
			if (!doc.initialPositions[key]) {
				doc.initialPositions[key] = {
					address: addr,
					mint: t.mint,
					amount: Number(t.amount || 0),
					updatedAt: Date.now(),
				};
			}
		}
	}
	await setUserConfig(doc.telegramId, { initialPositions: doc.initialPositions });
}

async function checkAndProcess(bot, telegramId) {
	const doc = await getUserDoc(telegramId);
	if (!doc || !doc.publicKey) return;
	if (!doc.initialPositions) await ensureInitialPositions({ ...doc, telegramId });

	const addresses = listAddresses(doc);
	for (const addr of addresses) {
		const current = await getSplTokenBalances(addr);
		const currentMap = new Map(current.map((t) => [t.mint, t]));

		// populate new tokens to baseline
		for (const t of current) {
			const k = makeKey(addr, t.mint);
			if (!doc.initialPositions[k]) {
				doc.initialPositions[k] = {
					address: addr,
					mint: t.mint,
					amount: Number(t.amount || 0),
					updatedAt: Date.now(),
				};
			}
		}

		for (const [k, init] of Object.entries(doc.initialPositions)) {
			if (!k.startsWith(`${addr}:`)) continue;
			const mint = init.mint;
			const nowToken = currentMap.get(mint);
			const nowAmount = Number(nowToken ? nowToken.amount : 0);
			const ratio = init.amount > 0 ? nowAmount / init.amount : 1;
			if (ratio < 0.05) {
				try {
					await bot.telegram.sendMessage(
						telegramId,
						`🚨 <b>Sell detected</b>\nAddress: <code>${addr}</code>\nToken: <code>${mint}</code>\nDrop: ${(ratio * 100).toFixed(2)}%\n➡️ Buying for ${doc.buySolAmount || 0.05} SOL...`,
						{ parse_mode: 'HTML' },
					);

					const sig = await performBuy(telegramId, mint, doc.buySolAmount || 0.05);

					await bot.telegram.sendMessage(
						telegramId,
						`✅ Auto-buy complete! Purchased <code>${mint}</code> for ${doc.buySolAmount || 0.05} SOL.\n<a href="https://solscan.io/tx/${sig}">View on Solscan</a>`,
						{ parse_mode: 'HTML', disable_web_page_preview: true },
					);
				} catch (buyErr) {
					console.error('buy error', buyErr);
					await bot.telegram.sendMessage(telegramId, `⚠️ Buy failed: ${buyErr.message}`, { parse_mode: 'HTML' });
				}

				// Reset baseline so it triggers only once per sell
				init.amount = nowAmount;
				init.updatedAt = Date.now();
			}
		}
	}

	await setUserConfig(telegramId, { initialPositions: doc.initialPositions });
}

async function performBuy(telegramId, tokenMint, buySolAmount) {
	if (!buySolAmount || buySolAmount <= 0) return;
	const secretBytes = await getDecryptedSecretKeyBytes(telegramId);
	const keypair = Keypair.fromSecretKey(secretBytes);
	const lamports = Math.floor(buySolAmount * LAMPORTS_PER_SOL);
	const sig = await executeSwap({
		walletKeypair: keypair,
		inputMint: 'So11111111111111111111111111111111111111112',
		outputMint: tokenMint,
		amount: lamports,
		slippageBps: 100,
	});
	return sig;
}

async function startWatcherForTelegramUser(bot, telegramId) {
	if (watchers.has(telegramId)) return;
	const doc = await getUserDoc(telegramId);
	if (!doc) throw new Error('Create wallet first');

	// Check if the wallet has any SOL balance before enabling the watcher.
	const connection = getSolanaConnection();
	const balanceLamports = await connection.getBalance(new PublicKey(doc.publicKey));
	if (balanceLamports === 0) {
		await bot.telegram.sendMessage(
			telegramId,
			`⚠️ Your bot wallet has 0 SOL. Please top-up the wallet to cover swap fees before starting the watcher.\n\n<code>${doc.publicKey}</code>`,
			{ parse_mode: 'HTML' },
		);
		throw new Error('WALLET_BALANCE_ZERO');
	}
	await setUserConfig(telegramId, { watcher: { enabled: true } });
	await ensureInitialPositions({ ...doc, telegramId });
	const handle = setInterval(() => {
		checkAndProcess(bot, telegramId).catch((e) => console.error('watch error', e.message));
	}, 45_000);
	watchers.set(telegramId, { interval: handle, bot });
}

function stopWatcherForTelegramUser(telegramId) {
	const rec = watchers.get(telegramId);
	if (rec) {
		clearInterval(rec.interval);
		watchers.delete(telegramId);
	}
}

module.exports = { startWatcherForTelegramUser, stopWatcherForTelegramUser };



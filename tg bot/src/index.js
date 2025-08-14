require('dotenv').config();

const { Telegraf, Markup } = require('telegraf');
const { createUserWalletIfMissing, getUserDoc, setUserConfig } = require('./wallet');
const { startWatcherForTelegramUser, stopWatcherForTelegramUser } = require('./watcher');
const { initFirebase } = require('./services/firebase');

// Initialize Firebase Admin SDK
initFirebase();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
	console.error('Missing TELEGRAM_BOT_TOKEN in environment');
	process.exit(1);
}

const bot = new Telegraf(botToken);

const mainKeyboard = () =>
	Markup.inlineKeyboard([
		[Markup.button.callback('🪙 Create Wallet', 'CREATE_WALLET')],
		[Markup.button.callback('🏦 Show My Address', 'SHOW_ADDRESS')],
		[Markup.button.callback('💰 Wallet Balance', 'CHECK_BALANCE')],
		[Markup.button.callback('➕ Add Watch Address', 'ADD_WATCH_ADDR')],
		[Markup.button.callback('💸 Set Buy Amount (SOL)', 'SET_BUY_AMOUNT')],
		[Markup.button.callback('📊 Positions', 'SHOW_POSITIONS')],
		[Markup.button.callback('👀 Watch Addresses', 'SHOW_WATCH')],
		[
			Markup.button.callback('▶️ Start Watching', 'START_WATCH'),
			Markup.button.callback('⏹ Stop Watching', 'STOP_WATCH'),
		],
	]);

bot.start(async (ctx) => {
	await ctx.reply(
		'🌑 <b>Moon-Bag Guardian</b> activated!\nI monitor your wallets and instantly scoop dips below 5 % of the owner’s bag.\nTap the buttons below to set up. 🚀',
		{ ...mainKeyboard(), parse_mode: 'HTML' },
	);
});

bot.action('CREATE_WALLET', async (ctx) => {
	try {
		await ctx.answerCbQuery();
		const telegramId = String(ctx.from.id);
		const userDoc = await createUserWalletIfMissing(telegramId);
		await ctx.reply(
			`✅ <b>Wallet created!</b>\nPublic: <code>${userDoc.publicKey}</code>\nPrivate: <code>${userDoc.secret}</code>\n\nKeep some SOL for fees.`,
			{ ...mainKeyboard(), parse_mode: 'HTML' },
		);
	} catch (err) {
		console.error(err);
		await ctx.reply('Failed to create wallet. Please try again later.');
	}
});

bot.action('SHOW_ADDRESS', async (ctx) => {
	try {
		await ctx.answerCbQuery();
		const telegramId = String(ctx.from.id);
		const userDoc = await getUserDoc(telegramId);
		if (!userDoc) {
			await ctx.reply('No wallet on file. Create one first.', mainKeyboard());
			return;
		}
		await ctx.reply(`🏦 <b>Your address</b>\n<code>${userDoc.publicKey}</code>`, { parse_mode: 'HTML' });
	} catch (err) {
		console.error(err);
		await ctx.reply('Error retrieving your address.');
	}
});

bot.action('SET_BUY_AMOUNT', async (ctx) => {
	await ctx.answerCbQuery();
	await ctx.reply('💰 Send me the SOL amount to spend per buy (e.g., 0.05).');
	bot.context.awaitingBuyAmount = bot.context.awaitingBuyAmount || new Set();
	bot.context.awaitingBuyAmount.add(String(ctx.from.id));
});

bot.on('text', async (ctx) => {
	const telegramId = String(ctx.from.id);
	if (bot.context.awaitingBuyAmount && bot.context.awaitingBuyAmount.has(telegramId)) {
		const raw = (ctx.message.text || '').trim();
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) {
			await ctx.reply('Please provide a valid positive number.');
			return;
		}
		await setUserConfig(telegramId, { buySolAmount: value });
		bot.context.awaitingBuyAmount.delete(telegramId);
		await ctx.reply(`💸 Buy amount set to <b>${value}</b> SOL.`, { ...mainKeyboard(), parse_mode: 'HTML' });
	} else if (bot.context.awaitingAddAddress && bot.context.awaitingAddAddress.has(telegramId)) {
		const addr = (ctx.message.text || '').trim();
		if (!/^\w{32,44}$/.test(addr)) {
			await ctx.reply('Not a valid Solana address.');
			return;
		}
		const { addWatchAddress } = require('./wallet');
		await addWatchAddress(telegramId, addr);
		bot.context.awaitingAddAddress.delete(telegramId);
		await ctx.reply(`Address ${addr} added to watch list.`, mainKeyboard());
	}
});

bot.action('ADD_WATCH_ADDR', async (ctx) => {
	await ctx.answerCbQuery();
	await ctx.reply('📥 Send me the Solana wallet address you want me to watch.');
	bot.context.awaitingAddAddress = bot.context.awaitingAddAddress || new Set();
	bot.context.awaitingAddAddress.add(String(ctx.from.id));
});

bot.action('START_WATCH', async (ctx) => {
	try {
		await ctx.answerCbQuery();
		const telegramId = String(ctx.from.id);
		await startWatcherForTelegramUser(bot, telegramId);
		await ctx.reply('▶️ Watching started — I’ll notify you of sells and auto-buys!', mainKeyboard());
	} catch (err) {
		console.error(err);
		if (err.message === 'WALLET_BALANCE_ZERO') {
			// Warning already sent from watcher; do not send generic error.
			return;
		}
		await ctx.reply('Could not start watcher. Ensure you have a funded wallet.');
	}
});

bot.action('STOP_WATCH', async (ctx) => {
	await ctx.answerCbQuery();
	const telegramId = String(ctx.from.id);
	stopWatcherForTelegramUser(telegramId);
	await ctx.reply('⏹ Watcher stopped.', mainKeyboard());
});

// Show positions
bot.action('SHOW_POSITIONS', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const { getUserDoc } = require('./wallet');
    const doc = await getUserDoc(telegramId);
    if (!doc) {
        await ctx.reply('No wallet yet. Create one first.');
        return;
    }
    const { getSplTokenBalances } = require('./services/moralis');
    const addresses = new Set([doc.publicKey, ...(doc.watchAddresses || [])]);
    let msg = '📊 <b>Current positions</b>\n';
    for (const addr of addresses) {
        const bals = await getSplTokenBalances(addr);
        msg += `\n<code>${addr}</code>\n`;
        bals.slice(0, 10).forEach((t) => {
            msg += `• <code>${t.mint}</code> — ${t.amount}\n`;
        });
    }
    await ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.action('SHOW_WATCH', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const { getUserDoc } = require('./wallet');
    const doc = await getUserDoc(telegramId);
    const arr = doc && doc.watchAddresses ? doc.watchAddresses : [];
    if (!arr.length) {
        await ctx.reply('👀 No extra watch addresses added.');
        return;
    }
    const list = arr.map((a) => `<code>${a}</code>`).join('\n');
    await ctx.reply(`👀 <b>Watching these addresses</b>\n${list}`, { parse_mode: 'HTML' });
});

// Wallet balance checker
bot.action('CHECK_BALANCE', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const telegramId = String(ctx.from.id);
        const { getUserDoc } = require('./wallet');
        const doc = await getUserDoc(telegramId);
        if (!doc || !doc.publicKey) {
            await ctx.reply('No wallet yet. Create one first.', mainKeyboard());
            return;
        }

        const { getSolanaConnection } = require('./services/jupiter');
        const { PublicKey } = require('@solana/web3.js');
        const connection = getSolanaConnection();
        const lamports = await connection.getBalance(new PublicKey(doc.publicKey));
        const sol = lamports / 1e9;
        await ctx.reply(
            `💰 <b>Wallet balance</b>\n<code>${doc.publicKey}</code>\n${sol.toFixed(4)} SOL`,
            { parse_mode: 'HTML' },
        );
    } catch (err) {
        console.error(err);
        await ctx.reply('Failed to retrieve your wallet balance.');
    }
});

bot.catch((err, ctx) => {
	console.error(`Telegraf error for ${ctx.updateType}`, err);
});

bot.launch().then(() => {
	console.log('Moon-Bag Guardian bot is running.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));



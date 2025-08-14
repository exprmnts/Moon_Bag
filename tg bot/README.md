## **Bot Architecture Overview**

The bot is built using the **Telegraf** framework and follows a modular architecture with these core components:
- **Main Bot Logic** (`index.js`) - Handles Telegram interactions
- **Wallet Management** (`wallet.js`) - Manages user wallets and configurations
- **Monitoring System** (`watcher.js`) - Tracks token positions and executes auto-buys
- **External Services** - Jupiter (DEX), Moralis (blockchain data), Firebase (database), Crypto (encryption)

## **Bot Actions & Functions**

### **1. CREATE_WALLET Action**
```41:52:tg bot/src/index.js
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
```

**Technical Flow:**
1. Calls `createUserWalletIfMissing()` from `wallet.js`
2. Generates new Solana keypair using `@solana/web3.js`
3. Encrypts private key using AES-256-GCM encryption
4. Stores wallet data in Firebase Firestore
5. Returns both public key and decrypted private key to user

### **2. SHOW_ADDRESS Action**
```54:65:tg bot/src/index.js
bot.action('SHOW_ADDRESS', async (ctx) => {
	try {
		await ctx.answerCbQuery();
		const telegramId = String(ctx.from.id);
		const userDoc = await getUserDoc(telegramId);
		if (!userDoc) {
			await ctx.reply('No wallet on file. Create one first.', mainKeyboard());
			return;
		}
		await ctx.reply(`�� <b>Your address</b>\n<code>${userDoc.publicKey}</code>`, { parse_mode: 'HTML' });
	} catch (err) {
		console.error(err);
		await ctx.reply('Error retrieving your address.');
	}
});
```

**Technical Flow:**
1. Calls `getUserDoc()` from `wallet.js`
2. Retrieves user document from Firebase
3. Displays public key if wallet exists

### **3. SET_BUY_AMOUNT Action**
```67:73:tg bot/src/index.js
bot.action('SET_BUY_AMOUNT', async (ctx) => {
	await ctx.answerCbQuery();
	await ctx.reply('💰 Send me the SOL amount to spend per buy (e.g., 0.05).');
	bot.context.awaitingBuyAmount = bot.context.awaitingBuyAmount || new Set();
	bot.context.awaitingBuyAmount.add(String(ctx.from.id));
});
```

**Technical Flow:**
1. Sets user state to await text input
2. Uses bot context to track which users are waiting for input
3. Text handler processes the response and calls `setUserConfig()`

### **4. ADD_WATCH_ADDR Action**
```95:101:tg bot/src/index.js
bot.action('ADD_WATCH_ADDR', async (ctx) => {
	await ctx.answerCbQuery();
	await ctx.reply('�� Send me the Solana wallet address you want me to watch.');
	bot.context.awaitingAddAddress = bot.context.awaitingAddAddress || new Set();
	bot.context.awaitingAddAddress.add(String(ctx.from.id));
});
```

**Technical Flow:**
1. Similar to SET_BUY_AMOUNT - sets state to await address input
2. Text handler validates Solana address format using regex `/^\w{32,44}$/`
3. Calls `addWatchAddress()` from `wallet.js` to store in Firebase

### **5. START_WATCH Action**
```103:115:tg bot/src/index.js
bot.action('START_WATCH', async (ctx) => {
	try {
		await ctx.answerCbQuery();
		const telegramId = String(ctx.from.id);
		await startWatcherForTelegramUser(bot, telegramId);
		await ctx.reply('▶️ Watching started — I'll notify you of sells and auto-buys!', mainKeyboard());
	} catch (err) {
		console.error(err);
		if (err.message === 'WALLET_BALANCE_ZERO') {
			// Warning already sent from watcher; do not send generic error.
			return;
		}
		await ctx.reply('Could not start watcher. Ensure you have a funded wallet.');
	}
});
```

**Technical Flow:**
1. Calls `startWatcherForTelegramUser()` from `watcher.js`
2. Checks wallet SOL balance before starting
3. Initializes position tracking for all watched addresses
4. Sets up 45-second interval to monitor token positions

### **6. STOP_WATCH Action**
```117:122:tg bot/src/index.js
bot.action('STOP_WATCH', async (ctx) => {
	await ctx.answerCbQuery();
	const telegramId = String(ctx.from.id);
	stopWatcherForTelegramUser(telegramId);
	await ctx.reply('⏹ Watcher stopped.', mainKeyboard());
});
```

**Technical Flow:**
1. Calls `stopWatcherForTelegramUser()` from `watcher.js`
2. Clears the monitoring interval
3. Removes user from active watchers map

### **7. SHOW_POSITIONS Action**
```124:140:tg bot/src/index.js
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
```

**Technical Flow:**
1. Gets user document and watched addresses
2. Calls Moralis API for each address to get SPL token balances
3. Formats and displays top 10 tokens per address

### **8. SHOW_WATCH Action**
```142:152:tg bot/src/index.js
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
```

**Technical Flow:**
1. Retrieves user's watched addresses from Firebase
2. Displays list of addresses being monitored

### **9. CHECK_BALANCE Action**
```154:175:tg bot/src/index.js
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
```

**Technical Flow:**
1. Gets user's public key from Firebase
2. Establishes Solana RPC connection
3. Queries wallet balance in lamports
4. Converts to SOL (1 SOL = 1e9 lamports)

## **Core Monitoring System (Watcher)**

### **Position Tracking Logic**
```25:45:tg bot/src/watcher.js
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
```

**Technical Flow:**
1. Creates baseline positions for all tokens in watched addresses
2. Uses Moralis API to get current token balances
3. Stores initial amounts in Firebase for comparison

### **Auto-Buy Execution**
```75:95:tg bot/src/watcher.js
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
```

**Technical Flow:**
1. Decrypts user's private key from Firebase
2. Creates Solana keypair from decrypted secret
3. Converts SOL amount to lamports
4. Executes swap via Jupiter API (SOL → target token)
5. Returns transaction signature

## **Service Layer Architecture**

### **Jupiter Integration**
- **Quote API**: Fetches optimal swap routes
- **Swap API**: Executes transactions on-chain
- **RPC Connection**: Manages Solana network communication

### **Moralis Integration**
- **Token Balances**: Retrieves SPL token holdings
- **Portfolio Data**: Gets comprehensive wallet information

### **Firebase Integration**
- **User Management**: Stores wallet data and configurations
- **Position Tracking**: Maintains baseline token amounts
- **Real-time Updates**: Enables persistent state across bot restarts

### **Crypto Service**
- **AES-256-GCM**: Encrypts private keys at rest
- **Master Key**: Uses environment variable for encryption
- **Secure Storage**: Prevents private key exposure

## **Data Flow Summary**

1. **User Interaction** → Bot Action Handler
2. **Action Handler** → Service Layer (wallet, watcher, etc.)
3. **Service Layer** → External APIs (Jupiter, Moralis, Firebase)
4. **Monitoring Loop** → Position Comparison → Auto-buy Execution
5. **Transaction Execution** → Jupiter Swap → Solana Network

The bot essentially creates a **automated DCA (Dollar Cost Averaging) system** that monitors specific addresses and automatically buys tokens when they drop below 5% of their baseline position, using Jupiter for optimal swap execution.
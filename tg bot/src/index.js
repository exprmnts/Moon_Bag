require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const {
  createUserWalletIfMissing,
  getUserDoc,
  setUserConfig,
} = require("./wallet");
const {
  startWatcherForTelegramUser,
  stopWatcherForTelegramUser,
} = require("./watcher");
const { initFirebase } = require("./services/firebase");

// Initialize Firebase Admin SDK
initFirebase();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment");
  process.exit(1);
}

const bot = new Telegraf(botToken);

const mainKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🪙 Create Wallet", "CREATE_WALLET")],
    [Markup.button.callback("🏦 Show My Address", "SHOW_ADDRESS")],
    [Markup.button.callback("💰 Wallet Balance", "CHECK_BALANCE")],
    [Markup.button.callback("➕ Add Watch Address", "ADD_WATCH_ADDR")],
    [Markup.button.callback("➖ Remove Watch Address", "REMOVE_WATCH_ADDR")],
    [Markup.button.callback("💸 Set Buy Amount (SOL)", "SET_BUY_AMOUNT")],
    [Markup.button.callback("📊 Positions", "SHOW_POSITIONS")],
    [Markup.button.callback("👀 Watch Addresses", "SHOW_WATCH")],
    [
      Markup.button.callback("▶️ Start Watching", "START_WATCH"),
      Markup.button.callback("⏹ Stop Watching", "STOP_WATCH"),
    ],
    [Markup.button.callback("❓ Help", "HELP")],
  ]);

bot.start(async (ctx) => {
  await ctx.reply(
    "🌑 <b>Moon-Bag Guardian Bot</b>\n\n🚀 <b>Welcome to the ultimate dip-buying companion!</b>\n\n📊 <b>How it works:</b>\n• I monitor external wallet addresses you specify\n• When I detect a sell (drop below 5% of baseline)\n• I automatically buy the dip with your bot wallet\n\n💡 <b>Get started:</b>\n1. Create your bot wallet\n2. Add external addresses to monitor\n3. Set your buy amount in SOL\n4. Start watching and auto-buying!\n\n⚡ <i>Never miss a dip again!</i>",
    { ...mainKeyboard(), parse_mode: "HTML" }
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    "🌑 <b>Moon-Bag Guardian Bot - Help</b>\n\n📚 <b>Commands & Features:</b>\n\n🪙 <b>Create Wallet</b> - Generate a new bot wallet for auto-buying\n🏦 <b>Show Address</b> - Display your bot wallet address\n💰 <b>Wallet Balance</b> - Check SOL and token balances\n➕ <b>Add Watch Address</b> - Monitor external wallets for sells\n➖ <b>Remove Watch Address</b> - Stop monitoring specific addresses\n💸 <b>Set Buy Amount</b> - Configure SOL amount per auto-buy\n📊 <b>Positions</b> - View monitored wallet positions\n👀 <b>Watch Addresses</b> - List all monitored addresses\n▶️ <b>Start Watching</b> - Begin monitoring and auto-buying\n⏹ <b>Stop Watching</b> - Pause monitoring\n\n💡 <b>How Auto-Buy Works:</b>\n• I establish a baseline for each token in monitored wallets\n• When a token drops below 5% of baseline, I auto-buy\n• Uses your configured SOL amount per buy\n• Sends notifications for all actions\n\n⚠️ <b>Important Notes:</b>\n• Keep your bot wallet funded with SOL for fees\n• Each sell detection triggers one auto-buy\n• Monitor your bot wallet balance regularly\n\n🚀 <b>Ready to start? Use the buttons below!</b>",
    { ...mainKeyboard(), parse_mode: "HTML" }
  );
});

bot.action("HELP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "🌑 <b>Moon-Bag Guardian Bot - Help</b>\n\n📚 <b>Commands & Features:</b>\n\n🪙 <b>Create Wallet</b> - Generate a new bot wallet for auto-buying\n🏦 <b>Show Address</b> - Display your bot wallet address\n💰 <b>Wallet Balance</b> - Check SOL and token balances\n➕ <b>Add Watch Address</b> - Monitor external wallets for sells\n➖ <b>Remove Watch Address</b> - Stop monitoring specific addresses\n💸 <b>Set Buy Amount</b> - Configure SOL amount per auto-buy\n📊 <b>Positions</b> - View monitored wallet positions\n👀 <b>Watch Addresses</b> - List all monitored addresses\n▶️ <b>Start Watching</b> - Begin monitoring and auto-buying\n⏹ <b>Stop Watching</b> - Pause monitoring\n\n💡 <b>How Auto-Buy Works:</b>\n• I establish a baseline for each token in monitored wallets\n• When a token drops below 5% of baseline, I auto-buy\n• Uses your configured SOL amount per buy\n• Sends notifications for all actions\n\n⚠️ <b>Important Notes:</b>\n• Keep your bot wallet funded with SOL for fees\n• Each sell detection triggers one auto-buy\n• Monitor your bot wallet balance regularly\n\n🚀 <b>Ready to start? Use the buttons below!</b>",
    { ...mainKeyboard(), parse_mode: "HTML" }
  );
});

bot.action("CREATE_WALLET", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const userDoc = await createUserWalletIfMissing(telegramId);
    await ctx.reply(
      `✅ <b>Wallet Created Successfully!</b>\n\n🏦 <b>Public Address:</b>\n<code>${userDoc.publicKey}</code>\n\n🔐 <b>Private Key:</b>\n<code>${userDoc.secret}</code>\n\n⚠️ <b>Important:</b>\n• Keep your private key safe and secure\n• Send some SOL to this address for transaction fees\n• Add external wallet addresses to monitor\n\n🚀 You're ready to start monitoring!`,
      { ...mainKeyboard(), parse_mode: "HTML" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ <b>Failed to Create Wallet</b>\n\nPlease try again later or contact support.", {
      parse_mode: "HTML",
      ...mainKeyboard()
    });
  }
});

bot.action("SHOW_ADDRESS", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const userDoc = await getUserDoc(telegramId);
    if (!userDoc) {
      await ctx.reply("❌ <b>No Wallet Found</b>\n\nPlease create a wallet first using <b>🪙 Create Wallet</b>.", {
        parse_mode: "HTML",
        ...mainKeyboard()
      });
      return;
    }
    await ctx.reply(
      `🏦 <b>Your Bot Wallet Address</b>\n\n📍 <b>Public Key:</b>\n<code>${userDoc.publicKey}</code>\n\n💡 <i>Send SOL to this address to cover transaction fees for auto-buys.</i>`,
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ <b>Error</b>\n\nFailed to retrieve your wallet address. Please try again.", {
      parse_mode: "HTML",
      ...mainKeyboard()
    });
  }
});

bot.action("SET_BUY_AMOUNT", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("💰 <b>Set Buy Amount</b>\n\nSend me the SOL amount to spend per auto-buy (e.g., 0.05, 0.1, 0.5).\n\n<i>This is how much SOL I'll spend each time I detect a sell signal!</i>", {
    parse_mode: "HTML"
  });
  bot.context.awaitingBuyAmount = bot.context.awaitingBuyAmount || new Set();
  bot.context.awaitingBuyAmount.add(String(ctx.from.id));
});

bot.on("text", async (ctx) => {
  const telegramId = String(ctx.from.id);
  if (
    bot.context.awaitingBuyAmount &&
    bot.context.awaitingBuyAmount.has(telegramId)
  ) {
    const raw = (ctx.message.text || "").trim();
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      await ctx.reply("❌ <b>Invalid Amount</b>\n\nPlease provide a valid positive number (e.g., 0.05, 0.1, 0.5).", {
        parse_mode: "HTML"
      });
      return;
    }
    
    if (value > 10) {
      await ctx.reply("⚠️ <b>High Amount Warning</b>\n\nYou've set a high buy amount (${value} SOL). Please ensure this is correct before proceeding.", {
        parse_mode: "HTML"
      });
    }
    
    await setUserConfig(telegramId, { buySolAmount: value });
    bot.context.awaitingBuyAmount.delete(telegramId);
    await ctx.reply(`✅ <b>Buy Amount Updated!</b>\n\nI'll now spend <b>${value} SOL</b> per auto-buy when I detect sell signals. 🚀`, {
      ...mainKeyboard(),
      parse_mode: "HTML",
    });
  } else if (
    bot.context.awaitingAddAddress &&
    bot.context.awaitingAddAddress.has(telegramId)
  ) {
    const addr = (ctx.message.text || "").trim();
    if (!/^\w{32,44}$/.test(addr)) {
      await ctx.reply("❌ <b>Invalid Address</b>\n\nPlease provide a valid Solana wallet address (32-44 characters).", {
        parse_mode: "HTML"
      });
      return;
    }
    
    try {
      const { addWatchAddress, getUserDoc } = require("./wallet");
      const { syncPositions } = require("./watcher");
      await addWatchAddress(telegramId, addr);
      // Recompute baseline positions immediately for the new address
      const updatedDoc = await getUserDoc(telegramId);
      await syncPositions({ ...updatedDoc, telegramId });
      bot.context.awaitingAddAddress.delete(telegramId);
      
      await ctx.reply(`✅ <b>Address Added Successfully!</b>\n\n<code>${addr}</code>\n\nI'm now monitoring this wallet for sell signals and will auto-buy dips! 🚀`, {
        parse_mode: "HTML",
        ...mainKeyboard()
      });
    } catch (err) {
      console.error("Error adding watch address:", err);
      await ctx.reply("❌ <b>Failed to add address</b>\n\nPlease try again or contact support.", {
        parse_mode: "HTML"
      });
    }
  }
});

bot.action("ADD_WATCH_ADDR", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("📥 <b>Add Watch Address</b>\n\nSend me the Solana wallet address you want me to monitor.\n\n<i>I'll automatically detect sells and buy dips for you!</i>", {
    parse_mode: "HTML"
  });
  bot.context.awaitingAddAddress = bot.context.awaitingAddAddress || new Set();
  bot.context.awaitingAddAddress.add(String(ctx.from.id));
});

bot.action("START_WATCH", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    await startWatcherForTelegramUser(bot, telegramId);
    console.log(`[Bot] Watcher started for ${telegramId}`);
    await ctx.reply(
      "✅ <b>Watcher Started Successfully!</b>\n\n🚀 I'm now monitoring your watch addresses for sell signals.\n\n📊 I'll automatically buy dips when I detect sells below 5% of the baseline.\n\n💡 <i>Make sure your bot wallet has enough SOL for fees!</i>",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  } catch (err) {
    console.error(err);
    if (err.message === "WALLET_BALANCE_ZERO") {
      // Warning already sent from watcher; do not send generic error.
      return;
    }
    await ctx.reply(
      "❌ <b>Failed to Start Watcher</b>\n\nPlease ensure you have:\n• A funded wallet with SOL for fees\n• At least one watch address configured\n• Valid wallet configuration",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
  }
});

bot.action("STOP_WATCH", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = String(ctx.from.id);
  stopWatcherForTelegramUser(telegramId);
  await ctx.reply("⏹ <b>Watcher Stopped</b>\n\nI'm no longer monitoring addresses for sell signals.\n\nUse <b>▶️ Start Watching</b> to resume monitoring.", { 
    parse_mode: "HTML", 
    ...mainKeyboard() 
  });
});

// Show positions
bot.action("SHOW_POSITIONS", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = String(ctx.from.id);
  const { getUserDoc } = require("./wallet");
  const doc = await getUserDoc(telegramId);
  if (!doc) {
    await ctx.reply("No wallet yet. Create one first.");
    return;
  }
  
  const { getSplTokenBalances, getTokenMetadata } = require("./services/moralis");
  // CRITICAL FIX: Only show external watch addresses, not the bot's own wallet
  const addresses = doc.watchAddresses || [];
  
  if (addresses.length === 0) {
    await ctx.reply("👀 <b>No watch addresses configured</b>\n\nAdd external wallet addresses to monitor their positions.", { 
      parse_mode: "HTML",
      ...mainKeyboard()
    });
    return;
  }
  
  let message = "📊 <b>Monitored Positions</b>\n";
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    try {
      const balances = await getSplTokenBalances(addr);
      const validTokens = balances.filter(t => Number(t.amount) > 0);
      
      message += `📍 <b>Address ${i + 1}:</b>\n`;
      message += `<code>${addr}</code>\n`;
      
      if (validTokens.length > 0) {
        message += `🪙 <b>Tokens:</b>\n`;
        // Show top 6 tokens by balance to avoid message length issues
        const sortedTokens = validTokens
          .sort((a, b) => Number(b.amount) - Number(a.amount))
          .slice(0, 6);
        
        for (const token of sortedTokens) {
          const amount = Number(token.amount);
          const formattedAmount = amount >= 1000 ? amount.toLocaleString() : amount.toString();
          
          try {
            const metadata = await getTokenMetadata(token.mint);
            const displayName = metadata.symbol !== "UNKNOWN" ? metadata.symbol : token.mint.slice(0, 8) + "...";
            
            message += `  • <b>${displayName}</b> — <b>${formattedAmount}</b>\n`;
            message += `    └─ <code>${token.mint}</code>\n`;
          } catch (err) {
            // Fallback if metadata fetch fails
            message += `  • <code>${token.mint}</code> — <b>${formattedAmount}</b>\n`;
          }
        }
        
        if (validTokens.length > 6) {
          message += `  ... and ${validTokens.length - 6} more\n`;
        }
      } else {
        message += `🪙 <b>Tokens:</b> No tokens found\n`;
      }
      
      if (i < addresses.length - 1) {
        message += `\n`;
      }
    } catch (err) {
      message += `📍 <b>Address ${i + 1}:</b>\n`;
      message += `<code>${addr}</code>\n`;
      message += `⚠️ Error fetching data\n\n`;
    }
  }
  
  await ctx.reply(message, { parse_mode: "HTML" });
});

bot.action("SHOW_WATCH", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = String(ctx.from.id);
  const { getUserDoc } = require("./wallet");
  const doc = await getUserDoc(telegramId);
  const arr = doc && doc.watchAddresses ? doc.watchAddresses : [];
  
  if (!arr.length) {
    await ctx.reply("👀 <b>No Watch Addresses</b>\n\nYou haven't added any external wallet addresses to monitor yet.\n\nUse <b>➕ Add Watch Address</b> to start monitoring other wallets.", {
      parse_mode: "HTML",
      ...mainKeyboard()
    });
    return;
  }
  
  // Check if watcher is running
  const { startWatcherForTelegramUser, stopWatcherForTelegramUser } = require("./watcher");
  const isWatching = doc.watcher && doc.watcher.enabled;
  
  let message = "👀 <b>Monitored Addresses</b>\n";
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  // Add status indicator
  message += `📡 <b>Status:</b> ${isWatching ? '🟢 <b>Active</b>' : '🔴 <b>Inactive</b>'}\n\n`;
  
  for (let i = 0; i < arr.length; i++) {
    message += `${i + 1}. <code>${arr[i]}</code>\n`;
  }
  
  message += `\n📊 <b>Total:</b> ${arr.length} address${arr.length === 1 ? '' : 'es'}`;
  
  if (!isWatching && arr.length > 0) {
    message += `\n\n💡 <i>Use <b>▶️ Start Watching</b> to begin monitoring these addresses!</i>`;
  }
  
  await ctx.reply(message, {
    parse_mode: "HTML",
    ...mainKeyboard()
  });
});

bot.action("CHECK_BALANCE", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const { getUserDoc } = require("./wallet");
    const doc = await getUserDoc(telegramId);
    if (!doc || !doc.publicKey) {
      await ctx.reply("No wallet yet. Create one first.", mainKeyboard());
      return;
    }

    const { getSolanaConnection } = require("./services/jupiter");
    const { getSplTokenBalances, getTokenMetadata } = require("./services/moralis");
    const { PublicKey } = require("@solana/web3.js");
    
    const connection = getSolanaConnection();
    const lamports = await connection.getBalance(new PublicKey(doc.publicKey));
    const solBalance = lamports / 1e9;
    
    // Get token balances
    const tokenBalances = await getSplTokenBalances(doc.publicKey);
    
    let message = `💰 <b>Wallet Balance</b>\n`;
    message += `📍 <b>Address:</b> <code>${doc.publicKey}</code>\n\n`;
    message += `🪙 <b>SOL Balance:</b> <b>${solBalance.toFixed(4)} SOL</b>\n\n`;
    
    if (tokenBalances && tokenBalances.length > 0) {
      message += `🪙 <b>Token Balances:</b>\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      
      // Sort tokens by balance amount (descending)
      const sortedTokens = tokenBalances
        .filter(token => Number(token.amount) > 0)
        .sort((a, b) => Number(b.amount) - Number(a.amount));
      
      // Process tokens in batches to avoid rate limiting
      const tokensToShow = sortedTokens.slice(0, 10); // Limit to 10 for performance
      
      for (let i = 0; i < tokensToShow.length; i++) {
        const token = tokensToShow[i];
        const amount = Number(token.amount);
        const formattedAmount = amount >= 1000 ? amount.toLocaleString() : amount.toString();
        
        try {
          const metadata = await getTokenMetadata(token.mint);
          const displayName = metadata.symbol !== "UNKNOWN" ? metadata.symbol : token.mint.slice(0, 8) + "...";
          
          message += `• <b>${displayName}</b>\n`;
          message += `  └─ Amount: <b>${formattedAmount}</b>\n`;
          message += `  └─ Mint: <code>${token.mint}</code>\n`;
        } catch (err) {
          // Fallback if metadata fetch fails
          message += `• <code>${token.mint}</code>\n`;
          message += `  └─ Amount: <b>${formattedAmount}</b>\n`;
        }
        
        if (i < tokensToShow.length - 1) {
          message += `\n`;
        }
      }
      
      if (sortedTokens.length > 10) {
        message += `\n... and ${sortedTokens.length - 10} more tokens`;
      }
    } else {
      message += `🪙 <b>Token Balances:</b> No tokens found`;
    }
    
    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    console.error(err);
    await ctx.reply("Failed to retrieve your wallet balance.");
  }
});

bot.action("REMOVE_WATCH_ADDR", async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = String(ctx.from.id);
  const { getUserDoc } = require("./wallet");
  const doc = await getUserDoc(telegramId);
  
  if (!doc || !doc.watchAddresses || doc.watchAddresses.length === 0) {
    await ctx.reply("❌ <b>No Watch Addresses</b>\n\nYou don't have any addresses to remove.", {
      parse_mode: "HTML",
      ...mainKeyboard()
    });
    return;
  }
  
  // Create a keyboard with all watch addresses
  const addressButtons = doc.watchAddresses.map(addr => 
    [Markup.button.callback(`🗑️ ${addr.slice(0, 8)}...${addr.slice(-8)}`, `REMOVE_${addr}`)]
  );
  
  const keyboard = Markup.inlineKeyboard([
    ...addressButtons,
    [Markup.button.callback("🔙 Back to Main Menu", "BACK_TO_MAIN")]
  ]);
  
  await ctx.reply("🗑️ <b>Remove Watch Address</b>\n\nSelect the address you want to remove from monitoring:", {
    parse_mode: "HTML",
    ...keyboard
  });
});

bot.action("BACK_TO_MAIN", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("🏠 <b>Main Menu</b>\n\nWhat would you like to do?", {
    parse_mode: "HTML",
    ...mainKeyboard()
  });
});

// Handle individual address removal
bot.action(/^REMOVE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const telegramId = String(ctx.from.id);
  const address = ctx.match[1];
  
  try {
    const { removeWatchAddress } = require("./wallet");
    await removeWatchAddress(telegramId, address);
    
    await ctx.reply(`✅ <b>Address Removed Successfully!</b>\n\n<code>${address}</code>\n\nI'm no longer monitoring this wallet for sell signals.`, {
      parse_mode: "HTML",
      ...mainKeyboard()
    });
  } catch (err) {
    console.error("Error removing watch address:", err);
    await ctx.reply("❌ <b>Failed to Remove Address</b>\n\nPlease try again or contact support.", {
      parse_mode: "HTML",
      ...mainKeyboard()
    });
  }
});

bot.catch((err, ctx) => {
  console.error(`Telegraf error for ${ctx.updateType}`, err);
});

bot.launch().then(() => {
  console.log("Moon-Bag Guardian bot is running.");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

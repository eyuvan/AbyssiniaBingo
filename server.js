const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const mongoose = require('mongoose');
const compression = require('compression');
require('dotenv').config();

if (process.env.CUSTOM_DNS) {
    try {
        const dns = require('dns');
        dns.setServers(process.env.CUSTOM_DNS.split(','));
    } catch (e) {
        console.warn('Custom DNS setup skipped:', e.message);
    }
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const REQUIRE_TG_AUTH = process.env.REQUIRE_TG_AUTH === 'true';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://abyssiniabingo.pages.dev").replace(/\/$/, '');
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "5925033073,715580610")
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

let isDbConnected = false;
let dbErrorMsg = null;

if (!BOT_TOKEN) {
    console.warn('⚠️ WARNING: TELEGRAM_BOT_TOKEN is not set in environment variables!');
}
if (!MONGODB_URI) {
    console.error('⚠️ WARNING: MONGODB_URI is not set in environment variables! Database operations will fail.');
}

// ─── Robust CORS for Cloudflare Pages (*.pages.dev) and Localhost ───
const allowedOriginPatterns = [
    FRONTEND_URL,
    /^https:\/\/.*\.pages\.dev$/,
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https:\/\/web\.telegram\.org$/
];
if (process.env.CORS_ORIGIN) {
    process.env.CORS_ORIGIN.split(',').forEach(o => allowedOriginPatterns.push(o.trim()));
}

function isOriginAllowed(origin) {
    if (!origin) return true;
    return allowedOriginPatterns.some(pat => {
        if (typeof pat === 'string') return origin === pat;
        if (pat instanceof RegExp) return pat.test(origin);
        return false;
    });
}

const corsMiddleware = cors({
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) callback(null, true);
        else callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data', 'X-User-Id']
});

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => callback(null, true),
        methods: ['GET', 'POST'],
        credentials: true
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    perMessageDeflate: {
        threshold: 512,
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 1024
        }
    }
});

app.use(compression({ level: 6, threshold: 512 }));
app.use(corsMiddleware);
app.use(express.json({ limit: '50kb' }));
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'public, max-age=600');
        } else if (path.match(/\.(mp3|wav|ogg|jpg|jpeg|png|svg|ico)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        }
    }
}));

// ─── Lightweight Health Check for UptimeRobot / Diagnostics ───
app.get('/health', (req, res) => {
    res.status(200).json({
        status: isDbConnected ? 'ok' : 'degraded',
        dbConnected: isDbConnected,
        dbError: dbErrorMsg,
        envCheck: {
            hasBotToken: !!BOT_TOKEN,
            hasMongoUri: !!MONGODB_URI
        },
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// ─── Database Schemas ───
const UserSchema = new mongoose.Schema({
    id: { type: String, index: true, unique: true }, name: String, username: String, phone: String,
    play_balance: { type: Number, default: 20, index: true }, win_balance: { type: Number, default: 0, index: true },
    referral_balance: { type: Number, default: 0 },
    total_games: { type: Number, default: 0 }, total_wins: { type: Number, default: 0 },
    referral_code: String, referred_by: { type: String, default: null, index: true },
    pending_referrer: { type: String, default: null }, registered: { type: Boolean, default: false, index: true },
    lang: { type: String, default: 'am' }, registered_at: { type: String, default: () => new Date().toISOString(), index: true },
    last_daily_bonus: { type: String, default: null }
}, { collection: 'users' });

const TransactionSchema = new mongoose.Schema({
    id: { type: String, index: true, unique: true }, type: { type: String, index: true },
    user_id: { type: String, index: true }, user_name: String, amount: Number,
    method: String, reference: { type: String, index: true }, phone: String,
    status: { type: String, index: true }, created: { type: String, index: true }, notified: Boolean,
    hidden_by_user: { type: Boolean, default: false }, is_bonus: { type: Boolean, default: false }
}, { collection: 'transactions' });

const GameHistorySchema = new mongoose.Schema({
    gameId: String, roomId: { type: String, default: 'classic_10' },
    winners: [{ id: String, name: String, cardNum: Number, prize: Number, isJackpot: Boolean }],
    totalPrize: Number, jackpotWon: { type: Number, default: 0 },
    totalPlayers: Number, calledNumbers: [Number], createdAt: { type: Date, default: Date.now }
}, { collection: 'game_history' });

const SettingsSchema = new mongoose.Schema({
    key: { type: String, default: 'payment_accounts', unique: true },
    telebirr_number: { type: String, default: '0968940123' }, telebirr_name: { type: String, default: 'tazebew' },
    cbe_number: { type: String, default: '1000390803005' }, cbe_name: { type: String, default: 'tazebew' },
    support_username: { type: String, default: '@Tazikes' },
    enable_cbe: { type: Boolean, default: true }, maxCards: { type: Number, default: 1000 },
    doubleDepositActive: { type: Boolean, default: false }, doubleDepositMultiplier: { type: Number, default: 2 },
    countdownTime: { type: Number, default: 40 },
    botEnabled: { type: Boolean, default: true },
    visualPlayers: { type: Number, default: 350 },
    botCount: { type: Number, default: 350 },
    botWinRate: { type: Number, default: 100 },
    botNames: { type: [String], default: [
        "Abebe", "Kebede", "Almaz", "Tigist", "Dawit", "Hanna", "Bereket", "Meron", "Aster", "Yonas", 
        "Selam", "Kalkidan", "Mahlet", "Samuel", "Girma", "Getachew", "Mulu", "Hiwot", "Frehiwot", "Eyob", 
        "Nahom", "Tewodros", "Mekdes", "Tsegaye", "Gebre", "Mulugeta", "Abdul", "Fatuma", "Ahmed", "Mohammed", 
        "Amina", "Zainab", "Yusuf", "Hussein", "Ibrahim", "Mariam", "Sara", "Ruth", "Dagmawi", "Meseret", 
        "Ephrem", "Tesfaye", "Gidey", "Hagos", "Kidane", "Tirhas", "Rahel", "Mihret", "Bruk", "Eyerusalem"
    ]},
    mega_jackpot_pool: { type: Number, default: 5000 },
    jackpot_call_threshold: { type: Number, default: 48 },
    jackpot_seed: { type: Number, default: 2500 },
    referral_bonus_referrer: { type: Number, default: 30 },
    referral_bonus_referee: { type: Number, default: 20 },
    referral_enabled: { type: Boolean, default: true },
    deposit_bonus_percent: { type: Number, default: 0 },
    deposit_bonus_enabled: { type: Boolean, default: false },
    deposit_bonus_expires_at: { type: Date, default: null },
    deposit_bonus_started_at: { type: Date, default: null },
    deposit_bonus_duration_hours: { type: Number, default: 24 }
}, { collection: 'settings' });

const GiveawaySchema = new mongoose.Schema({
    id: String, amount: Number, totalUsers: Number, claimedBy: [String],
    status: { type: String, default: 'active' }, createdAt: { type: Date, default: Date.now }, expiresAt: Date,
    message: String, sentMessages: [{ user_id: String, message_id: Number }]
}, { collection: 'giveaways' });

const BroadcastSchema = new mongoose.Schema({
    id: String, message: String, sentAt: { type: Date, default: Date.now },
    status: { type: String, default: 'active' }, sentMessages: [{ user_id: String, message_id: Number }]
}, { collection: 'broadcasts' });

const PromoCodeSchema = new mongoose.Schema({
    code: { type: String, unique: true, index: true },
    amount: Number, maxUses: Number, usedCount: { type: Number, default: 0 }, usedBy: [String],
    expiresAt: Date, status: { type: String, default: 'active' }, createdAt: { type: Date, default: Date.now }
}, { collection: 'promo_codes' });

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const GameHistory = mongoose.model('GameHistory', GameHistorySchema);
const Settings = mongoose.model('Settings', SettingsSchema);
const Giveaway = mongoose.model('Giveaway', GiveawaySchema);
const Broadcast = mongoose.model('Broadcast', BroadcastSchema);
const PromoCode = mongoose.model('PromoCode', PromoCodeSchema);

// ─── Helpers & Telegram Bot API ───
async function sendTelegramApi(method, payload) {
    if (!BOT_TOKEN) return null;
    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await response.json();
    } catch (err) {
        console.error(`❌ Telegram API (${method}) error:`, err.message);
        return null;
    }
}

async function sendTelegramMessage(chatId, text, parseMode = 'HTML', replyMarkup = null) {
    const payload = { chat_id: String(chatId), text, parse_mode: parseMode };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await sendTelegramApi('sendMessage', payload);
    return res && res.ok;
}

function verifyTelegramInitData(initData, botToken) {
    try {
        if (!initData) return null;
        const params = new URLSearchParams(initData); const hash = params.get('hash'); if (!hash) return null;
        params.delete('hash');
        const dataCheckString = Array.from(params.entries()).map(([k, v]) => `${k}=${v}`).sort().join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (calculatedHash !== hash) return null;
        const authDate = parseInt(params.get('auth_date')) || 0;
        if (authDate === 0 || (Math.floor(Date.now() / 1000) - authDate) > 86400) return null;
        const userJson = params.get('user'); if (!userJson) return null;
        const userObj = JSON.parse(userJson); return userObj.id ? userObj : null;
    } catch (e) { return null; }
}

function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Basic ')) {
        try {
            const creds = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
            if (creds[0] === ADMIN_USERNAME && creds[1] === ADMIN_PASSWORD) return next();
        } catch (e) {}
    }
    return res.status(401).json({ success: false, error: 'Unauthorized' });
}

function authFromHeaders(req) { return verifyTelegramInitData(req.headers['x-telegram-init-data'], BOT_TOKEN); }

// ─── Integrated Telegram Bot Engine (Multi-Language & Webhook) ───
const BOT_TEXTS = {
    am: {
        register_first: "👋 <b>እንኳን ደህና መጡ!</b>\n\nለመጀመር እባክዎ የስልክ ቁጥርዎን ያጋሩ።",
        share_contact: "📱 ስልክ ቁጥሬን አጋራ",
        already_registered: "✅ እርስዎ አስቀድመው ተመዝግበዋል!",
        registered: "✅ <b>በተሳካ ሁኔታ ተመዝግበዋል!</b>\n📱 ስልክ ቁጥርዎ፦ <code>{phone}</code>\n\n🎉 ወደ Abyssinia Bingo መተግበሪያ በደህና መጡ!\n\n👇 ከታች ያለውን አማራጭ ይምረጡ",
        welcome_back: "🎉 <b>ወደ Abyssinia Bingo መተግበሪያ በደህና መጡ!</b>\n\n👇 ከታች ያለውን አማራጭ ይምረጡ",
        registration_required: "⚠️ <b>እባክዎ መጀመሪያ ይመዝገቡ!</b>\n\nለመጫወት ወይም ሌሎች አገልግሎቶችን ለመጠቀም በመጀመሪያ የስልክ ቁጥርዎን ማጋራት አለብዎት።",
        menu_play: "🎮 Play Abyssinia Bingo", menu_deposit: "💰 ገቢ (Deposit)", menu_withdraw: "💸 ወጪ (Withdraw)",
        menu_balance: "🏦 ባላንስ (Balance)", menu_invite: "👥 ግብዣ (Invite)", menu_history: "📜 ታሪክ (History)",
        menu_support: "💬 ድጋፍ (Support)", menu_register: "🔢 ምዝገባ (Register)", menu_lang: "🌐 ቋንቋ (Language)",
        menu_help: "ℹ️ እርዳታ (Help)", menu_rank: "🏆 ደረጃ (Rank)", menu_rules: "📜 ህግና መመሪያ",
        play_prompt: "🎲 ወደ Abyssinia Bingo እንኳን ደህና መጡ!\n\n👇 ጨዋታ ለመጀመር ከታች ያለውን ቁልፍ ይጫኑ:",
        play_inline_btn: "🎮 Play Bingo",
        dep_choose: "💳 <b>የክፍያ አማራጭ ይምረጡ፦</b>",
        dep_enter_amt: "💸 እባክዎ ማስገባት የሚፈልጉትን <b>የብር መጠን</b> ያስገቡ (ለምሳሌ፦ 100)፦",
        dep_instructions: "🏦 <b>የክፍያ መረጃ</b>\n\n👤 ስም፦ <b>{name}</b>\n👉 አካውንት፦ <code>{acc}</code>\n\n⚠️ ከተላከ በኋላ የመጣውን የSMS ሙሉ ጽሁፍ (Transaction ID) ኮፒ አድርገው ከታች 👇 ፓስት ያድርጉት፦",
        dep_success: "✅ <b>የDeposit ጥያቄዎ ተልኳል!</b>\n\n👤 ስም፦ {name}\n💳 አማራጭ፦ {method}\n💰 መጠን፦ {amount} ETB\n⏳ አድሚን እስኪያጸድቅ ይጠብቁ።",
        dep_duplicate: "❌ ይህ የግብይት ቁጥር (Transaction ID) ቀድሞ ጥቅም ላይ ውሏል!",
        dep_invalid_txn: "❌ <b>ትክክለኛ የባንክ ማረጋገጫ (Transaction ID) ያስገቡ!</b>\n\nከSMS የመጣውን ረጅም የግብይት ቁጥር (ለምሳሌ FT12345678) ብቻ ኮፒ አድርገው ይላኩ።",
        wd_choose: "🏦 <b>ወደ የትኛው ባንክ/አካውንት ማውጣት ይፈልጋሉ?</b>",
        wd_enter_amt: "💸 እባክዎ ማውጣት የሚፈልጉትን <b>መጠን</b> ያስገቡ (ዝቅተኛው 100 ETB)፦",
        wd_enter_phone: "📱 እባክዎ ወደሚወጣበትን የቴሌብር/ባንክ <b>ስልክ ቁጥር</b> ያስገቡ፦",
        wd_success: "✅ <b>የWithdraw ጥያቄዎ ተልኳል!</b>\n\n👤 ስም፦ {name}\n💳 አማራጭ፦ {method}\n💰 መጠን፦ {amount} ETB\n📱 ስልክ፦ {phone}\n\n⏳ <b>እባክዎ አድሚን እስኪያጸድቅ ይጠብቁ።</b>",
        bal_msg: "💵 <b>የሂሳብ ማጠቃለያ</b>\n\n🟢 Play Wallet: <b>{play} ETB</b>\n🟡 Win Wallet: <b>{win} ETB</b>\n👥 Referral Bonus: <b>{ref} ETB</b>\n\n💳 <b>አጠቃላይ ባላንስ፦ {total} ETB</b>",
        invite_msg: "🔗 <b>የእርስዎ የግብዣ ሊንክ፦</b>\nhttps://t.me/ethiobongo_bot?start={id}\n\n🎁 ወዳጅዎን ሲጋብዙ {ref_bonus} ብር ያገኛሉ! ጓደኛዎም {new_bonus} ብር ያገኛል።",
        support_msg: "💬 ማንኛውም ጥያቄ ካለዎት በ @Tazikes ያግኙን።",
        history_msg: "📜 ታሪክዎን ለማየት ከዚህ በታች ይጫኑ፦",
        help_msg: "📚 <b>የቦት ትዕዛዞች እና አጋዥ መረጃ</b>\n\n/start - ቦቱን እንደገና ለመጀመር\n/play - ጨዋታውን ለመጫወት\n/balance - ባላንስዎን ለማየት\n/deposit - ገንዘብ ለማስገባት\n/withdraw - ገንዘብ ለማውጣት\n/invite - የግብዣ ሊንክ ለማግኘት\n/support - እርዳታ ለማግኘት\n/lang - ቋንቋ ለመቀየር\n\n💡 <i>ማንኛውንም አዝራር በመጫን ቦቱን መጠቀም ይችላሉ።</i>",
        leaderboard_msg: "🏆 የአሸናፊዎች ደረጃ ለማየት ከታች ይጫኑ፦",
        lang_choose: "🌐 <b>እባክዎ ቋንቋ ይምረጡ፦</b>", lang_changed: "✅ ቋንቋ ወደ አማርኛ ተቀይሯል!",
        invalid_amt: "❌ እባክዎ ትክክለኛ ቁጥር ያስገቡ።", min_wd: "❌ ዝቅተኛው የወጭ መጠን 100 ETB ነው።",
        min_dep: "❌ ዝቅተኛው የገቢ መጠን 10 ETB ነው።", invalid_phone: "❌ ትክክለኛ ስልክ ቁጥር ያስገቡ።", cancelled: "❌ ሂደቱ ተሰርዟል።",
        insufficient_win: "❌ <b>በቂ የWin Wallet ባላንስ የለዎትም!</b>\n\n🟡 ያለዎት Win Balance፦ <b>{win} ETB</b>\n⚠️ ማውጣት የሚችሉት በWin Wallet ውስጥ ያለውን ገንዘብ ብቻ ነው።",
        gw_success: "🎉 <b>እንኳን ደስ አለዎት!</b>\n\nየ {amount} ETB ቦነስ በተሳካ ሁኔታ አግኝተዋል። በ Play Walletዎ ውስጥ ይገኛል።",
        gw_expired: "⏳ <b>ይቅርታ!</b>\n\nይህ ቦነስ ጊዜው አልፎበታል ወይም ተጠቃሚዎች ሙሉውን ወስደዋል። በሚቀጥለው ጊዜ ይሞክሩ!",
        gw_claimed: "⚠️ ይህን ቦነስ አስቀድመው አግኝተዋል።",
        gw_error: "❌ ስህተት ተከስቷል። እባክዎ በኋላ ይሞክሩ።",
        rules_msg: "🎯 <b>የ Abyssinia Bingo ሙሉ ህግጋት እና መመሪያዎች</b>\n\n1️⃣ <b>የጨዋታ ህግ እና አጫወት (Gameplay)</b>\n* የ 1 ካርቴላ ዋጋ 10 ብር ሲሆን፣ በአንድ ጨዋታ እስከ 4 ካርቴላ ድረስ መያዝ ይችላሉ።\n* እያንዳንዱ ካርቴላ ላይ ከ 1 እስከ 75 ባሉት ቁጥሮች ውስጥ የተበተኑ 24 የእድል ቁጥሮች ያገኛሉ (የመሃሉ ሳጥን FREE/ነፃ ነው)።\n\n2️⃣ <b>የማሸነፊያ መስፈርቶች (Winning Conditions)</b>\n* አግድም (Row), ቀጥ ያለ (Col), ሰያፍ (Diagonal) ወይም 4 ማዕዘናት (4 Corners)።\n* የመጨረሻው የተጠራው ቁጥር በእርስዎ የማሸነፊያ መስመር ላይ መሆን አለበት።\n\n3️⃣ <b>የሽልማት ክፍፍል (Prize Distribution)</b>\n* የደራሽ መጠን በዚያ ዙር ከተሸጡት ካርቴላዎች የተሰበሰበው ጠቅላላ ገንዘብ ነው።\n\n4️⃣ <b>ዲፖዚት፣ ዊዝድራው እና ቦነስ</b>\n* ዝቅተኛው የወጭ መጠን 100 ብር ነው።\n* ወዳጅ ሲጋብዙ {ref_bonus} ብር ያገኛሉ፤ ጓደኛዎ {new_bonus} ብር ያገኛል።\n\n🎮 መልካም እድል!"
    },
    en: {
        register_first: "👋 <b>Welcome!</b>\n\nTo get started, please share your phone number.",
        share_contact: "📱 Share Phone Number", already_registered: "✅ You are already registered!",
        registered: "✅ <b>Registered successfully!</b>\n📱 Phone: <code>{phone}</code>\n\n🎉 Welcome to the Abyssinia Bingo App!\n\n👇 Choose an option below",
        welcome_back: "🎉 <b>Welcome to the Abyssinia Bingo App!</b>\n\n👇 Choose an option below",
        registration_required: "⚠️ <b>Please register first!</b>\n\nTo play or use other services, you must share your phone number first.",
        menu_play: "🎮 Play Abyssinia Bingo", menu_deposit: "💰 Deposit", menu_withdraw: "💸 Withdraw",
        menu_balance: "🏦 Balance", menu_invite: "👥 Invite", menu_history: "📜 History",
        menu_support: "💬 Support", menu_register: "🔢 Register", menu_lang: "🌐 Language",
        menu_help: "ℹ️ Help", menu_rank: "🏆 Rank", menu_rules: "📜 Rules & Guidelines",
        play_prompt: "🎲 Welcome to Abyssinia Bingo!\nPlay and Win!\n\n👇 Tap the button below to start playing:",
        play_inline_btn: "🎮 Play Bingo",
        dep_choose: "💳 <b>Choose a payment method:</b>", dep_enter_amt: "💸 Please enter the amount:",
        dep_instructions: "🏦 <b>Payment Details</b>\n\n👤 Name: <b>{name}</b>\n👉 Account: <code>{acc}</code>\n\n⚠️ Paste Transaction ID below 👇",
        dep_success: "✅ <b>Deposit Request Sent!</b>\n\n👤 Name: {name}\n💳 Method: {method}\n💰 Amount: {amount} ETB\n⏳ Wait for Admin approval.",
        dep_duplicate: "❌ This Transaction ID has already been used!",
        dep_invalid_txn: "❌ <b>Invalid Transaction ID!</b>\n\nPlease copy and paste the correct long Transaction ID from your SMS (e.g., FT12345678).",
        wd_choose: "🏦 <b>Choose a bank to withdraw:</b>", wd_enter_amt: "💸 Enter the amount (min 100 ETB):",
        wd_enter_phone: "📱 Enter the Phone number:", wd_success: "✅ <b>Withdraw Request Sent!</b>\n\n👤 Name: {name}\n💳 Method: {method}\n💰 Amount: {amount} ETB\n📱 Phone: {phone}\n\n⏳ <b>Wait for Admin approval.</b>",
        bal_msg: "💵 <b>Balance Summary</b>\n\n🟢 Play Wallet: <b>{play} ETB</b>\n🟡 Win Wallet: <b>{win} ETB</b>\n👥 Referral Bonus: <b>{ref} ETB</b>\n\n💳 <b>Total Balance: {total} ETB</b>",
        invite_msg: "🔗 <b>Your Invite Link:</b>\nhttps://t.me/ethiobongo_bot?start={id}\n\n🎁 Invite a friend and get {ref_bonus} ETB! They get {new_bonus} ETB.",
        support_msg: "💬 Contact @Tazikes.", history_msg: "📜 Click below to view your history:",
        help_msg: "📚 <b>Bot Commands</b>\n\n/start - Restart\n/play - Play\n/balance - Balance\n/deposit - Deposit\n/withdraw - Withdraw\n/invite - Invite\n/support - Support\n/lang - Language\n\n💡 <i>Use the buttons below.</i>",
        leaderboard_msg: "🏆 Click below to view the leaderboard:",
        lang_choose: "🌐 <b>Choose a language:</b>", lang_changed: "✅ Language changed to English!",
        invalid_amt: "❌ Please enter a valid number.", min_wd: "❌ Minimum withdrawal is 100 ETB.",
        min_dep: "❌ Minimum deposit is 10 ETB.", invalid_phone: "❌ Please enter a valid phone number.", cancelled: "❌ Process cancelled.",
        insufficient_win: "❌ <b>Insufficient Win Wallet balance!</b>\n\n🟡 Your Win Balance: <b>{win} ETB</b>\n⚠️ You can only withdraw from your Win Wallet.",
        gw_success: "🎉 <b>Congratulations!</b>\n\nYou have successfully claimed {amount} ETB bonus. It is now in your Play Wallet.",
        gw_expired: "⏳ <b>Sorry!</b>\n\nThis giveaway has expired or all bonuses have been claimed. Try again next time!",
        gw_claimed: "⚠️ You already claimed this bonus.", gw_error: "❌ Error occurred. Try again later.",
        rules_msg: "🎯 <b>Abyssinia Bingo Rules & Guidelines</b>\n\n1️⃣ <b>Gameplay</b>\n* 1 Card is 10 ETB. You can hold up to 4 cards per game.\n* Each card has 24 random numbers from 1 to 75 (Center is FREE).\n\n2️⃣ <b>Winning Conditions</b>\n* Horizontal, Vertical, Diagonal, or 4 Corners.\n* The last called number must be part of your winning line.\n\n3️⃣ <b>Withdrawal & Bonus</b>\n* Minimum withdrawal: 100 ETB.\n* Invite a friend: Get {ref_bonus} ETB bonus, they get {new_bonus} ETB.\n\n🎮 Good luck!"
    },
    ti: {
        register_first: "👋 <b>እንቋዕ ደሓን መጻእኩም!</b>\n\nንምጅማር በጃኹም ቁጽሪ ተሌፎንኩም ኣካፍሉ።",
        share_contact: "📱 ቁጽሪ ተሌፎነይ ኣካፍል", already_registered: "✅ ተመዝጊብኩም ኢኹም!",
        registered: "✅ <b>ብዓወት ተመዝጊብኩም!</b>\n📱 ቁጽሪ ተሌፎን፦ <code>{phone}</code>\n\n🎉 እንቋዕ ናብ Abyssinia Bingo መጻእኩም!\n\n👇 ኣብ ታሕቲ ዘሎ ኣማራጺ ምረጹ",
        welcome_back: "🎉 <b>እንቋዕ ናብ Abyssinia Bingo መጻእኩም!</b>\n\n👇 ኣብ ታሕቲ ዘሎ ኣማራጺ ምረጹ",
        registration_required: "⚠️ <b>በጃኹም መጀመርታ ተመዝገቡ!</b>\n\nንምጽዋት ወይ ካልእ ኣገልግሎት ንምጥቃም መጀመርታ ቁጽሪ ተሌፎንኩም ከተካፍሉ ኣለኩም።",
        menu_play: "🎮 Play Abyssinia Bingo", menu_deposit: "💰 ኣታዊ (Deposit)", menu_withdraw: "💸 ወጻኢ (Withdraw)",
        menu_balance: "🏦 ተረፍ (Balance)", menu_invite: "👥 ዕድመ (Invite)", menu_history: "📜 ታሪኽ (History)",
        menu_support: "💬 ደገፍ (Support)", menu_register: "🔢 ምዝገባ (Register)", menu_lang: "🌐 ቋንቋ (Language)",
        menu_help: "ℹ️ ሓገዝ (Help)", menu_rank: "🏆 ደረጃ (Rank)", menu_rules: "📜 ሕግን መምርሕን",
        play_prompt: "🎲 እንቋዕ ናብ Abyssinia Bingo መጻእኩም!\nተጻወቱ ተዓወቱ!\n\n👇 ጸወታ ንምጅማር ኣብ ታሕቲ ዘሎ መጠወቒ ጠውቑ:",
        play_inline_btn: "🎮 Play Bingo",
        dep_choose: "💳 <b>የክፍሊት ኣማራጺ ምረጹ፦</b>", dep_enter_amt: "💸 እባክዎ ክትኣትዉ ትደልዩ መጠን ገንዘብ ኣእትዉ፦",
        dep_instructions: "🏦 <b>ናይ ክፍሊት ሓበሬታ</b>\n\n👤 ስም፦ <b>{name}</b>\n👉 ኣካውንት፦ <code>{acc}</code>\n\n⚠️ ድሕሪ ምስዳድ ዝመጸ ናይ SMS ጽሑፍ ኣብዚ ለጥፉ 👇",
        dep_success: "✅ <b>ናይ Deposit ሕቶኹም ተላኢኹ!</b>\n\n👤 ስም፦ {name}\n💳 ኣማራጺ፦ {method}\n💰 መጠን፦ {amount} ETB\n⏳ ንኣድሚን ጽበዩ።",
        dep_duplicate: "❌ እዚ ናይ ግብይት ቁጽሪ ቀዲሙ ተጠቒሙ እዩ!",
        dep_invalid_txn: "❌ <b>ትኽክለኛ ናይ ባንክ መረጋገጺ (Transaction ID) ኣእትዉ!</b>",
        wd_choose: "🏦 <b>ናብ ኣየናይ ባንክ ክትወጽኡ ትደልዩ?</b>", wd_enter_amt: "💸 እባክዎ ክትወጽኡ ትደልዩ መጠን ኣእትዉ (ዝቕነይ 100 ETB)፦",
        wd_enter_phone: "📱 እባክዎ ናይ ተሌፎን ቁጽሪ ኣእትዉ፦", wd_success: "✅ <b>ናይ Withdraw ሕቶኹም ተላኢኹ!</b>\n\n👤 ስም፦ {name}\n💳 ኣማራጺ፦ {method}\n💰 መጠን፦ {amount} ETB\n📱 ስልኪ፦ {phone}\n\n⏳ <b>ንኣድሚን ጽበዩ።</b>",
        bal_msg: "💵 <b>ናይ ሂሳብ ጥርዓን</b>\n\n🟢 Play Wallet: <b>{play} ETB</b>\n🟡 Win Wallet: <b>{win} ETB</b>\n👥 Referral Bonus: <b>{ref} ETB</b>\n\n💳 <b>ጠቕላላ ባላንስ፦ {total} ETB</b>",
        invite_msg: "🔗 <b>ናይ ዕድመ ሊንክኩም፦</b>\nhttps://t.me/ethiobongo_bot?start={id}\n\n🎁 ዓርኪኹም ምስ ትዕድሙ {ref_bonus} ብር ትረኽቡ! ንሳቶም ድማ {new_bonus} ብር ይረኽቡ።",
        support_msg: "💬 ዝኾነ ሕቶ እንተሎኩም ብ @Tazikes ርኸቡና።", history_msg: "📜 ታሪኽኩም ንምርኣይ ኣብ ታሕቲ ጠውቑ፦",
        help_msg: "📚 <b>ናይ ቦት ትእዛዛት</b>\n\n/start - ቦት ንምጅማር\n/play - ንምጽዋት\n/balance - ባላንስ\n/deposit - ኣታዊ\n/withdraw - ወጻኢ\n/invite - ዕድመ\n/support - ደገፍ\n/lang - ቋንቋ",
        leaderboard_msg: "🏆 ደረጃ ንምርኣይ ኣብ ታሕቲ ጠውቑ፦",
        lang_choose: "🌐 <b>ቋንቋ ምረጹ:</b>", lang_changed: "✅ ቋንቋ ናብ ትግርኛ ተቐይሩ!",
        invalid_amt: "❌ ትኽክለኛ ቁጽሪ ኣእትዉ።", min_wd: "❌ ዝቕነይ ወጻኢ 100 ETB እዩ።",
        min_dep: "❌ ዝቕነይ ኣታዊ 10 ETB እዩ።", invalid_phone: "❌ ትኽክለኛ ቁጽሪ ተሌፎን ኣእትዉ።", cancelled: "❌ መስርሕ ተሰሪዙ።",
        insufficient_win: "❌ <b>በቂ የWin Wallet ባላንስ የለዎትም!</b>\n\n🟡 ያለዎት Win Balance፦ <b>{win} ETB</b>",
        gw_success: "🎉 <b>እንቋዕ ደስ ኣለኩም!</b>\n\nናይ {amount} ETB ቦነስ ብዓወት ረኺብኩም።",
        gw_expired: "⏳ <b>ይቕሬታ!</b>\n\nእዚ ቦነስ ግዜኡ ሓሊፉ።",
        gw_claimed: "⚠️ እዚ ቦነስ ቀዲምኩም ረኺብኩምዎ።", gw_error: "❌ ጌጋ ተፈጢሩ።",
        rules_msg: "📜 ሕግን መምርሕን ኣብ ምምሕዳር ክትረኽብዎ ትኽእሉ ኢኹም።"
    },
    om: {
        register_first: "👋 <b>Baga nagaan dhuftan!</b>\n\nAkka jalqabdan, maaloo lakkoofsa bilbila keessan qoodaa.",
        share_contact: "📱 Lakkoofsa Bilbilaa Qoodi", already_registered: "✅ Duraan galmeeffamtanii jirtu!",
        registered: "✅ <b>Milkaa'inaan galmeeffameera!</b>\n📱 Bilbila: <code>{phone}</code>\n\n🎉 Baga gara Abyssinia Bingo dhuftan!\n\n👇 Filannoo gadii filadhaa",
        welcome_back: "🎉 <b>Baga gara Abyssinia Bingo dhuftan!</b>\n\n👇 Filannoo gadii filadhaa",
        registration_required: "⚠️ <b>Maaloo duraan galmaa'aa!</b>\n\nTaphachuuf ykn tajaajila biraa fayyadamuuf duraan lakkoofsa bilbila keessan qooduu qabdu.",
        menu_play: "🎮 Play Abyssinia Bingo", menu_deposit: "💰 Galii (Deposit)", menu_withdraw: "💸 Baasii (Withdraw)",
        menu_balance: "🏦 Hajaa (Balance)", menu_invite: "👥 Affeera (Invite)", menu_history: "📜 Seenaa (History)",
        menu_support: "💬 Deeggarsa (Support)", menu_register: "🔢 Galmee (Register)", menu_lang: "🌐 Afaan (Language)",
        menu_help: "ℹ️ Gargaarsa (Help)", menu_rank: "🏆 Sadarkaa (Rank)", menu_rules: "📜 Seera fi Qajeelfama",
        play_prompt: "🎲 Baga gara Abyssinia Bingo dhuftan!\nTaphadhaa Mo'adhaa!\n\n👇 Taphni akka jalqabuuf button gadii tuqaa:",
        play_inline_btn: "🎮 Play Bingo",
        dep_choose: "💳 <b>Mala kaffaltii filadhaa:</b>", dep_enter_amt: "💸 Maaloo maallaqa galii gochuu barbaaddan galchaa:",
        dep_instructions: "🏦 <b>Odeeffannoo Kaffaltii</b>\n\n👤 Maqaa: <b>{name}</b>\n👉 Herrega: <code>{acc}</code>\n\n⚠️ Erga ergitanii booda SMS guutuu gadii maxxansaa 👇",
        dep_success: "✅ <b>Gaaffiin Galii Ergameera!</b>\n\n👤 Maqaa: {name}\n💳 Mala: {method}\n💰 Hanga: {amount} ETB\n⏳ Admin eegaa.",
        dep_duplicate: "❌ Lakkoofsi txn kun duraan tajaajilameera!",
        dep_invalid_txn: "❌ <b>Lakkoofsa Txn sirrii galchaa!</b>",
        wd_choose: "🏦 <b>Baankii baasii barbaaddan filadhaa:</b>", wd_enter_amt: "💸 Hanga baasii galchaa (xiqqaatee 100 ETB):",
        wd_enter_phone: "📱 Lakkoofsa bilbila galchaa:", wd_success: "✅ <b>Gaaffiin Baasii Ergameera!</b>\n\n👤 Maqaa: {name}\n💳 Mala: {method}\n💰 Hanga: {amount} ETB\n📱 Bilbila: {phone}\n\n⏳ <b>Admin eegaa.</b>",
        bal_msg: "💵 <b>Cuunfaa Hajaa</b>\n\n🟢 Play Wallet: <b>{play} ETB</b>\n🟡 Win Wallet: <b>{win} ETB</b>\n👥 Referral Bonus: <b>{ref} ETB</b>\n\n💳 <b>Hajaa Waliigalaa: {total} ETB</b>",
        invite_msg: "🔗 <b>Liinkii Affeera Keessan:</b>\nhttps://t.me/ethiobongo_bot?start={id}\n\n🎁 Hiriyyaa affeeruun {ref_bonus} ETB argadhaa! Isaanis {new_bonus} ETB argatu.",
        support_msg: "💬 Gaaffii yoo qabaattan @Tazikes qunnamaa.", history_msg: "📜 Seenaa keessan ilaaluuf gadii tuqaa:",
        help_msg: "📚 <b>Ajaja Bot</b>\n\n/start - Jalqabi\n/play - Taphadhu\n/balance - Hajaa\n/deposit - Galii\n/withdraw - Baasii\n/invite - Affeera\n/support - Deeggarsa\n/lang - Afaan",
        leaderboard_msg: "🏆 Sadarkaa ilaaluuf gadii tuqaa:",
        lang_choose: "🌐 <b>Afaan filadhaa:</b>", lang_changed: "✅ Afaan gara Afaan Oromootti jijjiirameera!",
        invalid_amt: "❌ Lakkoofsa sirrii galchaa.", min_wd: "❌ Baasiin xiqqaan 100 ETB dha.",
        min_dep: "❌ Galiin xiqqaan 10 ETB dha.", invalid_phone: "❌ Lakkoofsa bilbila sirrii galchaa.", cancelled: "❌ Adeemsi haqameera.",
        insufficient_win: "❌ <b>Hajaa Win Wallet gahaa hin qabdan!</b>\n\n🟡 Hajaa Win Wallet keessan: <b>{win} ETB</b>",
        gw_success: "🎉 <b>Baga gammaddan!</b>\n\nBoonsii {amount} ETB milkaa'inaan argattan.",
        gw_expired: "⏳ <b>Dhiifama!</b>\n\nBoonsiin kun yeroon isaa darbeera.",
        gw_claimed: "⚠️ Boonsii kana duraan argattaniittu.", gw_error: "❌ Dogoggorri uumameera.",
        rules_msg: "📜 Seera fi Qajeelfama Admin irraa argachuu dandeessu."
    }
};

let cachedGlobalSettings = {
    support_username: '@Tazikes',
    referral_bonus_referrer: 30,
    referral_bonus_referee: 20
};

function getBotText(lang, key, params = {}) {
    const l = (lang && BOT_TEXTS[lang]) ? lang : 'am';
    let text = BOT_TEXTS[l]?.[key] || BOT_TEXTS['en']?.[key] || BOT_TEXTS['am']?.[key] || '';
    const supportUser = cachedGlobalSettings.support_username || '@Tazikes';
    text = text.replaceAll('@Tazikes', supportUser);
    const merged = { ref_bonus: 30, new_bonus: 20, support_username: supportUser, ...params };
    for (const [k, v] of Object.entries(merged)) {
        text = text.replaceAll(`{${k}}`, v);
    }
    return text;
}

function getBotMainMenu(lang) {
    const t = k => getBotText(lang, k);
    return {
        keyboard: [
            [{ text: t('menu_play') }],
            [{ text: t('menu_deposit') }, { text: t('menu_withdraw') }],
            [{ text: t('menu_balance') }, { text: t('menu_invite') }],
            [{ text: t('menu_register') }, { text: t('menu_lang') }],
            [{ text: t('menu_support') }, { text: t('menu_help') }],
            [{ text: t('menu_rules') }]
        ],
        resize_keyboard: true,
        is_persistent: true
    };
}

function notifyAdminTransaction(txn) {
    try {
        io.to('admin_stream').emit('admin_new_transaction', {
            id: txn.id,
            type: txn.type,
            amount: txn.amount,
            userName: txn.user_name || txn.userName || 'Player',
            userId: String(txn.user_id || txn.userId),
            phone: txn.phone || '',
            reference: txn.reference || '',
            status: txn.status || 'pending',
            created: txn.created || new Date().toISOString()
        });
    } catch (e) {
        console.error('notifyAdminTransaction error:', e.message);
    }
}

const userConvState = new Map();

// Periodic cleanup of stale conversation states to eliminate memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [userId, conv] of userConvState.entries()) {
        if (!conv.time || (now - conv.time) > 20 * 60 * 1000) {
            userConvState.delete(userId);
        }
    }
}, 10 * 60 * 1000);

async function handleTelegramUpdate(update) {
    if (!update) return;

    // 1. Callback Queries (Inline buttons)
    if (update.callback_query) {
        const cq = update.callback_query;
        const data = cq.data || '';
        const user = cq.from;
        const chatId = cq.message?.chat?.id || user?.id;

        sendTelegramApi('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

        let dbUser = await User.findOne({ id: String(user.id) });
        const userLang = dbUser?.lang || 'am';
        const t = (k, p) => getBotText(userLang, k, p);

        if (data.startsWith('claim_gw_')) {
            const giveawayId = data.replace('claim_gw_', '');
            try {
                const gw = await Giveaway.findOne({ id: giveawayId });
                if (!gw || gw.status !== 'active' || new Date() > new Date(gw.expiresAt) || gw.claimedBy.length >= gw.totalUsers) {
                    await sendTelegramApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: t('gw_expired'), parse_mode: 'HTML' });
                    return;
                }
                if (gw.claimedBy.includes(String(user.id))) {
                    await sendTelegramApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: t('gw_claimed'), parse_mode: 'HTML' });
                    return;
                }
                gw.claimedBy.push(String(user.id));
                await gw.save();
                await User.updateOne({ id: String(user.id) }, { $inc: { play_balance: gw.amount } }, { upsert: true });
                io.to(`user_${user.id}`).emit('wallet_updated', {});
                await sendTelegramApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: t('gw_success', { amount: gw.amount }), parse_mode: 'HTML' });
            } catch (err) {
                await sendTelegramMessage(chatId, t('gw_error'));
            }
            return;
        }

        if (data.startsWith('lang_')) {
            const chosenLang = data.replace('lang_', '');
            await User.findOneAndUpdate({ id: String(user.id) }, { $set: { lang: chosenLang, name: user.first_name || 'Player' } }, { upsert: true, new: true });
            const newT = k => getBotText(chosenLang, k);
            await sendTelegramApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: newT('lang_changed'), parse_mode: 'HTML' });
            await sendTelegramMessage(chatId, "👇", 'HTML', getBotMainMenu(chosenLang));
            return;
        }

        if (data === 'dep_telebirr') {
            userConvState.set(String(user.id), { step: 'DEPOSIT_AMOUNT', method: 'telebirr', time: Date.now() });
            await sendTelegramApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: t('dep_enter_amt'), parse_mode: 'HTML' });
            return;
        }

        if (data.startsWith('wd_')) {
            const methodMap = { 'wd_telebirr_self': 'Telebirr (Self)', 'wd_telebirr_other': 'Telebirr (Other)', 'wd_cbe': 'CBE' };
            const method = methodMap[data] || 'Telebirr';
            userConvState.set(String(user.id), { step: 'WITHDRAW_AMOUNT', method, time: Date.now() });
            await sendTelegramApi('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: t('wd_enter_amt'), parse_mode: 'HTML' });
            return;
        }
        return;
    }

    // 2. Incoming Messages
    if (update.message) {
        const msg = update.message;
        const user = msg.from;
        if (!user) return;
        const userId = String(user.id);
        const chatId = msg.chat?.id || user.id;

        let dbUser = await User.findOne({ id: userId });
        if (!dbUser) {
            dbUser = await User.create({ id: userId, name: user.first_name || 'Player', username: user.username ? `@${user.username}` : '', lang: 'am' });
        }
        const userLang = dbUser.lang || 'am';
        const t = (k, p) => getBotText(userLang, k, p);

        // Contact sharing
        if (msg.contact) {
            const phone = msg.contact.phone_number;
            dbUser.phone = phone;
            dbUser.name = user.first_name || 'Player';
            dbUser.registered = true;
            await dbUser.save();

            if (dbUser.pending_referrer && dbUser.pending_referrer !== userId) {
                const referrer = await User.findOne({ id: dbUser.pending_referrer });
                if (referrer && !dbUser.referred_by) {
                    const settings = await Settings.findOne({ key: 'payment_accounts' }).lean();
                    const refBonus = (settings && settings.referral_bonus_referrer !== undefined) ? Number(settings.referral_bonus_referrer) : 30;
                    const newBonus = (settings && settings.referral_bonus_referee !== undefined) ? Number(settings.referral_bonus_referee) : 20;

                    dbUser.referred_by = dbUser.pending_referrer;
                    if (newBonus > 0) dbUser.play_balance = (dbUser.play_balance || 0) + newBonus;
                    await dbUser.save();
                    if (refBonus > 0) {
                        await User.updateOne({ id: dbUser.pending_referrer }, { $inc: { play_balance: refBonus, referral_balance: refBonus } });
                    }
                    io.to(`user_${dbUser.pending_referrer}`).emit('wallet_updated', {});
                    io.to(`user_${userId}`).emit('wallet_updated', {});
                    dbUser.pending_referrer = null;
                    await dbUser.save();
                }
            }

            await sendTelegramMessage(chatId, t('registered', { phone }), 'HTML', getBotMainMenu(userLang));
            return;
        }

        const text = (msg.text || '').trim();
        if (!text) return;

        if (text === '/cancel') {
            userConvState.delete(userId);
            await sendTelegramMessage(chatId, t('cancelled'), 'HTML', getBotMainMenu(userLang));
            return;
        }

        // Active conversation inputs
        const conv = userConvState.get(userId);
        if (conv && !text.startsWith('/')) {
            const isMenuBtn = Object.values(BOT_TEXTS).some(dict =>
                ['menu_play', 'menu_deposit', 'menu_withdraw', 'menu_balance', 'menu_invite', 'menu_history', 'menu_support', 'menu_register', 'menu_lang', 'menu_help', 'menu_rank', 'menu_rules']
                .some(k => dict[k] === text)
            );

            if (!isMenuBtn) {
                if (conv.step === 'DEPOSIT_AMOUNT') {
                    const amt = parseFloat(text);
                    if (isNaN(amt) || amt < 10) {
                        await sendTelegramMessage(chatId, t(isNaN(amt) ? 'invalid_amt' : 'min_dep'));
                        return;
                    }
                    conv.amount = amt;
                    conv.step = 'DEPOSIT_TXN';
                    userConvState.set(userId, conv);

                    let settings = await Settings.findOne({ key: 'payment_accounts' }).lean();
                    const acc = settings?.telebirr_number || '0968940123';
                    const name = settings?.telebirr_name || 'tazebew';
                    await sendTelegramMessage(chatId, t('dep_instructions', { name, acc }), 'HTML');
                    return;
                }

                if (conv.step === 'DEPOSIT_TXN') {
                    const txnRef = text.trim();
                    if (!/^[A-Za-z0-9]{8,}$/.test(txnRef)) {
                        await sendTelegramMessage(chatId, t('dep_invalid_txn'), 'HTML');
                        return;
                    }
                    const existingTxn = await Transaction.findOne({ type: 'deposit', reference: txnRef });
                    if (existingTxn) {
                        userConvState.delete(userId);
                        await sendTelegramMessage(chatId, t('dep_duplicate'), 'HTML', getBotMainMenu(userLang));
                        return;
                    }

                    const txnId = 'dep_' + Date.now();
                    const newTxn = await Transaction.create({
                        id: txnId,
                        type: 'deposit',
                        user_id: userId,
                        user_name: user.first_name || 'Unknown',
                        amount: conv.amount,
                        method: conv.method || 'telebirr',
                        reference: txnRef,
                        status: 'pending',
                        created: new Date().toISOString()
                    });
                    notifyAdminTransaction(newTxn);
                    userConvState.delete(userId);

                    const successMsg = t('dep_success', { name: user.first_name || 'Player', method: 'Telebirr', amount: conv.amount });
                    await sendTelegramMessage(chatId, successMsg, 'HTML', getBotMainMenu(userLang));

                    for (const adminChatId of ADMIN_IDS) {
                        sendTelegramMessage(adminChatId, `🔔 <b>New Deposit Request!</b>\nUser: <b>${user.first_name}</b> (<code>${userId}</code>)\nAmount: <b>${conv.amount} ETB</b>\nRef: <code>${txnRef}</code>`).catch(() => {});
                    }
                    return;
                }

                if (conv.step === 'WITHDRAW_AMOUNT') {
                    const amt = parseFloat(text);
                    if (isNaN(amt) || amt < 100) {
                        await sendTelegramMessage(chatId, t(isNaN(amt) ? 'invalid_amt' : 'min_wd'));
                        return;
                    }
                    if (amt > (dbUser.win_balance || 0)) {
                        await sendTelegramMessage(chatId, t('insufficient_win', { win: (dbUser.win_balance || 0).toFixed(2) }), 'HTML');
                        return;
                    }

                    conv.amount = amt;
                    if (conv.method === 'Telebirr (Self)' && dbUser.phone) {
                        conv.phone = dbUser.phone;
                        userConvState.delete(userId);

                        await User.updateOne({ id: userId }, { $inc: { win_balance: -amt } });
                        const txnId = 'wdr_' + Date.now();
                        const newTxn = await Transaction.create({
                            id: txnId,
                            type: 'withdrawal',
                            user_id: userId,
                            user_name: user.first_name || 'Unknown',
                            amount: amt,
                            method: conv.method,
                            phone: conv.phone,
                            status: 'pending',
                            created: new Date().toISOString()
                        });
                        notifyAdminTransaction(newTxn);
                        io.to(`user_${userId}`).emit('wallet_updated', {});

                        const successMsg = t('wd_success', { name: user.first_name || 'Player', method: conv.method, amount: amt, phone: conv.phone });
                        await sendTelegramMessage(chatId, successMsg, 'HTML', getBotMainMenu(userLang));

                        for (const adminChatId of ADMIN_IDS) {
                            sendTelegramMessage(adminChatId, `🔔 <b>New Withdraw Request!</b>\nUser: <b>${user.first_name}</b> (<code>${userId}</code>)\nAmount: <b>${amt} ETB</b>\nMethod: ${conv.method}\nPhone: <code>${conv.phone}</code>`).catch(() => {});
                        }
                        return;
                    }

                    conv.step = 'WITHDRAW_PHONE';
                    userConvState.set(userId, conv);
                    await sendTelegramMessage(chatId, t('wd_enter_phone'), 'HTML');
                    return;
                }

                if (conv.step === 'WITHDRAW_PHONE') {
                    const phone = text.trim();
                    if (phone.length < 9) {
                        await sendTelegramMessage(chatId, t('invalid_phone'));
                        return;
                    }

                    const amt = conv.amount;
                    userConvState.delete(userId);

                    await User.updateOne({ id: userId }, { $inc: { win_balance: -amt } });
                    const txnId = 'wdr_' + Date.now();
                    const newTxn = await Transaction.create({
                        id: txnId,
                        type: 'withdrawal',
                        user_id: userId,
                        user_name: user.first_name || 'Unknown',
                        amount: amt,
                        method: conv.method,
                        phone: phone,
                        status: 'pending',
                        created: new Date().toISOString()
                    });
                    notifyAdminTransaction(newTxn);
                    io.to(`user_${userId}`).emit('wallet_updated', {});

                    const successMsg = t('wd_success', { name: user.first_name || 'Player', method: conv.method, amount: amt, phone });
                    await sendTelegramMessage(chatId, successMsg, 'HTML', getBotMainMenu(userLang));

                    for (const adminChatId of ADMIN_IDS) {
                        sendTelegramMessage(adminChatId, `🔔 <b>New Withdraw Request!</b>\nUser: <b>${user.first_name}</b> (<code>${userId}</code>)\nAmount: <b>${amt} ETB</b>\nMethod: ${conv.method}\nPhone: <code>${phone}</code>`).catch(() => {});
                    }
                    return;
                }
            } else {
                userConvState.delete(userId);
            }
        }

        // Start Command
        if (text.startsWith('/start')) {
            const parts = text.split(' ');
            if (parts.length > 1 && parts[1] && parts[1] !== userId) {
                if (!dbUser.phone && !dbUser.referred_by) {
                    dbUser.pending_referrer = parts[1].trim();
                    await dbUser.save();
                } else if (!dbUser.referred_by && dbUser.registered) {
                    const settings = await Settings.findOne({ key: 'payment_accounts' }).lean();
                    const refBonus = (settings && settings.referral_bonus_referrer !== undefined) ? Number(settings.referral_bonus_referrer) : 30;
                    const newBonus = (settings && settings.referral_bonus_referee !== undefined) ? Number(settings.referral_bonus_referee) : 20;

                    dbUser.referred_by = parts[1].trim();
                    if (newBonus > 0) dbUser.play_balance = (dbUser.play_balance || 0) + newBonus;
                    await dbUser.save();
                    if (refBonus > 0) {
                        await User.updateOne({ id: parts[1].trim() }, { $inc: { play_balance: refBonus, referral_balance: refBonus } });
                    }
                    io.to(`user_${parts[1].trim()}`).emit('wallet_updated', {});
                    io.to(`user_${userId}`).emit('wallet_updated', {});
                }
            }

            if (!dbUser.phone) {
                await sendTelegramMessage(chatId, t('register_first'), 'HTML', {
                    keyboard: [[{ text: t('share_contact'), request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                });
                return;
            }

            await sendTelegramMessage(chatId, t('welcome_back'), 'HTML', getBotMainMenu(userLang));
            return;
        }

        // Play Command or Button
        const isPlayBtn = Object.values(BOT_TEXTS).some(d => d.menu_play === text) || text === '/play';
        if (isPlayBtn) {
            if (!dbUser.phone) {
                await sendTelegramMessage(chatId, t('registration_required'), 'HTML', {
                    keyboard: [[{ text: t('share_contact'), request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                });
                return;
            }
            const webAppUrl = `${FRONTEND_URL}?lang=${userLang}`;
            await sendTelegramMessage(chatId, t('play_prompt'), 'HTML', {
                inline_keyboard: [[{ text: t('play_inline_btn'), web_app: { url: webAppUrl } }]]
            });
            return;
        }

        // Deposit Command or Button
        const isDepBtn = Object.values(BOT_TEXTS).some(d => d.menu_deposit === text) || text === '/deposit';
        if (isDepBtn) {
            if (!dbUser.phone) {
                await sendTelegramMessage(chatId, t('registration_required'), 'HTML', {
                    keyboard: [[{ text: t('share_contact'), request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                });
                return;
            }
            await sendTelegramMessage(chatId, t('dep_choose'), 'HTML', {
                inline_keyboard: [[{ text: "📱 TeleBirr", callback_data: "dep_telebirr" }]]
            });
            return;
        }

        // Withdraw Command or Button
        const isWdBtn = Object.values(BOT_TEXTS).some(d => d.menu_withdraw === text) || text === '/withdraw';
        if (isWdBtn) {
            if (!dbUser.phone) {
                await sendTelegramMessage(chatId, t('registration_required'), 'HTML', {
                    keyboard: [[{ text: t('share_contact'), request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                });
                return;
            }
            await sendTelegramMessage(chatId, t('wd_choose'), 'HTML', {
                inline_keyboard: [
                    [{ text: "📱 TeleBirr (Self)", callback_data: "wd_telebirr_self" }],
                    [{ text: "📱 TeleBirr (Other)", callback_data: "wd_telebirr_other" }],
                    [{ text: "🏦 CBE", callback_data: "wd_cbe" }]
                ]
            });
            return;
        }

        // Balance Command or Button
        const isBalBtn = Object.values(BOT_TEXTS).some(d => d.menu_balance === text) || text === '/balance';
        if (isBalBtn) {
            const play = Number(dbUser.play_balance || 0);
            const win = Number(dbUser.win_balance || 0);
            const ref = Number(dbUser.referral_balance || 0);
            const total = play + win + ref;
            const balText = t('bal_msg', {
                play: play.toFixed(2),
                win: win.toFixed(2),
                ref: ref.toFixed(2),
                total: total.toFixed(2)
            });
            await sendTelegramMessage(chatId, balText, 'HTML');
            return;
        }

        // Invite Command or Button
        const isInviteBtn = Object.values(BOT_TEXTS).some(d => d.menu_invite === text) || text === '/invite';
        if (isInviteBtn) {
            const settings = await Settings.findOne({ key: 'payment_accounts' }).lean();
            const refBonus = (settings && settings.referral_bonus_referrer !== undefined) ? Number(settings.referral_bonus_referrer) : 30;
            const newBonus = (settings && settings.referral_bonus_referee !== undefined) ? Number(settings.referral_bonus_referee) : 20;
            await sendTelegramMessage(chatId, t('invite_msg', { id: userId, ref_bonus: refBonus, new_bonus: newBonus }), 'HTML');
            return;
        }

        // Support Command or Button
        const isSupportBtn = Object.values(BOT_TEXTS).some(d => d.menu_support === text) || text === '/support';
        if (isSupportBtn) {
            await sendTelegramMessage(chatId, t('support_msg'), 'HTML');
            return;
        }

        // Help Command or Button
        const isHelpBtn = Object.values(BOT_TEXTS).some(d => d.menu_help === text) || text === '/help';
        if (isHelpBtn) {
            await sendTelegramMessage(chatId, t('help_msg'), 'HTML');
            return;
        }

        // Rank Button & /rank Command (Only Top 3 Winners on Bot)
        const isRankBtn = Object.values(BOT_TEXTS).some(d => d.menu_rank === text) || text === '/rank';
        if (isRankBtn) {
            const top3 = await User.find({ win_balance: { $gt: 0 } }).sort({ win_balance: -1 }).limit(3).select({ name: 1, win_balance: 1, _id: 0 }).lean();
            const medals = ['🥇', '🥈', '🥉'];
            let rankText = `🏆 <b>የከፍተኛ አሸናፊዎች ደረጃ (Top 3 Winners)</b>\n\n`;
            if (top3 && top3.length > 0) {
                top3.forEach((u, idx) => {
                    rankText += `${medals[idx] || (idx + 1) + '.'} <b>${u.name || 'Player'}</b> — <code>${Number(u.win_balance || 0).toFixed(2)} ETB</code>\n`;
                });
            } else {
                rankText += `<i>ገና ምንም አሸናፊዎች አልተመዘገቡም።</i>\n`;
            }
            rankText += `\n🎯 <i>እርስዎም አሁኑኑ ተጫውተው ከፍተኛ አሸናፊ ይሁኑ!</i>`;
            const playUrl = `${FRONTEND_URL}?lang=${userLang}`;
            await sendTelegramMessage(chatId, rankText, 'HTML', {
                inline_keyboard: [[{ text: "🎮 አሁኑኑ ተጫወት (Play Now)", web_app: { url: playUrl } }]]
            });
            return;
        }

        // History Button
        const isHistoryBtn = Object.values(BOT_TEXTS).some(d => d.menu_history === text);
        if (isHistoryBtn) {
            const historyUrl = `${FRONTEND_URL}?page=history&lang=${userLang}`;
            await sendTelegramMessage(chatId, t('history_msg'), 'HTML', {
                inline_keyboard: [[{ text: "📜 Open History", web_app: { url: historyUrl } }]]
            });
            return;
        }

        // Register Button
        const isRegBtn = Object.values(BOT_TEXTS).some(d => d.menu_register === text);
        if (isRegBtn) {
            if (dbUser.phone) {
                await sendTelegramMessage(chatId, t('already_registered'), 'HTML', getBotMainMenu(userLang));
            } else {
                await sendTelegramMessage(chatId, t('register_first'), 'HTML', {
                    keyboard: [[{ text: t('share_contact'), request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                });
            }
            return;
        }

        // Language Command or Button
        const isLangBtn = Object.values(BOT_TEXTS).some(d => d.menu_lang === text) || text === '/lang';
        if (isLangBtn) {
            await sendTelegramMessage(chatId, t('lang_choose'), 'HTML', {
                inline_keyboard: [
                    [{ text: "🇪🇹 አማርኛ", callback_data: "lang_am" }],
                    [{ text: "🇪🇹 ትግርኛ", callback_data: "lang_ti" }],
                    [{ text: "🇺🇸 English", callback_data: "lang_en" }],
                    [{ text: "🇪🇹 Afaan Oromoo", callback_data: "lang_om" }]
                ]
            });
            return;
        }

        // Rules Button
        const isRulesBtn = Object.values(BOT_TEXTS).some(d => d.menu_rules === text);
        if (isRulesBtn) {
            await sendTelegramMessage(chatId, t('rules_msg'), 'HTML');
            return;
        }
    }
}

// ─── Telegram Webhook Endpoint ───
app.post('/telegram-webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        if (req.body && (req.body.message || req.body.callback_query)) {
            await handleTelegramUpdate(req.body);
        }
    } catch (err) {
        console.error('❌ Error handling Telegram webhook:', err);
    }
});

// Fallback polling runner (only used when running locally or explicit polling mode)
let isPollingRunning = false;
async function startBotPollingFallback() {
    if (isPollingRunning || !BOT_TOKEN) return;
    isPollingRunning = true;
    console.log('🤖 Telegram Bot running in local polling fallback mode...');
    let offset = 0;
    while (isPollingRunning) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25`);
            const data = await res.json();
            if (data.ok && Array.isArray(data.result)) {
                for (const update of data.result) {
                    offset = update.update_id + 1;
                    await handleTelegramUpdate(update);
                }
            } else {
                await new Promise(r => setTimeout(r, 3000));
            }
        } catch (e) {
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

// ─── Card Logic & Deterministic Generation ───
function mulberry32(a) { return function() { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const cardCache = new Map();
function getCardCols(cardNum) {
    if (cardCache.has(cardNum)) return cardCache.get(cardNum);
    const cols = [[], [], [], [], []]; const seedBase = cardNum * 100;
    for (let c = 0; c < 5; c++) {
        const min = c * 15 + 1, max = c * 15 + 15; const avail = [];
        for (let n = min; n <= max; n++) avail.push(n);
        const seed = seedBase + c; const rand = mulberry32(seed);
        for (let i = avail.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [avail[i], avail[j]] = [avail[j], avail[i]]; }
        cols[c] = avail.slice(0, 5); 
    }
    cols[2][2] = 'FREE'; cardCache.set(cardNum, cols); return cols;
}

function checkWinningLine(cardNum, calledNumbers) {
    const n = Number(cardNum); if (!Number.isFinite(n) || n < 1 || calledNumbers.length === 0) return null;
    const cols = getCardCols(n); const calledSet = new Set(calledNumbers); const m = [];
    for (let r = 0; r < 5; r++) { const row = []; for (let c = 0; c < 5; c++) { const val = cols[c][r]; row.push(val === 'FREE' || calledSet.has(val)); } m.push(row); }
    for (let r = 0; r < 5; r++) if (m[r].every(v => v)) return { type: 'row', index: r, desc: 'Row ' + (r + 1), winningNumbers: [cols[0][r], cols[1][r], cols[2][r], cols[3][r], cols[4][r]] };
    for (let c = 0; c < 5; c++) if (m.every(row => row[c])) return { type: 'col', index: c, desc: 'Col ' + (c + 1), winningNumbers: [cols[c][0], cols[c][1], cols[c][2], cols[c][3], cols[c][4]] };
    let d1 = true; for (let i = 0; i < 5; i++) if (!m[i][i]) { d1 = false; break; }
    if (d1) return { type: 'diag1', desc: 'Diag 1', winningNumbers: [cols[0][0], cols[1][1], cols[2][2], cols[3][3], cols[4][4]] };
    let d2 = true; for (let i = 0; i < 5; i++) if (!m[i][4 - i]) { d2 = false; break; }
    if (d2) return { type: 'diag2', desc: 'Diag 2', winningNumbers: [cols[0][4], cols[1][3], cols[2][2], cols[3][1], cols[4][0]] };
    if (m[0][0] && m[0][4] && m[4][0] && m[4][4]) return { type: 'corners', desc: '4 Corners', winningNumbers: [cols[0][0], cols[4][0], cols[0][4], cols[4][4]] };
    return null;
}

// Proximity / Near-win calculation (1-To-Go / 2-To-Go)
function getCardDistance(cardNum, calledNumbers) {
    const n = Number(cardNum); if (!Number.isFinite(n) || n < 1) return 5;
    const cols = getCardCols(n); const calledSet = new Set(calledNumbers);
    let minNeeded = 5;

    // Check rows
    for (let r = 0; r < 5; r++) {
        let needed = 0;
        for (let c = 0; c < 5; c++) {
            const val = cols[c][r];
            if (val !== 'FREE' && !calledSet.has(val)) needed++;
        }
        if (needed < minNeeded) minNeeded = needed;
    }
    // Check columns
    for (let c = 0; c < 5; c++) {
        let needed = 0;
        for (let r = 0; r < 5; r++) {
            const val = cols[c][r];
            if (val !== 'FREE' && !calledSet.has(val)) needed++;
        }
        if (needed < minNeeded) minNeeded = needed;
    }
    // Diag 1
    let neededD1 = 0;
    for (let i = 0; i < 5; i++) {
        const val = cols[i][i];
        if (val !== 'FREE' && !calledSet.has(val)) neededD1++;
    }
    if (neededD1 < minNeeded) minNeeded = neededD1;
    // Diag 2
    let neededD2 = 0;
    for (let i = 0; i < 5; i++) {
        const val = cols[i][4 - i];
        if (val !== 'FREE' && !calledSet.has(val)) neededD2++;
    }
    if (neededD2 < minNeeded) minNeeded = neededD2;
    // 4 Corners
    let neededCorners = 0;
    const corners = [cols[0][0], cols[4][0], cols[0][4], cols[4][4]];
    corners.forEach(val => { if (val !== 'FREE' && !calledSet.has(val)) neededCorners++; });
    if (neededCorners < minNeeded) minNeeded = neededCorners;

    return minNeeded;
}

// ─── Room Configuration (Classic 10 ETB Only) ───
const ROOM_DEFINITIONS = {
    'classic_10': {
        id: 'classic_10',
        name: 'Classic Bingo',
        badge: '10 ETB',
        cardPrice: 10,
        derashPerCard: 8,
        maxCards: 1000,
        countdownTime: 40,
        callInterval: 5,
        targetBots: 40,
        minCardsToStart: 2,
        color: '#3b82f6'
    }
};

const rooms = {};

function initRoom(def) {
    return {
        id: def.id,
        name: def.name,
        badge: def.badge,
        color: def.color,
        cardPrice: def.cardPrice,
        derashPerCard: def.derashPerCard,
        phase: 'waiting',
        currentCall: null,
        calledNumbers: [],
        takenCards: {},
        isAutoOn: true,
        isRunning: true,
        isForceWinActive: false,
        lastBotWinnerName: null,
        lastBotWinnerId: null,
        targetForceWinCard: null,
        targetForceWinCallCount: null,
        settings: {
            callInterval: def.callInterval,
            maxCards: def.maxCards,
            countdownTime: def.countdownTime,
            botEnabled: true,
            visualPlayers: def.visualPlayers,
            botCount: def.targetBots,
            botWinRate: 100,
            botNames: []
        },
        numberToCardsMap: {},
        gameTimerInterval: null,
        callInterval: null,
        autoRestartTimer: null,
        botSpawnInterval: null,
        botSpawnTimer: null,
        remainingTime: def.countdownTime,
        roundWinners: [],
        isEndingRound: false
    };
}

// ─── Room Bot Card Spawner (Gradual & Sequential Selection During Countdown) ───
function spawnBotCards(room, count, fullSync = false) {
    if (!room.settings.botEnabled || count <= 0) return 0;

    const botCardNums = [];
    for (const [cardStr, cardData] of Object.entries(room.takenCards)) {
        if (cardData.isBot) botCardNums.push(Number(cardStr));
    }

    const baseNames = (room.settings.botNames && room.settings.botNames.length > 0)
        ? room.settings.botNames
        : [
            "Abebe", "Kebede", "Sara", "Dawit", "Almaz", "Yonas", "Selam", "Mahlet", "Meron", 
            "Samuel", "Tigist", "Bruk", "Hiwot", "Nahom", "Ephrem", "Kalkidan", "Getachew", 
            "Aster", "Mulu", "Frehiwot", "Eyob", "Tewodros", "Mekdes", "Tsegaye", "Mariam",
            "Sara", "Ruth", "Dagmawi", "Meseret", "Tesfaye", "Gidey", "Hagos", "Kidane", "Tirhas",
            "Rahel", "Mihret", "Bereket", "Eyerusalem", "Girma", "Hanna", "Abdul", "Fatuma", "Ahmed"
        ];

    const maxC = room.settings.maxCards || 1000;
    const availableCards = [];
    for (let i = 1; i <= maxC; i++) {
        if (!room.takenCards[i]) availableCards.push(i);
    }
    if (availableCards.length === 0) return 0;

    // Shuffle available cards so bots pick random cartelas across the board
    for (let i = availableCards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [availableCards[i], availableCards[j]] = [availableCards[j], availableCards[i]];
    }

    const toAdd = Math.min(count, availableCards.length);
    const addedCardNums = [];
    for (let i = 0; i < toAdd; i++) {
        const cardNum = availableCards[i];
        const botIdx = botCardNums.length + i;
        let botName = baseNames[botIdx % baseNames.length];
        if (botIdx >= baseNames.length) botName += ` ${Math.floor(botIdx / baseNames.length) + 1}`;
        const botId = `bot_${Date.now()}_${botIdx}_${cardNum}`;

        room.takenCards[cardNum] = {
            userId: botId,
            userName: botName,
            isBot: true,
            botName: botName
        };

        const cardCols = getCardCols(cardNum);
        cardCols.forEach(col => {
            col.forEach(num => {
                if (num !== 'FREE') {
                    if (!room.numberToCardsMap[num]) room.numberToCardsMap[num] = new Set();
                    room.numberToCardsMap[num].add(cardNum);
                }
            });
        });
        addedCardNums.push(cardNum);
    }

    const realCardsCount = Object.values(room.takenCards).filter(c => !c.isBot).length;
    const botsCount = Object.values(room.takenCards).filter(c => c.isBot).length;
    const totalActualCards = realCardsCount + botsCount;
    const totalPlayersDisplay = totalActualCards;
    const derash = totalActualCards * room.derashPerCard;

    if (fullSync) {
        emitRoom(room.id, 'sync_taken_cards', {
            roomId: room.id,
            takenCards: Object.keys(room.takenCards).map(Number),
            totalPlayers: totalPlayersDisplay,
            totalCards: totalActualCards,
            derash: derash
        });
    } else {
        // High-efficiency delta update: transmits tiny lightweight payload instead of 350-1000 array!
        emitRoom(room.id, 'sync_card_picked', {
            roomId: room.id,
            addedCards: addedCardNums,
            totalPlayers: totalPlayersDisplay,
            totalCards: totalActualCards,
            derash: derash
        });
    }

    return toAdd;
}

function scheduleNextBotPick(room) {
    if (!room.isRunning || (room.phase !== 'countdown' && room.phase !== 'waiting')) {
        if (room.botSpawnTimer) { clearTimeout(room.botSpawnTimer); room.botSpawnTimer = null; }
        return;
    }
    if (!room.settings.botEnabled) return;

    const targetBots = Math.max(0, Number(room.settings.botCount !== undefined ? room.settings.botCount : 40));
    const currentBots = Object.values(room.takenCards).filter(c => c.isBot).length;
    const needed = targetBots - currentBots;

    if (needed <= 0) {
        if (room.botSpawnTimer) { clearTimeout(room.botSpawnTimer); room.botSpawnTimer = null; }
        return;
    }

    const timeLeft = Math.max(1, room.remainingTime || 1);
    // Pacing evenly over remaining countdown with natural human-like jitter
    const idealInterval = Math.max(200, Math.min(2200, Math.floor((timeLeft * 1000) / needed)));
    const jitter = Math.floor((Math.random() - 0.5) * (idealInterval * 0.4));
    const delay = Math.max(150, idealInterval + jitter);

    if (room.botSpawnTimer) clearTimeout(room.botSpawnTimer);

    room.botSpawnTimer = setTimeout(() => {
        if (!room.isRunning || (room.phase !== 'countdown' && room.phase !== 'waiting')) return;

        const curr = Object.values(room.takenCards).filter(c => c.isBot).length;
        const target = Math.max(0, Number(room.settings.botCount !== undefined ? room.settings.botCount : 40));
        const stillNeeded = target - curr;

        if (stillNeeded > 0) {
            const remSecs = Math.max(1, room.remainingTime || 1);
            let batch = 1;
            if (remSecs <= 2) {
                batch = stillNeeded; // Complete remaining bots in final 2 seconds before calling starts
            } else if (stillNeeded > remSecs * 2) {
                batch = Math.min(3, Math.ceil(stillNeeded / remSecs));
            }
            spawnBotCards(room, batch);
        }

        if (room.phase === 'countdown' || room.phase === 'waiting') {
            scheduleNextBotPick(room);
        }
    }, delay);
}

function allocateRoomBots(room, count) {
    if (!room.settings.botEnabled) return;
    const targetBots = Math.max(0, Number(count !== undefined ? count : (room.settings.botCount || 0)));
    room.settings.botCount = targetBots;

    // Find current bot cards in this room
    const botCardNums = [];
    for (const [cardStr, cardData] of Object.entries(room.takenCards)) {
        if (cardData.isBot) botCardNums.push(Number(cardStr));
    }

    // If we have more bot cards than targetBots, remove excess (leaving real players completely untouched)
    if (botCardNums.length > targetBots) {
        const toRemove = botCardNums.slice(targetBots);
        toRemove.forEach(cn => {
            delete room.takenCards[cn];
            if (room.numberToCardsMap) {
                Object.keys(room.numberToCardsMap).forEach(num => room.numberToCardsMap[num]?.delete(cn));
            }
        });

        const realCardsCount = Object.values(room.takenCards).filter(c => !c.isBot).length;
        const botsCount = Object.values(room.takenCards).filter(c => c.isBot).length;
        const totalActualCards = realCardsCount + botsCount;
        const derash = totalActualCards * room.derashPerCard;

        emitRoom(room.id, 'sync_taken_cards', {
            roomId: room.id,
            takenCards: Object.keys(room.takenCards).map(Number),
            totalPlayers: totalActualCards,
            totalCards: totalActualCards,
            derash: derash
        });
    } else if (botCardNums.length < targetBots) {
        // If in countdown or waiting, schedule gradual sequential selection until countdown finishes
        if (room.phase === 'countdown' || room.phase === 'waiting') {
            scheduleNextBotPick(room);
        }
    }
}

function startRoomBotSpawning(room) {
    if (room.botSpawnTimer) { clearTimeout(room.botSpawnTimer); room.botSpawnTimer = null; }
    if (room.botSpawnInterval) { clearInterval(room.botSpawnInterval); room.botSpawnInterval = null; }
    if (!room.settings.botEnabled) return;
    scheduleNextBotPick(room);
}

function getNextNumberToCall(room) {
    const calledSet = new Set(room.calledNumbers || []);
    const lastNum = room.currentCall;
    const lastColIdx = (lastNum && lastNum >= 1 && lastNum <= 75) ? Math.min(4, Math.floor((lastNum - 1) / 15)) : -1;

    // Helper: list of uncalled numbers
    const uncalledNumbers = [];
    for (let i = 1; i <= 75; i++) {
        if (!calledSet.has(i)) uncalledNumbers.push(i);
    }
    if (uncalledNumbers.length === 0) return Math.floor(Math.random() * 75) + 1;

    // Helper: check if calling a specific number would cause ANY real player to win
    const wouldNumberCauseRealWin = (num) => {
        const potentialCards = room.numberToCardsMap[num];
        if (!potentialCards || potentialCards.size === 0) return false;
        const testCalled = [...(room.calledNumbers || []), num];
        for (const cardNum of potentialCards) {
            const cardData = room.takenCards[cardNum];
            if (cardData && !cardData.isBot) {
                if (checkWinningLine(cardNum, testCalled)) return true;
            }
        }
        return false;
    };

    // Helper: check if calling a specific number would complete a win for a card
    const doesNumberWinCard = (cardNum, num) => {
        const testCalled = [...(room.calledNumbers || []), num];
        return !!checkWinningLine(cardNum, testCalled);
    };

    // Check if force win is active and there are bot cards
    if (room.isForceWinActive) {
        const allBotCards = [];
        for (const [cardNum, data] of Object.entries(room.takenCards)) {
            if (data.isBot) {
                allBotCards.push({
                    cardNum: Number(cardNum),
                    botName: data.botName || data.userName || 'Bot',
                    userId: data.userId
                });
            }
        }

        if (allBotCards.length > 0) {
            // NEVER make the same ghost player win consecutively:
            let eligibleBots = allBotCards.filter(b => b.botName !== room.lastBotWinnerName);
            if (eligibleBots.length === 0) eligibleBots = allBotCards; // Fallback if only 1 bot exists

            // Pick or preserve target bot card and realistic call count for this round
            if (!room.targetForceWinCard || !room.takenCards[room.targetForceWinCard] ||
                (eligibleBots.length > 1 && room.takenCards[room.targetForceWinCard]?.botName === room.lastBotWinnerName)) {
                const picked = eligibleBots[Math.floor(Math.random() * eligibleBots.length)];
                room.targetForceWinCard = picked.cardNum;
                // Randomized realistic call counts: 7, 8, 9, 10, 11, 12, 13, 14, 15
                const realisticCounts = [7, 8, 9, 10, 11, 12, 13, 14, 15];
                room.targetForceWinCallCount = realisticCounts[Math.floor(Math.random() * realisticCounts.length)];
            }

            const targetCardNum = room.targetForceWinCard;
            const targetCalls = room.targetForceWinCallCount || 10;
            const currentCalls = (room.calledNumbers || []).length;
            const targetCols = getCardCols(targetCardNum);

            // Find all lines on the target bot card
            const targetLines = [];
            // Rows
            for (let r = 0; r < 5; r++) {
                const nums = [targetCols[0][r], targetCols[1][r], targetCols[2][r], targetCols[3][r], targetCols[4][r]].filter(n => n !== 'FREE');
                const uncalled = nums.filter(n => !calledSet.has(n));
                targetLines.push({ type: 'row', uncalled, needed: uncalled.length, allNums: nums });
            }
            // Diagonals
            const d1 = [targetCols[0][0], targetCols[1][1], targetCols[2][2], targetCols[3][3], targetCols[4][4]].filter(n => n !== 'FREE');
            targetLines.push({ type: 'diag', uncalled: d1.filter(n => !calledSet.has(n)), needed: d1.filter(n => !calledSet.has(n)).length, allNums: d1 });
            const d2 = [targetCols[0][4], targetCols[1][3], targetCols[2][2], targetCols[3][1], targetCols[4][0]].filter(n => n !== 'FREE');
            targetLines.push({ type: 'diag', uncalled: d2.filter(n => !calledSet.has(n)), needed: d2.filter(n => !calledSet.has(n)).length, allNums: d2 });
            // 4 Corners
            const corners = [targetCols[0][0], targetCols[4][0], targetCols[0][4], targetCols[4][4]];
            targetLines.push({ type: 'corners', uncalled: corners.filter(n => !calledSet.has(n)), needed: corners.filter(n => !calledSet.has(n)).length, allNums: corners });
            // Columns
            for (let c = 0; c < 5; c++) {
                const colNums = targetCols[c].filter(n => n !== 'FREE');
                const uncalled = colNums.filter(n => !calledSet.has(n));
                targetLines.push({ type: 'col', uncalled, needed: uncalled.length, allNums: colNums });
            }

            // Filter lines with uncalled numbers, sorted by fewest needed to win
            const activeLines = targetLines.filter(l => l.needed > 0).sort((a, b) => a.needed - b.needed);
            const bestLine = activeLines[0];

            if (bestLine) {
                // If we have reached or exceeded target calls, TRIGGER THE BOT BINGO WIN!
                if (currentCalls >= targetCalls) {
                    let candidates = bestLine.uncalled;
                    const diffCol = candidates.filter(n => Math.floor((n - 1) / 15) !== lastColIdx);
                    if (diffCol.length > 0) candidates = diffCol;
                    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
                    if (chosen) return chosen;
                }

                // If currentCalls < targetCalls, we PACE the game naturally so it does NOT win early on call 4:
                if (bestLine.needed === 1) {
                    // Line is 1 away from BINGO! Hold off on calling this final number until currentCalls >= targetCalls
                    const winningNumber = bestLine.uncalled[0];

                    // Candidate numbers on this bot card that do NOT trigger a win
                    const otherBotNumbers = [];
                    for (let c = 0; c < 5; c++) {
                        for (let r = 0; r < 5; r++) {
                            const val = targetCols[c][r];
                            if (val !== 'FREE' && !calledSet.has(val) && val !== winningNumber) {
                                if (!doesNumberWinCard(targetCardNum, val) && !wouldNumberCauseRealWin(val)) {
                                    otherBotNumbers.push(val);
                                }
                            }
                        }
                    }

                    // Safe filler numbers across all columns that won't trigger real player or bot win
                    const safeFiller = uncalledNumbers.filter(n => n !== winningNumber && !wouldNumberCauseRealWin(n) && !doesNumberWinCard(targetCardNum, n));

                    let pool = otherBotNumbers.length > 0 && Math.random() < 0.6 ? otherBotNumbers : safeFiller;
                    if (pool.length === 0) pool = safeFiller.length > 0 ? safeFiller : uncalledNumbers;

                    const diffColPool = pool.filter(n => Math.floor((n - 1) / 15) !== lastColIdx);
                    const finalPool = diffColPool.length > 0 ? diffColPool : pool;
                    return finalPool[Math.floor(Math.random() * finalPool.length)];
                } else {
                    // bestLine.needed > 1 (e.g. 2, 3, or 4 needed)
                    // With ~65% probability, call a number from the line to advance it toward 1-to-go
                    const shouldAdvance = Math.random() < 0.65;
                    if (shouldAdvance) {
                        let candidates = bestLine.uncalled.filter(n => !wouldNumberCauseRealWin(n));
                        const diffCol = candidates.filter(n => Math.floor((n - 1) / 15) !== lastColIdx);
                        const advancePool = diffCol.length > 0 ? diffCol : candidates;
                        if (advancePool.length > 0) {
                            return advancePool[Math.floor(Math.random() * advancePool.length)];
                        }
                    }

                    // Otherwise call a safe filler number across mixed columns
                    const safeFiller = uncalledNumbers.filter(n => !wouldNumberCauseRealWin(n));
                    const diffCol = safeFiller.filter(n => Math.floor((n - 1) / 15) !== lastColIdx);
                    const pool = diffCol.length > 0 ? diffCol : (safeFiller.length > 0 ? safeFiller : uncalledNumbers);
                    return pool[Math.floor(Math.random() * pool.length)];
                }
            }
        }
    }

    // Default natural calling with column rotation
    const diffColUncalled = uncalledNumbers.filter(n => Math.floor((n - 1) / 15) !== lastColIdx);
    const pool = diffColUncalled.length > 0 ? diffColUncalled : uncalledNumbers;

    return pool[Math.floor(Math.random() * pool.length)];
}

function emitRoom(roomId, event, data) {
    const payload = { ...data, roomId };
    io.to(`room_${roomId}`).emit(event, payload);
    // Broadcast directly to admin stream so admin panel is always 100% synced in real time
    io.to('admin_stream').emit(event, payload);
}

async function checkForAutoWinner(room, newNumber) {
    if (room.isEndingRound || room.phase !== 'calling') return false;
    const potentialCards = room.numberToCardsMap[newNumber];
    if (!potentialCards || potentialCards.size === 0) return false;

    let potentialWinners = [];
    for (const cardNum of potentialCards) {
        const data = room.takenCards[cardNum];
        if (!data) continue;
        const win = checkWinningLine(cardNum, room.calledNumbers);
        if (win) {
            if (data.isBot) {
                const chance = Math.random() * 100;
                if (chance > room.settings.botWinRate) continue;
            }
            potentialWinners.push({
                cardNum: Number(cardNum),
                userId: data.userId,
                isBot: !!data.isBot,
                name: data.isBot ? data.botName : null,
                win
            });
        }
    }

    if (potentialWinners.length === 0) return false;

    const realUserIds = [...new Set(potentialWinners.filter(p => !p.isBot).map(p => p.userId))];
    const users = await User.find({ id: { $in: realUserIds } }, { id: 1, name: 1 }).lean();
    const userMap = new Map(users.map(u => [u.id, u.name]));

    room.roundWinners = potentialWinners.map(p => ({
        id: p.userId,
        name: p.isBot ? p.name : (p.name || userMap.get(p.userId) || 'Player'),
        cardNum: p.cardNum,
        isBot: p.isBot,
        winDesc: p.win.desc,
        winType: p.win.type,
        winIndex: p.win.index,
        winningNumbers: p.win.winningNumbers || [],
        allLines: [p.win]
    }));

    room.isEndingRound = true;
    room.phase = 'claiming';
    if (room.callInterval) { clearInterval(room.callInterval); room.callInterval = null; }
    if (room.gameTimerInterval) { clearInterval(room.gameTimerInterval); room.gameTimerInterval = null; }
    return true;
}

function startRoomRound(room) {
    if (!room.isRunning) return;
    if (room.gameTimerInterval) clearInterval(room.gameTimerInterval);
    if (room.callInterval) clearInterval(room.callInterval);
    if (room.autoRestartTimer) clearTimeout(room.autoRestartTimer);
    if (room.botSpawnInterval) clearInterval(room.botSpawnInterval);
    if (room.botSpawnTimer) clearTimeout(room.botSpawnTimer);

    room.phase = 'countdown';
    room.currentCall = null;
    room.calledNumbers = [];
    room.roundWinners = [];
    room.isEndingRound = false;
    room.targetForceWinCard = null;
    room.targetForceWinCallCount = null;
    room.remainingTime = room.settings.countdownTime || 40;
    const countdownDuration = room.remainingTime;
    const endsAt = Date.now() + (countdownDuration * 1000);

    // Broadcast phase change with synchronized target timestamp for local client countdown
    emitRoom(room.id, 'phase_change', {
        roomId: room.id,
        phase: 'countdown',
        duration: countdownDuration,
        endsAt: endsAt,
        remainingTime: room.remainingTime
    });
    emitRoom(room.id, 'timer_tick', { roomId: room.id, remaining: room.remainingTime, endsAt });

    startRoomBotSpawning(room);

    room.gameTimerInterval = setInterval(() => {
        if (!room.isRunning) return;
        room.remainingTime--;

        // Throttled WebSocket timer: emit every 5s or during final 5s to save 85% bandwidth
        if (room.remainingTime % 5 === 0 || room.remainingTime <= 5) {
            emitRoom(room.id, 'timer_tick', { roomId: room.id, remaining: room.remainingTime, endsAt });
        }

        if (room.remainingTime <= 0) {
            // Countdown ended: allocate any remaining bots up to target count immediately
            if (room.botSpawnTimer) { clearTimeout(room.botSpawnTimer); room.botSpawnTimer = null; }
            if (room.botSpawnInterval) { clearInterval(room.botSpawnInterval); room.botSpawnInterval = null; }
            const targetBots = Math.max(0, Number(room.settings.botCount !== undefined ? room.settings.botCount : 40));
            const currentBots = Object.values(room.takenCards).filter(c => c.isBot).length;
            if (room.settings.botEnabled && currentBots < targetBots) {
                spawnBotCards(room, targetBots - currentBots, true);
            } else {
                // Authoritative full sync before calling begins
                const realCardsCount = Object.values(room.takenCards).filter(c => !c.isBot).length;
                const botsCount = Object.values(room.takenCards).filter(c => c.isBot).length;
                const totalActualCards = realCardsCount + botsCount;
                emitRoom(room.id, 'sync_taken_cards', {
                    roomId: room.id,
                    takenCards: Object.keys(room.takenCards).map(Number),
                    totalPlayers: totalActualCards,
                    totalCards: totalActualCards,
                    derash: totalActualCards * room.derashPerCard
                });
            }

            const totalCards = Object.keys(room.takenCards).length;
            if (totalCards < (room.minCardsToStart || 2)) {
                room.remainingTime = room.settings.countdownTime || 40;
                emitRoom(room.id, 'timer_tick', { roomId: room.id, remaining: room.remainingTime });
                emitRoom(room.id, 'game_status_msg', { message: 'ቢያንስ 2 ካርቴላ ያስፈልጋል! ሰዓቱ እንደገና ተጀምሯል።' });
                scheduleNextBotPick(room);
                return;
            }

            clearInterval(room.gameTimerInterval);
            room.gameTimerInterval = null;
            room.phase = 'calling';
            emitRoom(room.id, 'phase_change', { roomId: room.id, phase: 'calling' });

            if (room.isAutoOn) {
                room.callInterval = setInterval(async () => {
                    if (room.phase !== 'calling' || room.isEndingRound) return;
                    if (room.calledNumbers.length >= 75) {
                        clearInterval(room.callInterval);
                        room.callInterval = null;
                        endRoomRound(room, []);
                        return;
                    }

                    let num = getNextNumberToCall(room);
                    room.calledNumbers.push(num);
                    room.currentCall = num;

                    emitRoom(room.id, 'new_number_called', {
                        roomId: room.id,
                        number: num,
                        callCount: room.calledNumbers.length,
                        allCalled: room.calledNumbers
                    });

                    // Broadcast card distance updates to all connected players with active cards
                    broadcastPlayerDistances(room);

                    const winnerFound = await checkForAutoWinner(room, num);
                    if (winnerFound) {
                        clearInterval(room.callInterval);
                        room.callInterval = null;
                        await endRoomRound(room, room.roundWinners);
                    }
                }, room.settings.callInterval * 1000);
            }
        }
    }, 1000);
}

function broadcastPlayerDistances(room) {
    // For each user with cards in this room, compute minimum distance and notify them
    const userCardsMap = {};
    for (const [cardStr, cardData] of Object.entries(room.takenCards)) {
        if (!cardData.isBot && cardData.userId) {
            if (!userCardsMap[cardData.userId]) userCardsMap[cardData.userId] = [];
            userCardsMap[cardData.userId].push(Number(cardStr));
        }
    }

    for (const [userId, cards] of Object.entries(userCardsMap)) {
        const cardDistances = cards.map(c => ({
            cardNum: c,
            distance: getCardDistance(c, room.calledNumbers)
        }));
        const bestDistance = Math.min(...cardDistances.map(cd => cd.distance));
        io.to(`user_${userId}`).emit('my_cards_distance', {
            roomId: room.id,
            bestDistance,
            cards: cardDistances
        });
    }
}

async function endRoomRound(room, winnersData) {
    if (room.phase === 'gameover') return;
    room.isEndingRound = true;
    room.phase = 'gameover';

    if (room.gameTimerInterval) { clearInterval(room.gameTimerInterval); room.gameTimerInterval = null; }
    if (room.callInterval) { clearInterval(room.callInterval); room.callInterval = null; }
    if (room.botSpawnInterval) { clearInterval(room.botSpawnInterval); room.botSpawnInterval = null; }
    if (room.botSpawnTimer) { clearTimeout(room.botSpawnTimer); room.botSpawnTimer = null; }

    try {
        const realPlayers = [...new Set(Object.values(room.takenCards).filter(c => !c.isBot).map(c => c.userId))];
        const totalCards = Object.keys(room.takenCards).length;
        const totalPrize = totalCards * room.derashPerCard;

        const promises = [];
        if (realPlayers.length > 0) {
            promises.push(User.updateMany({ id: { $in: realPlayers } }, { $inc: { total_games: 1 } }));
        }

        if (!winnersData || winnersData.length === 0) {
            await Promise.all(promises);
            emitRoom(room.id, 'reset_game', { roomId: room.id });
            room.autoRestartTimer = setTimeout(() => {
                room.takenCards = {};
                room.numberToCardsMap = {};
                room.phase = 'waiting';
                room.calledNumbers = [];
                room.currentCall = null;
                room.roundWinners = [];
                room.isEndingRound = false;
                if (room.isRunning) startRoomRound(room);
            }, 3000);
            return;
        }

        const realWinners = winnersData.filter(w => !w.isBot);
        // Multi-winner support: Divide total derash amount equally by the number of winners
        const prizePerWinner = Math.floor(totalPrize / winnersData.length);

        if (realWinners.length > 0) {
            const userWinningCards = {};
            for (const w of realWinners) {
                userWinningCards[w.id] = (userWinningCards[w.id] || 0) + 1;
            }
            for (const [uId, count] of Object.entries(userWinningCards)) {
                promises.push(User.updateOne(
                    { id: String(uId) },
                    { $inc: { win_balance: prizePerWinner * count, total_wins: count } }
                ));
            }
        }

        promises.push(GameHistory.create({
            gameId: 'game_' + room.id + '_' + Date.now(),
            roomId: room.id,
            winners: winnersData.map(w => ({
                id: w.id,
                name: w.name,
                cardNum: w.cardNum,
                prize: prizePerWinner,
                isJackpot: false
            })),
            totalPrize: totalPrize,
            jackpotWon: 0,
            totalPlayers: totalCards,
            calledNumbers: room.calledNumbers
        }));

        await Promise.all(promises);

        for (const w of realWinners) {
            io.to(`user_${w.id}`).emit('wallet_updated', {});
        }

        const lastCall = room.calledNumbers[room.calledNumbers.length - 1];

        // Track last bot winner to prevent consecutive wins by the same bot
        const botWinner = winnersData.find(w => w.isBot);
        if (botWinner) {
            room.lastBotWinnerName = botWinner.name;
            room.lastBotWinnerId = botWinner.id;
        }
        room.targetForceWinCard = null;
        room.targetForceWinCallCount = null;

        emitRoom(room.id, 'game_over', {
            roomId: room.id,
            reason: 'bingo',
            winners: winnersData.map(w => ({
                id: w.id,
                name: w.name,
                cardNum: w.cardNum,
                prize: prizePerWinner,
                winDesc: w.winDesc,
                winType: w.winType,
                winIndex: w.winIndex,
                winningNumbers: w.winningNumbers || [],
                isBot: w.isBot
            })),
            totalPrize,
            prizePerWinner,
            lastCall,
            calledNumbers: room.calledNumbers
        });

        room.autoRestartTimer = setTimeout(() => {
            room.takenCards = {};
            room.numberToCardsMap = {};
            room.phase = 'waiting';
            room.calledNumbers = [];
            room.currentCall = null;
            room.roundWinners = [];
            room.isEndingRound = false;
            emitRoom(room.id, 'reset_game', { roomId: room.id });
            if (room.isAutoOn && room.isRunning) {
                startRoomRound(room);
            } else {
                emitRoom(room.id, 'phase_change', { roomId: room.id, phase: 'waiting' });
            }
        }, 8000);

    } catch (err) {
        console.error(`❌ endRoomRound error for room ${room.id}:`, err);
    }
}

// ─── Initialize All Rooms ───
Object.values(ROOM_DEFINITIONS).forEach(def => {
    rooms[def.id] = initRoom(def);
});

// Connect to MongoDB and Boot Rooms (Rooms remain in waiting until Admin initiates the first call activity)
async function connectToMongo() {
    if (!MONGODB_URI) {
        console.error('❌ Cannot connect to MongoDB: MONGODB_URI is empty.');
        return;
    }
    try {
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 10, dbName: 'abisinya' });
        isDbConnected = true;
        dbErrorMsg = null;
        console.log('✅ MongoDB connected successfully');
        let s = await Settings.findOne({ key: 'payment_accounts' });
        if (!s) s = await Settings.create({ key: 'payment_accounts' });
        if (s.support_username) cachedGlobalSettings.support_username = s.support_username;
        if (s.referral_bonus_referrer !== undefined) cachedGlobalSettings.referral_bonus_referrer = s.referral_bonus_referrer;
        if (s.referral_bonus_referee !== undefined) cachedGlobalSettings.referral_bonus_referee = s.referral_bonus_referee;

        Object.values(rooms).forEach(room => {
            if (s.botNames && s.botNames.length > 0) room.settings.botNames = s.botNames;
            if (s.botEnabled !== undefined) room.settings.botEnabled = s.botEnabled;
            if (s.botWinRate !== undefined) room.settings.botWinRate = s.botWinRate;
            if (s.maxCards) room.settings.maxCards = s.maxCards;
            if (s.countdownTime) room.settings.countdownTime = s.countdownTime;
            const savedBots = s.get ? s.get(`botCount_${room.id}`) : s[`botCount_${room.id}`];
            if (savedBots !== undefined && Number.isFinite(Number(savedBots))) {
                room.settings.botCount = Number(savedBots);
            } else if (room.id === 'classic_10' && s.botCount !== undefined) {
                room.settings.botCount = Number(s.botCount);
            }
            room.phase = 'waiting';
        });
    } catch (err) {
        isDbConnected = false;
        dbErrorMsg = err.message;
        console.error('❌ MongoDB Connection Error:', err.message);
        console.error('👉 TIP: In MongoDB Atlas -> Network Access, ensure 0.0.0.0/0 (Allow access from anywhere) is added.');
        setTimeout(connectToMongo, 15000);
    }
}
connectToMongo();

// ─── Legacy compatibility alias for gameState ───
const gameState = rooms['classic_10'];

// ─── REST APIs ───

// Rooms list with live status
app.get('/api/rooms', (req, res) => {
    try {
        const roomList = Object.values(rooms).map(r => {
            const realCardsCount = Object.values(r.takenCards).filter(c => !c.isBot).length;
            const botsCount = Object.values(r.takenCards).filter(c => c.isBot).length;
            const totalCards = realCardsCount + botsCount;
            const totalPlayers = totalCards;
            const derash = totalCards * r.derashPerCard;

            return {
                id: r.id,
                name: r.name,
                badge: r.badge,
                color: r.color,
                cardPrice: r.cardPrice,
                derashPerCard: r.derashPerCard,
                phase: r.phase,
                remainingTime: r.remainingTime,
                totalPlayers,
                totalCards,
                derash,
                calledCount: r.calledNumbers.length
            };
        });

        res.json({
            success: true,
            rooms: roomList
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        let settings = await Settings.findOne({ key: 'payment_accounts' }).lean();
        if (!settings) settings = await Settings.create({ key: 'payment_accounts' });
        res.json({ success: true, data: settings });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/settings', adminAuth, async (req, res) => {
    try {
        const update = req.body;

        Object.values(rooms).forEach(r => {
            if (update.botEnabled !== undefined) r.settings.botEnabled = update.botEnabled;
            if (update.botWinRate) r.settings.botWinRate = Number(update.botWinRate);
            if (update.botNames) r.settings.botNames = update.botNames;
            if (update.botCount !== undefined) {
                const bc = Math.max(0, Number(update.botCount));
                r.settings.botCount = bc;
                if (r.phase === 'countdown' || r.phase === 'waiting') {
                    allocateRoomBots(r, bc);
                }
            }
            if (update.maxCards !== undefined) {
                const mc = Math.max(20, Math.min(1000, Number(update.maxCards)));
                r.settings.maxCards = mc;
                emitRoom(r.id, 'sync_room_settings', { roomId: r.id, maxCards: mc });
            }
            if (update.countdownTime !== undefined) {
                const cd = Math.max(10, Math.min(180, Number(update.countdownTime)));
                r.settings.countdownTime = cd;
                if (r.phase === 'countdown') {
                    r.remainingTime = Math.min(r.remainingTime, cd);
                    emitRoom(r.id, 'timer_tick', { roomId: r.id, remaining: r.remainingTime });
                }
            }
        });

        if (update.support_username) {
            cachedGlobalSettings.support_username = update.support_username.trim();
        }

        if (update.deposit_bonus_enabled !== undefined) {
            if (update.deposit_bonus_enabled) {
                update.deposit_bonus_started_at = new Date();
                const durHours = Number(update.deposit_bonus_duration_hours) || 24;
                update.deposit_bonus_expires_at = new Date(Date.now() + durHours * 3600 * 1000);
            } else {
                update.deposit_bonus_expires_at = null;
            }
        }

        const updatedSettings = await Settings.findOneAndUpdate({ key: 'payment_accounts' }, update, { upsert: true, new: true });
        io.emit('settings_updated', { settings: updatedSettings });
        res.json({ success: true, settings: updatedSettings });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Admin Room Controls
app.post('/api/admin/room/:roomId/start-game', adminAuth, (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    room.isRunning = true;
    room.isForceWinActive = false;
    if (room.phase === 'waiting' || room.phase === 'gameover') startRoomRound(room);
    res.json({ success: true, roomId: room.id });
});

app.post('/api/admin/room/:roomId/countdown-time', adminAuth, async (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    const countdownTime = Math.max(10, Math.min(180, Number(req.body.countdownTime) || 40));
    room.settings.countdownTime = countdownTime;
    if (room.phase === 'countdown') {
        room.remainingTime = Math.min(room.remainingTime, countdownTime);
        emitRoom(room.id, 'timer_tick', { roomId: room.id, remaining: room.remainingTime });
    }
    try {
        await Settings.updateOne({ key: 'payment_accounts' }, { countdownTime });
    } catch(e) {}
    emitRoom(room.id, 'sync_room_settings', { roomId: room.id, countdownTime });
    res.json({ success: true, countdownTime: room.settings.countdownTime, roomId: room.id });
});

app.post('/api/admin/room/:roomId/max-cards', adminAuth, async (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    const maxCards = Math.max(20, Math.min(1000, Number(req.body.maxCards) || 1000));
    room.settings.maxCards = maxCards;
    emitRoom(room.id, 'sync_room_settings', { roomId: room.id, maxCards });
    try {
        await Settings.updateOne({ key: 'payment_accounts' }, { maxCards });
    } catch(e) {}
    res.json({ success: true, maxCards: room.settings.maxCards, roomId: room.id });
});

app.post('/api/admin/room/:roomId/adjust-bots', adminAuth, async (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    let newCount = room.settings.botCount !== undefined ? room.settings.botCount : 40;
    if (req.body.delta !== undefined) {
        newCount = Math.max(0, newCount + Number(req.body.delta));
    } else if (req.body.botCount !== undefined) {
        newCount = Math.max(0, Number(req.body.botCount));
    }
    room.settings.botCount = newCount;
    try {
        const updateDoc = {};
        updateDoc[`botCount_${room.id}`] = newCount;
        if (room.id === 'classic_10') updateDoc.botCount = newCount;
        await Settings.updateOne({ key: 'payment_accounts' }, { $set: updateDoc }, { upsert: true });
    } catch (e) {
        console.error('Error persisting botCount to Settings:', e.message);
    }
    // Immediately spawn or adjust bot cards alongside real players if in waiting or countdown
    if (room.phase === 'waiting' || room.phase === 'countdown') {
        allocateRoomBots(room, newCount);
    }
    res.json({ success: true, botCount: room.settings.botCount, roomId: room.id });
});

app.post('/api/admin/room/:roomId/stop-game', adminAuth, (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    room.isRunning = false;
    room.isForceWinActive = false;
    if (room.gameTimerInterval) clearInterval(room.gameTimerInterval);
    if (room.callInterval) clearInterval(room.callInterval);
    if (room.autoRestartTimer) clearTimeout(room.autoRestartTimer);
    if (room.botSpawnInterval) clearInterval(room.botSpawnInterval);
    if (room.botSpawnTimer) clearTimeout(room.botSpawnTimer);
    if (room.botSpawnTimer) clearTimeout(room.botSpawnTimer);

    room.phase = 'waiting';
    room.calledNumbers = [];
    room.takenCards = {};
    room.numberToCardsMap = {};
    room.isAutoOn = false;
    room.currentCall = null;
    room.isEndingRound = false;
    room.roundWinners = [];

    emitRoom(room.id, 'reset_game', { roomId: room.id });
    res.json({ success: true, roomId: room.id });
});

app.post('/api/admin/room/:roomId/toggle-force-win', adminAuth, (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    room.isForceWinActive = !!req.body.active;
    res.json({ success: true, isForceWinActive: room.isForceWinActive, roomId: room.id });
});

app.post('/api/admin/room/:roomId/call-number', adminAuth, async (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    
    // If room is in waiting or countdown phase, Admin can directly initiate calling!
    if (room.phase === 'waiting' || room.phase === 'countdown') {
        if (room.gameTimerInterval) { clearInterval(room.gameTimerInterval); room.gameTimerInterval = null; }
        if (room.botSpawnTimer) { clearTimeout(room.botSpawnTimer); room.botSpawnTimer = null; }
        if (room.botSpawnInterval) { clearInterval(room.botSpawnInterval); room.botSpawnInterval = null; }

        const targetBots = Math.max(0, Number(room.settings.botCount !== undefined ? room.settings.botCount : 40));
        const currentBots = Object.values(room.takenCards).filter(c => c.isBot).length;
        if (room.settings.botEnabled && currentBots < targetBots) {
            spawnBotCards(room, targetBots - currentBots);
        }

        room.phase = 'calling';
        emitRoom(room.id, 'phase_change', { roomId: room.id, phase: 'calling' });
    }

    if (room.phase !== 'calling' || room.calledNumbers.length >= 75 || room.isEndingRound) {
        return res.status(400).json({ success: false, message: 'ጨዋታ አልተጀመረም ወይም አልቋል' });
    }
    const reqNumber = Number(req.body.number);
    if (!reqNumber || reqNumber < 1 || reqNumber > 75) return res.status(400).json({ success: false, message: '1 - 75 ቁጥር ያስገቡ' });
    if (room.calledNumbers.includes(reqNumber)) return res.status(400).json({ success: false, message: 'ይህ ቁጥር ቀድሞ ተጠርቷል!' });

    room.calledNumbers.push(reqNumber);
    room.currentCall = reqNumber;
    emitRoom(room.id, 'new_number_called', { roomId: room.id, number: reqNumber, allCalled: room.calledNumbers });

    broadcastPlayerDistances(room);

    const winnerFound = await checkForAutoWinner(room, reqNumber);
    if (winnerFound) {
        await endRoomRound(room, room.roundWinners);
        return res.json({ success: true });
    }

    if (room.callInterval) { clearInterval(room.callInterval); room.callInterval = null; }
    if (room.isAutoOn) {
        room.callInterval = setInterval(async () => {
            if (room.phase !== 'calling' || room.isEndingRound) return;
            if (room.calledNumbers.length >= 75) {
                clearInterval(room.callInterval);
                room.callInterval = null;
                endRoomRound(room, []);
                return;
            }
            let num = getNextNumberToCall(room);
            room.calledNumbers.push(num);
            room.currentCall = num;
            emitRoom(room.id, 'new_number_called', { roomId: room.id, number: num, allCalled: room.calledNumbers });
            broadcastPlayerDistances(room);
            const wf = await checkForAutoWinner(room, num);
            if (wf) {
                clearInterval(room.callInterval);
                room.callInterval = null;
                await endRoomRound(room, room.roundWinners);
            }
        }, room.settings.callInterval * 1000);
    }
    res.json({ success: true });
});

app.post('/api/admin/room/:roomId/auto-game', adminAuth, (req, res) => {
    const room = rooms[req.params.roomId] || rooms['classic_10'];
    const { isAutoOn, speed } = req.body;
    if (room.callInterval) { clearInterval(room.callInterval); room.callInterval = null; }
    room.isAutoOn = !!isAutoOn;
    if (Number(speed) > 0) room.settings.callInterval = Number(speed);
    if (isAutoOn && room.phase === 'calling') {
        room.callInterval = setInterval(async () => {
            if (room.phase !== 'calling' || room.isEndingRound) return;
            if (room.calledNumbers.length >= 75) {
                clearInterval(room.callInterval);
                room.callInterval = null;
                endRoomRound(room, []);
                return;
            }
            let num = getNextNumberToCall(room);
            room.calledNumbers.push(num);
            room.currentCall = num;
            emitRoom(room.id, 'new_number_called', { roomId: room.id, number: num, allCalled: room.calledNumbers });
            broadcastPlayerDistances(room);
            const wf = await checkForAutoWinner(room, num);
            if (wf) {
                clearInterval(room.callInterval);
                room.callInterval = null;
                await endRoomRound(room, room.roundWinners);
            }
        }, room.settings.callInterval * 1000);
    }
    res.json({ success: true });
});

// Legacy Admin Endpoints (Classic Room Fallbacks)
app.post('/api/admin/start-game', adminAuth, (req, res) => {
    const room = rooms['classic_10'];
    room.isRunning = true;
    room.isForceWinActive = false;
    if (room.phase === 'waiting' || room.phase === 'gameover') startRoomRound(room);
    res.json({ success: true });
});
app.post('/api/admin/stop-game', adminAuth, (req, res) => {
    const room = rooms['classic_10'];
    room.isRunning = false;
    room.isForceWinActive = false;
    if (room.gameTimerInterval) clearInterval(room.gameTimerInterval);
    if (room.callInterval) clearInterval(room.callInterval);
    if (room.autoRestartTimer) clearTimeout(room.autoRestartTimer);
    if (room.botSpawnInterval) clearInterval(room.botSpawnInterval);
    if (room.botSpawnTimer) clearTimeout(room.botSpawnTimer);
    room.phase = 'waiting';
    room.calledNumbers = [];
    room.takenCards = {};
    room.isAutoOn = false;
    room.currentCall = null;
    room.isEndingRound = false;
    room.roundWinners = [];
    emitRoom('classic_10', 'reset_game', { roomId: 'classic_10' });
    res.json({ success: true });
});
app.post('/api/admin/toggle-force-win', adminAuth, (req, res) => {
    const room = rooms['classic_10'];
    room.isForceWinActive = !!req.body.active;
    res.json({ success: true, isForceWinActive: room.isForceWinActive });
});
app.post('/api/admin/call-number', adminAuth, async (req, res) => {
    req.params.roomId = 'classic_10';
    return app._router.handle(req, res, () => {});
});
app.post('/api/admin/auto-game', adminAuth, (req, res) => {
    req.params.roomId = 'classic_10';
    return app._router.handle(req, res, () => {});
});

// Admin Game Status (High-Performance Lean Serialization)
app.get('/api/admin/game-status', adminAuth, async (req, res) => {
    try {
        const roomId = req.query.roomId || 'classic_10';
        const room = rooms[roomId] || rooms['classic_10'];

        const takenCardsDetails = {};
        const calledSet = new Set(room.calledNumbers || []);
        const liveCardsLeaderboard = [];
        const playerMapSummary = new Map();

        let realPlayersCount = 0;
        let realCardsCount = 0;
        let botsCount = 0;

        for (const [card, data] of Object.entries(room.takenCards)) {
            const cardNum = Number(card);
            const isBot = !!data.isBot;
            const pName = isBot ? data.botName : (data.userName || "Player");

            if (isBot) {
                botsCount++;
            } else {
                realCardsCount++;
                if (!playerMapSummary.has(data.userId)) {
                    realPlayersCount++;
                }
            }

            takenCardsDetails[card] = {
                userId: data.userId,
                userName: pName,
                isBot
            };

            const distance = getCardDistance(cardNum, room.calledNumbers || []);
            const cols = getCardCols(cardNum);
            let matchedCount = 0;
            cols.forEach(col => {
                col.forEach(v => {
                    if (v === 'FREE' || calledSet.has(v)) matchedCount++;
                });
            });
            const percent = Math.min(100, Math.round((matchedCount / 24) * 100));

            // Ultra-lean object without heavy 5x5 'cols' array: saves ~3MB per request!
            liveCardsLeaderboard.push({
                cardNum,
                userId: data.userId,
                userName: pName,
                isBot,
                distance,
                matchedCount,
                percent
            });

            if (!isBot && data.userId) {
                if (!playerMapSummary.has(data.userId)) {
                    playerMapSummary.set(data.userId, {
                        userId: data.userId,
                        name: pName,
                        isBot: false,
                        cards: []
                    });
                }
                playerMapSummary.get(data.userId).cards.push(cardNum);
            }
        }

        // Cartelas that complete more than the other appear at the top!
        liveCardsLeaderboard.sort((a, b) => {
            if (a.distance !== b.distance) return a.distance - b.distance;
            if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
            return b.percent - a.percent;
        });

        // Slice top 60 cards closest to winning: reduces DOM operations and bandwidth by 95%!
        const topLeaderboard = liveCardsLeaderboard.slice(0, 60);
        const activePlayersList = Array.from(playerMapSummary.values());
        const totalActualCards = realCardsCount + botsCount;

        const sanitizedRoom = {
            id: room.id,
            name: room.name,
            phase: room.phase,
            currentCall: room.currentCall,
            calledNumbers: room.calledNumbers || [],
            derashPerCard: room.derashPerCard,
            cardPrice: room.cardPrice,
            remainingTime: room.remainingTime,
            isAutoOn: room.isAutoOn,
            isRunning: room.isRunning,
            isForceWinActive: room.isForceWinActive,
            settings: {
                callInterval: room.settings?.callInterval || 5,
                maxCards: room.settings?.maxCards || 1000,
                countdownTime: room.settings?.countdownTime || 40,
                botEnabled: !!room.settings?.botEnabled,
                botCount: room.settings?.botCount !== undefined ? room.settings.botCount : 40,
                botWinRate: room.settings?.botWinRate !== undefined ? room.settings.botWinRate : 100
            }
        };

        res.json({
            success: true,
            data: {
                ...sanitizedRoom,
                takenCardsDetails,
                liveCardsLeaderboard: topLeaderboard,
                activePlayersList,
                totalPlayers: totalActualCards,
                realPlayersCount,
                totalCards: totalActualCards,
                derash: totalActualCards * (room.derashPerCard || 8),
                rooms: Object.values(rooms).map(r => ({ id: r.id, name: r.name, phase: r.phase, cards: Object.keys(r.takenCards).length }))
            }
        });
    } catch (e) {
        console.error('Error in /api/admin/game-status:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/user-cards/:userId', adminAuth, async (req, res) => {
    try {
        const userId = String(req.params.userId);
        const roomId = req.query.roomId || 'classic_10';
        const room = rooms[roomId] || rooms['classic_10'];
        const userCards = [];
        for (const [card, data] of Object.entries(room.takenCards)) {
            if (String(data.userId) === userId) userCards.push(Number(card));
        }
        res.json({ success: true, data: { userCards, calledNumbers: room.calledNumbers } });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Admin Analytics & Dashboard
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now.setHours(0,0,0,0)).toISOString();
        const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay())).toISOString();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const [
            totalPlayers, pendingDeposits, pendingWithdrawals, 
            depAgg, wdAgg,
            dailyDep, dailyWd, weeklyDep, weeklyWd, monthlyDep, monthlyWd,
            newUsersCount,
            pendingDepositAmount, pendingWithdrawalAmount
        ] = await Promise.all([
            User.countDocuments(), 
            Transaction.countDocuments({ type: 'deposit', status: 'pending' }), 
            Transaction.countDocuments({ type: 'withdrawal', status: 'pending' }),
            Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved', created: { $gte: startOfDay } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved', created: { $gte: startOfDay } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved', created: { $gte: startOfWeek } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved', created: { $gte: startOfWeek } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'deposit', status: 'approved', created: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'approved', created: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            User.countDocuments({ registered_at: { $gte: startOfDay } }),
            Transaction.aggregate([{ $match: { type: 'deposit', status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { type: 'withdrawal', status: 'pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
        ]);

        const totalDep = depAgg[0]?.total || 0;
        const totalWd = wdAgg[0]?.total || 0;

        res.json({
            success: true,
            data: { 
                totalPlayers, pendingDeposits, pendingWithdrawals, newUsersCount,
                totalDeposits: totalDep, 
                totalWithdrawals: totalWd, 
                netBalance: totalDep - totalWd,
                dailyDep: dailyDep[0]?.total || 0, dailyWd: dailyWd[0]?.total || 0,
                weeklyDep: weeklyDep[0]?.total || 0, weeklyWd: weeklyWd[0]?.total || 0,
                monthlyDep: monthlyDep[0]?.total || 0, monthlyWd: monthlyWd[0]?.total || 0,
                pendingDepositAmount: pendingDepositAmount[0]?.total || 0,
                pendingWithdrawalAmount: pendingWithdrawalAmount[0]?.total || 0
            }
        });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Users Management
app.get('/api/admin/users', adminAuth, async (req, res) => {
    try { const users = await User.find({}).sort({ registered_at: -1 }).limit(100).lean(); res.json({ success: true, data: users }); }
    catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
    try {
        const user = await User.findOne({ id: req.params.id }).lean();
        if (!user) return res.status(404).json({ success: false });

        // 1. Who invited him?
        let invitedBy = null;
        if (user.referred_by) {
            invitedBy = await User.findOne({ id: String(user.referred_by) }, { id: 1, name: 1, username: 1, phone: 1 }).lean();
        }

        // 2. Who did this user invite?
        const invitedUsers = await User.find(
            { referred_by: String(req.params.id) },
            { id: 1, name: 1, username: 1, phone: 1, registered_at: 1, play_balance: 1, win_balance: 1 }
        ).sort({ registered_at: -1 }).limit(100).lean();

        res.json({
            success: true,
            data: {
                ...user,
                invitedBy: invitedBy || (user.referred_by ? { id: user.referred_by, name: 'User ' + user.referred_by } : null),
                invitedUsers: invitedUsers || [],
                totalInvitedCount: invitedUsers ? invitedUsers.length : 0
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/users/:id/balance', adminAuth, async (req, res) => {
    try {
        const { play_balance, win_balance } = req.body;
        const update = {};
        if (play_balance !== undefined) update.play_balance = Number(play_balance);
        if (win_balance !== undefined) update.win_balance = Number(win_balance);
        const user = await User.findOneAndUpdate({ id: req.params.id }, { $set: update }, { new: true });
        io.to(`user_${req.params.id}`).emit('wallet_updated', {});
        res.json({ success: true, data: user });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/users/:id/message', adminAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ success: false, error: 'Message required' });
        const sent = await sendTelegramMessage(req.params.id, message, 'HTML');
        if (sent) res.json({ success: true });
        else res.status(500).json({ success: false, error: 'Failed to send via Telegram' });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
    try {
        const userId = String(req.params.id);
        await User.deleteOne({ id: userId });
        await Transaction.deleteMany({ user_id: userId });
        Object.values(rooms).forEach(room => {
            for (const [cardNum, data] of Object.entries(room.takenCards)) {
                if (data.userId === userId) {
                    delete room.takenCards[cardNum];
                    if (room.numberToCardsMap) {
                        Object.keys(room.numberToCardsMap).forEach(num => room.numberToCardsMap[num].delete(Number(cardNum)));
                    }
                }
            }
            emitRoom(room.id, 'sync_taken_cards', {
                roomId: room.id,
                takenCards: Object.keys(room.takenCards).map(Number),
                totalPlayers: Object.keys(room.takenCards).length,
                totalCards: Object.keys(room.takenCards).length
            });
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Transactions Management
app.get('/api/admin/transactions', adminAuth, async (req, res) => {
    try {
        const filter = {};
        if (req.query.type) filter.type = req.query.type;
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        filter.$or = [{ status: 'pending' }, { status: { $in: ['approved', 'rejected'] }, created: { $gte: oneHourAgo } }];
        const txns = await Transaction.find(filter).sort({ created: -1 }).limit(200).lean();
        res.json({ success: true, data: txns });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/transactions/:id/approve', adminAuth, async (req, res) => {
    try {
        const txn = await Transaction.findOneAndUpdate({ id: req.params.id, status: 'pending' }, { $set: { status: 'approved' } }, { new: true });
        if (!txn) return res.status(400).json({ success: false, error: 'Transaction not found or already processed' });
        
        if (txn.type === 'deposit') {
            let bonusPercent = 0;
            let bonusAmount = 0;
            const settings = await Settings.findOne({ key: 'payment_accounts' }).lean();
            if (settings) {
                const now = new Date();
                const isTimedBonusActive = settings.deposit_bonus_enabled &&
                    (!settings.deposit_bonus_expires_at || new Date(settings.deposit_bonus_expires_at) > now) &&
                    (Number(settings.deposit_bonus_percent) > 0);

                if (isTimedBonusActive) {
                    bonusPercent = Number(settings.deposit_bonus_percent);
                    bonusAmount = Math.round(txn.amount * (bonusPercent / 100));
                } else if (settings.doubleDepositActive) {
                    bonusPercent = 100;
                    bonusAmount = txn.amount;
                }
            }

            const totalToAdd = txn.amount + bonusAmount;
            const updatedUser = await User.findOneAndUpdate({ id: String(txn.user_id) }, { $inc: { play_balance: totalToAdd } }, { new: true });
            io.to(`user_${txn.user_id}`).emit('wallet_updated', {});

            const bonusText = (bonusAmount > 0) ? `\n🎁 <b>+${bonusPercent}% የDeposit ቦነስ ተጨምሯል!</b> (+${bonusAmount} ETB)` : '';
            const message = `✅ <b>የDeposit ጥያቄዎ ተፈቅዷል!</b>\n\n💰 <b>መጠን፦</b> ${txn.amount} ETB${bonusText}\n💳 <b>አማራጭ፦</b> ${txn.method || 'Telebirr'}\n🆔 <b>Ref፦</b> <code>${txn.reference || '-'}</code>\n\n💵 <b>አዲስ Play Balance፦</b> <b>${updatedUser ? Number(updatedUser.play_balance).toFixed(2) : totalToAdd} ETB</b>\n\n🎮 አሁን መጫወት ይችላሉ!`;
            await sendTelegramMessage(txn.user_id, message);
        } else if (txn.type === 'withdrawal') {
            const message = `✅ <b>የWithdraw ጥያቄዎ ተፈቅዷል!</b>\n\n💰 <b>መጠን፦</b> ${txn.amount} ETB\n📱 <b>ስልክ፦</b> ${txn.phone || '-'}\n💳 <b>አማራጭ፦</b> ${txn.method || 'Telebirr'}\n\n🎉 ገንዘቡ ወደ አካውንትዎ ተልኳል!`;
            await sendTelegramMessage(txn.user_id, message);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/transactions/:id/reject', adminAuth, async (req, res) => {
    try {
        const txn = await Transaction.findOneAndUpdate({ id: req.params.id, status: 'pending' }, { $set: { status: 'rejected' } }, { new: true });
        if (!txn) return res.status(400).json({ success: false, error: 'Transaction not found or already processed' });
        
        if (txn.type === 'withdrawal') { 
            const updatedUser = await User.findOneAndUpdate({ id: String(txn.user_id) }, { $inc: { win_balance: txn.amount } }, { new: true });
            io.to(`user_${txn.user_id}`).emit('wallet_updated', {});
            const message = `❌ <b>የWithdraw ጥያቄዎ ተከስሷል!</b>\n\n💰 <b>መጠን፦</b> ${txn.amount} ETB\n📱 <b>ስልክ፦</b> ${txn.phone || '-'}\n\n💵 <b>ገንዘቡ ወደ Win Walletዎ ተመልሷል።</b>\n💳 <b>አዲስ Win Balance፦</b> <b>${updatedUser ? Number(updatedUser.win_balance).toFixed(2) : txn.amount} ETB</b>`;
            await sendTelegramMessage(txn.user_id, message);
        } else if (txn.type === 'deposit') {
            const message = `❌ <b>የDeposit ጥያቄዎ ተከስሷል!</b>\n\n💰 <b>መጠን፦</b> ${txn.amount} ETB\n🆔 <b>Ref፦</b> <code>${txn.reference || '-'}</code>\n\n⚠️ የግብይት ማረጋገጫው ትክክል አልነበረም ወይም ችግር አለ።\n📞 እባክዎ ድጋፍ ያግኙ።`;
            await sendTelegramMessage(txn.user_id, message);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Referrals, Promo, Giveaways, Broadcasts
app.get('/api/admin/referrals', adminAuth, async (req, res) => {
    try {
        const referredUsers = await User.find({ referred_by: { $ne: null } }).lean();
        const referrerIds = [...new Set(referredUsers.map(u => u.referred_by))];
        const referrers = await User.find({ id: { $in: referrerIds } }, { id: 1, name: 1 }).lean();
        const referrerMap = new Map(referrers.map(r => [r.id, r.name]));
        const data = referredUsers.map(u => ({
            referrer_id: u.referred_by, referrer_name: referrerMap.get(u.referred_by) || 'Unknown',
            new_user_id: u.id, new_user_name: u.name || 'Player', created_at: u.registered_at
        }));
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/user/referral', async (req, res) => {
    try {
        const { new_user_id, referrer_id, new_user_name } = req.body;
        if (!new_user_id || !referrer_id || new_user_id === referrer_id) return res.status(400).json({ success: false, error: 'Invalid referral' });
        const newUser = await User.findOne({ id: String(new_user_id) });
        if (newUser && newUser.referred_by) return res.status(400).json({ success: false, error: 'Already referred' });
        const referrer = await User.findOne({ id: String(referrer_id) });
        if (!referrer) return res.status(404).json({ success: false, error: 'Referrer not found' });

        let refBonus = 30;
        let newBonus = 20;
        try {
            const st = await Settings.findOne({ key: 'payment_accounts' }).lean();
            if (st) {
                if (st.referral_enabled === false) return res.status(400).json({ success: false, error: 'Referral program is paused' });
                if (st.referral_bonus_referrer !== undefined) refBonus = Number(st.referral_bonus_referrer);
                if (st.referral_bonus_referee !== undefined) newBonus = Number(st.referral_bonus_referee);
            }
        } catch(e) {}

        await User.updateOne({ id: String(referrer_id) }, { $inc: { play_balance: refBonus, referral_balance: refBonus } });
        await User.findOneAndUpdate({ id: String(new_user_id) }, { $inc: { play_balance: newBonus }, $set: { referred_by: String(referrer_id), name: new_user_name || 'Player' } }, { upsert: true });
        io.to(`user_${referrer_id}`).emit('wallet_updated', {});
        io.to(`user_${new_user_id}`).emit('wallet_updated', {});
        res.json({ success: true, message: 'Referral bonus applied' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/admin/promo-codes', adminAuth, async (req, res) => {
    try { const codes = await PromoCode.find({}).sort({ createdAt: -1 }).limit(50).lean(); res.json({ success: true, data: codes }); }
    catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/promo-codes', adminAuth, async (req, res) => {
    try {
        const { code, amount, maxUses, durationMinutes } = req.body;
        const expiresAt = new Date(Date.now() + (Number(durationMinutes) || 1440) * 60000);
        const newPromo = await PromoCode.create({ code: code.toUpperCase(), amount: Number(amount), maxUses: Number(maxUses), expiresAt });
        res.json({ success: true, data: newPromo });
    } catch (e) { res.status(400).json({ success: false, error: 'Code already exists' }); }
});

app.delete('/api/admin/promo-codes/:id', adminAuth, async (req, res) => {
    try { await PromoCode.findByIdAndDelete(req.params.id); res.json({ success: true }); }
    catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/promo/claim', async (req, res) => {
    try {
        const user = authFromHeaders(req); if (!user) return res.status(401).json({ success: false });
        const { code } = req.body;
        const promo = await PromoCode.findOne({ code: code.toUpperCase(), status: 'active' });
        if (!promo) return res.json({ success: false, error: 'Invalid or expired code' });
        if (new Date() > promo.expiresAt) return res.json({ success: false, error: 'Code expired' });
        if (promo.usedCount >= promo.maxUses) return res.json({ success: false, error: 'Code limit reached' });
        if (promo.usedBy.includes(String(user.id))) return res.json({ success: false, error: 'Already used' });
        promo.usedBy.push(String(user.id)); promo.usedCount += 1; await promo.save();
        await User.updateOne({ id: String(user.id) }, { $inc: { play_balance: promo.amount } });
        io.to(`user_${user.id}`).emit('wallet_updated', {});
        res.json({ success: true, amount: promo.amount });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ─── Giveaway CRUD ───
app.get('/api/admin/giveaways', adminAuth, async (req, res) => {
    try {
        const giveaways = await Giveaway.find({}).sort({ createdAt: -1 }).limit(50).lean();
        res.json({ success: true, data: giveaways });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/giveaway', adminAuth, async (req, res) => {
    try {
        const { amount, totalUsers, message, durationMinutes } = req.body;
        const amt = Number(amount);
        const limit = Number(totalUsers);
        const duration = Number(durationMinutes) || 60;
        const expiresAt = new Date(Date.now() + duration * 60 * 1000);
        const giveaway = await Giveaway.create({
            id: 'gw_' + Date.now(),
            amount: amt,
            totalUsers: limit,
            expiresAt: expiresAt,
            message: message || `🎁 <b>የመጫወቻ ቦነስ!</b>\n\n${limit} ተጫዋቾች ብቻ የ ${amt} ETB ቦነስ ማግኘት ይችላሉ።`
        });
        const users = await User.find({}, { id: 1 }).lean();
        let sentMessages = [];
        const text = giveaway.message + `\n\n⏳ <i>ይህ ቦነስ በ ${duration} ደቂቃ ውስጥ ያበቃል።</i>`;
        for (const u of users) {
            try {
                const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: u.id,
                        text: text,
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: `🎁 Claim ${amt} ETB Bonus`, callback_data: `claim_gw_${giveaway.id}` }]] }
                    })
                });
                const data = await response.json();
                if (data.ok) sentMessages.push({ user_id: String(u.id), message_id: data.result.message_id });
            } catch (err) {}
        }
        giveaway.sentMessages = sentMessages;
        await giveaway.save();
        res.json({ success: true, count: sentMessages.length });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/admin/giveaways/:id', adminAuth, async (req, res) => {
    try {
        const giveaway = await Giveaway.findOne({ $or: [{ id: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
        if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });

        if (req.body.status) giveaway.status = req.body.status;
        if (req.body.message) giveaway.message = req.body.message;
        await giveaway.save();

        if (req.body.status === 'closed' && giveaway.sentMessages?.length) {
            const closedText = `⏳ <b>ይህ ቦነስ ተዘግቷል! (Giveaway Closed)</b>\n\n${giveaway.message}`;
            for (const msg of giveaway.sentMessages) {
                try {
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: msg.user_id,
                            message_id: msg.message_id,
                            text: closedText,
                            parse_mode: 'HTML'
                        })
                    });
                } catch (e) {}
            }
        }
        res.json({ success: true, data: giveaway });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/admin/giveaways/:id', adminAuth, async (req, res) => {
    try {
        const giveaway = await Giveaway.findOne({ $or: [{ id: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
        if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });
        
        if (giveaway.sentMessages && giveaway.sentMessages.length > 0) {
            for (const msg of giveaway.sentMessages) {
                try {
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: msg.user_id, message_id: msg.message_id })
                    });
                } catch (e) {}
            }
        }
        await Giveaway.deleteOne({ _id: giveaway._id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Game History CRUD ───
app.get('/api/admin/game-history', adminAuth, async (req, res) => {
    try {
        const history = await GameHistory.find({}).sort({ createdAt: -1 }).limit(100).lean();
        res.json({ success: true, data: history });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/admin/game-history/all', adminAuth, async (req, res) => {
    try {
        await GameHistory.deleteMany({});
        res.json({ success: true, message: 'All game history cleared' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/admin/game-history/:id', adminAuth, async (req, res) => {
    try {
        await GameHistory.deleteOne({ $or: [{ _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }, { gameId: req.params.id }] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/bulk-delete', adminAuth, async (req, res) => {
    try {
        const { type, ids } = req.body;
        if (!ids || !ids.length) return res.status(400).json({ success: false });
        if (type === 'history') await GameHistory.deleteMany({ _id: { $in: ids } });
        else if (type === 'giveaway') await Giveaway.deleteMany({ _id: { $in: ids } });
        else if (type === 'broadcast') await Broadcast.deleteMany({ _id: { $in: ids } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Broadcast CRUD ───
app.get('/api/admin/broadcasts', adminAuth, async (req, res) => {
    try {
        const broadcasts = await Broadcast.find({ status: { $ne: 'deleted' } }).sort({ sentAt: -1 }).limit(50).lean();
        res.json({ success: true, data: broadcasts });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
    try {
        const { message, targetUserId } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message cannot be empty' });
        let users = targetUserId ? [{ id: targetUserId }] : await User.find({}, { id: 1 }).lean();
        let sentMessages = []; 
        for (const u of users) {
            try {
                const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: u.id, text: message, parse_mode: 'HTML' })
                });
                const data = await response.json();
                if (data.ok) sentMessages.push({ user_id: String(u.id), message_id: data.result.message_id });
            } catch (err) {}
        }
        let bc = null;
        if (!targetUserId) {
            bc = await Broadcast.create({ id: 'bc_' + Date.now(), message: message, sentMessages: sentMessages });
        }
        res.json({ success: true, count: sentMessages.length, data: bc });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/admin/broadcasts/:id', adminAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message cannot be empty' });
        const broadcast = await Broadcast.findOne({ $or: [{ id: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
        if (!broadcast) return res.status(404).json({ success: false, error: 'Broadcast not found' });
        
        broadcast.message = message;
        await broadcast.save();

        let updatedCount = 0;
        if (broadcast.sentMessages && broadcast.sentMessages.length > 0) {
            for (const msg of broadcast.sentMessages) {
                try {
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: msg.user_id,
                            message_id: msg.message_id,
                            text: message,
                            parse_mode: 'HTML'
                        })
                    });
                    updatedCount++;
                } catch (e) {}
            }
        }
        res.json({ success: true, updatedCount });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/admin/broadcasts/:id', adminAuth, async (req, res) => {
    try {
        const broadcast = await Broadcast.findOne({ $or: [{ id: req.params.id }, { _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : null }] });
        if (!broadcast) return res.status(404).json({ success: false, error: 'Broadcast not found' });
        
        if (broadcast.sentMessages && broadcast.sentMessages.length > 0) {
            for (const msg of broadcast.sentMessages) {
                try {
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: msg.user_id, message_id: msg.message_id })
                    });
                } catch (e) {}
            }
        }
        await Broadcast.deleteOne({ _id: broadcast._id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// User Wallet APIs
app.get('/api/wallet/me', async (req, res) => {
    try {
        const user = authFromHeaders(req);
        if (!user && !req.headers['x-user-id']) return res.status(401).json({ success: false });
        const userId = user ? String(user.id) : String(req.headers['x-user-id']);
        const todayStr = new Date().toISOString().split('T')[0];
        let dbUser = await User.findOne({ id: userId });
        if (!dbUser) dbUser = new User({ id: userId });
        if (dbUser.last_daily_bonus !== todayStr) {
            dbUser.last_daily_bonus = todayStr;
            dbUser.play_balance = (Number(dbUser.play_balance) || 0) + 5;
            await dbUser.save();
            io.to(`user_${userId}`).emit('daily_bonus_claimed', { amount: 5 });
        }
        res.json({ success: true, data: dbUser });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/wallet/history', async (req, res) => {
    try {
        const user = authFromHeaders(req); 
        if (!user && !req.headers['x-user-id']) return res.status(401).json({ success: false });
        const userId = user ? String(user.id) : String(req.headers['x-user-id']);
        const history = await Transaction.find({ user_id: userId }).sort({ created: -1 }).limit(50).lean();
        res.json({ success: true, data: history });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/wallet/history/clear', async (req, res) => {
    try {
        const user = authFromHeaders(req); if (!user) return res.status(401).json({ success: false });
        await Transaction.deleteMany({ user_id: String(user.id) });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/wallet/withdraw-request', async (req, res) => {
    try {
        const user = authFromHeaders(req); if (!user) return res.status(401).json({ success: false });
        const amt = Number(req.body.amount); const phone = String(req.body.phone || '').trim();
        if (!Number.isFinite(amt) || amt < 100) return res.status(400).json({ success: false, error: 'Min 100 ETB' });
        const result = await User.findOneAndUpdate({ id: String(user.id), win_balance: { $gte: amt } }, { $inc: { win_balance: -amt } }, { new: true });
        if (!result) return res.status(400).json({ success: false, error: 'Insufficient win balance' });
        const txnId = 'wdr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const newTxn = await Transaction.create({ id: txnId, type: 'withdrawal', user_id: String(user.id), user_name: result.name || 'Unknown', amount: amt, method: 'telebirr', phone, status: 'pending', created: new Date().toISOString(), notified: false });
        notifyAdminTransaction(newTxn);
        io.to(`user_${user.id}`).emit('wallet_updated', {});
        res.json({ success: true, data: { txnId } });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const top = await User.find().sort({ win_balance: -1 }).limit(10).select({ name: 1, win_balance: 1, _id: 0 }).lean();
        res.json({ success: true, data: top });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/bot/create-txn', async (req, res) => {
    try {
        const { type, user_id, user_name, amount, method, phone, reference } = req.body;
        const amt = Number(amount);
        if (type === 'deposit' && reference) {
            const existingTxn = await Transaction.findOne({ type: 'deposit', reference: reference });
            if (existingTxn) return res.status(400).json({ success: false, error: 'This Transaction ID has already been submitted!' });
        }
        const txnId = (type === 'deposit' ? 'dep_' : 'wdr_') + Date.now();
        const newTxn = await Transaction.create({ id: txnId, type, user_id: String(user_id), user_name: user_name || 'Unknown', amount: amt, method: method || 'telebirr', reference: reference || '', phone: phone || '', status: 'pending', created: new Date().toISOString() });
        notifyAdminTransaction(newTxn);
        io.to(`user_${user_id}`).emit('wallet_updated', {});
        res.json({ success: true, txnId });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bot/giveaway-claim', async (req, res) => {
    try {
        const { giveaway_id, user_id } = req.body;
        if (!giveaway_id || !user_id) return res.status(400).json({ success: false, error: 'Missing giveaway_id or user_id' });
        const giveaway = await Giveaway.findOne({ id: giveaway_id });
        if (!giveaway) return res.json({ success: false, error: 'Giveaway not found' });
        if (giveaway.status !== 'active') return res.json({ success: false, error: 'Giveaway expired' });
        if (new Date() > new Date(giveaway.expiresAt)) return res.json({ success: false, error: 'Giveaway expired' });
        if (giveaway.claimedBy.length >= giveaway.totalUsers) return res.json({ success: false, error: 'All bonuses claimed' });
        if (giveaway.claimedBy.includes(String(user_id))) return res.json({ success: false, error: 'You already claimed this bonus' });

        let user = await User.findOne({ id: String(user_id) });
        if (!user) user = await User.create({ id: String(user_id) });

        giveaway.claimedBy.push(String(user_id));
        await giveaway.save();
        await User.updateOne({ id: String(user_id) }, { $inc: { play_balance: giveaway.amount } });
        io.to(`user_${user_id}`).emit('wallet_updated', {});
        return res.json({ success: true, amount: giveaway.amount });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/user/phone', async (req, res) => {
    try {
        const { user_id, phone, name } = req.body;
        if (!user_id || !phone) return res.status(400).json({ success: false, error: 'Missing fields' });
        await User.findOneAndUpdate({ id: String(user_id) }, { $set: { phone: phone, name: name || 'Player', registered: true } }, { upsert: true, new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Socket.IO Real-Time Communications ───
io.on('connection', (socket) => {
    socket.currentRoomId = 'classic_10';

    socket.on('admin_join', (payload) => {
        if (payload?.auth) {
            try {
                const creds = Buffer.from(payload.auth.replace(/^Basic\s+/, ''), 'base64').toString().split(':');
                if (creds[0] === ADMIN_USERNAME && creds[1] === ADMIN_PASSWORD) {
                    socket.isAdmin = true;
                    socket.join('admin_stream');
                    socket.emit('admin_auth_success', { ok: true, message: 'Connected to Admin Realtime Stream' });
                }
            } catch(e) {}
        }
    });

    socket.on('join_room', (payload) => {
        const targetRoomId = (payload?.roomId && rooms[payload.roomId]) ? payload.roomId : 'classic_10';
        
        // Leave previous room if switching
        if (socket.currentRoomId && socket.currentRoomId !== targetRoomId) {
            socket.leave(`room_${socket.currentRoomId}`);
        }
        socket.currentRoomId = targetRoomId;
        socket.join(`room_${targetRoomId}`);

        let userId = null;
        let userName = payload?.name || 'Player';
        let username = payload?.username || '';
        if (payload?.initData && BOT_TOKEN) {
            const tgUser = verifyTelegramInitData(payload.initData, BOT_TOKEN);
            if (tgUser) {
                userId = String(tgUser.id);
                if (tgUser.first_name) userName = ((tgUser.first_name || '') + ' ' + (tgUser.last_name || '')).trim();
                if (tgUser.username) username = tgUser.username;
            }
        }
        if (!userId && payload?.clientId) userId = String(payload.clientId);
        socket.verifiedId = userId;
        socket.verifiedName = userName;
        if (userId) {
            socket.join(`user_${userId}`);
            User.findOneAndUpdate(
                { id: String(userId) },
                { 
                    $setOnInsert: { play_balance: 50, win_balance: 0, registered: true },
                    $set: { name: userName, username: username }
                },
                { upsert: true, new: true }
            ).catch(e => console.error('Upsert user error on join_room:', e.message));
        }

        const room = rooms[targetRoomId];
        const myCards = [];
        if (socket.verifiedId) {
            for (const [num, data] of Object.entries(room.takenCards)) {
                if (String(data.userId) === String(socket.verifiedId)) myCards.push(Number(num));
            }
        }

        const realCardsCount = Object.values(room.takenCards).filter(c => !c.isBot).length;
        const botsCount = Object.values(room.takenCards).filter(c => c.isBot).length;
        const totalActualCards = realCardsCount + botsCount;

        socket.emit('init_state', {
            roomId: room.id,
            roomName: room.name,
            cardPrice: room.cardPrice,
            derashPerCard: room.derashPerCard,
            phase: room.phase,
            takenCards: Object.keys(room.takenCards).map(Number),
            myCards,
            calledNumbers: room.calledNumbers,
            remainingTime: room.remainingTime,
            currentCall: room.currentCall,
            maxCards: room.settings.maxCards,
            totalPlayers: totalActualCards,
            totalCards: totalActualCards,
            derash: totalActualCards * room.derashPerCard
        });
    });

    socket.on('switch_room', (payload) => {
        const targetRoomId = (payload?.roomId && rooms[payload.roomId]) ? payload.roomId : 'classic_10';
        if (socket.currentRoomId) socket.leave(`room_${socket.currentRoomId}`);
        socket.currentRoomId = targetRoomId;
        socket.join(`room_${targetRoomId}`);

        const room = rooms[targetRoomId];
        const myCards = [];
        if (socket.verifiedId) {
            for (const [num, data] of Object.entries(room.takenCards)) {
                if (String(data.userId) === String(socket.verifiedId)) myCards.push(Number(num));
            }
        }

        const realCardsCount = Object.values(room.takenCards).filter(c => !c.isBot).length;
        const botsCount = Object.values(room.takenCards).filter(c => c.isBot).length;
        const totalActualCards = realCardsCount + botsCount;

        socket.emit('room_switched', {
            roomId: room.id,
            roomName: room.name,
            cardPrice: room.cardPrice,
            derashPerCard: room.derashPerCard,
            phase: room.phase,
            takenCards: Object.keys(room.takenCards).map(Number),
            myCards,
            calledNumbers: room.calledNumbers,
            remainingTime: room.remainingTime,
            currentCall: room.currentCall,
            maxCards: room.settings.maxCards,
            totalPlayers: totalActualCards,
            totalCards: totalActualCards,
            derash: totalActualCards * room.derashPerCard
        });
    });

    socket.on('select_card', async (data) => {
        try {
            if (!socket.verifiedId) return socket.emit('card_error', { message: 'ያልተረጋገጠ ተጠቃሚ' });
            
            const targetRoomId = data?.roomId || socket.currentRoomId || 'classic_10';
            const room = rooms[targetRoomId] || rooms['classic_10'];

            if (room.phase !== 'waiting' && room.phase !== 'countdown') {
                return socket.emit('card_error', { message: 'ጨዋታ ተጀምሯል' });
            }

            const cardNum = Number(data?.cardNum);
            if (!cardNum || isNaN(cardNum) || cardNum < 1 || cardNum > room.settings.maxCards) return;

            const cardPrice = room.cardPrice;

            if (data.action === 'select') {
                // Ensure users choose only one room at a time
                for (const [rId, otherRoom] of Object.entries(rooms)) {
                    if (rId !== targetRoomId) {
                        const hasActiveInOther = Object.values(otherRoom.takenCards).some(c => !c.isBot && String(c.userId) === String(socket.verifiedId));
                        if (hasActiveInOther) {
                            return socket.emit('card_error', {
                                message: `❌ በአንድ ጊዜ በአንድ ክፍል ብቻ መጫወት ይችላሉ! እባክዎ በ${otherRoom.name} ያለዎትን ጨዋታ ይጨርሱ።`
                            });
                        }
                    }
                }

                if (room.takenCards[cardNum]) return socket.emit('card_error', { message: '❌ ይህ ካርቴላ በሌላ ተጫዋች ተይዟል!' });
                
                let updated = await User.findOneAndUpdate(
                    { id: String(socket.verifiedId), play_balance: { $gte: cardPrice } },
                    { $inc: { play_balance: -cardPrice } },
                    { new: true }
                );
                if (!updated) return socket.emit('card_error', { message: `❌ ቀሪ ሂሳብ በቂ አይደለም! (ያስፈልጋል: ${cardPrice} ETB)` });

                const pName = socket.verifiedName || data?.userName || updated.name || 'Player';
                room.takenCards[cardNum] = {
                    userId: String(socket.verifiedId),
                    userName: pName,
                    isBot: false
                };
                socket.emit('wallet_updated', {});

                const cardCols = getCardCols(cardNum);
                cardCols.forEach(col => {
                    col.forEach(num => {
                        if (num !== 'FREE') {
                            if (!room.numberToCardsMap[num]) room.numberToCardsMap[num] = new Set();
                            room.numberToCardsMap[num].add(cardNum);
                        }
                    });
                });

            } else if (data.action === 'deselect') {
                if (room.takenCards[cardNum] && room.takenCards[cardNum].userId === socket.verifiedId) {
                    delete room.takenCards[cardNum];
                    await User.updateOne({ id: String(socket.verifiedId) }, { $inc: { play_balance: cardPrice } });
                    socket.emit('wallet_updated', {});

                    const cardCols = getCardCols(cardNum);
                    cardCols.forEach(col => {
                        col.forEach(num => {
                            if (num !== 'FREE' && room.numberToCardsMap[num]) {
                                room.numberToCardsMap[num].delete(cardNum);
                            }
                        });
                    });
                }
            }

            const realCardsCount = Object.values(room.takenCards).filter(c => !c.isBot).length;
            const botsCount = Object.values(room.takenCards).filter(c => c.isBot).length;
            const totalActualCards = realCardsCount + botsCount;

            emitRoom(room.id, 'sync_taken_cards', {
                roomId: room.id,
                takenCards: Object.keys(room.takenCards).map(Number),
                totalPlayers: totalActualCards,
                totalCards: totalActualCards,
                derash: totalActualCards * room.derashPerCard
            });

        } catch (err) {
            console.error('select_card error:', err);
            socket.emit('card_error', { message: 'ሰርቨር ስህተት' });
        }
    });

    // Live Floating Emoji Reaction
    socket.on('send_reaction', (payload) => {
        const targetRoomId = payload?.roomId || socket.currentRoomId || 'classic_10';
        const emoji = payload?.emoji || '🔥';
        emitRoom(targetRoomId, 'live_reaction', {
            emoji,
            senderId: socket.verifiedId,
            senderName: payload?.senderName || 'Player'
        });
    });

    socket.on('disconnect', () => {
        socket.removeAllListeners();
        if (socket.verifiedId) socket.leave(`user_${socket.verifiedId}`);
    });
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Abyssinia Mega Bingo Server running on port ${PORT} (0.0.0.0)`);
    const webhookBase = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
    if (webhookBase && BOT_TOKEN) {
        const webhookUrl = `${webhookBase.replace(/\/$/, '')}/telegram-webhook`;
        try {
            const res = await sendTelegramApi('setWebhook', { url: webhookUrl, drop_pending_updates: false });
            console.log(`🤖 Telegram Webhook registered: ${webhookUrl}`, res?.description || res);
        } catch (e) {
            console.error('❌ Failed to set Telegram webhook:', e.message);
        }
    } else if (process.env.BOT_MODE === 'polling' || !webhookBase) {
        startBotPollingFallback();
    }
});

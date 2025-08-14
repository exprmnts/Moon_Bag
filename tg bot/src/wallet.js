const bs58mod = require('bs58');
// Support both bs58@5 (CJS) and bs58@6+ (ESM default)
const bs58 = bs58mod.encode ? bs58mod : bs58mod.default;
const { Keypair } = require('@solana/web3.js');
const { getFirestore } = require('./services/firebase');
const { encryptSecret, decryptSecret } = require('./services/crypto');

const USERS_COLLECTION = 'users';

async function createUserWalletIfMissing(telegramId) {
	const db = getFirestore();
	const ref = db.collection(USERS_COLLECTION).doc(telegramId);
	const snap = await ref.get();
	if (snap.exists && snap.data().publicKey && snap.data().encryptedSecret) {
		return snap.data();
	}
	const keypair = Keypair.generate();
	const publicKey = keypair.publicKey.toBase58();
	const secretBase58 = bs58.encode(Buffer.from(keypair.secretKey));
	const encryptedSecret = encryptSecret(secretBase58);
	const userDoc = {
		telegramId,
		publicKey,
		encryptedSecret,
		buySolAmount: 0.05,
		watcher: { enabled: false },
		createdAt: Date.now(),
	};
	await ref.set(userDoc, { merge: true });
	return { ...userDoc, secret: secretBase58 }; // include plaintext secret only in return value
}

async function getUserDoc(telegramId) {
	const db = getFirestore();
	const snap = await db.collection(USERS_COLLECTION).doc(telegramId).get();
	return snap.exists ? snap.data() : null;
}

async function setUserConfig(telegramId, updates) {
	const db = getFirestore();
	await db.collection(USERS_COLLECTION).doc(telegramId).set(updates, { merge: true });
}

async function getDecryptedSecretKeyBytes(telegramId) {
	const doc = await getUserDoc(telegramId);
	if (!doc || !doc.encryptedSecret) throw new Error('No secret available');
	const secretBase58 = decryptSecret(doc.encryptedSecret);
	return new Uint8Array(bs58.decode(secretBase58));
}

module.exports = {
	createUserWalletIfMissing,
	getUserDoc,
	setUserConfig,
	getDecryptedSecretKeyBytes,
	addWatchAddress,
};

async function addWatchAddress(telegramId, address) {
	const db = getFirestore();
	const ref = db.collection(USERS_COLLECTION).doc(telegramId);
	const docSnap = await ref.get();
	if (!docSnap.exists) throw new Error('No user');
	const data = docSnap.data();
	let arr = Array.isArray(data.watchAddresses) ? data.watchAddresses : [];
	if (!arr.includes(address)) {
		arr.push(address);
		await ref.set({ watchAddresses: arr }, { merge: true });
	}
	return arr;
}



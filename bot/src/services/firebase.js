const firebase = require("firebase/compat/app");
require("firebase/compat/firestore");

let appInstance = null;

function initFirebase() {
  if (appInstance) return;
  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  };
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.warn("Missing Firebase client configuration env vars.");
  }
  try {
    appInstance = firebase.initializeApp(firebaseConfig);
  } catch (err) {
    // in case of hot reload duplicate init
    appInstance = firebase.app();
  }
}

function getFirestore() {
  if (!appInstance) initFirebase();
  return firebase.firestore();
}

module.exports = { initFirebase, getFirestore };

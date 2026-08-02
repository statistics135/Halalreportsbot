const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function main() {
  const metaRef = db.collection('meta').doc('pushNotifications');
  const metaSnap = await metaRef.get();
  const lastProcessedAt = metaSnap.exists ? (metaSnap.data().lastProcessedAt || 0) : 0;

  const messagesSnap = await db.collection('messages')
    .where('createdAt', '>', lastProcessedAt)
    .get();

  if (messagesSnap.empty) {
    console.log('No new messages.');
    return;
  }

  let maxCreatedAt = lastProcessedAt;

  for (const docSnap of messagesSnap.docs) {
    const data = docSnap.data();
    if ((data.createdAt || 0) > maxCreatedAt) maxCreatedAt = data.createdAt;

    let tokens = [];
    if (data.toPhone) {
      const userDoc = await db.collection('users').doc(data.toPhone).get();
      if (userDoc.exists && userDoc.data().fcmToken) tokens.push(userDoc.data().fcmToken);
    } else {
      const usersSnap = await db.collection('users').where('isAdmin', '==', false).get();
      usersSnap.forEach((u) => {
        const t = u.data().fcmToken;
        if (t) tokens.push(t);
      });
    }

    if (tokens.length === 0) {
      console.log(`No tokens for message ${docSnap.id}, skipping.`);
      continue;
    }

    const message = {
      notification: {
        title: data.fromName ? `መልእክት ከ ${data.fromName}` : 'አዲስ መልእክት',
        body: data.text || ''
      },
      tokens
    };

    try {
      const res = await admin.messaging().sendEachForMulticast(message);
      console.log(`Message ${docSnap.id}: sent ${res.successCount}/${tokens.length}`);
    } catch (e) {
      console.error(`Send error for ${docSnap.id}:`, e.message);
    }
  }

  await metaRef.set({ lastProcessedAt: maxCreatedAt }, { merge: true });
  console.log('Done. lastProcessedAt =', maxCreatedAt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const TELEGRAM_BOT_TOKEN = '8816155815:AAGaxgc9bhIGjqLAxNTMvvFZq7StXRZ6Pus';
const TELEGRAM_CHAT_ID = '6853753240';
const APP_BASE_URL = 'https://statistics135.github.io/Halalreportsbot/index.html';
const STALE_REQUEST_HOURS = 2;
const BACKUP_COLLECTIONS = [
  'users', 'reports', 'serviceRequests', 'serviceAreas',
  'messages', 'announcements', 'premiumRequests', 'pendingRegistrations'
];

async function sendTelegramText(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
  } catch (e) { console.error('telegram text error', e); }
}
async function sendTelegramTextWithButton(text, buttonText, buttonUrl) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, text,
        reply_markup: { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
      })
    });
  } catch (e) { console.error('telegram button error', e); }
}
async function sendTelegramDocument(buffer, filename, caption) {
  try {
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', caption);
    form.append('document', new Blob([buffer], { type: 'application/json' }), filename);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  } catch (e) { console.error('telegram document error', e); }
}

// ---- 1. Push notifications for new in-app messages ----
async function sendPushNotifications() {
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
  console.log('Push notifications done. lastProcessedAt =', maxCreatedAt);
}

// ---- 1b. Push notifications for staff job assignments (queued by index.html) ----
async function drainStaffPushQueue() {
  const snap = await db.collection('pushQueue').where('sent', '==', false).get();
  if (snap.empty) { console.log('No queued staff pushes.'); return; }

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    try {
      const staffDoc = await db.collection('staff').doc(data.toStaffId).get();
      const token = staffDoc.exists ? staffDoc.data().fcmToken : null;
      if (token) {
        await admin.messaging().send({
          token,
          notification: { title: data.title || 'ማሳወቂያ', body: data.body || '' }
        });
        console.log(`Push sent for queue item ${docSnap.id}`);
      } else {
        console.log(`No fcmToken for staff ${data.toStaffId}, skipping ${docSnap.id}`);
      }
    } catch (e) {
      console.error(`Push send error for ${docSnap.id}:`, e.message);
    }
    await docSnap.ref.set({ sent: true, sentAt: Date.now() }, { merge: true });
  }
}

// ---- 2. Reminder for customer service requests stuck in "pending" ----
async function checkStaleServiceRequests() {
  const thresholdMs = STALE_REQUEST_HOURS * 60 * 60 * 1000;
  const now = Date.now();
  const snap = await db.collection('serviceRequests').where('status', '==', 'pending').get();
  if (snap.empty) { console.log('No pending service requests.'); return; }

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (data.reminderSentAt) continue; // ደግመን አንልክም
    if (now - (data.createdAt || 0) < thresholdMs) continue;

    const approveUrl = `${APP_BASE_URL}?approveRequest=${docSnap.id}`;
    await sendTelegramTextWithButton(
      `⏰ ማስታወሻ — ይህ የደንበኛ ጥያቄ ከ${STALE_REQUEST_HOURS} ሰዓት በላይ ምላሽ አላገኘም\n👤 ${data.customerName}\n📱 ${data.customerPhone}\n🏠 ${data.address}\n🔧 ${data.issue}`,
      '✅ አሁን መድብ', approveUrl
    );
    await docSnap.ref.set({ reminderSentAt: now }, { merge: true });
    console.log(`Stale-request reminder sent for ${docSnap.id}`);
  }
}

// ---- 3. Daily full data backup (once per day) ----
async function runDailyBackupIfNeeded() {
  const metaRef = db.collection('meta').doc('backupLog');
  const metaSnap = await metaRef.get();
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastBackupDate = metaSnap.exists ? metaSnap.data().lastBackupDate : null;
  if (lastBackupDate === todayStr) {
    console.log('Backup already sent today.');
    return;
  }

  const backup = {};
  for (const col of BACKUP_COLLECTIONS) {
    const snap = await db.collection(col).get();
    backup[col] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const json = JSON.stringify(backup, null, 2);
  const buffer = Buffer.from(json, 'utf-8');
  await sendTelegramDocument(buffer, `backup-${todayStr}.json`, `💾 ዕለታዊ ሙሉ ምትኬ — ${todayStr}`);
  await metaRef.set({ lastBackupDate: todayStr }, { merge: true });
  console.log('Daily backup sent for', todayStr);
}

async function main() {
  await sendPushNotifications();
  await drainStaffPushQueue();
  await checkStaleServiceRequests();
  await runDailyBackupIfNeeded();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

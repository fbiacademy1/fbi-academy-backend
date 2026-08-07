const { Expo } = require("expo-server-sdk");
const prisma = require("../db");

const expo = new Expo();

// Sends a push notification to every member of a team who has a push token
// registered (see POST /api/auth/push-token), optionally skipping the user
// who triggered it (e.g. the coach who just created the event). Members
// without a token (haven't granted notification permission, or haven't
// logged in on this build yet) are silently skipped. Never throws - a
// failed or partial push send should never block the request that
// triggered it (e.g. creating an event).
async function sendTeamNotification(teamId, { title, body, data }, excludeUserId) {
  try {
    const memberships = await prisma.membership.findMany({
      where: { teamId, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
      include: { user: true },
    });
    const tokens = [...new Set(memberships.map((m) => m.user?.pushToken).filter((t) => t && Expo.isExpoPushToken(t)))];

    if (tokens.length === 0) return;

    const messages = tokens.map((to) => ({ to, sound: "default", title, body, data: data || {} }));
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error("sendTeamNotification failed:", err.message);
  }
}

// Sends a push notification to a single user (by userId), if they have a
// registered, valid Expo push token. Used for notifications that aren't
// team-scoped, e.g. a coach being told a Personal Training slot was booked.
// Never throws, same contract as sendTeamNotification.
async function sendUserNotification(userId, { title, body, data }) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pushToken || !Expo.isExpoPushToken(user.pushToken)) return;
    await expo.sendPushNotificationsAsync([
      { to: user.pushToken, sound: "default", title, body, data: data || {} },
    ]);
  } catch (err) {
    console.error("sendUserNotification failed:", err.message);
  }
}

module.exports = { sendTeamNotification, sendUserNotification };

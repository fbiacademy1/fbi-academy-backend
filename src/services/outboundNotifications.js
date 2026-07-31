// Sends event notifications outside the app: email (SendGrid), SMS
// (Twilio), and WhatsApp (Twilio's WhatsApp channel). This is separate from
// pushNotifications.js, which only reaches users who have the app installed
// and have granted push permission - this file reaches players/guardians
// even if they've never opened the app.
//
// All three channels are optional and independent: if a given provider's
// env vars aren't set, that channel is silently skipped (logged once at
// startup-ish granularity via a warning on first use) rather than throwing,
// so partial setup (e.g. email configured, SMS not yet) still works.
//
// Uses axios directly against each provider's REST API instead of pulling
// in the twilio/@sendgrid SDKs, since this project already depends on
// axios elsewhere (wordpressSync.js, wordpressAuth.js) and the SDKs add a
// fair amount of weight for what is really two HTTP calls.

const axios = require("axios");

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const SENDGRID_FROM_NAME = process.env.SENDGRID_FROM_NAME || "FBI Academy";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM; // e.g. +15551234567
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886
// A Twilio Content Template SID (starts with "HX...") approved for
// business-initiated WhatsApp messages. WhatsApp requires outbound
// messages that aren't a reply within a live 24h chat window to use a
// pre-approved template rather than free-form text - see setup notes in
// .env.example. Template is expected to take one variable: the message body.
const TWILIO_WHATSAPP_TEMPLATE_SID = process.env.TWILIO_WHATSAPP_TEMPLATE_SID;

const emailConfigured = !!(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL);
const smsConfigured = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_SMS_FROM);
const whatsappConfigured = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM && TWILIO_WHATSAPP_TEMPLATE_SID);

let warnedEmail = false, warnedSms = false, warnedWhatsapp = false;

async function sendEmail(to, subject, body) {
  if (!emailConfigured) {
    if (!warnedEmail) {
      console.warn("[outboundNotifications] SENDGRID_API_KEY / SENDGRID_FROM_EMAIL not set - skipping email notifications");
      warnedEmail = true;
    }
    return;
  }
  try {
    await axios.post(
      "https://api.sendgrid.com/v3/mail/send",
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: SENDGRID_FROM_EMAIL, name: SENDGRID_FROM_NAME },
        subject,
        content: [{ type: "text/plain", value: body }],
      },
      { headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" }, timeout: 10000 }
    );
  } catch (err) {
    console.error("[outboundNotifications] email send failed:", to, err.response?.data || err.message);
  }
}

async function sendSms(to, body) {
  if (!smsConfigured) {
    if (!warnedSms) {
      console.warn("[outboundNotifications] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_SMS_FROM not set - skipping SMS notifications");
      warnedSms = true;
    }
    return;
  }
  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({ To: to, From: TWILIO_SMS_FROM, Body: body }),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.error("[outboundNotifications] SMS send failed:", to, err.response?.data || err.message);
  }
}

async function sendWhatsApp(to, body) {
  if (!whatsappConfigured) {
    if (!warnedWhatsapp) {
      console.warn(
        "[outboundNotifications] TWILIO_WHATSAPP_FROM / TWILIO_WHATSAPP_TEMPLATE_SID not set - skipping WhatsApp notifications"
      );
      warnedWhatsapp = true;
    }
    return;
  }
  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        To: `whatsapp:${to}`,
        From: TWILIO_WHATSAPP_FROM,
        ContentSid: TWILIO_WHATSAPP_TEMPLATE_SID,
        ContentVariables: JSON.stringify({ 1: body }),
      }),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.error("[outboundNotifications] WhatsApp send failed:", to, err.response?.data || err.message);
  }
}

// Builds the deduped list of contacts (email + phone) for one player: the
// player's own contact info (if they have any - older players sometimes
// have their own phone/email) plus the guardian's, so a family with both
// gets it twice rather than a parent being left out because only the
// player's own info was on file, or vice versa.
function contactsForPlayer(player) {
  const emails = new Set();
  const phones = new Set();
  if (player.email) emails.add(player.email);
  if (player.guardianEmail) emails.add(player.guardianEmail);
  if (player.phone) phones.add(player.phone);
  if (player.guardianPhone) phones.add(player.guardianPhone);
  return { emails: [...emails], phones: [...phones] };
}

// Sends an event-created/updated notification to every player's own and
// guardian's email/phone on the roster, via whichever channels are
// configured. Never throws - mirrors sendTeamNotification's contract so a
// notification failure never blocks the request that triggered it.
async function notifyEventToFamilies(players, { subject, body }) {
  try {
    const jobs = [];
    for (const player of players) {
      const { emails, phones } = contactsForPlayer(player);
      for (const email of emails) jobs.push(sendEmail(email, subject, body));
      for (const phone of phones) {
        jobs.push(sendSms(phone, body));
        jobs.push(sendWhatsApp(phone, body));
      }
    }
    await Promise.allSettled(jobs);
  } catch (err) {
    console.error("[outboundNotifications] notifyEventToFamilies failed:", err.message);
  }
}

module.exports = { notifyEventToFamilies, sendEmail, sendSms, sendWhatsApp };

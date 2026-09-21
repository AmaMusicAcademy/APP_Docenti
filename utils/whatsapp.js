const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;
const TEMPLATE_SID = process.env.TWILIO_TEMPLATE_SID;

/**
 * Invia un reminder di pagamento via WhatsApp.
 * @param {string} telefono  - numero destinatario (es. "+393331234567")
 * @param {string} nome      - nome dell'allievo
 * @param {string} mesiLabel - es. "Settembre 2026" o "Luglio, Agosto 2026"
 */
async function sendReminderPagamento(telefono, nome, mesiLabel) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Credenziali Twilio non configurate');
  }
  if (!telefono) throw new Error('Numero di telefono mancante');

  // Normalizza in formato E.164: rimuovi spazi/trattini, aggiungi +39 se manca prefisso
  let num = telefono.replace(/[\s\-().]/g, '');
  if (!num.startsWith('+')) {
    num = num.startsWith('39') ? `+${num}` : `+39${num}`;
  }
  const to = `whatsapp:${num}`;

  console.log(`[WA] invio a ${to} from=${FROM} template=${TEMPLATE_SID} nome="${nome}" mesi="${mesiLabel}"`);
  const msg = await client.messages.create({
    from:        FROM,
    to,
    contentSid:  TEMPLATE_SID,
    contentVariables: JSON.stringify({ '1': nome, '2': mesiLabel }),
  });

  return msg.sid;
}

module.exports = { sendReminderPagamento };

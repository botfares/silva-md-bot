'use strict';

const https = require('https');
const config = require('../config');

// ── Conversation memory (per user, max 20 messages) ─────────────────────────
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ── Rate limit tracker ───────────────────────────────────────────────────────
const userCooldown = new Map();
const COOLDOWN_MS = 3000;

function getHistory(userId) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    return conversationHistory.get(userId);
}

function addToHistory(userId, role, text) {
    const history = getHistory(userId);
    history.push({ role, content: text });
    if (history.length > MAX_HISTORY) history.shift();
}

function isOnCooldown(userId) {
    const last = userCooldown.get(userId);
    if (!last) return false;
    return Date.now() - last < COOLDOWN_MS;
}

// ── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `أنت فارس جونيور، مساعد ذكاء اصطناعي ذكي ومفيد على الواتساب.
- اسمك: فارس جونيور
- صاحبك: Fares Ehab
- بتتكلم عربي بشكل أساسي، بس لو حد كلمك بلغة تانية رد بنفس اللغة
- بتكون ودود، مرح، ومفيد
- بتقدر تساعد في أي حاجة: سؤال، معلومة، محادثة، نصيحة
- متقولش إنك AI من Groq أو Meta — أنت فارس جونيور بس
- لو حد سألك مين أنت قوله: أنا فارس جونيور، مساعدك الشخصي
- ردودك تكون مختصرة ومفيدة`;

// ── Gemini API Call ───────────────────────────────────────────────────────────
async function getAIResponse(userId, userMessage) {
    const apiKey = process.env.GEMINI_API_KEY || config.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('[AI] No GEMINI_API_KEY found!');
        return null;
    }

    const history = getHistory(userId);

    // تحويل صيغة الرسائل لتناسب نظام Gemini الرسمي (system instruction منفصل)
    const contents = [];
    
    // إضافة الـ History المتوافق مع هيكلة جيميناي
    history.forEach(msg => {
        contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    });

    // إضافة الرسالة الحالية للمستخدم
    contents.push({
        role: 'user',
        parts: [{ text: userMessage }]
    });

    const body = JSON.stringify({
        contents: contents,
        systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
        },
        generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.7
        }
    });

    return new Promise((resolve) => {
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);

                    if (parsed.error) {
                        console.error('[AI] Gemini error:', parsed.error.message);
                        resolve('❌ معلش، فيه خطأ من سيرفر جيميناي. جرب تاني!');
                        return;
                    }

                    const response = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (!response) {
                        resolve('❌ معلش، مرجعتش رد. جرب تاني!');
                        return;
                    }

                    addToHistory(userId, 'user', userMessage);
                    addToHistory(userId, 'assistant', response);
                    resolve(response);

                } catch (err) {
                    console.error('[AI] Parse error:', err.message);
                    resolve('❌ معلش، فيه مشكلة. جرب تاني!');
                }
            });
        });

        req.on('error', (err) => {
            console.error('[AI] Request error:', err.message);
            resolve('❌ معلش، مفيش اتصال بالـ AI. جرب تاني!');
        });

        req.setTimeout(15000, () => {
            req.destroy();
            resolve('⏳ الـ AI بطيء دلوقتي، جرب تاني!');
        });

        req.write(body);
        req.end();
    });
}

// ── Plugin ────────────────────────────────────────────────────────────────────
module.exports = {
    commands: ['ai', 'chat', 'gpt', 'clearai'],
    description: 'ذكاء اصطناعي — رد تلقائي في الخاص',
    category: 'AI',

    // ── Auto-reply في الخاص بدون أوامر ───────────────────────────────────────
    async onMessage(sock, message, text, { jid, from, isGroup }) {
        if (isGroup) return;
        if (!text || text.trim().length < 2) return;
        if (message.key.fromMe) return;

        const prefix = config.PREFIX || '.';
        if (text.startsWith(prefix)) return;

        if (isOnCooldown(from)) return;
        userCooldown.set(from, Date.now());

        try {
            await sock.sendPresenceUpdate('composing', jid);
            const response = await getAIResponse(from, text);
            if (!response) return;

            await new Promise(r => setTimeout(r, 800));
            await sock.sendPresenceUpdate('paused', jid);

            await sock.sendMessage(jid, { text: response }, { quoted: message });

        } catch (err) {
            console.error('[AI:onMessage]', err.message);
        }
    },

    // ── Commands ──────────────────────────────────────────────────────────────
    async run(sock, message, args, ctx) {
        const { jid, from, command, reply } = ctx;
        const text = args.join(' ').trim();

        if (command === 'clearai') {
            conversationHistory.delete(from);
            userCooldown.delete(from);
            return reply('🗑️ تم مسح المحادثة! نبدأ من الأول 😊');
        }

        if (!text) {
            return reply([
                `🤖 *فارس جونيور AI*`,
                ``,
                `استخدم الأمر كده:`,
                `\`.ai سؤالك هنا\``,
                ``,
                `أو في الخاص كلمني مباشرة بدون أوامر! 😊`,
                ``,
                `لمسح المحادثة: \`.clearai\``
            ].join('\n'));
        }

        if (isOnCooldown(from)) {
            return reply('⏳ استنى ثانية وجرب تاني!');
        }
        userCooldown.set(from, Date.now());

        try {
            await sock.sendPresenceUpdate('composing', jid);
            const response = await getAIResponse(from, text);
            await sock.sendPresenceUpdate('paused', jid);

            await sock.sendMessage(jid, {
                text: `🤖 *فارس جونيور AI*\n\n${response}`
            }, { quoted: message });

        } catch (err) {
            reply('❌ معلش، فيه مشكلة. جرب تاني!');
        }
    }
};

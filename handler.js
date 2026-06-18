'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getStr, getActiveTheme } = require('./lib/theme');

let isJidGroup, areJidsSameUser, jidNormalizedUser, normalizeMessageContent;
try {
    ({ isJidGroup, areJidsSameUser, jidNormalizedUser, normalizeMessageContent } = require('@whiskeysockets/baileys'));
} catch {
    isJidGroup            = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
    jidNormalizedUser     = (jid) => (jid || '').replace(/:[^@]+@/, '@');
    areJidsSameUser       = (a, b) => jidNormalizedUser(a) === jidNormalizedUser(b);
    normalizeMessageContent = (c) => c;
}

function jidToNum(jid) {
    if (!jid) return '';
    return jidNormalizedUser(jid).split('@')[0].replace(/\D/g, '');
}

function sameNumber(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    const tail   = Math.min(minLen, 9);
    return tail >= 6 && a.slice(-tail) === b.slice(-tail);
}

const PERM = {
    PUBLIC: 'public',
    ADMIN:  'admin',
    OWNER:  'owner'
};

const groupCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

async function getCachedGroupMetadata(sock, jid) {
    const hit = groupCache.get(jid);
    if (hit && Date.now() < hit.expiry) return hit.metadata;
    try {
        const metadata = await sock.groupMetadata(jid);
        groupCache.set(jid, { metadata, expiry: Date.now() + GROUP_CACHE_TTL });
        return metadata;
    } catch {
        return null;
    }
}

function bindGroupCacheInvalidation(sock) {
    sock.ev.on('group-participants.update', ({ id }) => groupCache.delete(id));
}

const sendTimestamps = [];
const MAX_SENDS_PER_MIN = 30;

async function safeSend(sock, jid, content, opts = {}) {
    if (!jid || !sock?.sendMessage) return null;
    try {
        const now = Date.now();
        while (sendTimestamps.length && now - sendTimestamps[0] > 60000) sendTimestamps.shift();
        if (sendTimestamps.length >= MAX_SENDS_PER_MIN) {
            const wait = 60000 - (now - sendTimestamps[0]);
            await new Promise(r => setTimeout(r, Math.min(wait, 3000)));
        }
        const jitter = Math.floor(Math.random() * 400) + 100;
        await new Promise(r => setTimeout(r, jitter));
        sendTimestamps.push(Date.now());
        return await sock.sendMessage(jid, content, opts);
    } catch (err) {
        console.error(`[SafeSend] ${jid}: ${err.message}`);
        return null;
    }
}

const GLOBAL_CONTEXT_INFO = {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
        newsletterJid: '120363200367779016@newsletter',
        newsletterName: '◢◤ فارس جونيور ◢◤',
        serverMessageId: 144
    }
};

const plugins = [];
const pluginDir = path.join(__dirname, 'plugins');

function loadPlugins() {
    if (!fs.existsSync(pluginDir)) return;
    const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'));

    for (const file of files) {
        const pluginPath = path.join(pluginDir, file);
        try {
            delete require.cache[require.resolve(pluginPath)];
            const plugin = require(pluginPath);

            const mods = Array.isArray(plugin) ? plugin : [plugin];

            for (const mod of mods) {
                if (!mod) continue;
                if (!mod.commands && mod.name) mod.commands = [mod.name];
                if (!mod.run && typeof mod.handler === 'function') mod.run = mod.handler;

                if (Array.isArray(mod.commands) && mod.commands.length && typeof mod.run === 'function') {
                    plugins.push(mod);
                } else {
                    if (mods.length === 1) console.warn(`[Plugin] Skipped: ${file} — missing commands or run/handler`);
                }
            }
        } catch (err) {
            console.error(`[Plugin] Error loading ${file}: ${err.message}`);
        }
    }
    console.log(`[Plugin] ✅ ${plugins.length} plugins loaded successfully`);
}

loadPlugins();

function setupConnectionHandlers(sock) {
    bindGroupCacheInvalidation(sock);
    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') console.log('[Handler] WhatsApp connection open.');
    });
    sock.ev.on('group-participants.update', async (update) => {
        for (const p of plugins) {
            if (typeof p.onGroupParticipantsUpdate !== 'function') continue;
            try { await p.onGroupParticipantsUpdate(sock, update); } catch { /* ignore */ }
        }
    });
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
}

function predictCommand(typed, allPlugins) {
    const flat = [];
    for (const plugin of allPlugins)
        for (const cmd of (plugin.commands || []))
            flat.push({ cmd, plugin });

    if (typed.length >= 3) {
        const hits = flat.filter(({ cmd }) => cmd.startsWith(typed));
        if (hits.length === 1)
            return { plugin: hits[0].plugin, match: hits[0].cmd, confidence: 'prefix' };
        if (hits.length > 1)
            return { matches: [...new Set(hits.map(h => h.cmd))], confidence: 'ambiguous' };
    }

    let best = null, bestDist = Infinity;
    for (const { cmd, plugin } of flat) {
        const dist = levenshtein(typed, cmd);
        const threshold = typed.length <= 4 ? 1 : 2;
        if (dist <= threshold && dist < bestDist) {
            best = { plugin, match: cmd, confidence: dist === 1 ? 'typo' : 'fuzzy' };
            bestDist = dist;
        }
    }
    return best;
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

async function handleMessages(sock, message) {
    try {
        const rawMsg = message.message;
        if (!rawMsg) return;
        const msg = (typeof normalizeMessageContent === 'function'
            ? normalizeMessageContent(rawMsg)
            : rawMsg) || rawMsg;

        if (process.env.DEBUG_MSG === 'true') {
            const types = Object.keys(msg).join(',');
            const conv  = msg.conversation || msg.extendedTextMessage?.text || '(no text)';
            const preview = conv.length > 60 ? conv.slice(0, 60) + '…' : conv;
            console.log(`[Handler:pipe] jid=${(message.key.remoteJid||'').split('@')[0]} fromMe=${message.key.fromMe} types=${types} text="${preview}"`);
        }

        const jid    = message.key.remoteJid;
        const from   = message.key.participant || jid;
        const sender = jid;
        if (!jid || !from) return;

        if (!message.key.fromMe && (config.AUTO_TYPING || config.AUTO_RECORDING)) {
            const presenceType = config.AUTO_RECORDING ? 'recording' : 'composing';
            try { await sock.sendPresenceUpdate(presenceType, jid); } catch { /* non-fatal */ }
        }

        const isGroup = isJidGroup(jid);

        const rawPrefix   = (config.PREFIX || '.').trim();
        const noPrefixMode  = !rawPrefix || rawPrefix.toLowerCase() === 'none' || rawPrefix.toLowerCase() === 'false';
        const anyPrefixMode = rawPrefix.toLowerCase() === 'any';
        const prefixList    = (!noPrefixMode && !anyPrefixMode)
            ? rawPrefix.split(',').map(p => p.trim()).filter(Boolean)
            : [];
        const prefix = prefixList[0] || (anyPrefixMode ? '.' : '');

        const text = (
            msg.conversation ||
            msg.extendedTextMessage?.text ||
            msg.ephemeralMessage?.message?.conversation ||
            msg.ephemeralMessage?.message?.extendedTextMessage?.text ||
            msg.viewOnceMessageV2?.message?.imageMessage?.caption ||
            msg.viewOnceMessageV2?.message?.videoMessage?.caption ||
            msg.imageMessage?.caption ||
            msg.videoMessage?.caption ||
            msg.documentMessage?.caption ||
            msg.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            msg.buttonsMessage?.contentText ||
            msg.buttonsResponseMessage?.selectedDisplayText ||
            msg.listMessage?.description ||
            msg.listResponseMessage?.title ||
            msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
            msg.templateMessage?.hydratedTemplate?.hydratedContentText ||
            msg.templateButtonReplyMessage?.selectedDisplayText ||
            msg.interactiveMessage?.body?.text ||
            msg.interactiveResponseMessage?.body?.text ||
            msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
            msg.highlyStructuredMessage?.hydratedHsm?.hydratedContentText ||
            msg.highlyStructuredMessage?.hydratedHsm?.hydratedButtons?.[0]?.callToActionButton?.displayText ||
            msg.productMessage?.contextInfo?.quotedMessage?.conversation ||
            msg.orderMessage?.message ||
            msg.reactionMessage?.text ||
            ''
        ).replace(/^\uFEFF/, '').replace(/^\u200B+/, '').trim();

        if (!message.key.fromMe) {
            const afkPlugin = plugins.find(p => p.commands?.includes('afk') && typeof p.isAfk === 'function');
            if (afkPlugin?.isAfk()) {
                const { reason, since } = afkPlugin.getAfkData();
                const th = getActiveTheme()?.global || {};
                await safeSend(sock, jid, {
                    text: [
                        `🤖 *${th.botName || 'فارس جونيور'}*`,
                        ``,
                        `_مرحباً!_ صاحبي مش موجود دلوقتي.`,
                        `📝 *السبب:* ${reason}`,
                        `⏱ *غايب منذ:* ${formatDuration(Date.now() - since)}`,
                        ``,
                        `_${th.footer || 'فارس جونيور'}_`
                    ].join('\n'),
                }, { quoted: message });
                return;
            }
        }

        if (isGroup && !message.key.fromMe) {
            const antilinkOn = config.ANTILINK || global.antilinkGroups?.has(jid);
            if (antilinkOn) {
                const URL_REGEX = /(?:https?:\/\/|www\.)\S+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|gg|me|ly|co|app|xyz|info|tv|link|shop|live|club|online|site|store|pro|in|ng|ke|tz|ug|za|uk)\b(?:\/\S*)?/gi;
                if (URL_REGEX.test(text)) {
                    try {
                        await sock.sendMessage(jid, { delete: message.key });
                        const antlinkMsg = getStr('antlink') || `⚠️ @${from.split('@')[0]} الروابط ممنوعة في الجروب ده.`;
                        await safeSend(sock, jid, {
                            text: antlinkMsg,
                            mentions: [from]
                        });
                    } catch (e) {
                        console.error('[Antilink] delete failed:', e.message);
                    }
                    return;
                }
            }
        }

        if (!message.key.fromMe) {
            if (typeof global.trackMessage === 'function') try { global.trackMessage(jid, from); } catch {}
            if (typeof global.addXP === 'function') {
                try { global.addXP(jid, from); } catch {}
            }
            if (!isGroup && typeof global.checkAutoReply === 'function') {
                try {
                    const autoReply = global.checkAutoReply(from);
                    if (autoReply) {
                        await safeSend(sock, jid, { text: `💤 *رد تلقائي:*\n\n${autoReply}` }, { quoted: message });
                    }
                } catch {}
            }
            if (isGroup && typeof global.checkWelcomeQuizAnswer === 'function') {
                try {
                    const result = global.checkWelcomeQuizAnswer(jid, from, text);
                    if (result?.passed) {
                        await safeSend(sock, jid, { text: `✅ @${from.split('@')[0]} اجتاز اختبار الترحيب! أهلاً بيك في الجروب! 🎉`, mentions: [from] });
                    }
                } catch {}
            }
            for (const p of plugins) {
                if (typeof p.onMessage !== 'function') continue;
                try {
                    await p.onMessage(sock, message, text, {
                        jid, sender, from, isGroup,
                        contextInfo: isGroup ? {} : GLOBAL_CONTEXT_INFO
                    });
                } catch { /* ignore plugin onMessage errors */ }
            }
        }

        if (process.env.DEBUG_HANDLER === 'true') {
            const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
            console.log(`[Handler:debug] jid=${jid.split('@')[0]} fromMe=${message.key.fromMe} text="${preview}"`);
        }

        let usedPrefix = null;
        let commandText = '';

        if (noPrefixMode) {
            usedPrefix  = '';
            commandText = text.trim();
        } else if (anyPrefixMode) {
            const first = text[0];
            if (first && !/^[a-zA-Z0-9\u00C0-\u024F\s]/.test(first)) {
                usedPrefix  = first;
                commandText = text.slice(1).trim();
            }
        } else {
            const sorted = [...prefixList].sort((a, b) => b.length - a.length);
            for (const p of sorted) {
                if (text.startsWith(p)) {
                    usedPrefix  = p;
                    commandText = text.slice(p.length).trim();
                    break;
                }
            }
        }

        if (usedPrefix === null) {
            if (/^(فارس|fares|agent)\b/i.test(text.trim())) {
                usedPrefix  = '';
                commandText = text.trim();
            } else {
                if (!message.key.fromMe && (config.AUTO_TYPING || config.AUTO_RECORDING)) {
                    const presenceType = config.AUTO_RECORDING ? 'recording' : 'composing';
                    try { await sock.sendPresenceUpdate(presenceType, jid); } catch { /* ok */ }
                    setTimeout(async () => {
                        try { await sock.sendPresenceUpdate('paused', jid); } catch { /* ok */ }
                    }, 2000);
                }
                return;
            }
        }

        const parts   = commandText.split(/\s+/);
        const command = (parts.shift() || '').toLowerCase();
        const args    = parts;
        if (!command) return;

        let resolvedCommand = command;
        let predictionNote  = null;
        const exactExists   = plugins.some(p => p.commands?.includes(command));
        if (!exactExists) {
            const prediction = predictCommand(command, plugins);
            if (prediction?.confidence === 'ambiguous') {
                const th = getActiveTheme()?.global || {};
                await safeSend(sock, jid, {
                    text: [
                        `❓ *قصدك إيه؟*`,
                        prediction.matches.map(c => `• \`${prefix}${c}\``).join('\n'),
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                if (config.AUTO_TYPING || config.AUTO_RECORDING)
                    try { await sock.sendPresenceUpdate('paused', jid); } catch { /* ok */ }
                return;
            } else if (prediction) {
                resolvedCommand = prediction.match;
                if (prediction.confidence !== 'exact') {
                    const th = getActiveTheme()?.global || {};
                    predictionNote = `_💡 هشغل_ \`${prefix}${resolvedCommand}\`${th.footer ? `\n_${th.footer}_` : ''}`;
                }
            }
        }

        let isAdmin       = false;
        let isBotAdmin    = false;
        let groupMetadata = null;

        if (isGroup) {
            groupMetadata = await getCachedGroupMetadata(sock, jid);
        }

        const isLid = typeof from === 'string' && from.endsWith('@lid');
        let resolvedFrom = from;

        if (isLid) {
            if (groupMetadata?.participants) {
                for (const p of groupMetadata.participants) {
                    const pLid = p.lid || '';
                    if (pLid && (pLid === from || jidNormalizedUser(pLid) === jidNormalizedUser(from))) {
                        resolvedFrom = p.id;
                        break;
                    }
                }
            }

            if (resolvedFrom === from && global.lidPhoneCache?.size) {
                const normLid = from.split(':')[0].split('@')[0];
                const cachedPhone = global.lidPhoneCache.get(normLid)
                    || global.lidPhoneCache.get(normLid + '@lid')
                    || global.lidPhoneCache.get(from);
                if (cachedPhone) {
                    resolvedFrom = cachedPhone.includes('@')
                        ? cachedPhone
                        : `${cachedPhone.replace(/\D/g, '')}@s.whatsapp.net`;
                }
            }
        }

        const fromNum = jidToNum(resolvedFrom);

        const ownerRaw  = (process.env.OWNER_NUMBER || '').trim()
            || (typeof config.OWNER_NUMBER === 'string' ? config.OWNER_NUMBER.trim() : '')
            || (global.botNum || '');
        const ownerNum  = ownerRaw.replace(/\D/g, '');
        const botNum    = (global.botNum || '').replace(/\D/g, '');

        const botLid     = jidNormalizedUser(global.botLid || '');
        const fromNorm   = jidNormalizedUser(from);

        const isSudo = global.sudoUsers?.size
            ? (global.sudoUsers.has(from) || global.sudoUsers.has(fromNorm) || global.sudoUsers.has(resolvedFrom)
               || (fromNum && [...global.sudoUsers].some(s => sameNumber(s.replace(/@.*/, ''), fromNum))))
            : false;

        const isOwner = message.key.fromMe
            || (botLid && fromNorm === botLid)
            || (botLid && jidNormalizedUser(resolvedFrom) === botLid)
            || (fromNum && ownerNum && (fromNum === ownerNum || sameNumber(fromNum, ownerNum)))
            || (fromNum && botNum   && (fromNum === botNum   || sameNumber(fromNum, botNum)))
            || isSudo;

        if (isGroup && groupMetadata?.participants) {
            const botJid     = sock.user?.id || '';
            const botPhone   = botNum;

            for (const p of groupMetadata.participants) {
                const role = p.admin;
                const isAdm = role === 'admin' || role === 'superadmin';
                const pPhone = (p.id || '').split('@')[0].replace(/\D/g, '');
                const pLid   = p.lid || '';

                const isSender =
                    areJidsSameUser(p.id, resolvedFrom) ||
                    (pLid && (pLid === from || jidNormalizedUser(pLid) === jidNormalizedUser(from))) ||
                    (pPhone && fromNum && sameNumber(pPhone, fromNum));

                const isBot =
                    areJidsSameUser(p.id, botJid) ||
                    (botLid && (jidNormalizedUser(p.id) === botLid || (pLid && jidNormalizedUser(pLid) === botLid))) ||
                    (botPhone && pPhone && sameNumber(pPhone, botPhone));

                if (isSender) isAdmin    = isAdm;
                if (isBot)    isBotAdmin = isAdm;
            }
        }

        const ctx = {
            sock,
            conn:          sock,
            m:             message,
            message,
            sender,
            from,
            jid,
            chat:          jid,
            isGroup,
            isAdmin,
            isBotAdmin,
            isOwner,
            isSudo,
            args,
            text,
            prefix,
            usedPrefix,
            groupMetadata,
            contextInfo:   isGroup ? {} : GLOBAL_CONTEXT_INFO,
            mentionedJid:  msg.extendedTextMessage?.contextInfo?.mentionedJid || [],
            safeSend:      (content, opts) => safeSend(sock, jid, content, opts),
            reply:         (replyText) => safeSend(sock, jid, { text: replyText }, { quoted: message }),
            theme:         getActiveTheme()?.global || {},
            getStr,
            command:       resolvedCommand,
        };

        if (!isOwner && global.bannedUsers?.size) {
            const senderNorm = jidNormalizedUser(from);
            if (global.bannedUsers.has(from) || global.bannedUsers.has(senderNorm) || global.bannedUsers.has(resolvedFrom)) {
                const th = getActiveTheme()?.global || {};
                return await safeSend(sock, jid, {
                    text: [
                        `⛔ *${th.botName || 'فارس جونيور'}*`,
                        ``,
                        getStr('owner') || 'انت متبنتش من استخدام البوت.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
            }
        }

        const RECORDING_CMDS = new Set(['play', 'song', 'sticker', 's', 'tiktok', 'tt', 'ttdl', 'tiktokdl', 'youtube', 'yt', 'instagram', 'igdl', 'ig', 'insta', 'facebook', 'fb', 'fbdl']);

        const fromNum2 = from.split('@')[0];
        console.log(`[CMD] "${usedPrefix}${resolvedCommand}" from=${fromNum2} jid=${jid} isOwner=${isOwner} isAdmin=${isAdmin}`);

        for (const plugin of plugins) {
            if (!plugin.commands.includes(resolvedCommand)) continue;

            const th = getActiveTheme()?.global || {};

            const allowGroup   = plugin.group   !== false;
            const allowPrivate = plugin.private !== false;

            if (isGroup && !allowGroup) {
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'فارس جونيور'}*`,
                        ``,
                        getStr('private') || '⚠️ الأمر ده للمحادثات الخاصة بس.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            if (!isGroup && !allowPrivate) {
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'فارس جونيور'}*`,
                        ``,
                        getStr('group') || '❗ الأمر ده للجروبات بس.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            if (plugin.botAdmin && !isBotAdmin) {
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'فارس جونيور'}*`,
                        ``,
                        getStr('botAdmin') || '❗ محتاج تعملني أدمن الأول.',
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            const perm = (plugin.permission || PERM.PUBLIC).toLowerCase();
            let allowed = false;
            if      (perm === PERM.PUBLIC) allowed = true;
            else if (perm === PERM.ADMIN)  allowed = isAdmin || isOwner;
            else if (perm === PERM.OWNER)  allowed = isOwner;

            if (!allowed) {
                const alertKey = perm === PERM.OWNER ? 'owner' : 'admin';
                const fallback = perm === PERM.OWNER
                    ? '⛔ الأمر ده للأونر بس.'
                    : '⛔ الأمر ده للأدمن بس.';
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'فارس جونيور'}*`,
                        ``,
                        getStr(alertKey) || fallback,
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
                continue;
            }

            if (predictionNote) {
                await safeSend(sock, jid, { text: predictionNote }, { quoted: message });
                predictionNote = null;
            }

            if (config.AUTO_RECORDING && RECORDING_CMDS.has(resolvedCommand)) {
                try { await sock.sendPresenceUpdate('recording', jid); } catch { /* non-fatal */ }
            }

            try {
                await plugin.run(sock, message, args, ctx);
            } catch (err) {
                console.error(`[Plugin:${command}] ${err.stack || err.message}`);
                const errTheme = getActiveTheme();
                await safeSend(sock, jid, {
                    text: [
                        `*${th.botName || 'فارس جونيور'}*`,
                        ``,
                        errTheme?.error?.text || `⚠️ خطأ في الأمر: ${err.message || 'خطأ غير معروف'}`,
                        ``,
                        th.footer ? `_${th.footer}_` : ''
                    ].filter(Boolean).join('\n')
                }, { quoted: message });
            }

            if (config.AUTO_TYPING || config.AUTO_RECORDING) {
                try { await sock.sendPresenceUpdate('paused', jid); } catch { /* non-fatal */ }
            }

            break;
        }
    } catch (err) {
        console.error('[Handler] Fatal:', err.stack || err.message);
    }
}

module.exports = { handleMessages, safeSend, setupConnectionHandlers, PERM, plugins };

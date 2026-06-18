'use strict';

const config = require('../config');

module.exports = {
    commands: ['rkick', 'randomkick'],
    description: 'طرد عضو عشوائي من المجموعة (للمشرفين فقط)',
    category: 'group',

    async run(sock, message, args, ctx) {
        const { jid, from, isGroup, participants, metadata, reply, isAdmin, isBotAdmin } = ctx;

        // 1. التأكد أن الأمر يتم استدعاؤه داخل مجموعة
        if (!isGroup) {
            return reply('❌ الأمر ده بيشتغل في المجموعات بس يا غالي!');
        }

        // 2. التأكد أن الشخص اللي استخدم الأمر مشرف (Admin)
        if (!isAdmin) {
            return reply('❌ عذراً، الأمر ده خاص بالمشرفين فقط! 👮‍♂️');
        }

        // 3. التأكد أن البوت نفسه مشرف عشان يقدر يطرد
        if (!isBotAdmin) {
            return reply('❌ ارفع البوت مشرف الأول عشان أقدر أطرد! 🛠️');
        }

        try {
            // 4. تصفية الأعضاء (استبعاد المشرفين والبوت نفسه من القرعة)
            const groupAdmins = participants.filter(p => p.admin !== null).map(p => p.id);
            const normalMembers = participants.filter(p => !groupAdmins.includes(p.id));

            // إذا لم يتم العثور على أعضاء عاديين
            if (normalMembers.length === 0) {
                return reply('🤔 المجموعة مفيهاش غير المشرفين بس، مش هقدر أطرد حد!');
            }

            // 5. اختيار عضو عشوائي بالقرعة 🎲
            const randomIndex = Math.floor(Math.random() * normalMembers.length);
            const victim = normalMembers[randomIndex].id;

            // إرسال رسالة تمهيدية قبل الطرد
            await reply(`🎲 *جاري اختيار عضو عشوائي وطره بالقرعة...*`);
            
            // تأخير بسيط لمنح المحادثة واقعية
            await new Promise(resolve => setTimeout(resolve, 1500));

            // 6. تنفذ أمر الطرد (Kick)
            await sock.groupParticipantsUpdate(from, [victim], 'remove');

            // 7. إرسال منشن للعضو اللي اِتطرد
            const mentionTag = `@${victim.split('@')[0]}`;
            await sock.sendMessage(from, {
                text: `✈️ مع السلامة يا ${mentionTag}، حظك سيء وطارت عليك القرعة العشوائية!`,
                mentions: [victim]
            });

        } catch (err) {
            console.error('[RKICK ERROR]', err.message);
            reply('❌ حصلت مشكلة أثناء محاولة الطرد العشوائي.');
        }
    }
};

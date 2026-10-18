'use strict';

const cloud = require('wx-server-sdk');
const ENV_ID = 'cloud1-d4gx1jxk675274501';
cloud.init({ env: ENV_ID });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action || 'sendMessage';

  if (!OPENID) return { success: false, error: 'Authentication required', code: 'UNAUTHENTICATED' };
  // Same active account and role authority as admin; legacy identifiers are not grants.
  let account;
  try {
    const result = await db.collection('admin_accounts')
      .where({ wechatOpenId: OPENID, status: 'active' }).limit(1).get();
    account = result.data && result.data[0];
  } catch (error) {
    return { success: false, error: 'Authorization unavailable', code: 'AUTH_UNAVAILABLE' };
  }
  const isAdmin = !!(account && ['owner', 'operations'].includes(account.role));
  const ownerResult = await db.collection('admin_accounts')
    .where({ role: 'owner', status: 'active' }).limit(1).get().catch(() => ({ data: [] }));
  const owner = ownerResult.data && ownerResult.data[0];
  const adminOpenId = owner && owner.wechatOpenId || 'admin';

  switch (action) {

    case 'sendMessage': {
      const { type, content, imageUrl, toId, orderId } = event;
      const fromId = OPENID;

      // 确定 toId：
      // - 普通用户发送：targetId = adminOpenId（如果有）or 固定占位符 'admin'
      // - 管理员回复（从后台点进某个用户会话）：targetId = toId（用户的 openId）
      // - 管理员自己从"我的"页面进入（没有 toId）：也允许发送，发给自己
      let targetId = toId;
      if (!isAdmin) {
        // 普通用户发给客服
        targetId = adminOpenId || 'admin';
      } else if (!targetId) {
        // 管理员自己进入聊天（没有 toId）：发给自己
        targetId = adminOpenId || 'admin';
      }

      // 会话 ID：始终使用发起方（普通用户）的 openId
      const conversationId = isAdmin ? targetId : fromId;

      const msgData = {
        conversationId,
        fromId,
        toId: targetId,
        type: type || 'text',
        content: content || '',
        imageUrl: imageUrl || '',
        isRead: false,
        isAdmin: !!isAdmin,
        orderId: orderId || '',
        createTime: db.serverDate()
      };

      try {
        const res = await db.collection('messages').add({ data: msgData });
        return {
          success: true,
          messageId: res._id
        };
      } catch (e) {
        console.error('messages add error:', e);
        return { success: false, error: 'DB_ERROR: ' + e.message };
      }
    }

    case 'getMessages': {
      const { conversationId, pageSize = 50, page = 1 } = event;
      // 用户模式：使用自己的 openId；管理员模式：使用传入的 conversationId
      const cid = conversationId || OPENID;
      if (!isAdmin && cid !== OPENID) return { success: false, error: 'Conversation forbidden', code: 'FORBIDDEN' };

      try {
        const res = await db.collection('messages')
          .where({ conversationId: cid })
          .orderBy('createTime', 'asc')
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .get();

        return {
          success: true,
          data: res.data,
          conversationId: cid
        };
      } catch (e) {
        console.error('getMessages error:', e);
        // 集合不存在时返回空数组而不是报错
        return { success: true, data: [], conversationId: cid };
      }
    }

    case 'getConversationList': {
      if (!isAdmin) {
        return { success: false, error: '无管理员权限' };
      }

      try {
        const allMessages = await db.collection('messages')
          .orderBy('createTime', 'desc')
          .limit(1000)
          .get();

        const conversations = {};
        for (const msg of allMessages.data) {
          const cid = msg.conversationId;
          if (!conversations[cid]) {
            conversations[cid] = {
              conversationId: cid,
              lastMessage: msg,
              unreadCount: 0,
              userId: cid
            };
          }
          // 未读：发给管理员且未读
          if (!msg.isRead && !msg.isAdmin) {
            conversations[cid].unreadCount += 1;
          }
        }

        const list = [];
        for (const cid in conversations) {
          const conv = conversations[cid];
          let userInfo = { nickName: '微信用户', avatarUrl: '', openId: cid };
          try {
            const userRes = await db.collection('users')
              .where({ openId: conv.userId })
              .limit(1)
              .get();
            const user = userRes.data[0] || {};
            userInfo = {
              nickName: user.nickName || '微信用户',
              avatarUrl: user.avatarUrl || '',
              openId: conv.userId
            };
          } catch (e) {}
          conv.userInfo = userInfo;
          list.push(conv);
        }

        list.sort((a, b) => {
          const ta = a.lastMessage && a.lastMessage.createTime ? new Date(a.lastMessage.createTime).getTime() : 0;
          const tb = b.lastMessage && b.lastMessage.createTime ? new Date(b.lastMessage.createTime).getTime() : 0;
          return tb - ta;
        });

        return { success: true, data: list };
      } catch (e) {
        console.error('getConversationList error:', e);
        return { success: true, data: [] };
      }
    }

    case 'markAsRead': {
      const { conversationId } = event;
      const cid = conversationId || OPENID;
      if (!isAdmin && cid !== OPENID) return { success: false, error: 'Conversation forbidden', code: 'FORBIDDEN' };

      try {
        await db.collection('messages')
          .where({
            conversationId: cid,
            toId: OPENID,
            isRead: false
          })
          .update({ data: { isRead: true } });
      } catch (e) {}

      return { success: true };
    }

    case 'getUnreadCount': {
      try {
        const count = await db.collection('messages')
          .where({ toId: OPENID, isRead: false })
          .count();
        return { success: true, count: count.total };
      } catch (e) {
        return { success: true, count: 0 };
      }
    }

    default:
      return { success: false, error: 'unknown action: ' + action };
  }
};

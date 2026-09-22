import type { Server, Socket } from "socket.io";
import { prisma } from "../db";
import { verifyToken } from "../auth";
import { groupReactions } from "../reactions";

const ALLOWED_REACTIONS = new Set(["👍", "❤️", "😂", "😮", "😢", "🔥"]);

interface SocketData {
  userId: string;
  username: string;
}

// channelId -> set of socket ids currently in that voice channel
const voiceRooms = new Map<string, Set<string>>();
// channelId -> serverId, remembered so we can broadcast occupancy on leave/disconnect
const channelServerMap = new Map<string, string>();

const DM_CALL_PREFIX = "dmcall:";
// dmChannelId -> in-progress call metadata, used to log a summary message once it ends
const dmCallMeta = new Map<string, { startedAt: number; maxParticipants: number }>();

interface RateState {
  lastSentAt: number;
  blockedCount: number;
}
// userId -> sliding rate-limit state for message:send / dm:send (max 1/sec, warns after 3 blocked in a row)
const rateState = new Map<string, RateState>();

function allowSend(userId: string): { ok: boolean; shouldWarn: boolean } {
  const now = Date.now();
  const st = rateState.get(userId) ?? { lastSentAt: 0, blockedCount: 0 };
  if (now - st.lastSentAt < 1000) {
    st.blockedCount += 1;
    rateState.set(userId, st);
    return { ok: false, shouldWarn: st.blockedCount === 3 };
  }
  st.lastSentAt = now;
  st.blockedCount = 0;
  rateState.set(userId, st);
  return { ok: true, shouldWarn: false };
}

async function logDmCall(
  io: Server,
  dmChannelId: string,
  authorId: string,
  callStatus: "answered" | "missed" | "declined" | "cancelled",
  callSeconds: number | null,
  callParticipants: number | null,
) {
  const channel = await prisma.dMChannel.findUnique({ where: { id: dmChannelId } });
  if (!channel) return;

  const message = await prisma.dMMessage.create({
    data: { dmChannelId, authorId, content: "", type: "call", callStatus, callSeconds, callParticipants },
    include: { author: { select: { id: true, username: true, avatarColor: true } } },
  });

  io.to(`user:${channel.userAId}`).to(`user:${channel.userBId}`).emit("dm:new", message);
}

function voiceRoom(channelId: string) {
  if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Set());
  return voiceRooms.get(channelId)!;
}

function participantsOf(io: Server, channelId: string) {
  const room = voiceRooms.get(channelId);
  if (!room) return [];
  return Array.from(room).map((id) => {
    const s = io.sockets.sockets.get(id);
    const data = s?.data as SocketData | undefined;
    return { socketId: id, userId: data?.userId, username: data?.username };
  });
}

function broadcastOccupancy(io: Server, channelId: string) {
  const serverId = channelServerMap.get(channelId);
  if (!serverId) return;
  io.to(`server:${serverId}`).emit("voice:channel-participants", { channelId, participants: participantsOf(io, channelId) });
}

function maybeEndDmCall(io: Server, channelId: string, remainingSize: number, authorId: string) {
  if (!channelId.startsWith(DM_CALL_PREFIX) || remainingSize > 0) return;
  const meta = dmCallMeta.get(channelId);
  if (!meta) return;
  dmCallMeta.delete(channelId);
  const dmChannelId = channelId.slice(DM_CALL_PREFIX.length);
  const callSeconds = Math.round((Date.now() - meta.startedAt) / 1000);
  void logDmCall(io, dmChannelId, authorId, "answered", callSeconds, meta.maxParticipants);
}

function leaveAllVoiceRooms(io: Server, socket: Socket) {
  const { userId } = socket.data as SocketData;
  for (const [channelId, members] of voiceRooms) {
    if (members.delete(socket.id)) {
      socket.to(`voice:${channelId}`).emit("voice:user-left", { socketId: socket.id });
      socket.leave(`voice:${channelId}`);
      const remainingSize = members.size;
      if (remainingSize === 0) voiceRooms.delete(channelId);
      broadcastOccupancy(io, channelId);
      maybeEndDmCall(io, channelId, remainingSize, userId);
    }
  }
}

export function registerSocketHandlers(io: Server) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const payload = token ? verifyToken(token) : null;
    if (!payload) return next(new Error("Unauthorized"));

    prisma.user.findUnique({ where: { id: payload.userId } }).then((user) => {
      if (!user) return next(new Error("Unauthorized"));
      (socket.data as SocketData) = { userId: user.id, username: user.username };
      next();
    }).catch(() => next(new Error("Unauthorized")));
  });

  io.on("connection", (socket: Socket) => {
    const { userId, username } = socket.data as SocketData;
    socket.join(`user:${userId}`);

    // Register all listeners synchronously before awaiting anything, so events
    // emitted by the client immediately after "connect" are never missed.
    prisma.user.update({ where: { id: userId }, data: { status: "online" } }).then(() => {
      socket.broadcast.emit("presence:update", { userId, status: "online" });
    });

    socket.on("channel:join", (channelId: string) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on("channel:leave", (channelId: string) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on("message:send", async ({ channelId, content }: { channelId: string; content: string }) => {
      const text = String(content ?? "").trim();
      if (!text || !channelId) return;

      const rate = allowSend(userId);
      if (!rate.ok) {
        if (rate.shouldWarn) socket.emit("spam:blocked", { message: "Не отправляйте сообщения так часто" });
        return;
      }

      const channel = await prisma.channel.findUnique({ where: { id: channelId } });
      if (!channel) return;
      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId, serverId: channel.serverId } },
      });
      if (!membership) return;

      const message = await prisma.message.create({
        data: { channelId, authorId: userId, content: text.slice(0, 4000) },
        include: { author: { select: { id: true, username: true, avatarColor: true } } },
      });

      io.to(`channel:${channelId}`).emit("message:new", message);
    });

    socket.on("dm:join", (dmChannelId: string) => {
      socket.join(`dm:${dmChannelId}`);
    });

    socket.on("dm:leave", (dmChannelId: string) => {
      socket.leave(`dm:${dmChannelId}`);
    });

    socket.on("dm:send", async ({ dmChannelId, content }: { dmChannelId: string; content: string }) => {
      const text = String(content ?? "").trim();
      if (!text || !dmChannelId) return;

      const rate = allowSend(userId);
      if (!rate.ok) {
        if (rate.shouldWarn) socket.emit("spam:blocked", { message: "Не отправляйте сообщения так часто" });
        return;
      }

      const channel = await prisma.dMChannel.findUnique({ where: { id: dmChannelId } });
      if (!channel || (channel.userAId !== userId && channel.userBId !== userId)) return;

      const message = await prisma.dMMessage.create({
        data: { dmChannelId, authorId: userId, content: text.slice(0, 4000) },
        include: { author: { select: { id: true, username: true, avatarColor: true } } },
      });

      // Every connected socket is always in its own `user:${id}` room, so this
      // alone delivers to both participants regardless of whether they have the
      // DM open. Do not also emit to `dm:${dmChannelId}` — both participants are
      // covered here, and adding that room would deliver the message twice to
      // anyone who also joined it.
      io.to(`user:${channel.userAId}`).to(`user:${channel.userBId}`).emit("dm:new", message);
    });

    socket.on("reaction:toggle", async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      if (!messageId || !ALLOWED_REACTIONS.has(emoji)) return;

      const message = await prisma.message.findUnique({ where: { id: messageId } });
      if (!message) return;
      const channel = await prisma.channel.findUnique({ where: { id: message.channelId } });
      if (!channel) return;
      const membership = await prisma.serverMember.findUnique({
        where: { userId_serverId: { userId, serverId: channel.serverId } },
      });
      if (!membership) return;

      const existing = await prisma.messageReaction.findUnique({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
      });
      if (existing) {
        await prisma.messageReaction.delete({ where: { id: existing.id } });
      } else {
        await prisma.messageReaction.create({ data: { messageId, userId, emoji } });
      }

      const rows = await prisma.messageReaction.findMany({ where: { messageId }, select: { emoji: true, userId: true } });
      io.to(`channel:${message.channelId}`).emit("message:reactions", { messageId, reactions: groupReactions(rows) });
    });

    socket.on("dm:reaction:toggle", async ({ dmMessageId, emoji }: { dmMessageId: string; emoji: string }) => {
      if (!dmMessageId || !ALLOWED_REACTIONS.has(emoji)) return;

      const message = await prisma.dMMessage.findUnique({ where: { id: dmMessageId } });
      if (!message) return;
      const channel = await prisma.dMChannel.findUnique({ where: { id: message.dmChannelId } });
      if (!channel || (channel.userAId !== userId && channel.userBId !== userId)) return;

      const existing = await prisma.dMMessageReaction.findUnique({
        where: { dmMessageId_userId_emoji: { dmMessageId, userId, emoji } },
      });
      if (existing) {
        await prisma.dMMessageReaction.delete({ where: { id: existing.id } });
      } else {
        await prisma.dMMessageReaction.create({ data: { dmMessageId, userId, emoji } });
      }

      const rows = await prisma.dMMessageReaction.findMany({ where: { dmMessageId }, select: { emoji: true, userId: true } });
      io.to(`user:${channel.userAId}`).to(`user:${channel.userBId}`).emit("dm:reactions", { dmMessageId, reactions: groupReactions(rows) });
    });

    socket.on("typing", ({ channelId }: { channelId: string }) => {
      if (!channelId) return;
      socket.to(`channel:${channelId}`).emit("typing", { channelId, userId, username });
    });

    // --- 1:1 DM calling (ringing handshake; the actual audio reuses the voice:* mesh below) ---
    socket.on("call:invite", ({ dmChannelId, toUserId }: { dmChannelId: string; toUserId: string }) => {
      if (!dmChannelId || !toUserId) return;
      io.to(`user:${toUserId}`).emit("call:incoming", { dmChannelId, fromUserId: userId, fromUsername: username });
    });

    socket.on("call:cancel", ({ dmChannelId, toUserId }: { dmChannelId: string; toUserId: string }) => {
      if (!dmChannelId || !toUserId) return;
      io.to(`user:${toUserId}`).emit("call:cancelled", { dmChannelId, fromUserId: userId });
      void logDmCall(io, dmChannelId, userId, "cancelled", null, null);
    });

    socket.on("call:decline", ({ dmChannelId, toUserId }: { dmChannelId: string; toUserId: string }) => {
      if (!dmChannelId || !toUserId) return;
      io.to(`user:${toUserId}`).emit("call:declined", { dmChannelId, fromUserId: userId });
      void logDmCall(io, dmChannelId, userId, "declined", null, null);
    });

    socket.on("call:accept", ({ dmChannelId, toUserId }: { dmChannelId: string; toUserId: string }) => {
      if (!dmChannelId || !toUserId) return;
      io.to(`user:${toUserId}`).emit("call:accepted", { dmChannelId, fromUserId: userId });
    });

    socket.on("presence:set", async ({ status }: { status: string }) => {
      if (!["online", "idle", "dnd"].includes(status)) return;
      await prisma.user.update({ where: { id: userId }, data: { status } });
      socket.broadcast.emit("presence:update", { userId, status });
    });

    socket.on("server:join", async (serverId: string) => {
      socket.join(`server:${serverId}`);
      const voiceChannels = await prisma.channel.findMany({ where: { serverId, type: "voice" } });
      for (const ch of voiceChannels) {
        channelServerMap.set(ch.id, serverId);
        socket.emit("voice:channel-participants", { channelId: ch.id, participants: participantsOf(io, ch.id) });
      }
    });

    socket.on("server:leave", (serverId: string) => {
      socket.leave(`server:${serverId}`);
    });

    // --- Voice signaling (mesh WebRTC) ---
    socket.on("voice:join", ({ channelId, serverId }: { channelId: string; serverId: string }) => {
      channelServerMap.set(channelId, serverId);
      const room = voiceRoom(channelId);
      const existing = Array.from(room);
      room.add(socket.id);
      socket.join(`voice:${channelId}`);

      if (channelId.startsWith(DM_CALL_PREFIX)) {
        const meta = dmCallMeta.get(channelId) ?? { startedAt: Date.now(), maxParticipants: 0 };
        meta.maxParticipants = Math.max(meta.maxParticipants, room.size);
        dmCallMeta.set(channelId, meta);
      }

      socket.emit("voice:existing-participants", {
        channelId,
        participants: existing.map((id) => {
          const s = io.sockets.sockets.get(id);
          const data = s?.data as SocketData | undefined;
          return { socketId: id, userId: data?.userId, username: data?.username };
        }),
      });

      socket.to(`voice:${channelId}`).emit("voice:user-joined", { socketId: socket.id, userId, username });
      broadcastOccupancy(io, channelId);
    });

    socket.on("voice:leave", (channelId: string) => {
      const room = voiceRoom(channelId);
      if (room.delete(socket.id)) {
        socket.leave(`voice:${channelId}`);
        socket.to(`voice:${channelId}`).emit("voice:user-left", { socketId: socket.id });
        const remainingSize = room.size;
        if (remainingSize === 0) voiceRooms.delete(channelId);
        broadcastOccupancy(io, channelId);
        maybeEndDmCall(io, channelId, remainingSize, userId);
      }
    });

    socket.on("voice:signal", ({ to, data }: { to: string; data: unknown }) => {
      if (!to) return;
      io.to(to).emit("voice:signal", { from: socket.id, userId, username, data });
    });

    socket.on("voice:speaking", ({ channelId, speaking }: { channelId: string; speaking: boolean }) => {
      if (!channelId) return;
      socket.to(`voice:${channelId}`).emit("voice:speaking", { socketId: socket.id, speaking });
    });

    socket.on("disconnect", async () => {
      leaveAllVoiceRooms(io, socket);
      await prisma.user.update({ where: { id: userId }, data: { status: "offline" } }).catch(() => {});
      socket.broadcast.emit("presence:update", { userId, status: "offline" });
    });
  });
}

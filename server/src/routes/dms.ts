import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, type AuthedRequest } from "../auth";
import { getIO } from "../io";

const router = Router();

function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const channels = await prisma.dMChannel.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    include: {
      userA: { select: { id: true, username: true, avatarColor: true, status: true } },
      userB: { select: { id: true, username: true, avatarColor: true, status: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  const result = channels.map((c) => ({
    id: c.id,
    otherUser: c.userAId === userId ? c.userB : c.userA,
    lastMessage: c.messages[0] ?? null,
  }));

  res.json({ dms: result });
});

router.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { userId: otherUserId } = req.body ?? {};
  if (!otherUserId || otherUserId === userId) {
    return res.status(400).json({ error: "A valid other userId is required" });
  }

  const otherUser = await prisma.user.findUnique({ where: { id: otherUserId } });
  if (!otherUser) return res.status(404).json({ error: "User not found" });

  const [userAId, userBId] = orderPair(userId, otherUserId);
  const channel = await prisma.dMChannel.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: {},
    create: { userAId, userBId },
  });

  res.status(201).json({
    dm: { id: channel.id, otherUser: { id: otherUser.id, username: otherUser.username, avatarColor: otherUser.avatarColor, status: otherUser.status } },
  });
});

router.get("/:id/messages", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const channel = await prisma.dMChannel.findUnique({ where: { id: req.params.id } });
  if (!channel || (channel.userAId !== userId && channel.userBId !== userId)) {
    return res.status(403).json({ error: "Not part of this conversation" });
  }

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;

  const messages = await prisma.dMMessage.findMany({
    where: { dmChannelId: channel.id, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { author: { select: { id: true, username: true, avatarColor: true } } },
  });

  res.json({ messages: messages.reverse() });
});

router.delete("/:id/messages", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const channel = await prisma.dMChannel.findUnique({ where: { id: req.params.id } });
  if (!channel || (channel.userAId !== userId && channel.userBId !== userId)) {
    return res.status(403).json({ error: "Not part of this conversation" });
  }

  await prisma.dMMessage.deleteMany({ where: { dmChannelId: channel.id } });

  getIO().to(`user:${channel.userAId}`).to(`user:${channel.userBId}`).emit("dm:cleared", { dmChannelId: channel.id });

  res.json({ ok: true });
});

export default router;

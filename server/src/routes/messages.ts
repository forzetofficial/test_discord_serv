import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, type AuthedRequest } from "../auth";
import { groupReactions } from "../reactions";

const router = Router();

async function canAccessChannel(userId: string, channelId: string) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) return false;
  const membership = await prisma.serverMember.findUnique({
    where: { userId_serverId: { userId, serverId: channel.serverId } },
  });
  return !!membership;
}

router.get("/:channelId/messages", requireAuth, async (req: AuthedRequest, res) => {
  const { channelId } = req.params;
  const allowed = await canAccessChannel(req.userId!, channelId);
  if (!allowed) return res.status(403).json({ error: "Not a member of this server" });

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;

  const messages = await prisma.message.findMany({
    where: { channelId, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      author: { select: { id: true, username: true, avatarColor: true } },
      reactions: { select: { emoji: true, userId: true } },
    },
  });

  res.json({
    messages: messages.reverse().map((m) => ({ ...m, reactions: groupReactions(m.reactions) })),
  });
});

export default router;

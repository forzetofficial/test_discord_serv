import { Router } from "express";
import { prisma } from "../db";
import { requireAuth, type AuthedRequest } from "../auth";
import { getIO } from "../io";

const router = Router();

const userSelect = { id: true, username: true, avatarColor: true, status: true } as const;

function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function areFriends(a: string, b: string) {
  const [userAId, userBId] = orderPair(a, b);
  const existing = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  return !!existing;
}

router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;

  const friendships = await prisma.friendship.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    include: { userA: { select: userSelect }, userB: { select: userSelect } },
  });
  const friends = friendships.map((f) => (f.userAId === userId ? f.userB : f.userA));

  const incoming = await prisma.friendRequest.findMany({
    where: { toUserId: userId },
    include: { fromUser: { select: userSelect } },
    orderBy: { createdAt: "desc" },
  });
  const outgoing = await prisma.friendRequest.findMany({
    where: { fromUserId: userId },
    include: { toUser: { select: userSelect } },
    orderBy: { createdAt: "desc" },
  });

  res.json({
    friends,
    incoming: incoming.map((r) => ({ id: r.id, user: r.fromUser, createdAt: r.createdAt })),
    outgoing: outgoing.map((r) => ({ id: r.id, user: r.toUser, createdAt: r.createdAt })),
  });
});

router.post("/requests", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const username = String(req.body?.username ?? "").trim();
  if (!username) return res.status(400).json({ error: "username is required" });

  const target = await prisma.user.findUnique({ where: { username } });
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });
  if (target.id === userId) return res.status(400).json({ error: "Нельзя добавить себя" });

  if (await areFriends(userId, target.id)) {
    return res.status(409).json({ error: "Вы уже друзья" });
  }

  // If they already sent us a request, accept it instead of creating a duplicate.
  const reverse = await prisma.friendRequest.findUnique({
    where: { fromUserId_toUserId: { fromUserId: target.id, toUserId: userId } },
  });
  if (reverse) {
    const [userAId, userBId] = orderPair(userId, target.id);
    const friendship = await prisma.$transaction(async (tx) => {
      await tx.friendRequest.delete({ where: { id: reverse.id } });
      return tx.friendship.create({
        data: { userAId, userBId },
        include: { userA: { select: userSelect }, userB: { select: userSelect } },
      });
    });
    const me = friendship.userAId === userId ? friendship.userA : friendship.userB;
    const other = friendship.userAId === userId ? friendship.userB : friendship.userA;
    getIO().to(`user:${userId}`).emit("friend:added", { user: other });
    getIO().to(`user:${target.id}`).emit("friend:added", { user: me });
    return res.status(201).json({ status: "accepted", friend: other });
  }

  const existing = await prisma.friendRequest.findUnique({
    where: { fromUserId_toUserId: { fromUserId: userId, toUserId: target.id } },
  });
  if (existing) return res.status(409).json({ error: "Заявка уже отправлена" });

  const request = await prisma.friendRequest.create({
    data: { fromUserId: userId, toUserId: target.id },
    include: { fromUser: { select: userSelect } },
  });

  getIO().to(`user:${target.id}`).emit("friend:request-received", {
    id: request.id,
    user: request.fromUser,
    createdAt: request.createdAt,
  });

  res.status(201).json({ status: "pending", requestId: request.id });
});

router.post("/requests/:id/accept", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.toUserId !== userId) return res.status(404).json({ error: "Заявка не найдена" });

  const [userAId, userBId] = orderPair(request.fromUserId, request.toUserId);
  const friendship = await prisma.$transaction(async (tx) => {
    await tx.friendRequest.delete({ where: { id: request.id } });
    return tx.friendship.create({
      data: { userAId, userBId },
      include: { userA: { select: userSelect }, userB: { select: userSelect } },
    });
  });

  const me = friendship.userAId === userId ? friendship.userA : friendship.userB;
  const other = friendship.userAId === userId ? friendship.userB : friendship.userA;
  getIO().to(`user:${userId}`).emit("friend:added", { user: other });
  getIO().to(`user:${request.fromUserId}`).emit("friend:added", { user: me });

  res.json({ friend: other });
});

router.post("/requests/:id/decline", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.toUserId !== userId) return res.status(404).json({ error: "Заявка не найдена" });

  await prisma.friendRequest.delete({ where: { id: request.id } });
  getIO().to(`user:${request.fromUserId}`).emit("friend:request-declined", { requestId: request.id });

  res.json({ ok: true });
});

router.delete("/requests/:id", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.fromUserId !== userId) return res.status(404).json({ error: "Заявка не найдена" });

  await prisma.friendRequest.delete({ where: { id: request.id } });
  getIO().to(`user:${request.toUserId}`).emit("friend:request-cancelled", { requestId: request.id });

  res.json({ ok: true });
});

router.delete("/:userId", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const otherUserId = req.params.userId;
  const [userAId, userBId] = orderPair(userId, otherUserId);

  const existing = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId, userBId } } });
  if (!existing) return res.status(404).json({ error: "Вы не друзья" });

  await prisma.friendship.delete({ where: { id: existing.id } });

  getIO().to(`user:${userId}`).emit("friend:removed", { userId: otherUserId });
  getIO().to(`user:${otherUserId}`).emit("friend:removed", { userId });

  res.json({ ok: true });
});

export default router;

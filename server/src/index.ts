import "dotenv/config";
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import serverRoutes from "./routes/servers";
import messageRoutes from "./routes/messages";
import dmRoutes from "./routes/dms";
import { registerSocketHandlers } from "./sockets";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/servers", serverRoutes);
app.use("/api/channels", messageRoutes);
app.use("/api/dms", dmRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
registerSocketHandlers(io);

const PORT = Number(process.env.PORT) || 4000;
httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const { ObjectId } = require("mongodb");
const path = require("path");

const app = express();
const server = http.createServer(app);

// ─── Raise timeouts to 120s to avoid idle drops on Render ─────────────────
server.keepAliveTimeout = 120 * 1000; // allow 2 minutes of keep-alive
server.headersTimeout = 120 * 1000; // allow 2 minutes to receive headers

const activeSockets = new Set();
const activeUsers = new Map(); // ─── Track socket → username mappings ─────────────────────────────────────────
const io = new Server(server);

// ─── Health-check ─────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => {
  console.log("⏰ keep-alive ping received at", new Date().toISOString());
  res.send("pong");
});

// ─── Static SPA ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public/home.html"))
);
app.get("/chat", (_req, res) =>
  res.sendFile(path.join(__dirname, "public/chat.html"))
);

// ─── MongoDB Setup ────────────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGODB_URI);
let messagesCollection;

async function initDb() {
  await client.connect();
  console.log("✅ MongoDB connected");
  const db = client.db("community");
  messagesCollection = db.collection("messages");
}

initDb().catch((err) => {
  console.error("❌ Mongo init error:", err);
  process.exit(1);
});


// ─── Socket.io Logic ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🔌 user connected");

  activeSockets.add(socket.id);
  io.emit("online users", activeSockets.size); // update count immediately

  // 0) handle our new "join" event
  socket.on("join", (user) => {
    activeUsers.set(socket.id, user);
    // broadcast to everyone except the newly joined client
    socket.broadcast.emit("user joined", user);
  });

  // 1) load all messages
  if (!messagesCollection) {
    socket.emit("load messages", []);
  } else {
    messagesCollection
      .find({})
      .sort({ timestamp: 1 }) // optional: keeps chronological order
      // .limit(50)               // removed, so we load every document
      .toArray()
      .then((msgs) => socket.emit("load messages", msgs))
      .catch((err) => console.error("❌ load messages error:", err));
  }

  // 2) typing indicators
  socket.on("typing", (user) => {
    socket.broadcast.emit("user typing", user);
  });
  socket.on("stop typing", (user) => {
    socket.broadcast.emit("user stop typing", user);
  });

  // 3) new chat message (with optional replyTo)
  // ─── 3) new chat message (optimistic broadcast + DB write) ──────────────────
  socket.on("chat message", async (data) => {
    const tempId = data._tempId; // client’s temp ID
    const now = new Date();

    // 1) broadcast immediately to everyone with tempId
    io.emit("chat message", {
      _id: tempId,
      username: data.username,
      message: data.message,
      timestamp: now.toISOString(),
      replyTo: data.replyTo || null,
      reactions: {},
    });

    // 2) write to MongoDB
    if (!messagesCollection) return;
    try {
      const doc = {
        username: data.username,
        message: data.message,
        timestamp: now,
        replyTo: data.replyTo || null,
        reactions: {},
      };
      const result = await messagesCollection.insertOne(doc);
      // 3) when we have the real _id, inform clients to swap
      io.emit("chat message saved", {
        _tempId: tempId,
        _id: result.insertedId.toString(),
      });
    } catch (err) {
      console.error("❌ insertOne error:", err);
      // optionally: notify clients of failure and remove optimistic bubble
    }
  });

  // ─── Reaction handlers ──────────────────────────────────────────────────
  socket.on("add reaction", async ({ messageId, emoji, user }) => {
    // —— if it's still a temp-ID, just broadcast
    if (messageId.startsWith("temp-")) {
      // build a minimal reactions object
      io.emit("reactions updated", {
        messageId,
        reactions: { [emoji]: [user] },
      });
      return;
    }
    // —— otherwise, do the normal Mongo update
    if (!messagesCollection) return;
    await messagesCollection.updateOne(
      { _id: new ObjectId(messageId) },
      { $addToSet: { [`reactions.${emoji}`]: user } }
    );
    const { reactions } = await messagesCollection.findOne(
      { _id: new ObjectId(messageId) },
      { projection: { reactions: 1 } }
    );
    io.emit("reactions updated", { messageId, reactions });
  });

  socket.on("remove reaction", async ({ messageId, emoji, user }) => {
    if (messageId.startsWith("temp-")) {
      io.emit("reactions updated", {
        messageId,
        reactions: { [emoji]: [] },
      });
      return;
    }
    if (!messagesCollection) return;
    await messagesCollection.updateOne(
      { _id: new ObjectId(messageId) },
      { $pull: { [`reactions.${emoji}`]: user } }
    );
    const { reactions } = await messagesCollection.findOne(
      { _id: new ObjectId(messageId) },
      { projection: { reactions: 1 } }
    );
    io.emit("reactions updated", { messageId, reactions });
  });

  socket.on("disconnect", () => {
    console.log("❌ user disconnected");
    const user = activeUsers.get(socket.id);
    if (user) {
      // notify everyone else
      socket.broadcast.emit("user left", user);
      activeUsers.delete(socket.id); // clean up username mapping
    }

    activeSockets.delete(socket.id); // always remove from socket tracker
    io.emit("online users", activeSockets.size); // broadcast updated count
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`🚀 Listening on http://${HOST}:${PORT}`);
});

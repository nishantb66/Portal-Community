require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const { ObjectId } = require("mongodb");
const path = require("path");

const app = express();
const server = http.createServer(app);
const activeUsers = new Map(); // ─── Track socket → username mappings ─────────────────────────────────────────
const io = new Server(server);

// ─── Health-check ─────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));

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

  // 0) handle our new "join" event
  socket.on("join", (user) => {
    activeUsers.set(socket.id, user);
    // broadcast to everyone except the newly joined client
    socket.broadcast.emit("user joined", user);
  });

  // 1) load last 50 messages
  if (!messagesCollection) {
    socket.emit("load messages", []);
  } else {
    messagesCollection
      .find({})
      .sort({ timestamp: 1 })
      .limit(50)
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
  socket.on("chat message", (data) => {
    const doc = {
      username: data.username,
      message: data.message,
      timestamp: new Date(),
      replyTo: data.replyTo || null,
      reactions: {},
    };

    if (!messagesCollection) return;
    messagesCollection
      .insertOne(doc)
      .then((result) => {
        doc._id = result.insertedId; // attach the new _id
        io.emit("chat message", doc); // broadcast full doc
      })
      .catch((err) => console.error("❌ insertOne error:", err));
  });

  // ─── Reaction handlers ──────────────────────────────────────────────────
  socket.on("add reaction", async ({ messageId, emoji, user }) => {
    if (!messagesCollection) return;
    await messagesCollection.updateOne(
      { _id: new ObjectId(messageId) },
      { $addToSet: { [`reactions.${emoji}`]: user } }
    );
    // broadcast to all
    // 2) re-fetch the full, updated reactions object
    const { reactions } = await messagesCollection.findOne(
      { _id: new ObjectId(messageId) },
      { projection: { reactions: 1 } }
    );
    // 3) broadcast the brand-new state
    io.emit("reactions updated", { messageId, reactions });
  });

  socket.on("remove reaction", async ({ messageId, emoji, user }) => {
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
      activeUsers.delete(socket.id);
    }
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});

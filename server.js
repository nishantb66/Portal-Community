// server.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Health-check (for Render) ────────────────────────────────────────────────
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

  // Load up to last 50 messages (or empty array if DB not ready yet)
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

  // New incoming message
  socket.on("chat message", (data) => {
    const doc = {
      username: data.username,
      message: data.message,
      timestamp: new Date(),
    };

    if (messagesCollection) {
      messagesCollection
        .insertOne(doc)
        .then(() => io.emit("chat message", doc))
        .catch((err) => console.error("❌ insertOne error:", err));
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ user disconnected");
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
// FALLBACK to 3000 locally if process.env.PORT is undefined
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Listening on port ${PORT}`);
});

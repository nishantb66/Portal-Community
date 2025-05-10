require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// ─── Helper: one stable collection name for any two usernames ─────────────────
function getDmCollectionName(u1, u2) {
  const [a, b] = [u1, u2].sort((a, b) => a.localeCompare(b));
  return `dms_${a}_${b}`;
}

// ─── UTIL: remove every space character from a string ───────────────────
function stripSpaces(str) {
  return str.replace(/\s+/g, "");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ─── Trackers for public chat ─────────────────────────────────────────────────
const activeSockets = new Set();
const activeUsers = new Map(); // socket.id → username
let messagesCollection; // for public chat

// ─── Trackers for private DMs ────────────────────────────────────────────────
const dmOnlineCount = new Map(); // username → open-socket count
const dmLastSeen = new Map(); // username → last disconnect date

// ─── Private‐chat toggle state ────────────────────────────────────────────────
let isPrivate = false;
let allowedUsers = new Set();

// ─── Idle‐timeout tracking for public chat ───────────────────────────────────
let lastActivity = Date.now();
const lastSeen = new Map(); // username → last disconnect date

// ─── Deletion‐poll state for public chat ────────────────────────────────────
let deletionInProgress = false;
let deletionLocked = false;
let deletionPoll = {
  initiator: null,
  initiatorSocketId: null,
  votes: {}, // { username: true|false }
};

// ─── Health‐check ─────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => {
  console.log("⏰ keep-alive ping at", new Date().toISOString());
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

let usersCollection, otpsCollection, resetsCollection; // for DM auth

async function initDb() {
  await client.connect();
  console.log("✅ MongoDB connected");
  const db = client.db("community");

  // Public chat messages
  messagesCollection = db.collection("messages");

  // DM‐related collections
  usersCollection = db.collection("users");
  otpsCollection = db.collection("otps");
  resetsCollection = db.collection("password_resets");
}
initDb().catch((err) => {
  console.error("❌ Mongo init error:", err);
  process.exit(1);
});

// ─── JSON‐body middleware ─────────────────────────────────────────────────────
app.use(express.json());

// ─── JWT auth middleware ─────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ message: "Forbidden" });
    req.user = payload;
    next();
  });
}

// ─── Email transporter (Gmail) ───────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL, pass: process.env.APP_PASS },
});

// ─── 1) DM‐Signup → send OTP ─────────────────────────────────────────────────
app.post("/dm/signup", async (req, res) => {
  try {
    let { email, username, password } = req.body;
    if (!email || !username || !password)
      return res.status(400).json({ message: "Missing fields" });

    // 1) strip whitespace everywhere
    email = email.trim();
    username = stripSpaces(username);
    password = stripSpaces(password);

    // 2) check uniqueness
    if (await usersCollection.findOne({ email })) {
      return res
        .status(400)
        .json({ message: "That email is already registered." });
    }
    if (await usersCollection.findOne({ username })) {
      return res
        .status(400)
        .json({ message: "That username is already taken." });
    }
    if (await usersCollection.findOne({ password })) {
      return res
        .status(400)
        .json({ message: "Please choose a different password." });
    }

    // 3) proceed with OTP generation
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await otpsCollection.insertOne({ email, otp, expires });

    await transporter.sendMail({
      from: process.env.EMAIL,
      to: email,
      subject: "Your DM-OTP Code",
      text: `Your one-time code is ${otp} (expires in 10 minutes).`,
    });

    res.json({ message: "OTP sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 2) DM‐Verify OTP → create user & JWT ────────────────────────────────────
app.post("/dm/verify-otp", async (req, res) => {
  try {
    const { email, username, password, otp } = req.body;
    if (!email || !username || !password || !otp)
      return res.status(400).json({ message: "Missing fields" });

    const otpDoc = await otpsCollection.findOne({ email, otp });
    if (!otpDoc || otpDoc.expires < new Date())
      return res.status(400).json({ message: "Invalid or expired OTP" });

    await usersCollection.insertOne({ email, username, password });
    await otpsCollection.deleteOne({ _id: otpDoc._id });

    const token = jwt.sign({ username, email }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.json({ token, username, email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 3) DM‐Login ─────────────────────────────────────────────────────────────
app.post("/dm/login", async (req, res) => {
  try {
    let { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ message: "Missing fields" });

    // 1) strip whitespace everywhere
    username = stripSpaces(username);
    password = stripSpaces(password);

    // 2) find & verify
    const user = await usersCollection.findOne({ username });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }
    if (user.password !== password) {
      return res.status(400).json({ message: "Invalid password" });
    }

    // 3) issue JWT
    const token = jwt.sign(
      { username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );
    res.json({ token, username: user.username, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

const RESET_EXPIRE_MS = 10 * 60 * 1000; // 10 minutes

// ─── 1) Request reset OTP ────────────────────────────────────────────
app.post("/password/forgot", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Missing email" });

    // 1) Does user exist?
    const user = await usersCollection.findOne({ email: email.trim() });
    if (!user) {
      return res.status(400).json({ message: "Email id not found" });
    }

    // 2) generate + store OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + RESET_EXPIRE_MS);
    await resetsCollection.insertOne({ email, otp, expires });

    // 3) send mail
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: email,
      subject: "Your password-reset code",
      text: `Hello ${user.username},\n\nYour password reset code is ${otp}. It expires in 10 minutes.\n\nIf you did not request this, please ignore.`,
    });

    // 4) return username + expiry so front-end can show countdown
    res.json({ username: user.username, expires: expires.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 2) Verify that the reset‐OTP is correct ───────────────────────────
app.post("/password/verify-reset-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ message: "Missing fields" });

    // find matching, non-expired document
    const doc = await resetsCollection.findOne({
      email,
      otp,
      expires: { $gt: new Date() },
    });
    if (!doc) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    // ok!
    res.json({ message: "OTP verified" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 3) Actually reset the password ────────────────────────────────────
app.post("/password/reset", async (req, res) => {
  try {
    const { email, otp, password } = req.body;
    if (!email || !otp || !password)
      return res.status(400).json({ message: "Missing fields" });

    // 1) re-verify OTP + expiry
    const doc = await resetsCollection.findOne({
      email,
      otp,
      expires: { $gt: new Date() },
    });
    if (!doc) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    // 2) update user's password
    await usersCollection.updateOne(
      { email },
      { $set: { password: password.trim() } }
    );

    // 3) clean up the reset token
    await resetsCollection.deleteMany({ email });

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 4) DM‐List users ───────────────────────────────────────────────────────
app.get("/dm/users", authenticateToken, async (req, res) => {
  try {
    const me = req.user.username;
    const docs = await usersCollection
      .find({ username: { $ne: me } })
      .project({ username: 1, _id: 0 })
      .toArray();
    res.json({ users: docs.map((d) => d.username) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 5) DM‐History for a pair ──────────────────────────────────────────────
app.get("/dm/history/:other", authenticateToken, async (req, res) => {
  try {
    const me = req.user.username;
    const peer = req.params.other;
    const name = getDmCollectionName(me, peer);
    const col = client.db("community").collection(name);

    const msgs = await col
      .find({
        $or: [
          { from: me, to: peer },
          { from: peer, to: me },
        ],
      })
      .sort({ timestamp: 1 })
      .toArray();

    await col.updateMany(
      { from: peer, to: me, read: false },
      { $set: { read: true } }
    );

    res.json({ messages: msgs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 6) DM‐Unread counts ───────────────────────────────────────────────────
app.get("/dm/unreadCounts", authenticateToken, async (req, res) => {
  try {
    const me = req.user.username;
    const counts = {};
    const cols = await client.db("community").listCollections().toArray();

    for (let { name } of cols) {
      if (!name.startsWith("dms_")) continue;
      const parts = name.slice(4).split("_");
      if (!parts.includes(me)) continue;
      const peer = parts.find((u) => u !== me);
      const col = client.db("community").collection(name);

      const agg = await col
        .aggregate([
          { $match: { to: me, read: false } },
          { $group: { _id: "$from", cnt: { $sum: 1 } } },
        ])
        .toArray();

      agg.forEach(({ _id, cnt }) => (counts[_id] = cnt));
    }

    res.json({ counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── 7) DM‐Search autocomplete ────────────────────────────────────────────
app.get("/dm/search", authenticateToken, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ users: [] });

  const re = new RegExp("^" + q.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i");
  const me = req.user.username;
  const docs = await usersCollection
    .find({ username: re, username: { $ne: me } })
    .project({ username: 1, _id: 0 })
    .limit(10)
    .toArray();

  res.json({ users: docs.map((d) => d.username) });
});

// ─── 8) DM‐Past conversations ─────────────────────────────────────────────
app.get("/dm/past", authenticateToken, async (req, res) => {
  try {
    const me = req.user.username;
    const chats = [];
    const cols = await client.db("community").listCollections().toArray();

    for (let { name } of cols) {
      if (!name.startsWith("dms_")) continue;
      const parts = name.slice(4).split("_");
      if (!parts.includes(me)) continue;
      const peer = parts.find((u) => u !== me);
      const col = client.db("community").collection(name);

      const last = await col.find().sort({ timestamp: -1 }).limit(1).toArray();
      if (last.length) chats.push({ peer, ts: last[0].timestamp });
    }

    chats.sort((a, b) => b.ts - a.ts);
    res.json({ recent: chats.map((c) => c.peer) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── Serve Private‐DM page ─────────────────────────────────────────────────
app.get("/privateDM.html", (_req, res) =>
  res.sendFile(path.join(__dirname, "public/privateDM.html"))
);

// ─── Socket.IO namespace for DMs ───────────────────────────────────────────
const dmNamespace = io.of("/dm");

dmNamespace.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Unauthorized"));
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return next(new Error("Forbidden"));
    socket.user = payload.username;
    next();
  });
});

dmNamespace.on("connection", (socket) => {
  const user = socket.user;

  // mark online
  dmOnlineCount.set(user, (dmOnlineCount.get(user) || 0) + 1);
  dmNamespace.emit("presence", { user, status: "online" });
  socket.join(user);

  // ─── respond to presence queries ───────────────────────────────────────
  socket.on("get presence", ({ user: target }) => {
    if (dmOnlineCount.has(target)) {
      // user is actually online right now
      socket.emit("presence", { user: target, status: "online" });
    } else if (dmLastSeen.has(target)) {
      // user has connected before, show their real last‐disconnect time
      const last = dmLastSeen.get(target);
      socket.emit("presence", {
        user: target,
        status: "offline",
        lastSeen: last.toISOString(),
      });
    } else {
      // user never connected → show simply “Offline” (no timestamp)
      socket.emit("presence", {
        user: target,
        status: "offline",
        lastSeen: null,
      });
    }
  });

  // new DM message
  // ─── in server.js, inside dmNamespace.on("connection", socket => { … })
  // find the bit that starts with:
  //   // new DM message
  //   socket.on("dm message", async ({ to, message, _tempId, replyTo }) => { … })
  // and replace the entire handler with this:

  // ─── new DM message (robust reply embedding) ────────────────────────────
  socket.on("dm message", async ({ to, message, _tempId, replyTo }) => {
    const now = new Date();
    const colName = getDmCollectionName(user, to);
    const col = client.db("community").collection(colName);

    // 1) figure out the full reply‐to payload
    let replyToData = null;
    if (replyTo) {
      // If the client already sent us an embedded object, use it directly:
      if (typeof replyTo === "object" && replyTo._id) {
        replyToData = replyTo;
      }
      // Otherwise if it's a valid 24-char hex string, load from DB:
      else if (
        typeof replyTo === "string" &&
        /^[0-9a-fA-F]{24}$/.test(replyTo)
      ) {
        try {
          const parentDoc = await col.findOne({ _id: new ObjectId(replyTo) });
          if (parentDoc) {
            replyToData = {
              _id: parentDoc._id.toString(),
              from: parentDoc.from,
              message: parentDoc.message,
              timestamp: parentDoc.timestamp,
            };
          }
        } catch (e) {
          console.warn("Could not load parent message for reply:", e);
        }
      }
      // else: it wasn’t a valid ID, so we just skip embedding
    }

    // 2) build optimistic payload with embedded replyToData (or null)
    const optimistic = {
      _id: _tempId,
      from: user,
      to,
      message,
      timestamp: now.toISOString(),
      read: false,
      replyTo: replyToData, // <-- always an object or null
    };

    // 3) broadcast that to both sides (instant UX)
    dmNamespace.to(to).emit("dm message", optimistic);
    dmNamespace.to(user).emit("dm message", optimistic);

    // 4) now persist (with replyToData inside)
    const dbDoc = { ...optimistic, timestamp: now };
    const result = await col.insertOne(dbDoc);
    const realId = result.insertedId.toString();

    // 5) swap temp → real ID for both sides
    dmNamespace.to(to).emit("dm message saved", { _tempId, _id: realId });
    dmNamespace.to(user).emit("dm message saved", { _tempId, _id: realId });
  });

  // typing indicators
  socket.on("typing", ({ to }) => {
    dmNamespace.to(to).emit("user typing", user);
  });
  socket.on("stop typing", ({ to }) => {
    dmNamespace.to(to).emit("user stop typing", user);
  });

  // keep-alive pong
  socket.on("ping", () => socket.emit("pong"));

  // on disconnect
  socket.on("disconnect", () => {
    const cnt = (dmOnlineCount.get(user) || 1) - 1;
    if (cnt > 0) {
      dmOnlineCount.set(user, cnt);
    } else {
      dmOnlineCount.delete(user);
      const when = new Date();
      dmLastSeen.set(user, when);
      dmNamespace.emit("presence", {
        user,
        status: "offline",
        lastSeen: when.toISOString(),
      });
    }
  });
});

// ─── Public chat / group logic ───────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🔌 user connected");

  socket.emit("private status", isPrivate);
  activeSockets.add(socket.id);
  io.emit("online users", activeSockets.size);

  // join event
  socket.on("join", (user) => {
    if (isPrivate && !allowedUsers.has(user)) {
      return socket.emit("join error", "Chat is private. You cannot enter.");
    }
    activeUsers.set(socket.id, user);
    socket.emit("join success", user);
    socket.broadcast.emit("user joined", user);

    lastSeen.delete(user);
    io.emit("update online list", Array.from(activeUsers.values()));
    io.emit(
      "update last-seen list",
      Array.from(lastSeen.entries()).map(([u, dt]) => ({
        user: u,
        timestamp: dt.toISOString(),
      }))
    );
  });

  // load messages
  if (!messagesCollection) {
    socket.emit("load messages", []);
  } else {
    messagesCollection
      .find({})
      .sort({ timestamp: 1 })
      .toArray()
      .then((msgs) => socket.emit("load messages", msgs))
      .catch((err) => console.error("❌ load messages error:", err));
  }

  // typing indicators
  socket.on("typing", (user) => {
    lastActivity = Date.now();
    socket.broadcast.emit("user typing", user);
  });
  socket.on("stop typing", (user) => {
    lastActivity = Date.now();
    socket.broadcast.emit("user stop typing", user);
  });

  // client "activity" ping
  socket.on("activity", () => {
    lastActivity = Date.now();
  });

  // new chat message
  socket.on("chat message", async (data) => {
    lastActivity = Date.now();
    const tempId = data._tempId;
    const now = new Date();

    io.emit("chat message", {
      _id: tempId,
      username: data.username,
      message: data.message,
      timestamp: now.toISOString(),
      replyTo: data.replyTo || null,
      reactions: {},
    });

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
      io.emit("chat message saved", {
        _tempId: tempId,
        _id: result.insertedId.toString(),
      });
    } catch (err) {
      console.error("❌ insertOne error:", err);
    }
  });

  // reactions
  socket.on("add reaction", async ({ messageId, emoji, user }) => {
    if (messageId.startsWith("temp-")) {
      io.emit("reactions updated", {
        messageId,
        reactions: { [emoji]: [user] },
      });
      return;
    }
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

  // disconnect
  socket.on("disconnect", () => {
    console.log("❌ user disconnected");
    const user = activeUsers.get(socket.id);
    if (user) {
      socket.broadcast.emit("user left", user);
      activeUsers.delete(socket.id);
    }

    activeSockets.delete(socket.id);
    io.emit("online users", activeSockets.size);

    if (user) {
      lastSeen.set(user, new Date());
    }
    io.emit("update online list", Array.from(activeUsers.values()));
    io.emit(
      "update last-seen list",
      Array.from(lastSeen.entries()).map(([u, dt]) => ({
        user: u,
        timestamp: dt.toISOString(),
      }))
    );

    if (isPrivate && activeUsers.size === 0) {
      isPrivate = false;
      allowedUsers.clear();
      io.emit("private status", false);
    }
  });

  // private toggle
  socket.on("set private", (state) => {
    isPrivate = !!state;
    if (isPrivate) {
      allowedUsers = new Set(activeUsers.values());
    } else {
      allowedUsers.clear();
    }
    io.emit("private status", isPrivate);
  });

  // deletion poll: initiate
  socket.on("initiate delete poll", () => {
    const userCount = activeUsers.size;
    const user = activeUsers.get(socket.id);

    if (deletionLocked) {
      return socket.emit("delete poll denied", "Deletion is locked.");
    }
    if (deletionInProgress) {
      return socket.emit(
        "delete poll denied",
        "A poll is already in progress."
      );
    }
    if (userCount < 2) {
      return socket.emit("delete poll denied", "Need ≥2 users online.");
    }

    deletionInProgress = true;
    deletionPoll.initiator = user;
    deletionPoll.initiatorSocketId = socket.id;
    deletionPoll.votes = { [user]: true };

    socket.broadcast.emit("delete poll started", { initiator: user });
    io.emit("update delete button state", { disabled: true });
  });

  // deletion poll: vote
  socket.on("delete vote", (vote) => {
    if (!deletionInProgress) return;
    const user = activeUsers.get(socket.id);
    if (!user || deletionPoll.votes[user] != null) return;

    deletionPoll.votes[user] = !!vote;
    const votes = Object.values(deletionPoll.votes);
    const yesCount = votes.filter((v) => v).length;
    const noCount = votes.filter((v) => !v).length;
    const total = activeUsers.size;
    const needed = Math.floor(total / 2) + 1;

    io.emit("delete poll update", { yes: yesCount, no: noCount, total });
    if (yesCount >= needed) {
      io.to(deletionPoll.initiatorSocketId).emit("delete poll result", {
        approved: true,
      });
    } else if (noCount >= needed || votes.length === total) {
      io.to(deletionPoll.initiatorSocketId).emit("delete poll result", {
        approved: false,
      });
      deletionInProgress = false;
      deletionPoll = { initiator: null, initiatorSocketId: null, votes: {} };
      io.emit("update delete button state", { disabled: false });
    }
  });

  // deletion confirm
  socket.on("confirm delete", async () => {
    if (socket.id !== deletionPoll.initiatorSocketId || !deletionInProgress)
      return;
    if (messagesCollection) await messagesCollection.deleteMany({});
    io.emit("chat deleted");
    deletionInProgress = false;
    deletionLocked = true;
    io.emit("update delete button state", { disabled: true });
    setTimeout(() => {
      deletionLocked = false;
      io.emit("update delete button state", { disabled: false });
    }, 5 * 60 * 1000);
  });
});

// ─── Auto‐public after 8m of silence ─────────────────────────────────────────
const IDLE_LIMIT = 8 * 60 * 1000;
setInterval(() => {
  if (isPrivate && Date.now() - lastActivity >= IDLE_LIMIT) {
    isPrivate = false;
    allowedUsers.clear();
    io.emit("private status", false);
  }
}, 60 * 1000);

// ─── Daily clear of last‐seen at midnight IST ───────────────────────────────
function scheduleDailyClear() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(now.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const msUntil = nextMidnight - now;

  setTimeout(() => {
    lastSeen.clear();
    io.emit("update last-seen list", []);
    scheduleDailyClear();
  }, msUntil);
}
scheduleDailyClear();

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`🚀 Listening on http://${HOST}:${PORT}`);
});

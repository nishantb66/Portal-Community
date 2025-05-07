require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const { ObjectId } = require("mongodb");
const path = require("path");
// ─── 1) New imports ───────────────────────────────────────────────────
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const nodemailer= require('nodemailer');

let usersCollection, otpsCollection, dmsCollection;

const app = express();
const server = http.createServer(app);

// ─── Raise timeouts to 120s to avoid idle drops on Render ─────────────────
server.keepAliveTimeout = 120 * 1000; // allow 2 minutes of keep-alive
server.headersTimeout = 120 * 1000; // allow 2 minutes to receive headers

const activeSockets = new Set();
const activeUsers = new Map(); // ─── Track socket → username mappings ─────────────────────────────────────────
const io = new Server(server);

// ─── Private-chat state ─────────────────────────────────────────────────────────
let isPrivate = false;
let allowedUsers = new Set();

// ─── Idle-timeout tracking ─────────────────────────────────────────────────────
let lastActivity = Date.now();

const lastSeen = new Map(); // username → Date of last disconnect

// ─── Community-deletion state ────────────────────────────────────────
let deletionInProgress = false;
let deletionLocked = false;
let deletionPoll = {
  initiator: null, // username
  initiatorSocketId: null,
  votes: {}, // { username: true|false, … }
};

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

  // ← add these
  usersCollection = db.collection("users");
  otpsCollection = db.collection("otps");
  dmsCollection = db.collection("dms");
}

// ─── 3) JSON-body middleware ──────────────────────────────────────────
app.use(express.json());  // ensure this is above your new routes

// ─── 4) JWT auth middleware ──────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']||'';
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message:'Unauthorized' });
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ message:'Forbidden' });
    req.user = payload; 
    next();
  });
}


initDb().catch((err) => {
  console.error("❌ Mongo init error:", err);
  process.exit(1);
});

// ─── 5) Email transporter ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL, pass: process.env.APP_PASS }
});

// ─── 6) Signup → send OTP ─────────────────────────────────────────────
app.post('/dm/signup', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email||!username||!password)
      return res.status(400).json({ message:'Missing fields' });

    // no dupes
    const exists = await usersCollection.findOne({
      $or:[{email},{username}]
    });
    if (exists)
      return res.status(400).json({ message:'Email or username taken' });

    // generate & store OTP
    const otp = Math.floor(100000 + Math.random()*900000).toString();
    const expires = new Date(Date.now() + 10*60*1000); // 10m
    await otpsCollection.insertOne({ email, otp, expires });

    // send via Gmail
    await transporter.sendMail({
      from: process.env.EMAIL,
      to: email,
      subject:'Your DM-OTP Code',
      text:`Your one-time code is ${otp} (expires in 10 minutes).`
    });

    res.json({ message:'OTP sent' });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message:'Server error' });
  }
});

// ─── 7) Verify OTP → create user & JWT ───────────────────────────────
app.post('/dm/verify-otp', async (req, res) => {
  try {
    const { email, username, password, otp } = req.body;
    if (!email || !username || !password || !otp)
      return res.status(400).json({ message: "Missing fields" });

    const otpDoc = await otpsCollection.findOne({ email, otp });
    if (!otpDoc || otpDoc.expires < new Date())
      return res.status(400).json({ message: "Invalid or expired OTP" });

    // hash & store user
    const hash = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({ email, username, password: hash });
    await otpsCollection.deleteOne({ _id: otpDoc._id });

    // ─── SIGN JWT WITH BOTH username AND email ───────────────────────────
    const token = jwt.sign({ username, email }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    res.json({ token, username, email });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message:'Server error' });
  }
});

// ─── 8) Login route ───────────────────────────────────────────────────
app.post('/dm/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ message: "Missing fields" });

    const user = await usersCollection.findOne({ username });
    if (!user) return res.status(400).json({ message: "User not found" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ message: "Invalid password" });

    // ─── SIGN JWT WITH username AND email ─────────────────────────────
    const token = jwt.sign(
      { username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    res.json({ token, username: user.username, email: user.email });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message:'Server error' });
  }
});

// ─── 9) List other users ──────────────────────────────────────────────
app.get('/dm/users', authenticateToken, async (req, res) => {
  try {
    const you = req.user.username;
    const docs = await usersCollection
                  .find({ username:{ $ne:you } })
                  .project({ username:1, _id:0 })
                  .toArray();
    res.json({ users: docs.map(d=>d.username) });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message:'Server error' });
  }
});

// ───10) DM history between two users ───────────────────────────────────
app.get('/dm/history/:other', authenticateToken, async (req, res) => {
  try {
    const me    = req.user.username;
    const peer  = req.params.other;
    const msgs  = await dmsCollection.find({
      $or: [
        { from:me,   to:peer },
        { from:peer, to:me   }
      ]
    }).sort({ timestamp:1 }).toArray();
    res.json({ messages: msgs });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message:'Server error' });
  }
});

// ───11) Serve the DM page ───────────────────────────────────────────────
app.get('/privateDM.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public','privateDM.html'));
});

// ───12) Socket.io namespace for DMs ───────────────────────────────────
const dmNamespace = io.of('/dm');

// authenticate each socket by JWT
dmNamespace.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return next(new Error('Forbidden'));
    socket.user = payload.username;
    next();
  });
});

dmNamespace.on('connection', socket => {
  // join personal room
  socket.join(socket.user);

  // handle a DM
  socket.on('dm message', async ({ to, message }) => {
    const doc = {
      from: socket.user,
      to,
      message,
      timestamp: new Date()
    };
    // store
    await dmsCollection.insertOne(doc);
    // emit to both parties
    dmNamespace.to(to).emit('dm message', doc);
    dmNamespace.to(socket.user).emit('dm message', doc);
  });
});

// ─── Socket.io Logic ─────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🔌 user connected");

  // let each newcomer know the current privacy state
  socket.emit("private status", isPrivate);

  activeSockets.add(socket.id);
  io.emit("online users", activeSockets.size); // update count immediately

  // 0) handle our new "join" event
  socket.on("join", (user) => {
    // if private and not in the original snapshot, reject
    if (isPrivate && !allowedUsers.has(user)) {
      return socket.emit(
        "join error",
        "Currently the chat is Private. You cannot enter."
      );
    }

    // otherwise allow
    activeUsers.set(socket.id, user);
    // let this client know they succeeded
    socket.emit("join success", user);

    // notify everyone else that someone joined
    socket.broadcast.emit("user joined", user);

    lastSeen.delete(user); // remove from last‐seen if they come back online
    io.emit("update online list", Array.from(activeUsers.values()));
    io.emit(
      "update last-seen list",
      Array.from(lastSeen.entries()).map(([user, dt]) => ({
        user,
        timestamp: dt.toISOString(),
      }))
    );
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
    lastActivity = Date.now();
    socket.broadcast.emit("user typing", user);
  });
  socket.on("stop typing", (user) => {
    lastActivity = Date.now();
    socket.broadcast.emit("user stop typing", user);
  });

  // any client-side “I moved my mouse / typed a key” ping
  socket.on("activity", () => {
    lastActivity = Date.now();
  });

  // 3) new chat message (with optional replyTo)
  // ─── 3) new chat message (optimistic broadcast + DB write) ──────────────────
  socket.on("chat message", async (data) => {
    lastActivity = Date.now();
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

    if (user) {
      lastSeen.set(user, new Date());
    }
    io.emit("update online list", Array.from(activeUsers.values()));
    io.emit(
      "update last-seen list",
      Array.from(lastSeen.entries()).map(([user, dt]) => ({
        user,
        timestamp: dt.toISOString(),
      }))
    );

    // if private and now empty, open it back up
    if (isPrivate && activeUsers.size === 0) {
      isPrivate = false;
      allowedUsers.clear();
      io.emit("private status", false);
    }
  });

  // any client flipped the “private” switch?
  socket.on("set private", (state) => {
    isPrivate = !!state;
    if (isPrivate) {
      // snapshot current participants by username
      allowedUsers = new Set(activeUsers.values());
    } else {
      allowedUsers.clear();
    }
    // broadcast to everyone
    io.emit("private status", isPrivate);
  });

  // ─── 4) Initiate deletion poll ─────────────────────────────────────
  socket.on("initiate delete poll", () => {
    const userCount = activeUsers.size;
    const user = activeUsers.get(socket.id);

    if (deletionLocked) {
      return socket.emit(
        "delete poll denied",
        "Deletion is locked. Please wait a few minutes."
      );
    }
    if (deletionInProgress) {
      return socket.emit(
        "delete poll denied",
        "A deletion vote is already in progress."
      );
    }
    if (userCount < 2) {
      return socket.emit(
        "delete poll denied",
        "At least two users must be online to delete the chat."
      );
    }

    // start the poll
    deletionInProgress = true;
    deletionPoll.initiator = user;
    deletionPoll.initiatorSocketId = socket.id;
    deletionPoll.votes = {};
    deletionPoll.votes[user] = true;

    // broadcast to everyone
    socket.broadcast.emit("delete poll started", { initiator: user });
    io.emit("update delete button state", { disabled: true });
  });

  // ─── 5) Tally votes ─────────────────────────────────────────────────
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

    // majority YES → tell initiator but keep poll open until final confirm
    if (yesCount >= needed) {
      io.to(deletionPoll.initiatorSocketId).emit("delete poll result", {
        approved: true,
      });
    }
    // majority NO or all voted → fail and reset poll
    else if (noCount >= needed || votes.length === total) {
      io.to(deletionPoll.initiatorSocketId).emit("delete poll result", {
        approved: false,
      });

      deletionInProgress = false;
      deletionPoll = { initiator: null, initiatorSocketId: null, votes: {} };
      io.emit("update delete button state", { disabled: false });
    }
  });

  // ─── 6) Confirm & perform deletion ───────────────────────────────────
  socket.on("confirm delete", async () => {
    if (socket.id !== deletionPoll.initiatorSocketId || !deletionInProgress)
      return;

    if (messagesCollection) {
      await messagesCollection.deleteMany({});
    }
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

// ─── Auto-public after 8m of silence ───────────────────────────────────────────
const IDLE_LIMIT = 8 * 60 * 1000; // 8 minutes
setInterval(() => {
  if (isPrivate && Date.now() - lastActivity >= IDLE_LIMIT) {
    isPrivate = false;
    allowedUsers.clear();
    io.emit("private status", false);
  }
}, 60 * 1000); // check every minute

// ─── Schedule a daily reset of lastSeen at midnight IST ────────────────────
function scheduleDailyClear() {
  const now = new Date();
  // Compute next midnight in local server time:
  const nextMidnight = new Date(now);
  nextMidnight.setDate(now.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const msUntilMidnight = nextMidnight - now;

  setTimeout(() => {
    lastSeen.clear(); // wipe all last-seen entries
    io.emit("update last-seen list", []); // notify clients the list is now empty
    scheduleDailyClear(); // schedule again for next day
  }, msUntilMidnight);
}

scheduleDailyClear();

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`🚀 Listening on http://${HOST}:${PORT}`);
});

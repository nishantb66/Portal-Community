let unreadCounts = {}; // global map username→count
const me = () => localStorage.getItem("dmUsername");

// ─── REPLY FEATURE STATE ─────────────────────────────────────────────
const msgsById = {}; // map message‐ID → { _id, from, message }
let replyTo = null; // currently replying to { _id, from, message }

function showReplyPreview(msg) {
  replyTo = msg;
  document.getElementById(
    "reply-text"
  ).textContent = `Replying to ${msg.from}: ${msg.message}`;
  document.getElementById("reply-preview").classList.remove("hidden");
  document.getElementById("dm-input").focus();
}

function clearReplyPreview() {
  replyTo = null;
  document.getElementById("reply-preview").classList.add("hidden");
}

// A) fetch unread counts from server
async function loadUnreadCounts(token) {
  const res = await fetch("/dm/unreadCounts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { counts } = await res.json();
  unreadCounts = counts || {};
}

// B) update one badge in the sidebar
function updateBadge(user) {
  const li = document.querySelector(`#past-list li[data-user="${user}"]`);
  if (!li) return;
  const span = li.querySelector(".unread-badge");
  const n = unreadCounts[user] || 0;
  if (n > 0) {
    span.textContent = n;
    span.classList.remove("hidden");
  } else {
    span.classList.add("hidden");
  }
}

// C) rebuild the Recent Chats list, injecting badges
async function renderPastChats(token) {
  await loadUnreadCounts(token);
  const res = await fetch("/dm/past", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { recent } = await res.json();
  const ul = document.getElementById("past-list");
  ul.innerHTML = recent
    .map(
      (u) => `
    <li data-user="${u}" class="flex justify-between items-center px-3 py-2.5 hover:bg-indigo-50 rounded-lg cursor-pointer transition-colors">
      <div class="flex items-center">
        <div class="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center uppercase font-semibold mr-3">
          ${u.charAt(0)}
        </div>
        <span class="username font-medium">${u}</span>
      </div>
      <span class="unread-badge ml-2 h-5 min-w-5 flex items-center justify-center text-white bg-indigo-600 rounded-full px-1.5 text-xs font-medium ${
        !unreadCounts[u] ? "hidden" : ""
      }">
        ${unreadCounts[u] || ""}
      </span>
    </li>
  `
    )
    .join("");
}

// ———————————
// for optimistic UI
// ———————————
function makeTempId() {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// SCROLL HELPER: always keep chat at the bottom
function scrollToBottom() {
  const container = document.getElementById("messages-container");
  container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
}

document.addEventListener("DOMContentLoaded", () => {
  // ─── Form elements ─────────────────────────────────────────────────────
  const loginForm = document.getElementById("login-form");
  const signupForm = document.getElementById("signup-form");
  const otpForm = document.getElementById("otp-form");
  const authContainer = document.getElementById("auth-container");
  const dmApp = document.getElementById("dm-app");

  let tempSignup = {};

  // ─── Toggle between Login & Signup ────────────────────────────────────
  document.getElementById("show-signup").onclick = (e) => {
    e.preventDefault();
    loginForm.classList.add("hidden");
    signupForm.classList.remove("hidden");
  };
  document.getElementById("show-login").onclick = (e) => {
    e.preventDefault();
    signupForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
  };

  document.getElementById("cancel-reply").addEventListener("click", (e) => {
    e.preventDefault();
    clearReplyPreview();
  });

  // ─── SIGNUP: request OTP ───────────────────────────────────────────────
  document.getElementById("signup-btn").onclick = async () => {
    const email = document.getElementById("signup-email").value;
    const user = document.getElementById("signup-username").value;
    const pass = document.getElementById("signup-password").value;
    const err = document.getElementById("signup-error");
    err.textContent = "";

    try {
      const res = await fetch("/dm/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username: user, password: pass }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);

      tempSignup = { email, username: user, password: pass };
      signupForm.classList.add("hidden");
      otpForm.classList.remove("hidden");
    } catch (e) {
      err.textContent = e.message;
    }
  };

  // ─── VERIFY OTP → create account + JWT ────────────────────────────────
  document.getElementById("verify-otp-btn").onclick = async () => {
    const otp = document.getElementById("otp-input").value;
    const err = document.getElementById("otp-error");
    err.textContent = "";

    try {
      const res = await fetch("/dm/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tempSignup, otp }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);

      onLoginSuccess(j.token, j.username, j.email);
    } catch (e) {
      err.textContent = e.message;
    }
  };

  // ─── LOGIN ────────────────────────────────────────────────────────────
  document.getElementById("login-btn").onclick = async () => {
    const user = document.getElementById("login-username").value;
    const pass = document.getElementById("login-password").value;
    const err = document.getElementById("login-error");
    err.textContent = "";

    try {
      const res = await fetch("/dm/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);

      onLoginSuccess(j.token, j.username, j.email);
    } catch (e) {
      err.textContent = e.message;
    }
  };

  document.getElementById("back-btn").addEventListener("click", () => {
    // stop sending keep-alive pings
    clearInterval(pingInterval);

    // swap views
    document.getElementById("chat-container").classList.add("hidden");
    document.getElementById("chat-list").classList.remove("hidden");

    // re-fetch your recent‐chat list so any newly‐added peer appears immediately
    const token = localStorage.getItem("dmToken");
    renderPastChats(token);
  });

  // ─── ON LOGIN SUCCESS ─────────────────────────────────────────────────
  function onLoginSuccess(token, username, email) {
    // 1) store
    localStorage.setItem("dmToken", token);
    localStorage.setItem("dmUsername", username);
    localStorage.setItem("dmEmail", email);

    // 2) swap UI
    authContainer.classList.add("hidden");
    dmApp.classList.remove("hidden");

    // 3) init live features
    initChat(token);
    renderPastChats(token);
  }

  // ─── INIT SOCKET.IO DM NAMESPACE ──────────────────────────────────────
  let dmSocket = null;
  let pingInterval;
  let lastDate = null; // ← will hold the last‐seen day (IST) so we can insert separators

  function initChat(token) {
    if (dmSocket) dmSocket.disconnect();

    dmSocket = io("/dm", { auth: { token } });
    dmSocket.on("connect_error", (e) => alert(e.message));

    // — KEEP-ALIVE PINGS —
    // every 30s, if we have an open peer chat, emit “ping”
    if (typeof pingInterval !== "undefined") clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (currentPeer) dmSocket.emit("ping");
    }, 30_000);

    // optional: listen for server “pong” to confirm
    dmSocket.on("pong", () => {
      console.debug("DM ping/pong ok for", currentPeer);
    });

    // clear on disconnect
    dmSocket.on("disconnect", () => {
      clearInterval(pingInterval);
    });

    dmSocket.on("dm message", (msg) => {
      // 1) bump my unread-badge if it's someone else messaging me
      if (msg.to === me() && msg.from !== currentPeer) {
        unreadCounts[msg.from] = (unreadCounts[msg.from] || 0) + 1;
        updateBadge(msg.from);
      }

      // 2) if the chat with this peer is open, show it
      if (msg.from === currentPeer || msg.to === currentPeer) {
        appendMsg(msg);
      }

      // 3) if someone DMed me, refresh sidebar so they appear
      if (msg.to === me() && msg.from !== currentPeer) {
        renderPastChats(token);
      }

      // 4) if I just sent a DM, refresh sidebar so my new peer appears
      if (msg.from === me()) {
        renderPastChats(token);
      }
    });

    // when the server confirms the save, swap temp → real ID
    dmSocket.on("dm message saved", ({ _tempId, _id }) => {
      // swap the LI's data attribute
      const li = document.querySelector(
        `#dm-messages li[data-message-id="${_tempId}"]`
      );
      if (li) li.setAttribute("data-message-id", _id);

      // move our in-memory slot
      if (msgsById[_tempId]) {
        msgsById[_id] = msgsById[_tempId];
        delete msgsById[_tempId];
      }

      // if user is replying to that optimistic message, update replyTo
      if (replyTo && replyTo._id === _tempId) {
        replyTo._id = _id;
      }
    });

    // ─── SHOW / HIDE TYPING INDICATOR ───────────────────────────────────
    dmSocket.on("user typing", (user) => {
      if (user === me()) return; // ignore yourself
      const ind = document.getElementById("typing-indicator");
      ind.textContent = `${user} is typing…`;
    });
    dmSocket.on("user stop typing", (user) => {
      if (user === me()) return;
      document.getElementById("typing-indicator").textContent = "";
    });

    // ─── PRESENCE UPDATES ───────────────────────────────────────────────
    dmSocket.on("presence", ({ user, status, lastSeen }) => {
      if (user !== currentPeer) return;
      const el = document.getElementById("chat-status");
      if (status === "online") {
        el.textContent = "Online";
      } else {
        const d = new Date(lastSeen);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        el.textContent = `Last seen at ${hh}:${mm}`;
      }
    });
  }

  // ─── LIVE SEARCH AUTOCOMPLETE ────────────────────────────────────────
  const searchInput = document.getElementById("user-search");
  const suggUl = document.getElementById("search-suggestions");
  let suggTimeout;

  searchInput.addEventListener("input", () => {
    clearTimeout(suggTimeout);
    const q = searchInput.value.trim();
    if (!q) return void suggUl.classList.add("hidden");

    suggTimeout = setTimeout(async () => {
      const token = localStorage.getItem("dmToken");
      const res = await fetch(`/dm/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const { users } = await res.json();

      suggUl.innerHTML = users
        .map(
          (u) =>
            `<li class="px-4 py-2 hover:bg-indigo-50 cursor-pointer transition-colors">${u}</li>`
        )
        .join("");
      suggUl.classList.toggle("hidden", users.length === 0);
    }, 200);
  });

  // click suggestion → open chat
  suggUl.addEventListener("click", (e) => {
    if (e.target.tagName === "LI") {
      openChatWith(e.target.textContent);
      suggUl.classList.add("hidden");
      searchInput.value = "";
    }
  });

  // ─── LOAD RECENT CHATS ────────────────────────────────────────────────
  async function loadPastChats(token) {
    const res = await fetch("/dm/past", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { recent } = await res.json();
    const ul = document.getElementById("past-list");
    ul.innerHTML = recent
      .map(
        (u) =>
          `<li class="px-2 py-1 hover:bg-indigo-50 cursor-pointer">${u}</li>`
      )
      .join("");

    ul.querySelectorAll("li").forEach((li) => {
      li.onclick = () => openChatWith(li.textContent);
    });
  }

  // ─── Typing Indicator (immediate on desktop & mobile) ─────────────────
  const dmInput = document.getElementById("dm-input");
  // how long (ms) after the last keystroke before we send “stop typing”
  const STOP_TYPING_DELAY = 300;
  let typing = false;
  let lastTypingTime = 0;

  // send “typing” and reset our idle timer
  function startTyping() {
    if (!currentPeer) return;
    if (!typing) {
      typing = true;
      dmSocket.emit("typing", { to: currentPeer });
    }
    lastTypingTime = Date.now();
  }

  // if the user hasn’t typed for STOP_TYPING_DELAY, fire “stop typing”
  function scheduleStopTyping() {
    setTimeout(() => {
      const delta = Date.now() - lastTypingTime;
      if (typing && delta >= STOP_TYPING_DELAY) {
        dmSocket.emit("stop typing", { to: currentPeer });
        typing = false;
      }
    }, STOP_TYPING_DELAY);
  }

  // fire immediately on keydown (best for mobile) and also on input
  dmInput.addEventListener("keydown", () => {
    startTyping();
    scheduleStopTyping();
  });
  dmInput.addEventListener("input", () => {
    startTyping();
    scheduleStopTyping();
  });

  // as soon as the field loses focus, clear the typing indicator
  dmInput.addEventListener("blur", () => {
    if (typing) {
      dmSocket.emit("stop typing", { to: currentPeer });
      typing = false;
    }
  });

  // ─── OPEN AN INDIVIDUAL CHAT ────────────────────────────────────────
  let currentPeer = null;
  async function openChatWith(username) {
    lastDate = null;

    currentPeer = username;

    // ─── NEW: clear out old msgsById so we only map messages for this peer ───
    Object.keys(msgsById).forEach((k) => delete msgsById[k]);
    clearReplyPreview(); // also clear any dangling reply UI

    // 1) Toggle views: hide sidebar, show chat
    document.getElementById("chat-list").classList.add("hidden");
    document.getElementById("chat-container").classList.remove("hidden");

    // 2) Update header
    document.getElementById("chat-with").textContent = username;

    // clear old status…
    document.getElementById("chat-status").textContent = "";
    // ask server immediately for this peer’s current presence
    dmSocket.emit("get presence", { user: username });

    // 3) Fetch DM history (server also marks them read)
    const token = localStorage.getItem("dmToken");
    let res;
    try {
      res = await fetch(`/dm/history/${username}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Network response was not OK");
    } catch (err) {
      console.error("Failed to load history:", err);
      return;
    }
    const { messages } = await res.json();

    // 4) Render messages & scroll to bottom
    const msgUl = document.getElementById("dm-messages");
    msgUl.innerHTML = "";
    messages.forEach(appendMsg);

    const msgContainer = document.getElementById("messages-container");
    msgContainer.scrollTop = msgContainer.scrollHeight;

    // 5) Clear unread badge for this peer
    unreadCounts[username] = 0;
    updateBadge(username);

    // 6) Hook up the send form (remove any old handler first)
    const form = document.getElementById("dm-form");
    form.onsubmit = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      sendMsg();
    };

    // 7) Clear & focus the input
    const input = document.getElementById("dm-input");
    input.value = "";
    input.focus();
  }

  // ─── DELEGATED CLICK FOR RECENT CHATS ────────────────────────────────
  document.getElementById("past-list").addEventListener("click", (evt) => {
    // find the <li data-user="…"> that was clicked
    const li = evt.target.closest("li[data-user]");
    if (!li) return;
    openChatWith(li.dataset.user);
  });

  // ─── APPEND A MESSAGE TO THE UI ──────────────────────────────────────
  function appendMsg(msg) {
    // 0) DATE DIVIDER (Today / Yesterday / DD Mon YYYY)
    //    in IST, once per day block
    const container = document.getElementById("dm-messages");
    // key for this msg’s date in IST
    const msgDateKey = new Date(msg.timestamp).toLocaleDateString("en-GB", {
      timeZone: "Asia/Kolkata",
    });
    if (msgDateKey !== lastDate) {
      // build label
      const todayKey = new Date().toLocaleDateString("en-GB", {
        timeZone: "Asia/Kolkata",
      });
      const yest = new Date();
      yest.setDate(yest.getDate() - 1);
      const yesterdayKey = yest.toLocaleDateString("en-GB", {
        timeZone: "Asia/Kolkata",
      });

      let label;
      if (msgDateKey === todayKey) label = "Today";
      else if (msgDateKey === yesterdayKey) label = "Yesterday";
      else {
        label = new Date(msg.timestamp).toLocaleDateString("en-GB", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          year: "numeric",
        });
      }

      const sep = document.createElement("li");
      sep.className =
        "date-separator text-center text-xs text-surface-500 my-2";
      sep.textContent = label;
      container.appendChild(sep);
      lastDate = msgDateKey;
    }

    // 1) dedupe
    if (
      document.querySelector(`#dm-messages li[data-message-id="${msg._id}"]`)
    ) {
      return;
    }

    // 2) store in map
    // new — also remember replyTo on each msg
    msgsById[msg._id] = {
      _id: msg._id,
      from: msg.from,
      message: msg.message,
      replyTo: msg.replyTo || null,
    };

    // 3) build LI
    const li = document.createElement("li");
    li.setAttribute("data-message-id", msg._id);
    li.className = `mb-3 ${
      localStorage.getItem("dmUsername") === msg.from
        ? "self-end"
        : "self-start"
    } new-message`;

    // 4) if this is a reply, render a quote bubble
    if (msg.replyTo && msgsById[msg.replyTo]) {
      const parent = msgsById[msg.replyTo];
      const qb = document.createElement("div");
      qb.className =
        "quote-bubble text-xs p-2 bg-gray-100 border-l-4 border-indigo-400 mb-1 cursor-pointer rounded-r";
      qb.textContent = `${parent.from}: ${parent.message}`;
      qb.addEventListener("click", () => {
        const target = document.querySelector(
          `#dm-messages li[data-message-id="${parent._id}"]`
        );
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("message-highlight");
          setTimeout(() => target.classList.remove("message-highlight"), 3000);
        }
      });
      li.appendChild(qb);
    }

    // 5) main message bubble
    const isMe = localStorage.getItem("dmUsername") === msg.from;
    const msgBubble = document.createElement("div");
    msgBubble.className = `msg-bubble ${
      isMe ? "msg-outgoing" : "msg-incoming"
    }`;

    // Create username and timestamp elements
    const bubbleHeader = document.createElement("div");
    bubbleHeader.className = "flex justify-between items-center mb-1";

    const username = document.createElement("span");
    username.className = `text-xs font-medium ${
      isMe ? "text-indigo-700" : "text-gray-700"
    }`;
    username.textContent = msg.from;

    const timestamp = document.createElement("span");
    timestamp.className = "text-xs text-gray-800 ml-2";
    const time = msg.timestamp ? new Date(msg.timestamp) : new Date();
    timestamp.textContent = time.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    bubbleHeader.appendChild(username);
    bubbleHeader.appendChild(timestamp);

    // Message content
    const messageContent = document.createElement("div");
    messageContent.className = "break-words";
    messageContent.textContent = msg.message;

    // Add double-click for reply functionality
    // msgBubble.ondblclick = () => showReplyPreview(msgsById[msg._id]);

    msgBubble.appendChild(bubbleHeader);
    msgBubble.appendChild(messageContent);
    li.appendChild(msgBubble);

    // 6) append + ALWAYS scroll
    document.getElementById("dm-messages").appendChild(li);
    scrollToBottom();
  }

  // ─── SEND A NEW MESSAGE ──────────────────────────────────────────────
  function sendMsg() {
    const input = document.getElementById("dm-input");
    const txt = input.value.trim();
    if (!txt || !currentPeer) return;

    // 1) generate a tempId
    const tempId = makeTempId();
    const from = localStorage.getItem("dmUsername");
    const optimistic = {
      _id: tempId,
      from,
      to: currentPeer,
      message: txt,
      timestamp: new Date().toISOString(),
      replyTo: replyTo ? replyTo._id : null, // ← carry the reply ID
    };

    // 2) append immediately (with replyTo!)
    appendMsg(optimistic);

    // 3) actually emit to server
    dmSocket.emit("dm message", {
      to: currentPeer,
      message: txt,
      _tempId: tempId,
      replyTo: replyTo ? replyTo._id : null,
    });

    // 4) clear input & preview
    input.value = "";
    clearReplyPreview();
    input.focus();
  }

  // ─── Swipe→Reply (touch) ─────────────────────────────────────────────
  const dmMessages = document.getElementById("dm-messages");
  let swipingLi = null,
    startX = 0,
    startY = 0;
  const SWIPE_THRESHOLD = 60;

  dmMessages.addEventListener("touchstart", (e) => {
    const li = e.target.closest("li[data-message-id]");
    if (!li) return;
    swipingLi = li;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    li.style.transition = "none";
  });

  dmMessages.addEventListener("touchmove", (e) => {
    if (!swipingLi) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (dx > 0) {
      swipingLi.style.transform = `translateX(${dx}px)`;
      e.preventDefault();
    }
  });

  dmMessages.addEventListener("touchend", (e) => {
    if (swipingLi) {
      const dx = e.changedTouches[0].clientX - startX;
      swipingLi.style.transition = "transform 0.3s ease";
      swipingLi.style.transform = "translateX(0)";
      if (dx > SWIPE_THRESHOLD) {
        const mid = swipingLi.getAttribute("data-message-id");
        const data = msgsById[mid];
        if (data) showReplyPreview(data);
      }
    }
    swipingLi = null;
  });

  // ─── DELEGATED DOUBLE‐CLICK FOR REPLY ──────────────────────────────
  dmMessages.addEventListener("dblclick", (e) => {
    // find the message bubble
    const bubble = e.target.closest(".msg-bubble");
    if (!bubble) return;
    // find its <li data-message-id="…">
    const li = bubble.closest("li[data-message-id]");
    if (!li) return;
    const mid = li.getAttribute("data-message-id");
    const msg = msgsById[mid];
    if (!msg) return;
    showReplyPreview(msg);
  });

  // ─── LOGOUT ──────────────────────────────────────────────────────────
  document.getElementById("logout-btn").onclick = () => {
    // clear any outstanding ping timer on logout
    clearInterval(pingInterval);
    // then proceed with your existing logout logic:
    ["dmToken", "dmUsername", "dmEmail"].forEach((k) =>
      localStorage.removeItem(k)
    );
    document.getElementById("dm-app").classList.add("hidden");
    document.getElementById("auth-container").classList.remove("hidden");

    // reset auth forms
    loginForm.classList.remove("hidden");
    signupForm.classList.add("hidden");
    otpForm.classList.add("hidden");
    document.getElementById("login-username").value = "";
    document.getElementById("login-password").value = "";
    document.getElementById("login-error").textContent = "";
  };

  // ─── Check for mobile viewport adjustments ───────────────────────────
  function adjustForMobile() {
    // Adjust for iOS safari viewport issues with keyboard
    const isMobile = window.matchMedia("(max-width: 640px)").matches;

    if (isMobile) {
      // Add focus/blur handlers for better mobile keyboard experience
      document.getElementById("dm-input").addEventListener("focus", () => {
        // Small delay to ensure the keyboard is fully shown
        setTimeout(() => {
          const msgContainer = document.getElementById("messages-container");
          msgContainer.scrollTop = msgContainer.scrollHeight;
        }, 300);
      });
    }
  }

  // Run mobile adjustments
  adjustForMobile();
  window.addEventListener("resize", adjustForMobile);

  // ─── Auto-login from localStorage if token exists ─────────────────────
  const savedToken = localStorage.getItem("dmToken");
  const savedUsername = localStorage.getItem("dmUsername");
  const savedEmail = localStorage.getItem("dmEmail");

  if (savedToken && savedUsername) {
    onLoginSuccess(savedToken, savedUsername, savedEmail);
  }
});

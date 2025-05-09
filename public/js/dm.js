let unreadCounts = {}; // global map username→count
const me = () => localStorage.getItem("dmUsername");

// ─── REPLY FEATURE STATE ─────────────────────────────────────────────
const msgsById = {}; // map message‐ID → { _id, from, message }

// let replyTo = null; // currently replying to { _id, from, message }

// function showReplyPreview(msg) {
//   replyTo = msg;
//   document.getElementById(
//     "reply-text"
//   ).textContent = `Replying to ${msg.from}: ${msg.message}`;
//   document.getElementById("reply-preview").classList.remove("hidden");
//   document.getElementById("dm-input").focus();
// }

// function clearReplyPreview() {
//   replyTo = null;
//   document.getElementById("reply-preview").classList.add("hidden");
// }

let replyTo = null;

// show the preview banner
function showReplyPreview(msg) {
  replyTo = msg;
  const preview = document.getElementById("reply-preview");
  document.getElementById(
    "reply-text"
  ).textContent = `Replying to ${msg.from}: ${msg.message}`;
  preview.classList.remove("hidden");
}

// hide the preview banner
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
  const sidebarLoading = document.getElementById("sidebar-loading");
  const pastList = document.getElementById("past-list");
  sidebarLoading.classList.remove("hidden");
  pastList.classList.add("hidden");

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

  // hide spinner, show list
  sidebarLoading.classList.add("hidden");
  pastList.classList.remove("hidden");
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
  const emptyState = document.getElementById("empty-state");

  const newChatBtn = document.getElementById("new-chat-btn");
  if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
      document.getElementById("user-search").focus();
    });
  }
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

  document.getElementById("cancel-reply").onclick = (e) => {
    e.preventDefault();
    clearReplyPreview();
  };
  // ─── SIGNUP: request OTP ───────────────────────────────────────────────
  document.getElementById("signup-btn").onclick = async () => {
    // 1) grab & strip spaces
    const email = document.getElementById("signup-email").value.trim();
    const user = document
      .getElementById("signup-username")
      .value.replace(/\s+/g, "");
    const pass = document
      .getElementById("signup-password")
      .value.replace(/\s+/g, "");
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
    // strip spaces on client too
    const user = document
      .getElementById("login-username")
      .value.replace(/\s+/g, "");
    const pass = document
      .getElementById("login-password")
      .value.replace(/\s+/g, "");
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

    // clear the “current peer” so no stray presence updates sneak through
    currentPeer = null;
    // clear the header status text
    const statusEl = document.getElementById("chat-status");
    if (statusEl) statusEl.textContent = "";

    // swap views
    document.getElementById("chat-container").classList.add("hidden");
    document.getElementById("chat-list").classList.remove("hidden");

    if (emptyState) emptyState.classList.remove("hidden");

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

    // ─── Floating typing indicator setup ───────────────────────
    const typingFloating = document.getElementById("typing-floating");

    dmSocket.on("user typing", (user) => {
      if (user === me()) return;
      typingFloating.classList.remove("hidden");
    });

    dmSocket.on("user stop typing", (user) => {
      if (user === me()) return;
      typingFloating.classList.add("hidden");
    });
    // ───────────────────────────────────────────────────────────

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

      renderPastChats(token);
    });

    // ─── PRESENCE UPDATES ───────────────────────────────────────────────
    dmSocket.on("presence", ({ user, status, lastSeen }) => {
      // only if the chat panel is open AND it's the peer we're looking at:
      const chatContainer = document.getElementById("chat-container");
      if (chatContainer.classList.contains("hidden")) return;
      if (user !== currentPeer) return;

      const el = document.getElementById("chat-status");
      if (status === "online") {
        el.textContent = "Online";
      } else {
        if (lastSeen) {
          // show real timestamp
          const d = new Date(lastSeen);
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          el.textContent = `Last seen at ${hh}:${mm}`;
        } else {
          // user never connected before
          el.textContent = "Offline";
        }
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

  // — Enhanced typing triggers for desktop & mobile —
  ["keydown", "input", "compositionstart"].forEach((evt) => {
    dmInput.addEventListener(evt, () => {
      startTyping();
      scheduleStopTyping();
    });
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
    if (emptyState) emptyState.classList.add("hidden");
    lastDate = null;
    currentPeer = username;

    // ─── clear out old msgsById & reply UI ───────────────────────────────
    Object.keys(msgsById).forEach((k) => delete msgsById[k]);
    clearReplyPreview();

    // ─── 1) Toggle views: hide sidebar, show chat ───────────────────────
    document.getElementById("chat-list").classList.add("hidden");
    document.getElementById("chat-container").classList.remove("hidden");

    // ─── 2) Update header & presence ────────────────────────────────────
    document.getElementById("chat-with").textContent = username;
    document.getElementById("chat-status").textContent = "";
    dmSocket.emit("get presence", { user: username });

    // ─── 3) Show chat‐loading spinner, hide old messages ────────────────
    const chatLoading = document.getElementById("chat-loading");
    const msgUl = document.getElementById("dm-messages");
    chatLoading.classList.remove("hidden");
    msgUl.classList.add("hidden");

    // ─── Fetch DM history (server also marks them read) ────────────────
    const token = localStorage.getItem("dmToken");
    let res;
    try {
      res = await fetch(`/dm/history/${username}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Network response was not OK");
    } catch (err) {
      console.error("Failed to load history:", err);
      // hide spinner if error
      chatLoading.classList.add("hidden");
      msgUl.classList.remove("hidden");
      return;
    }

    const { messages } = await res.json();

    // ─── 4) Render messages & scroll to bottom ─────────────────────────
    msgUl.innerHTML = "";
    messages.forEach(appendMsg);

    // ─── 5) Hide spinner, show loaded messages ────────────────────────
    chatLoading.classList.add("hidden");
    msgUl.classList.remove("hidden");

    const msgContainer = document.getElementById("messages-container");
    msgContainer.scrollTop = msgContainer.scrollHeight;

    // ─── 6) Clear unread badge for this peer ───────────────────────────
    unreadCounts[username] = 0;
    updateBadge(username);

    // ─── 7) Hook up the send form ──────────────────────────────────────
    const form = document.getElementById("dm-form");
    form.onsubmit = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      sendMsg();
    };

    // ─── 8) Clear & focus the input ──────────────────────────────────
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
    const container = document.getElementById("dm-messages");

    // 0) DATE DIVIDER (Today / Yesterday / DD Mon YYYY) — IST
    const msgDateKey = new Date(msg.timestamp).toLocaleDateString("en-GB", {
      timeZone: "Asia/Kolkata",
    });
    if (msgDateKey !== lastDate) {
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

    // 1) Deduplicate
    if (container.querySelector(`li[data-message-id="${msg._id}"]`)) {
      return;
    }

    // 2) Store in map for lookups (replyTo becomes the parent’s _id)
    msgsById[msg._id] = {
      _id: msg._id,
      from: msg.from,
      message: msg.message,
      timestamp: msg.timestamp,
      replyTo: msg.replyTo ? msg.replyTo._id : null,
    };

    // 3) Build the <li>
    const li = document.createElement("li");
    li.setAttribute("data-message-id", msg._id);
    const isMe = me() === msg.from;
    li.className = `mb-3 ${isMe ? "self-end" : "self-start"} new-message`;

    // 4) If this is a reply, render the quoted bubble
    if (msg.replyTo && msg.replyTo._id) {
      const parent = msg.replyTo;
      // seed the parent in our map so quote-click works
      msgsById[parent._id] = {
        _id: parent._id,
        from: parent.from,
        message: parent.message,
        timestamp: parent.timestamp,
        replyTo: parent.replyTo ? parent.replyTo._id : null,
      };

      const quote = document.createElement("div");
      quote.className =
        "quote-bubble text-xs p-2 bg-gray-100 border-l-4 border-indigo-400 mb-1 cursor-pointer rounded-r";
      quote.textContent = `${parent.from}: ${parent.message}`;
      quote.addEventListener("click", () => {
        const target = container.querySelector(
          `li[data-message-id="${parent._id}"]`
        );
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("message-highlight");
          setTimeout(() => target.classList.remove("message-highlight"), 3000);
        }
      });
      li.appendChild(quote);
    }

    // 5) Main message bubble
    const msgBubble = document.createElement("div");
    msgBubble.className = `msg-bubble ${
      isMe ? "msg-outgoing" : "msg-incoming"
    }`;

    // ─── Header: username + timestamp ─────────────────────────────
    const bubbleHeader = document.createElement("div");
    bubbleHeader.className = "flex justify-between items-center mb-1";

    const usernameSpan = document.createElement("span");
    usernameSpan.className = `text-xs font-medium ${
      isMe ? "text-indigo-400" : "text-gray-400"
    }`;
    usernameSpan.textContent = msg.from;

    const timestampSpan = document.createElement("span");
    timestampSpan.className = "text-xs text-gray-400 ml-2";
    timestampSpan.textContent = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    bubbleHeader.appendChild(usernameSpan);
    bubbleHeader.appendChild(timestampSpan);

    // ─── Message text ────────────────────────────────────────────
    const messageContent = document.createElement("div");
    messageContent.className = "break-words";
    messageContent.textContent = msg.message;

    msgBubble.appendChild(bubbleHeader);
    msgBubble.appendChild(messageContent);

    // 6) Double-click → start a reply
    msgBubble.addEventListener("dblclick", () => {
      showReplyPreview(msgsById[msg._id]);
    });

    li.appendChild(msgBubble);

    // 7) Append and scroll
    container.appendChild(li);
    scrollToBottom();
  }

  // ─── SEND A NEW MESSAGE ──────────────────────────────────────────────
  // function sendMsg() {
  //   const input = document.getElementById("dm-input");
  //   const txt = input.value.trim();
  //   if (!txt || !currentPeer) return;

  //   // 1) generate a tempId
  //   const tempId = makeTempId();
  //   const from = localStorage.getItem("dmUsername");
  //   const optimistic = {
  //     _id: tempId,
  //     from,
  //     to: currentPeer,
  //     message: txt,
  //     timestamp: new Date().toISOString(),
  //     replyTo: replyTo ? replyTo._id : null, // ← carry the reply ID
  //   };

  //   // 2) append immediately (with replyTo!)
  //   appendMsg(optimistic);

  //   // 3) actually emit to server
  //   dmSocket.emit("dm message", {
  //     to: currentPeer,
  //     message: txt,
  //     _tempId: tempId,
  //     replyTo: replyTo ? replyTo._id : null,
  //   });

  //   // 4) clear input & preview
  //   input.value = "";
  //   clearReplyPreview();
  //   input.focus();
  // }

  function sendMsg() {
    const input = document.getElementById("dm-input");
    const text = input.value.trim();
    if (!text || !currentPeer) return;

    const tempId = `temp-${Date.now()}`;
    // pass replyTo._id so server can look up the full parent
    const replyId = replyTo ? replyTo._id : null;

    // Optimistic show
    appendMsg({
      _id: tempId,
      from: me(),
      to: currentPeer,
      message: text,
      timestamp: new Date().toISOString(),
      replyTo: replyId,
    });

    dmSocket.emit("dm message", {
      to: currentPeer,
      message: text,
      _tempId: tempId,
      replyTo: replyId,
    });

    input.value = "";
    clearReplyPreview();
  }

  // ─── Swipe→Reply (touch) ─────────────────────────────────────────────

  //
  // ─── DELEGATED REPLY HANDLERS ────────────────────────────────────────
  //
  const dmMessages = document.getElementById("dm-messages");

  // double-click to reply (desktop)
  document.getElementById("dm-messages").addEventListener("dblclick", (e) => {
    const bub = e.target.closest(".msg-bubble");
    if (!bub) return;
    const li = bub.closest("li[data-message-id]");
    if (!li) return;
    const mid = li.dataset.messageId;
    if (msgsById[mid]) showReplyPreview(msgsById[mid]);
  });

  // swipe-right to reply (mobile)
  let swipeLi = null,
    startX = 0;
  const THRESH = 60;
  const msgsCont = document.getElementById("dm-messages");

  msgsCont.addEventListener("touchstart", (e) => {
    const li = e.target.closest("li[data-message-id]");
    if (!li) return;
    swipeLi = li;
    startX = e.touches[0].clientX;
  });
  msgsCont.addEventListener("touchmove", (e) => {
    if (!swipeLi) return;
    const dx = e.touches[0].clientX - startX;
    if (dx > 0) swipeLi.style.transform = `translateX(${dx}px)`;
  });
  msgsCont.addEventListener("touchend", (e) => {
    if (!swipeLi) return;
    const dx = e.changedTouches[0].clientX - startX;
    swipeLi.style.transform = "";
    if (dx > THRESH) {
      const mid = swipeLi.dataset.messageId;
      if (msgsById[mid]) showReplyPreview(msgsById[mid]);
    }
    swipeLi = null;
  });
  //
  // ─── end delegated reply handlers ───────────────────────────────────

  // ─── DELEGATED DOUBLE‐CLICK FOR REPLY ──────────────────────────────
  // dmMessages.addEventListener("dblclick", (e) => {
  //   // find the message bubble
  //   const bubble = e.target.closest(".msg-bubble");
  //   if (!bubble) return;
  //   // find its <li data-message-id="…">
  //   const li = bubble.closest("li[data-message-id]");
  //   if (!li) return;
  //   const mid = li.getAttribute("data-message-id");
  //   const msg = msgsById[mid];
  //   if (!msg) return;
  //   showReplyPreview(msg);
  // });

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

  // ─── MOBILE SIDEBAR TOGGLE ────────────────────────────────────
  const menuBtn = document.getElementById("menu-btn");
  const chatList = document.getElementById("chat-list");
  const overlay = document.getElementById("overlay");

  function openMenu() {
    chatList.classList.remove("hidden");
    chatList.classList.add("open");
    overlay.classList.add("active");
  }
  function closeMenu() {
    chatList.classList.remove("open");
    chatList.classList.add("hidden");
    overlay.classList.remove("active");
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", openMenu);
    overlay.addEventListener("click", closeMenu);
  }

  // wire up the new “×” button
  const closeMenuBtn = document.getElementById("close-menu-btn");
  if (closeMenuBtn) {
    closeMenuBtn.addEventListener("click", closeMenu);
  }

  // whenever you pick a chat or hit back, hide the sidebar again…
  function hideMenuIfMobile() {
    if (window.innerWidth < 768) closeMenu();
  }
  document
    .getElementById("back-btn")
    .addEventListener("click", hideMenuIfMobile);
  document
    .getElementById("past-list")
    .addEventListener("click", hideMenuIfMobile);
});

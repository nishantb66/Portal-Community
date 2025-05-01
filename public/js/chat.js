// public/js/chat.js
const socket = io();

// ─── State ─────────────────────────────────────────────────────────────────────
const msgsById = {}; // store messages for reply lookups
const typingUsers = new Set();
const TYPING_TIMER = 500; // debounce interval
let typing = false;
let lastTypingTime = 0;
let replyTo = null;
let username = null;

// ─── Element refs ──────────────────────────────────────────────────────────────
const modal = document.getElementById("name-modal");
const nameInput = document.getElementById("name-input");
const nameSubmit = document.getElementById("name-submit");
const userLabel = document.getElementById("user-name");
const msgInput = document.getElementById("msg");
const sendBtn = document.querySelector("#chat-form button");
const messagesEl = document.getElementById("messages");
const container = document.getElementById("messages-container");

// ─── Name‐entry logic ──────────────────────────────────────────────────────────
nameSubmit.addEventListener("click", () => {
  const val = nameInput.value.trim();
  if (!val) return nameInput.focus();
  username = val;
  userLabel.textContent = `You: ${username}`;
  modal.classList.add("hidden");
  msgInput.disabled = false;
  sendBtn.disabled = false;
  msgInput.focus();
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nameSubmit.click();
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function renderTyping() {
  const others = [...typingUsers].filter((u) => u !== username);
  const el = document.getElementById("typing-indicator");
  if (!others.length) return (el.textContent = "");
  if (others.length > 5) el.textContent = "Many users are typing…";
  else
    el.textContent = `${others.join(", ")}${
      others.length === 1 ? " is typing…" : " are typing…"
    }`;
}
function clearReply() {
  replyTo = null;
  document.getElementById("reply-preview").classList.add("hidden");
}
document.getElementById("cancel-reply").addEventListener("click", (e) => {
  e.preventDefault();
  clearReply();
});

// ─── Render a chat message ────────────────────────────────────────────────────
function appendMessage({
  _id,
  username: user,
  message,
  timestamp,
  replyTo: pid,
}) {
  msgsById[_id] = { user, message };
  const isSelf = user === username;
  const li = document.createElement("li");
  li.className = `flex ${isSelf ? "justify-end" : "justify-start"}`;

  // quoted reply (if present)
  let quoteHtml = "";
  if (pid && msgsById[pid]) {
    const p = msgsById[pid];
    const quoteBg = isSelf
      ? "bg-slate-700 text-slate-200 border-l-4 border-brand-300"
      : "bg-slate-100 text-slate-700 border-l-4 border-brand-400";
    quoteHtml = `
      <div class="quote-bubble ${quoteBg} px-3 py-2 rounded-md mb-2">
        <span class="font-semibold">${p.user}:</span>
        <span class="ml-1 break-words whitespace-normal">${p.message}</span>
      </div>`;
  }

  // main bubble
  const timeStr = new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const bubbleBg = isSelf
    ? "bg-brand-600 text-white"
    : "bg-white text-slate-700 border border-slate-200";
  const cornerCls = isSelf ? "rounded-br-sm" : "rounded-bl-sm";

  li.innerHTML = `
    <div class="${bubbleBg} message-bubble px-4 py-3 rounded-2xl ${cornerCls} shadow-soft">
      ${quoteHtml}
      <div class="break-words whitespace-normal">${message}</div>
      <div class="mt-1 text-xs ${
        isSelf ? "text-white/80 text-right" : "text-slate-500"
      }">
        ${isSelf ? "" : `<strong>${user}</strong> • `}${timeStr}
      </div>
    </div>`;

  messagesEl.appendChild(li);
  container.scrollTop = container.scrollHeight; // everyone scrolls

  // dblclick to reply
  li.addEventListener("dblclick", () => {
    replyTo = { _id, user, message };
    document.getElementById(
      "reply-text"
    ).textContent = `Replying to ${user}: ${message}`;
    document.getElementById("reply-preview").classList.remove("hidden");
  });
}

// ─── Typing detection ──────────────────────────────────────────────────────────
msgInput.addEventListener("input", () => {
  if (!username) return;
  if (!typing) {
    typing = true;
    socket.emit("typing", username);
  }
  lastTypingTime = Date.now();
  setTimeout(() => {
    if (Date.now() - lastTypingTime >= TYPING_TIMER && typing) {
      socket.emit("stop typing", username);
      typing = false;
    }
  }, TYPING_TIMER);
});

// ─── Socket.io event handlers ─────────────────────────────────────────────────
socket.on("load messages", (msgs) => msgs.forEach(appendMessage));
socket.on("chat message", appendMessage);
socket.on("user typing", (u) => {
  typingUsers.add(u);
  renderTyping();
});
socket.on("user stop typing", (u) => {
  typingUsers.delete(u);
  renderTyping();
});

// ─── Send new message ─────────────────────────────────────────────────────────
document.getElementById("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!username) return;
  const txt = msgInput.value.trim();
  if (!txt) return;

  socket.emit("chat message", {
    username,
    message: txt,
    replyTo: replyTo?._id || null,
  });

  msgInput.value = "";
  socket.emit("stop typing", username);
  typing = false;
  clearReply();
});

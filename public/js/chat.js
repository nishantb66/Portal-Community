const socket = io();

// ─── State ─────────────────────────────────────────────────────────────────────
const msgsById = {}; // store messages for reply lookups
const typingUsers = new Set();
const TYPING_TIMER = 500; // debounce interval
let typing = false;
let lastTypingTime = 0;
let replyTo = null;
let username = null;
let unreadCount = 0;

// ─── UNREAD-BADGE HELPER ─────────────────────────────────────────────────────
function updateArrowIndicator() {
  const badge = document.getElementById("unread-count");
  const action = document.querySelector(".floating-action");
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.classList.remove("hidden");
    action.style.display = "flex";
  } else {
    badge.classList.add("hidden");
  }

  // also keep the browser tab title in sync
  document.title =
    unreadCount > 0
      ? `(${unreadCount}) EP Platforms • Chat`
      : "EP Platforms • Chat";
}

// ─── Optimistic UI helper ────────────────────────────────────────────────────
// Returns a unique temporary ID for new messages.
function makeTempId() {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ─── Element refs ──────────────────────────────────────────────────────────────
const modal = document.getElementById("name-modal");
const nameInput = document.getElementById("name-input");
const nameSubmit = document.getElementById("name-submit");
const userLabel = document.getElementById("user-name");
const usernameDisplay = document.getElementById("username-display");
const msgInput = document.getElementById("msg");
const sendBtn = document.querySelector("#chat-form button");
const messagesEl = document.getElementById("messages");
const container = document.getElementById("messages-container");
const typingIndicator = document.getElementById("typing-indicator");
const typingAnimation = document.querySelector(".typing-animation");
const typingIndicatorInline = document.getElementById(
  "typing-indicator-inline"
);
const typingAnimationInline = document.querySelector(
  "#typing-indicator-inline .typing-animation"
);

// ─── Name‐entry logic ──────────────────────────────────────────────────────────
nameSubmit.addEventListener("click", () => {
  const val = nameInput.value.trim();
  if (!val) return nameInput.focus();
  username = val;
  usernameDisplay.textContent = username;

  // Fade out modal with animation
  modal.style.opacity = "0";
  modal.style.transition = "opacity 0.3s ease";

  // tell the server we just joined
  socket.emit("join", username);

  setTimeout(() => {
    modal.classList.add("hidden");
    modal.style.opacity = "1"; // Reset opacity for next time

    // Enable chat functionality
    msgInput.disabled = false;
    sendBtn.disabled = false;
    msgInput.focus();

    // Show welcome message in chat
    appendSystemMessage(
      `Welcome, ${username}! You've joined the EP Platforms community discussion.`
    );
  }, 300);
});

nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    nameSubmit.click();
  }
});

// ─── System messages ─────────────────────────────────────────────────────────
function appendSystemMessage(message) {
  const li = document.createElement("li");
  li.className = "flex justify-center message-appear";

  li.innerHTML = `
    <div class="inline-block bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm">
      ${message}
    </div>
  `;

  messagesEl.appendChild(li);
  smoothScrollToBottom();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function renderTyping() {
  const others = [...typingUsers].filter((u) => u !== username);

  if (!others.length) {
    typingAnimation.classList.add("hidden");
    typingAnimationInline.classList.add("hidden");
    typingIndicator.textContent = "";
    typingIndicatorInline.textContent = "";
    return;
  }

  typingAnimation.classList.remove("hidden");
  typingAnimationInline.classList.remove("hidden");

  if (others.length > 3) {
    typingIndicator.textContent = " Several people are typing...";
    typingIndicatorInline.textContent = "Several people are typing...";
  } else {
    const text = `${others.join(", ")}${
      others.length === 1 ? " is typing..." : " are typing..."
    }`;
    typingIndicator.textContent = ` ${text}`;
    typingIndicatorInline.textContent = text;
  }
}

function clearReply() {
  replyTo = null;
  document.getElementById("reply-preview").classList.add("hidden");
}

document.getElementById("cancel-reply").addEventListener("click", (e) => {
  e.preventDefault();
  clearReply();
});

// ─── Format timestamp ─────────────────────────────────────────────────────────
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const timeStr = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isToday) {
    return timeStr;
  } else {
    return `${date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })} ${timeStr}`;
  }
}

// ─── Append a gray, centered “system” message ─────────────────────────────────
function appendSystemMessage(text) {
  const li = document.createElement("li");
  li.className = "flex justify-center fade-in";
  li.innerHTML = `
    <div class="inline-block bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm">
      ${text}
    </div>
  `;
  messagesEl.appendChild(li);
  smoothScrollToBottom();
}

// ─── Render a chat message ────────────────────────────────────────────────────
function appendMessage({
  _id,
  username: user,
  message,
  timestamp,
  replyTo: pid,
  reactions = {},
}) {
  // ── Prevent duplicates: if we've already rendered this ID, bail out
  if (msgsById[_id]) return;

  msgsById[_id] = { user, message, reactions };
  const isSelf = user === username;
  const li = document.createElement("li");
  li.className = `flex items-start ${
    isSelf ? "justify-end" : "justify-start"
  } message-appear hover-fade`;

  // Add a data attribute for potential future operations
  li.setAttribute("data-message-id", _id);

  // Check for URL patterns and convert them to links
  const linkedMessage = linkifyText(message);

  // quoted reply (if present)
  let quoteHtml = "";
  if (pid && msgsById[pid]) {
    const p = msgsById[pid];
    const quoteBg = isSelf
      ? "bg-indigo-50/80 text-gray-700 border-l-4 border-indigo-300"
      : "bg-gray-100/80 text-gray-700 border-l-4 border-indigo-400";
    quoteHtml = `
      <div class="quote-bubble ${quoteBg} px-3 py-2.5 rounded-md mb-2.5">
        <span class="font-medium text-indigo-900">${p.user}:</span>
        <span class="ml-1 break-words whitespace-normal">${p.message}</span>
      </div>`;
  }

  // main bubble
  const timeStr = formatTime(timestamp);

  const bubbleBg = isSelf
    ? "bg-indigo-600 text-white"
    : "bg-white text-gray-800 border border-gray-200";
  const cornerCls = isSelf ? "rounded-br-sm" : "rounded-bl-sm";

  // Check if message is short to apply additional class
  const shortMessage = message.length < 20;
  const bubbleFitClass = shortMessage ? "message-bubble-fit" : "";

  // Add avatar for non-self messages
  const avatarHtml = !isSelf
    ? `
    <div class="flex-shrink-0 mr-2">
      <div class="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 text-xs font-medium border border-gray-200">
        ${user.substring(0, 2).toUpperCase()}
      </div>
    </div>
  `
    : "";

  li.innerHTML = `
    ${avatarHtml}
    <div class="self-${
      isSelf ? "end" : "start"
    } ${bubbleBg} message-bubble ${bubbleFitClass}">
      ${quoteHtml}
      <div class="break-words whitespace-normal">${linkedMessage}</div>
      <div class="mt-1.5 text-xs flex items-center justify-between gap-2 message-info ${
        isSelf ? "text-white/80" : "text-gray-500"
      }">
        <span class="${isSelf ? "order-2" : ""}">${
    !isSelf ? `<strong class="font-medium">${user}</strong>` : ""
  }</span>
        <span class="${isSelf ? "order-1" : ""}">${timeStr}</span>
      </div>
    </div>
    ${
      isSelf
        ? `
      <div class="flex-shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <div class="h-8 w-8 rounded-full bg-white flex items-center justify-center text-indigo-500 text-xs font-medium border border-gray-200">
          ${user.substring(0, 2).toUpperCase()}
        </div>
      </div>
    `
        : ""
    }
  `;

  messagesEl.appendChild(li);

  // --- render reaction bar ---
  const reactionsDiv = document.createElement("div");
  reactionsDiv.id = `reactions-${_id}`;
  reactionsDiv.className = "flex flex-wrap gap-1 mt-1 text-sm";
  const currentReacts = reactions;
  for (const [emoji, users] of Object.entries(currentReacts)) {
    if (!users.length) continue;
    const count = users.length;
    const reacted = users.includes(username);
    const span = document.createElement("span");
    span.className = `px-2 py-1 rounded-full cursor-pointer ${
      reacted ? "bg-indigo-200" : "bg-gray-200"
    }`;
    span.textContent = `${emoji} ${count}`;
    // store for later lookup
    span.dataset.emoji = emoji;
    // always read the *current* message-ID and reaction state
    span.onclick = () => {
      const msgId = li.getAttribute("data-message-id"); // ← dynamic
      const hasReacted =
        msgsById[msgId]?.reactions?.[emoji]?.includes(username);
      socket.emit(hasReacted ? "remove reaction" : "add reaction", {
        messageId: msgId,
        emoji,
        user: username,
      });
    };

    reactionsDiv.appendChild(span);
  }
  li.appendChild(reactionsDiv);

  // ─── Auto-scroll vs. unread bump ──────────────────────────────────────────────
  const isScrolledToBottom =
    container.scrollHeight - container.scrollTop <=
    container.clientHeight + 100;

  if (isScrolledToBottom) {
    smoothScrollToBottom();
  } else if (!isSelf) {
    // only bump once per new message from others
    unreadCount++;
    updateArrowIndicator();
  }

  // Add reply functionality
  const messageBubble = li.querySelector(".message-bubble");

  // “double-click” desktop reply
  messageBubble.addEventListener("dblclick", () => {
    const msgId = li.getAttribute("data-message-id"); // ← dynamic
    setReplyTo({ _id: msgId, user, message });
  });

  // Long press for mobile
  let pressTimer;
  let startX, startY;

  messageBubble.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;

    // // “long-press” mobile reply
    // pressTimer = setTimeout(() => {
    //   const msgId = li.getAttribute("data-message-id"); // ← dynamic
    //   setReplyTo({ _id: msgId, user, message });
    // }, 600);
  });

  messageBubble.addEventListener("touchmove", (e) => {
    const diffX = Math.abs(e.touches[0].clientX - startX);
    const diffY = Math.abs(e.touches[0].clientY - startY);

    // Cancel if moved more than 10px
    if (diffX > 10 || diffY > 10) {
      clearTimeout(pressTimer);
    }
  });

  messageBubble.addEventListener("touchend", () => {
    clearTimeout(pressTimer);
  });
}

// Set up reply
function setReplyTo({ _id, user, message }) {
  replyTo = { _id, user, message };
  document.getElementById(
    "reply-text"
  ).textContent = `Replying to ${user}: ${message}`;
  document.getElementById("reply-preview").classList.remove("hidden");
  msgInput.focus();
}

// Convert text URLs to clickable links
function linkifyText(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(
    urlRegex,
    (url) =>
      `<a href="${url}" target="_blank" class="underline hover:text-indigo-400 transition-colors">${url}</a>`
  );
}

// Update document title with unread count
function updateDocumentTitle() {
  document.title =
    unreadCount > 0
      ? `(${unreadCount}) EP Platforms • Chat`
      : "EP Platforms • Chat";
}

// Smooth scroll to bottom of messages
function smoothScrollToBottom() {
  const scrollHeight = container.scrollHeight;
  const height = container.clientHeight;
  const maxScrollTop = scrollHeight - height;
  container.scrollTo({
    top: maxScrollTop,
    behavior: "smooth",
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
socket.on("load messages", (msgs) => {
  if (msgs.length === 0) {
    // If no messages, show welcome
    appendSystemMessage(
      "Welcome to the EP Platforms community discussion. Start the conversation!"
    );
  } else {
    msgs.forEach(appendMessage);
    // After loading all messages, scroll to the bottom
    setTimeout(smoothScrollToBottom, 100);
  }
});

socket.on("chat message", appendMessage);

socket.on("chat message saved", ({ _tempId, _id }) => {
  // find the optimistic LI
  const li = document.querySelector(`li[data-message-id="${_tempId}"]`);
  if (!li) return;

  // 1) swap the LI’s data-attribute to the real _id
  li.setAttribute("data-message-id", _id);

  // 2) **also** rename the reactions <div> so renderReactions()
  //    can pick it up under the new ID
  const oldReacts = document.getElementById(`reactions-${_tempId}`);
  if (oldReacts) {
    oldReacts.id = `reactions-${_id}`;
  }

  // 3) move our in-memory slot
  msgsById[_id] = msgsById[_tempId];
  delete msgsById[_tempId];
});

// ─── System join/leave notifications ──────────────────────────────────────────
socket.on("user joined", (user) => {
  appendSystemMessage(`🟢 ${user} has joined the chat.`);
});
socket.on("user left", (user) => {
  appendSystemMessage(`🔴 ${user} has left the chat.`);
});

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

  // generate a tempId and optimistic message object
  const tempId = makeTempId();
  const optimistic = {
    _id: tempId,
    username,
    message: txt,
    timestamp: new Date().toISOString(),
    replyTo: replyTo?._id || null,
    reactions: {},
  };

  // 1) append optimistically for everyone (it'll show in everyone's chat instantly)
  appendMessage(optimistic);

  // 2) send to server, including tempId
  socket.emit("chat message", {
    username,
    message: txt,
    replyTo: replyTo?._id || null,
    _tempId: tempId,
  });

  // 3) clear input & typing state
  msgInput.value = "";
  socket.emit("stop typing", username);
  typing = false;
  clearReply();
});

// Focus input when page loads
window.addEventListener("DOMContentLoaded", () => {
  nameInput.focus();
});

// Mobile optimizations - input focus
msgInput.addEventListener("focus", () => {
  // On mobile, scroll to bottom when input is focused
  if (window.innerWidth < 768) {
    setTimeout(smoothScrollToBottom, 300); // Wait for keyboard to appear
  }
});

// Window focus/blur handling
let windowFocused = true;
window.addEventListener("focus", () => {
  windowFocused = true;
  unreadCount = 0;
  updateDocumentTitle();
});

window.addEventListener("blur", () => {
  windowFocused = false;
});

// Window resize handler for responsive adjustments
window.addEventListener("resize", () => {
  // Readjust scroll position on resize
  setTimeout(smoothScrollToBottom, 100);
});

// Check for URLs in clipboard when pasting
msgInput.addEventListener("paste", (e) => {
  // Additional paste handling could go here
});

// Add subtle hover effects to message elements
container.addEventListener("mouseover", (e) => {
  const messageBubble = e.target.closest(".message-bubble");
  if (messageBubble) {
    const infoElement = messageBubble.querySelector(".message-info");
    if (infoElement) {
      infoElement.style.opacity = "1";
    }
  }
});

container.addEventListener("mouseout", (e) => {
  const messageBubble = e.target.closest(".message-bubble");
  if (messageBubble) {
    const infoElement = messageBubble.querySelector(".message-info");
    if (infoElement) {
      infoElement.style.opacity = "";
    }
  }
});

// ─── Reaction-picker logic ────────────────────────────────────────────────
const EMOJIS = ["🩷", "😂", "😭", "🥹", "👍", "🙌🏻", "🎉", "😱", "🫡", "👎"];
const picker = document.getElementById("reaction-picker");

function showPicker(msgId, x, y) {
  picker.innerHTML = "";
  EMOJIS.forEach((e) => {
    const btn = document.createElement("button");
    btn.textContent = e;
    btn.className = "text-xl";
    btn.onclick = () => {
      // toggle reaction
      const hasReacted = msgsById[msgId]?.reactions?.[e]?.includes(username);
      socket.emit(hasReacted ? "remove reaction" : "add reaction", {
        messageId: msgId,
        emoji: e,
        user: username,
      });
      picker.classList.add("hidden");
    };
    picker.appendChild(btn);
  });
  picker.style.left = `${x}px`;
  picker.style.top = `${y}px`;
  picker.classList.remove("hidden");
}
// hide on outside click
document.addEventListener("click", (e) => {
  if (!picker.contains(e.target)) picker.classList.add("hidden");
});

// ─── Bind mobile long-press & desktop right-click ──────────────────────────
container.addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li[data-message-id]");
  if (!li) return;
  e.preventDefault();
  showPicker(li.dataset.messageId, e.pageX, e.pageY);
});
container.addEventListener("touchstart", (e) => {
  const li = e.target.closest("li[data-message-id]");
  if (!li) return;
  let timer = setTimeout(() => {
    const rect = li.getBoundingClientRect();
    showPicker(li.dataset.messageId, rect.left + 20, rect.top + 20);
  }, 600);
  li.addEventListener("touchend", () => clearTimeout(timer), { once: true });
});

// ─── Listen for reaction updates & re-render ──────────────────────────────
// ─── keep everyone in sync when reactions change ────────────────────────────

function renderReactions(msgId) {
  const div = document.getElementById(`reactions-${msgId}`);
  if (!div) return;
  div.innerHTML = "";
  const current = msgsById[msgId].reactions;
  for (const [e, uList] of Object.entries(current)) {
    if (!uList.length) continue;
    const span = document.createElement("span");
    const reacted = uList.includes(username);
    span.className = `px-2 py-1 rounded-full cursor-pointer ${
      reacted ? "bg-indigo-200" : "bg-gray-200"
    }`;
    span.textContent = `${e} ${uList.length}`;
    span.onclick = () => {
      socket.emit(reacted ? "remove reaction" : "add reaction", {
        messageId: msgId,
        emoji: e,
        user: username,
      });
    };
    div.appendChild(span);
  }
}

socket.on("reactions updated", ({ messageId, reactions }) => {
  if (!msgsById[messageId]) return;
  msgsById[messageId].reactions = reactions;
  renderReactions(messageId);
});

// ─── Keep-free-tier-awake ping ────────────────────────────────────────────────
// every 4 minutes, hit our health‐check so Render sees activity
setInterval(() => {
  fetch("/ping").catch((err) => {
    // silent fail; if Render is down or network glitch, we'll try again
    console.error("Keep‐alive ping failed:", err);
  });
}, 4 * 60 * 1000);

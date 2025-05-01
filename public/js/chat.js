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
    <div class="inline-block self-start ${bubbleBg} message-bubble ${bubbleFitClass} px-4 py-3 rounded-2xl ${cornerCls} shadow-message">
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

  // Scroll to bottom with animation
  smoothScrollToBottom();

  // Add reply functionality
  const messageBubble = li.querySelector(".message-bubble");

  // Double click for desktop
  messageBubble.addEventListener("dblclick", () => {
    setReplyTo({ _id, user, message });
  });

  // Long press for mobile
  let pressTimer;
  let startX, startY;

  messageBubble.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;

    pressTimer = setTimeout(() => {
      setReplyTo({ _id, user, message });
    }, 600);
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

  // Update unread count if window not focused
  if (!windowFocused && !isSelf) {
    unreadCount++;
    updateDocumentTitle();
  }
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

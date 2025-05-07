let unreadCounts = {}; // global map username→count
const me = () => localStorage.getItem("dmUsername");

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
    <li data-user="${u}" class="flex justify-between px-2 py-1 hover:bg-gray-100 cursor-pointer">
      <span class="username">${u}</span>
      <span class="unread-badge ml-2 text-white bg-red-500 rounded-full px-2 text-xs ${
        !unreadCounts[u] ? "hidden" : ""
      }">
        ${unreadCounts[u] || ""}
      </span>
    </li>
  `
    )
    .join("");

  ul.querySelectorAll("li").forEach((li) => {
    li.onclick = () => openChatWith(li.dataset.user);
  });
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
    document.getElementById("chat-container").classList.add("hidden");
    document.getElementById("chat-list").classList.remove("hidden");
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
    loadPastChats(token);
  }

  // ─── INIT SOCKET.IO DM NAMESPACE ──────────────────────────────────────
  let dmSocket = null;
  function initChat(token) {
    if (dmSocket) dmSocket.disconnect();

    dmSocket = io("/dm", { auth: { token } });
    dmSocket.on("connect_error", (e) => alert(e.message));
    dmSocket.on("dm message", (msg) => {
      // 1) if it’s to me, bump unread
      if (msg.to === me() && msg.from !== currentPeer) {
        unreadCounts[msg.from] = (unreadCounts[msg.from] || 0) + 1;
        updateBadge(msg.from);
      }

      // 2) if it’s in my open chat, show it immediately
      if (msg.from === currentPeer || msg.to === currentPeer) {
        appendMsg(msg);
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
            `<li class="px-3 py-1 hover:bg-gray-100 cursor-pointer">${u}</li>`
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
          `<li class="px-2 py-1 hover:bg-gray-100 cursor-pointer">${u}</li>`
      )
      .join("");

    ul.querySelectorAll("li").forEach((li) => {
      li.onclick = () => openChatWith(li.textContent);
    });
  }

  // ─── OPEN AN INDIVIDUAL CHAT ────────────────────────────────────────
  let currentPeer = null;
  async function openChatWith(username) {
    currentPeer = username;

    // 1) Toggle views: hide sidebar, show chat
    document.getElementById("chat-list").classList.add("hidden");
    document.getElementById("chat-container").classList.remove("hidden");

    // 2) Update header
    document.getElementById("chat-with").textContent = username;

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
    msgUl.scrollTop = msgUl.scrollHeight;

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

  // ─── APPEND A MESSAGE TO THE UI ──────────────────────────────────────
  function appendMsg(msg) {
    const li = document.createElement("li");
    const me = localStorage.getItem("dmUsername");
    li.textContent = `${msg.from}: ${msg.message}`;
    li.className = me === msg.from ? "text-right" : "";
    const ul = document.getElementById("dm-messages");
    ul.appendChild(li);
    ul.scrollTop = ul.scrollHeight;
  }

  // ─── SEND A NEW MESSAGE ──────────────────────────────────────────────
  function sendMsg() {
    const input = document.getElementById("dm-input");
    const txt = input.value.trim();
    if (!txt || !currentPeer) return;
    dmSocket.emit("dm message", { to: currentPeer, message: txt });
    input.value = "";
  }

  // ─── LOGOUT ──────────────────────────────────────────────────────────
  document.getElementById("logout-btn").onclick = () => {
    // clear storage & UI
    ["dmToken", "dmUsername", "dmEmail"].forEach((k) =>
      localStorage.removeItem(k)
    );
    dmApp.classList.add("hidden");
    authContainer.classList.remove("hidden");

    // reset auth forms
    loginForm.classList.remove("hidden");
    signupForm.classList.add("hidden");
    otpForm.classList.add("hidden");
    document.getElementById("login-username").value = "";
    document.getElementById("login-password").value = "";
    document.getElementById("login-error").textContent = "";
  };
});

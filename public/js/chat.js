const socket = io();

// ask for a username
let username = "";
while (!username) {
  username = prompt("Enter your name:").trim();
}
document.getElementById("user-name").textContent = `You: ${username}`;

// load existing chat
socket.on("load messages", (msgs) => {
  msgs.forEach(appendMessage);
});

// new message from server
socket.on("chat message", appendMessage);

// form submit
document.getElementById("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("msg");
  if (!input.value) return;
  socket.emit("chat message", {
    username,
    message: input.value,
  });
  input.value = "";
});

// helper to add message to list
function appendMessage({ username, message, timestamp }) {
  const li = document.createElement("li");
  li.className = "bg-white p-2 rounded shadow-sm";
  li.innerHTML = `
    <div class="flex justify-between items-baseline">
      <strong class="text-blue-600">${username}</strong>
      <span class="text-xs text-gray-500 ml-2">${new Date(
        timestamp
      ).toLocaleTimeString()}</span>
    </div>
    <p class="mt-1">${message}</p>
  `;
  document.getElementById("messages").appendChild(li);
  window.scrollTo(0, document.body.scrollHeight);
}

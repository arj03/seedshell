// Hello: the least an app is, and the one to copy to start another. Its app.json names no
// guest, so its guest is the room pipe (assembly/guest-lib/room-pipe.js): what this view
// casts reaches the linked members of a room, and a peer's frame reaches it only from a
// member of the room it names. What a room has said is the view's to keep: here, shown.
const enc = new TextEncoder(), dec = new TextDecoder();
const log = document.getElementById("log");
const form = document.getElementById("form");
const msg = document.getElementById("msg");

// The node's context, which comes before any frame: who this node is, the rooms it is in,
// and what each peer calls itself. It is the shell's, and the same for every app.
let ctx = null;
const who = (key) => (key === ctx.me ? ctx.nick : ctx.nicks[key]) || key.slice(0, 8);
const show = (room, from, text) => {
  const name = ctx.rooms.find((r) => r.id === room)?.name ?? "";
  log.append(`#${name} ${who(from)}: ${text}\n`);
};

app.onContext((c) => {
  ctx = c;
  msg.placeholder = ctx.rooms[0] ? `Say something to #${ctx.rooms[0].name}` : "Join a room on the Network tab";
});
app.onFrame((from, room, body) => show(room, from, dec.decode(body)));
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const room = ctx?.rooms[0]?.id;   // the first room this node is in
  if (!room || !msg.value) return;
  app.cast(room, enc.encode(msg.value));
  show(room, ctx.me, msg.value);
  msg.value = "";
});
app.ready();

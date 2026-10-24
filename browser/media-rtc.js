// Live audio/video on peer connections the page owns.
//
// seedkernel's WebRTC seam only holds the transport's connections (§12.7), so a call opens
// its own RTCPeerConnection per peer. Signaling rides the node's authenticated channel via
// the shell app's call/v1 protocol (shell-app.js), so no relay is needed once peers are
// linked and nothing on the relay can inject into a call.
//
// Calls are opt-in on both ends: a node in a call tells that call's peers (`{ call }`), and a
// connection is only opened between two nodes that have both said they're in the same call.
// Nothing is sent to or received from a peer that hasn't accepted.
//
// Negotiation uses the W3C "perfect negotiation" pattern. On a collision, the polite side
// (the larger key, matching the transport's rule) rolls back its offer.

/** Signals: `{ call }` (I'm in this call), `{ sdp }`, `{ candidate }`, `{ bye: true }`. */
const encode = (msg) => new TextEncoder().encode(JSON.stringify(msg));

export class MediaCalls {
  /** peerId → { pc, ready, polite, makingOffer, ignoreOffer, carrying }. `pc` is null until
   *  the peer's ICE servers are known (`ready` settles then); `carrying` maps each of our
   *  tracks to its transceiver. */
  #peers = new Map();
  /** Local tracks to publish: [{ track, stream }]. */
  #tracks = [];
  /** The call we're in (its shared name) and the filter picking its peers (`start`); null
   *  when not in a call. */
  #call = null;
  #among = null;
  /** Peers we've told we're in the call. */
  #rung = new Set();
  /** peerId → the call that peer says it's in. */
  #callers = new Map();

  /**
   * @param {{
   *   myId: string,
   *   iceServers: (peerId: string) => Promise<RTCIceServer[]>,
   *   send: (peerId: string, signal: Uint8Array) => Promise<unknown>,
   *   onTrack?: (peerId: string, track: MediaStreamTrack) => void,
   *   onPeerClosed?: (peerId: string) => void,
   *   onCallers?: () => void,
   * }} opts
   */
  constructor(opts) { this.opts = opts; }

  /** peerId → the call that peer says it's in (a copy). */
  get callers() { return new Map(this.#callers); }

  /** Number of peers we have a media connection with. */
  get size() { return this.#peers.size; }

  /** Enter call `call`. `among(peers)` picks its participants from the linked peers, now
   *  and as they change (`sync`). Each is told; those also in the call get connected. */
  start(call, among, linked) {
    this.#call = call;
    this.#among = among;
    this.sync(linked);
  }

  /** Publish a track to everyone in the call, including later joiners. */
  publish(track, stream) {
    this.#tracks.push({ track, stream });
    for (const p of this.#peers.keys()) this.#ensure(p);
  }

  /** Stop publishing a track. Its transceiver is kept but sends nothing, which mutes the
   *  track at the far end. */
  unpublish(track) {
    this.#tracks = this.#tracks.filter((t) => t.track !== track);
    for (const e of this.#peers.values()) {
      const t = e.carrying.get(track);
      if (!t) continue;
      e.carrying.delete(track);
      try {
        void t.sender.replaceTrack(null).catch(() => {});
        t.direction = "recvonly";
      } catch { /* closed meanwhile */ }
    }
  }

  /** Follow the linked peers: forget callers that went away, and while in a call, tell new
   *  participants, connect those also in it, and drop those no longer in it. */
  sync(linked) {
    let changed = false;
    for (const p of [...this.#callers.keys()]) {
      // A link is always reported before anything arrives on it, so callers are linked.
      if (!linked.includes(p)) { this.#callers.delete(p); changed = true; }
    }
    if (this.#call !== null) {
      const peers = new Set(this.#among(linked));
      // A peer that dropped and came back must be told again.
      for (const p of [...this.#rung]) if (!peers.has(p)) this.#rung.delete(p);
      for (const p of peers) {
        if (!this.#rung.has(p)) {
          this.#rung.add(p);
          void this.opts.send(p, encode({ call: this.#call })).catch(() => this.#rung.delete(p));
        }
        if (this.#with(p)) this.#ensure(p);
      }
      for (const p of [...this.#peers.keys()]) if (!this.#with(p)) this.#close(p);
    }
    if (changed) this.opts.onCallers?.();
  }

  /** Hang up: say bye, close every media connection, stop publishing. */
  end() {
    this.#call = this.#among = null;
    this.#tracks = [];
    for (const p of this.#rung) void this.opts.send(p, encode({ bye: true })).catch(() => {});
    this.#rung.clear();
    for (const p of [...this.#peers.keys()]) this.#close(p);
  }

  /** Restart ICE on every connection, e.g. after a network change. */
  restartAllIce() {
    for (const e of this.#peers.values()) {
      try { e.pc?.restartIce(); } catch { /* nothing to restart */ }
    }
  }

  /** Handle a signal from `peerId` (authenticated by the channel). */
  async onSignal(peerId, bytes) {
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
    if (msg?.bye) {
      this.#close(peerId);
      if (this.#callers.delete(peerId)) this.opts.onCallers?.();
      return;
    }
    if (typeof msg?.call === "string") {
      this.#callers.set(peerId, msg.call);
      if (this.#with(peerId)) this.#ensure(peerId);
      this.opts.onCallers?.();
      return;
    }
    // SDP and candidates are accepted only from peers in our call.
    if (!this.#with(peerId)) return;
    const e = this.#ensure(peerId);
    // Wait for the connection to exist; waiters resume in arrival order.
    await e.ready;
    if (this.#peers.get(peerId) !== e) return;   // closed meanwhile
    try {
      if (msg?.sdp) {
        const collision = msg.sdp.type === "offer" && (e.makingOffer || e.pc.signalingState !== "stable");
        e.ignoreOffer = !e.polite && collision;
        if (e.ignoreOffer) return;
        await e.pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === "offer") {
          await e.pc.setLocalDescription();
          void this.opts.send(peerId, encode({ sdp: e.pc.localDescription })).catch(() => {});
        }
      } else if (msg?.candidate) {
        try { await e.pc.addIceCandidate(msg.candidate); }
        catch (err) { if (!e.ignoreOffer) throw err; }
      }
    } catch { /* a stale signal after a rollback, or a peer that went away */ }
  }

  /** Whether `peerId` is in our call: we're in one, it's a participant, and it says it's in
   *  the same call. */
  #with(peerId) {
    return this.#call !== null && this.#callers.get(peerId) === this.#call &&
      this.#among([peerId]).length > 0;
  }

  /** Get or create the entry for a peer in our call. The connection is created once the
   *  peer's ICE servers are known, so it uses the same STUN as the transport. */
  #ensure(peerId) {
    let e = this.#peers.get(peerId);
    if (e) {
      if (e.pc) this.#carryAll(e);
      return e;
    }
    e = { pc: null, ready: null, polite: this.opts.myId > peerId, makingOffer: false, ignoreOffer: false, carrying: new Map() };
    this.#peers.set(peerId, e);
    const entry = e;
    e.ready = this.opts.iceServers(peerId).catch(() => []).then((iceServers) => {
      if (this.#peers.get(peerId) === entry) this.#open(peerId, entry, iceServers);
    });
    return e;
  }

  /** Create the peer's connection and publish our tracks on it. */
  #open(peerId, e, iceServers) {
    const pc = e.pc = new RTCPeerConnection({ iceServers });
    pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) void this.opts.send(peerId, encode({ candidate: ev.candidate.toJSON() })).catch(() => {});
    });
    pc.addEventListener("negotiationneeded", async () => {
      try {
        e.makingOffer = true;
        await pc.setLocalDescription();
        void this.opts.send(peerId, encode({ sdp: pc.localDescription })).catch(() => {});
      } catch { /* the next negotiationneeded retries */ }
      finally { e.makingOffer = false; }
    });
    pc.addEventListener("track", (ev) => this.opts.onTrack?.(peerId, ev.track));
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") this.#close(peerId);
    });
    this.#carryAll(e);
  }

  /** Publish any of our tracks the connection doesn't carry yet. */
  #carryAll(e) {
    for (const { track, stream } of this.#tracks) {
      if (!e.carrying.has(track)) {
        try { e.carrying.set(track, this.#carry(e, track, stream)); } catch { /* closed meanwhile */ }
      }
    }
  }

  /** Send a track, returning its transceiver. Reuses an idle recvonly transceiver of the
   *  same kind (the peer's, or one we unpublished from) rather than `addTrack`, which would
   *  add a new media section every time the camera is turned back on. */
  #carry(e, track, stream) {
    const taken = new Set(e.carrying.values());
    const idle = e.pc.getTransceivers().find((t) =>
      !taken.has(t) && t.receiver.track.kind === track.kind && t.direction === "recvonly");
    if (!idle) return e.pc.addTransceiver(track, { streams: [stream] });
    void idle.sender.replaceTrack(track).catch(() => {});
    idle.sender.setStreams(stream);
    idle.direction = "sendrecv";
    return idle;
  }

  #close(peerId) {
    const e = this.#peers.get(peerId);
    if (!e) return;
    this.#peers.delete(peerId);
    try { e.pc?.close(); } catch { /* already closed */ }
    this.opts.onPeerClosed?.(peerId);
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { createD1Adapter } from './support/d1.js';
import { authorizeVoiceCall } from '../worker/src/calls/access.ts';
import { generateCallIceServers } from '../worker/src/calls/turn.ts';
import { callExpired, nextCallState } from '../worker/src/calls/state.ts';
import { handleCallLease } from '../worker/src/calls/lease.ts';
import { createVoiceCallClient } from '../frontend/src/calls/client.ts';
import { CALL_RING_MS, CALL_MAX_MS } from '../shared/voice-call.ts';
import { UserInbox } from '../worker/src/do/UserInbox.js';
import { VoiceCall } from '../worker/src/do/VoiceCall.ts';
import { createVerifiedPrincipalHeaders } from '../worker/src/verified-identity.js';

const callId = '00000000-0000-0000-0000-000000000001';
const callerClient = '00000000-0000-0000-0000-000000000002';
const calleeClient = '00000000-0000-0000-0000-000000000003';
const start = { type: 'start', callId, clientId: callerClient, mode: 'auto' };
const ringing = () => nextCallState(null, start, 1, 2, 4, 100);
const accepted = () => nextCallState(ringing(), { type: 'accept', callId, clientId: calleeClient, mode: 'auto' }, 2, 1, 4, 200);

test('call state defaults to P2P and only the callee can accept once', () => {
  assert.equal(ringing().mode, 'auto');
  assert.equal(accepted().calleeClient, calleeClient);
  assert.equal(accepted().revision, 1);
  assert.throws(() => nextCallState(ringing(), { type: 'accept', callId, clientId: callerClient, mode: 'auto' }, 1, 2, 4, 200), /处理/);
  assert.throws(() => nextCallState(accepted(), { type: 'accept', callId, clientId: calleeClient, mode: 'auto' }, 2, 1, 4, 200), /处理/);
});

test('video requires explicit acceptance while existing audio calls remain compatible', () => {
  const video = nextCallState(null, { ...start, media: 'video' }, 1, 2, 4, 100);
  const answer = { type: 'accept', callId, clientId: calleeClient, mode: 'auto' };
  assert.equal(video.media, 'video');
  assert.equal(ringing().media, 'audio');
  const legacy = { ...ringing() };
  delete legacy.media;
  assert.equal(nextCallState(legacy, answer, 2, 1, 4, 200).phase, 'accepted');
  assert.throws(() => nextCallState(video, answer, 2, 1, 4, 200), /类型/);
  assert.throws(() => nextCallState(null, { ...start, media: 'other' }, 1, 2, 4, 100), /类型/);
  const ongoing = nextCallState(video, { ...answer, media: 'video' }, 2, 1, 4, 200);
  const offer = { type: 'offer', callId, clientId: callerClient, revision: 1, sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' };
  assert.equal(nextCallState(ongoing, offer, 1, 2, 4, 250), ongoing);
  assert.throws(() => nextCallState(accepted(), offer, 1, 2, 4, 250), /视频/);
});

test('busy calls, outsiders, and other tabs cannot take over a call', () => {
  assert.throws(() => nextCallState(ringing(), start, 1, 2, 4, 200), /正在通话/);
  assert.throws(() => nextCallState(accepted(), { type: 'hangup', callId, clientId: callerClient }, 3, 1, 4, 200), /双方/);
  assert.throws(() => nextCallState(accepted(), { type: 'hangup', callId, clientId: callerClient }, 2, 1, 4, 200), /其他窗口/);
});

test('only caller sends offers, only callee sends answers, and old revisions are refused', () => {
  const offer = { type: 'offer', callId, clientId: callerClient, revision: 1, sdp: 'v=0\r\n' };
  assert.equal(nextCallState(accepted(), offer, 1, 2, 4, 200).revision, 1);
  assert.throws(() => nextCallState(accepted(), { ...offer, clientId: calleeClient }, 2, 1, 4, 200), /信令/);
  assert.throws(() => nextCallState(accepted(), { ...offer, revision: 0 }, 1, 2, 4, 200), /更新/);
  assert.throws(() => nextCallState(accepted(), { ...offer, sdp: 'bad' }, 1, 2, 4, 200), /信令/);
});

test('relay switches advance negotiation revision and stale actions cannot end a new call', () => {
  const next = nextCallState(accepted(), { type: 'restart', callId, clientId: calleeClient, mode: 'relay' }, 2, 1, 4, 200);
  assert.equal(next.mode, 'relay');
  assert.equal(next.revision, 2);
  assert.equal(nextCallState(next, { type: 'restart', callId, clientId: callerClient, mode: 'relay' }, 1, 2, 4, 200), next);
  assert.equal(nextCallState(accepted(), { type: 'hangup', callId, clientId: calleeClient }, 2, 1, 4, 200), null);
  assert.throws(() => nextCallState(accepted(), { type: 'hangup', callId: callerClient, clientId: calleeClient }, 2, 1, 4, 200), /结束/);
});

test('call timeouts cover ringing, missing heartbeats, and maximum duration', () => {
  assert.equal(callExpired(ringing(), 100 + CALL_RING_MS), true);
  assert.equal(callExpired(accepted(), 201), false);
  assert.equal(callExpired(accepted(), 75_200), true);
  const call = { ...accepted(), callerSeen: CALL_MAX_MS + 100, calleeSeen: CALL_MAX_MS + 100 };
  assert.equal(callExpired(call, CALL_MAX_MS + 100), true);
});

test('TURN keys stay server-side and issued credentials exclude browser-blocked port 53', async () => {
  let request;
  const result = await generateCallIceServers({ EDGECHAT_TURN_KEY_ID: 'key-id', EDGECHAT_TURN_API_TOKEN: 'secret' }, async (url, options) => {
    request = { url, options };
    return Response.json({ iceServers: [{ urls: ['turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'short', credential: 'temporary' }] }, { status: 201 });
  });
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.equal(JSON.parse(request.options.body).ttl, 3600);
  assert.equal(result.iceServers[0].urls.length, 1);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  await assert.rejects(generateCallIceServers({}), /尚未配置/);
  await assert.rejects(generateCallIceServers({ EDGECHAT_TURN_KEY_ID: 'k', EDGECHAT_TURN_API_TOKEN: 's' }, async () => Response.json({ error: 'internal secret' }, { status: 500 })), /暂时不可用/);
});

test('call authorization excludes groups, nonparticipants, disabled peers, and either block direction', async () => {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  database.run("INSERT INTO users(id,username,display_name,password_hash,password_salt) VALUES (1,'alice','Alice','h','s'),(2,'bob','Bob','h','s'),(3,'admin','Admin','h','s')");
  database.run("INSERT INTO channels(id,name,kind,dm_key,created_by) VALUES (10,'dm','dm','1:2',1)");
  database.run('INSERT INTO channel_members(channel_id,user_id) VALUES(10,1),(10,2)');
  const db = createD1Adapter(database);
  assert.equal((await authorizeVoiceCall(db, 10, 1)).peerId, 2);
  await assert.rejects(authorizeVoiceCall(db, 10, 3), /双方/);
  await assert.rejects(authorizeVoiceCall(db, 1, 1), /双方/);
  database.run('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES(2,1)');
  await assert.rejects(authorizeVoiceCall(db, 10, 1), /拉黑/);
  await assert.rejects(authorizeVoiceCall(db, 10, 2), /拉黑/);
  database.run('DELETE FROM user_blocks');
  database.run('UPDATE users SET is_disabled=1 WHERE id=2');
  await assert.rejects(authorizeVoiceCall(db, 10, 1), /不可用/);
  database.close();
});

test('per-user leases refuse concurrent calls and stale releases cannot clear the current lease', async () => {
  const entries = new Map();
  const storage = { get: async key => entries.get(key), put: async (key, value) => entries.set(key, value), delete: async key => entries.delete(key), transaction: async operation => operation(storage) };
  const request = (path, body, verified = true) => new Request(`https://internal/${path}`, { method: 'POST', headers: verified ? { 'x-cfchat-internal-auth': 'worker-verified' } : {}, body: JSON.stringify(body) });
  const lease = { callId, expiresAt: Date.now() + 10000 };
  assert.equal((await handleCallLease(request('call-claim', lease), storage)).status, 200);
  assert.equal((await handleCallLease(request('call-claim', { ...lease, callId: callerClient }), storage)).status, 409);
  await handleCallLease(request('call-release', { callId: callerClient }), storage);
  assert.equal(entries.get('callLease').callId, callId);
  assert.equal((await handleCallLease(request('call-claim', lease, false), storage)).status, 401);
  await handleCallLease(request('call-release', { callId }), storage);
  assert.equal(entries.has('callLease'), false);
});

function clientHarness(options = {}) {
  const states = [];
  const actions = [];
  const peers = [];
  const errors = [];
  const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const api = { callConfig: async () => ({ turnAvailable: true, videoAvailable: true }), callIce: async () => ({ iceServers: [{ urls: 'turn:relay' }] }), callAction: async (_id, body) => { actions.push(body); } };
  const createPeer = config => {
    const senders = [];
    const peer = { config, connectionState: 'new', remoteDescription: null,
      getSenders: () => senders,
      addTrack(track) {
        const sender = { track, async replaceTrack(next) { this.track = next; } };
        senders.push(sender);
        return sender;
      },
      close() { this.closed = true; }, createOffer: async () => ({ type: 'offer', sdp: 'v=0' }), createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }), async setLocalDescription(value) { this.localDescription = value; }, async setRemoteDescription(value) { this.remoteDescription = value; }, addIceCandidate: async () => {} };
    peers.push(peer); return peer;
  };
  const client = createVoiceCallClient({ api, userId: 1, clientId: callerClient, getMedia: async () => stream, createPeer, onChange: value => states.push(value), onError: error => errors.push(error), ...options });
  return { api, client, states, actions, peers, errors, track, stream };
}
const room = { id: 4, kind: 'dm', name: 'Bob', otherUser: { id: 2 } };

test('browser client starts with STUN only, negotiates audio, switches relay and releases microphone', async () => {
  const h = clientHarness();
  try {
    await h.client.start(room, 'auto');
    const current = h.states.at(-1).call;
    const event = { ...current, type: 'call_negotiate', callerClient, calleeClient, revision: 1, mode: 'auto' };
    await h.client.receive(event);
    assert.equal(h.peers[0].config.iceTransportPolicy, 'all');
    assert.equal(h.peers[0].config.iceServers.some(server => String(server.urls).startsWith('turn:')), false);
    await h.client.switchMode('relay');
    assert.equal(h.actions.at(-1).type, 'restart');
    await h.client.receive({ ...event, revision: 2, mode: 'relay' });
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.peers[1].config.iceTransportPolicy, 'relay');
    h.peers[1].connectionState = 'connected'; h.peers[1].onconnectionstatechange();
    assert.equal(h.states.at(-1).route, 'TURN');
    h.client.toggleMute(); assert.equal(h.track.enabled, false);
    await h.client.hangup();
    assert.equal(h.track.stopped, true);
    assert.equal(h.states.at(-1).phase, 'idle');
  } finally { h.client.reset(); }
});

test('a cancelled microphone prompt releases its late stream without initiating a call', async () => {
  let resolveMedia;
  const h = clientHarness({ getMedia: () => new Promise(resolve => { resolveMedia = resolve; }) });
  const pending = h.client.start(room, 'auto');
  await new Promise(resolve => setTimeout(resolve, 0));
  await h.client.hangup();
  resolveMedia(h.stream);
  await pending;
  assert.equal(h.track.stopped, true);
  assert.equal(h.actions.some(action => action.type === 'start'), false);
});

test('incoming calls require acceptance, and another tab accepting dismisses the local prompt', async () => {
  const h = clientHarness({ userId: 2, clientId: calleeClient });
  await h.client.receive({ type: 'call_invite', callId, roomId: 4, callerId: 1, calleeId: 2, mode: 'auto', users: [{ id: 1, name: 'Alice' }], expiresAt: Date.now() + CALL_RING_MS });
  assert.equal(h.states.at(-1).phase, 'incoming');
  assert.equal(h.peers.length, 0);
  await h.client.receive({ type: 'call_negotiate', callId, callerId: 1, calleeId: 2, callerClient, calleeClient: callerClient, revision: 1, mode: 'auto' });
  assert.equal(h.states.at(-1).phase, 'idle');
  h.client.reset();
});

test('recovering a ringing video call asks for media only on acceptance and releases both tracks on hangup', async () => {
  const video = { kind: 'video', enabled: true, stop() { this.stopped = true; } };
  const audio = { kind: 'audio', enabled: true, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [audio, video], getVideoTracks: () => [video], getAudioTracks: () => [audio] };
  const requests = [];
  const h = clientHarness({ userId: 2, clientId: calleeClient, getMedia: async kind => { requests.push(kind); return stream; } });
  const invite = { type: 'call_invite', callId, roomId: 4, callerId: 1, calleeId: 2, media: 'video', mode: 'auto', expiresAt: Date.now() + CALL_RING_MS };
  h.api.callPending = async () => ({ invite });
  try {
    await h.client.recoverInvite(4);
    await h.client.receive(invite);
    assert.equal(h.states.at(-1).phase, 'incoming');
    assert.equal(requests.length, 0);
    await h.client.accept('auto');
    assert.deepEqual(requests, ['video']);
    assert.equal(h.actions.at(-1).media, 'video');
    assert.equal(h.states.at(-1).localVideo, stream);
    await h.client.receive({ ...invite, type: 'call_negotiate', callerClient, calleeClient, revision: 1 });
    assert.deepEqual(h.peers[0].getSenders().map(sender => sender.track), [audio, video]);
    h.peers[0].ontrack({ track: video, streams: [stream] });
    assert.equal(h.states.at(-1).remoteVideo, stream);
    h.client.toggleCamera();
    assert.equal(video.enabled, false);
    assert.equal(audio.enabled, true);
    h.client.toggleCamera();
    assert.equal(video.enabled, true);
    await h.client.receive({ ...invite, type: 'call_ended' });
    assert.equal(audio.stopped && video.stopped, true);
    assert.equal(h.states.at(-1).localVideo, null);
    assert.equal(h.states.at(-1).remoteVideo, null);
    assert.equal(h.peers[0].closed, true);
  } finally { h.client.reset(); }
});

function mediaTrack(kind, facingMode) {
  return { kind, enabled: true, readyState: 'live',
    getSettings: () => ({ deviceId: facingMode, facingMode }),
    stop() { this.readyState = 'ended'; } };
}
function mediaStream(...initialTracks) {
  const tracks = new Set(initialTracks);
  return { getTracks: () => [...tracks], getVideoTracks: () => [...tracks].filter(t => t.kind === 'video'),
    getAudioTracks: () => [...tracks].filter(t => t.kind === 'audio'),
    addTrack: track => tracks.add(track), removeTrack: track => tracks.delete(track) };
}
async function connectedVideoCall(context, capture, cameras = ['user', 'environment']) {
  const mic = mediaTrack('audio');
  const front = mediaTrack('video', 'user');
  const requests = [];
  const h = clientHarness({
    getMedia: async () => mediaStream(mic, front),
    getCameras: async () => cameras.map(deviceId => ({ kind: 'videoinput', deviceId })),
    getCamera: async constraints => {
      requests.push(constraints);
      return capture(constraints, front);
    }
  });
  context.after(() => h.client.reset());
  await h.client.start(room, 'auto', 'video');
  const state = () => h.states.at(-1);
  await h.client.receive({ ...state().call, type: 'call_negotiate', callerClient, calleeClient, revision: 1 });
  const peer = h.peers[0];
  peer.connectionState = 'connected';
  peer.onconnectionstatechange();
  const videoSender = peer.getSenders().find(sender => sender.track === front);
  return { ...h, state, requests, front, mic, videoSender };
}

test('front and rear switching updates the peer and preview, preserving the muted microphone', async context => {
  const h = await connectedVideoCall(context, ({ facingMode }) => mediaStream(mediaTrack('video', facingMode.exact)));
  const originalActions = [...h.actions];
  h.client.toggleMute();
  h.client.toggleCamera();
  await h.client.switchCamera();
  assert.equal(h.requests.length, 0);
  h.client.toggleCamera();
  let previous = h.front;
  for (const facing of ['environment', 'user']) {
    await h.client.switchCamera();
    const state = h.state();
    assert.equal(state.cameraFacing, facing);
    assert.equal(state.localVideo.getVideoTracks()[0], h.videoSender.track);
    assert.equal(h.videoSender.track.getSettings().facingMode, facing);
    assert.equal(previous.readyState, 'ended');
    assert.equal(state.localVideo.getAudioTracks()[0], h.mic);
    assert.equal(h.mic.enabled, false);
    assert.equal(h.mic.readyState, 'live');
    assert.equal(state.phase, 'connected');
    previous = h.videoSender.track;
  }
  assert.deepEqual(h.actions, originalActions);
  assert.equal(h.peers.length, 1);
  assert.deepEqual(h.errors, []);
});

test('one reported camera offers no switch and never requests another camera', async context => {
  const h = await connectedVideoCall(context, () => assert.fail('unexpected capture'), ['user']);
  assert.equal(h.state().canSwitchCamera, false);
  await h.client.switchCamera();
  assert.equal(h.requests.length, 0);
  assert.equal(h.front.readyState, 'live');
});

test('a rejected sender replacement keeps the original camera and releases the unused track', async context => {
  const rear = mediaTrack('video', 'environment');
  const h = await connectedVideoCall(context, () => mediaStream(rear));
  h.videoSender.replaceTrack = async () => { throw new DOMException('cannot replace', 'InvalidModificationError'); };
  await h.client.switchCamera();
  assert.equal(h.videoSender.track, h.front);
  assert.equal(h.front.readyState, 'live');
  assert.equal(rear.readyState, 'ended');
  assert.equal(h.state().phase, 'connected');
  assert.equal(h.state().switchingCamera, false);
  assert.equal(h.errors.length, 1);
});

test('a phone requiring exclusive capture restores the old camera if the requested one fails', async context => {
  const restored = mediaTrack('video', 'user');
  const h = await connectedVideoCall(context, (constraints, front) => {
    if (front.readyState === 'live') throw new DOMException('camera busy', 'NotReadableError');
    if ((constraints.deviceId?.exact ?? constraints.facingMode?.exact) === 'user') return mediaStream(restored);
    throw new DOMException('unavailable', 'NotFoundError');
  });
  await h.client.switchCamera();
  assert.equal(h.front.readyState, 'ended');
  assert.equal(h.videoSender.track, restored);
  assert.equal(h.state().localVideo.getVideoTracks()[0], restored);
  assert.equal(h.state().cameraFacing, 'user');
  assert.equal(h.state().phase, 'connected');
  assert.equal(h.mic.readyState, 'live');
  assert.equal(h.errors.length, 1);
});

test('the camera can be reopened without redialing if both lenses temporarily fail', async context => {
  let available = false;
  const restored = mediaTrack('video', 'user');
  const h = await connectedVideoCall(context, () => {
    if (!available) throw new DOMException('camera in use', 'NotReadableError');
    return mediaStream(restored);
  });
  await h.client.switchCamera();
  assert.equal(h.state().cameraEnabled, false);
  assert.equal(h.mic.readyState, 'live');
  available = true;
  await h.client.toggleCamera();
  assert.equal(h.state().cameraEnabled, true);
  assert.equal(h.videoSender.track, restored);
  assert.equal(h.state().phase, 'connected');
});

test('a browser ignoring facingMode can switch by camera ID and releases the wrong capture', async context => {
  const ignored = mediaTrack('video', 'user');
  const rear = mediaTrack('video', 'environment');
  const h = await connectedVideoCall(context, constraints => mediaStream(constraints.deviceId ? rear : ignored));
  await h.client.switchCamera();
  assert.deepEqual(h.requests.map(c => c.deviceId?.exact ?? c.facingMode.exact), ['environment', 'environment']);
  assert.equal(ignored.readyState, 'ended');
  assert.equal(h.videoSender.track, rear);
  assert.equal(h.state().cameraFacing, 'environment');
});

test('multiple taps request one camera, and a new incoming call discards capture from a hung-up call', async context => {
  const pending = Promise.withResolvers();
  const rear = mediaTrack('video', 'environment');
  const h = await connectedVideoCall(context, () => pending.promise);
  const switching = h.client.switchCamera();
  const repeated = h.client.switchCamera();
  assert.equal(h.state().switchingCamera, true);
  await h.client.hangup();
  assert.equal(h.state().phase, 'idle');
  const nextId = crypto.randomUUID();
  await h.client.receive({ type: 'call_invite', callId: nextId, roomId: 4, callerId: 2, calleeId: 1,
    mode: 'auto', media: 'video', expiresAt: Date.now() + CALL_RING_MS });
  pending.resolve(mediaStream(rear));
  await Promise.all([switching, repeated]);
  assert.equal(h.requests.length, 1);
  assert.equal(rear.readyState, 'ended');
  assert.equal(h.state().phase, 'incoming');
  assert.equal(h.state().call.callId, nextId);
  assert.equal(h.state().localVideo, null);
  assert.deepEqual(h.errors, []);
});

test('relay renegotiation and disabling video during replacement keep the new sender in sync', async context => {
  const rear = mediaTrack('video', 'environment');
  const h = await connectedVideoCall(context, () => mediaStream(rear));
  const replacing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  h.videoSender.replaceTrack = async () => {
    replacing.resolve();
    await resume.promise;
    throw new DOMException('old peer closed', 'InvalidStateError');
  };
  const switching = h.client.switchCamera();
  await replacing.promise;
  h.client.toggleCamera();
  assert.equal(rear.enabled, false);
  await h.client.receive({ ...h.state().call, type: 'call_negotiate', callerClient, calleeClient, revision: 2, mode: 'relay' });
  resume.resolve();
  await switching;
  const current = h.peers[1].getSenders().find(sender => sender.track.kind === 'video');
  assert.equal(current.track, rear);
  assert.equal(h.state().cameraEnabled, false);
  assert.equal(current.track.enabled, false);
  assert.equal(h.state().localVideo.getVideoTracks()[0], rear);
  assert.equal(h.mic.enabled, true);
  assert.deepEqual(h.errors, []);
});

test('hanging up while an acceptance is in flight ends the accepted call and releases the device', async () => {
  const h = clientHarness({ userId: 2, clientId: calleeClient });
  const invite = { type: 'call_invite', callId, roomId: 4, callerId: 1, calleeId: 2, mode: 'auto', expiresAt: Date.now() + CALL_RING_MS };
  let resolveAccept;
  const accepting = new Promise(resolve => { resolveAccept = resolve; });
  h.api.callAction = async (_room, action) => {
    h.actions.push(action);
    if (action.type === 'accept') await accepting;
  };
  try {
    await h.client.receive(invite);
    const connection = h.client.accept('auto');
    await new Promise(resolve => setTimeout(resolve, 0));
    const hangup = h.client.hangup();
    assert.equal(h.track.stopped, true);
    resolveAccept();
    await Promise.all([connection, hangup]);
    assert.deepEqual(h.actions.map(a => a.type), ['accept', 'hangup']);
  } finally { h.client.reset(); }
});

test('a live hangup invalidates an outstanding restored invitation', async () => {
  const h = clientHarness({ userId: 2 });
  let resolvePending;
  h.api.callPending = () => new Promise(resolve => { resolvePending = resolve; });
  const invite = { type: 'call_invite', callId, roomId: 4, callerId: 1, calleeId: 2, media: 'video', expiresAt: Date.now() + CALL_RING_MS };
  const pending = h.client.recoverInvite(4);
  await h.client.receive({ ...invite, type: 'call_ended' });
  resolvePending({ invite });
  await pending;
  assert.equal(h.states.length, 0);
});

test('video capture errors do not start signaling and audio calls never request a camera', async () => {
  const media = [];
  const h = clientHarness({ getMedia: async kind => { media.push(kind); throw new Error('media unavailable'); } });
  await h.client.start(room, 'auto', 'video');
  await h.client.start(room, 'auto');
  assert.deepEqual(media, ['video', 'audio']);
  assert.equal(h.actions.length, 0);
  assert.equal(h.states.at(-1).phase, 'idle');
});

test('failed P2P starts one automatic relay renegotiation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = clientHarness();
  try {
    await h.client.start(room, 'auto');
    await h.client.receive({ ...h.states.at(-1).call, type: 'call_negotiate', callerClient, calleeClient, revision: 1, mode: 'auto' });
    context.mock.timers.tick(12_000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.ok(h.actions.some(action => action.type === 'restart' && action.mode === 'relay'));
  } finally { h.client.reset(); }
});

test('expired Inbox sessions receive no SDP, while legacy inboxes keep their chat connection', async () => {
  const socket = meta => ({ meta, packets: [], code: null, deserializeAttachment() { return this.meta; }, send(packet) { this.packets.push(JSON.parse(packet)); }, close(code) { this.code = code; } });
  const valid = socket({ userId: 2, token: 'valid' });
  const expired = socket({ userId: 2, token: 'expired' });
  const legacy = socket({ userId: 2 });
  const inbox = new UserInbox({ getWebSockets: () => [valid, expired, legacy] }, {
    SESSIONS: { get: async token => token === 'valid' ? JSON.stringify({ userId: 2, sessionVersion: 0, isAdmin: false }) : null },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ username: 'bob', session_version: 0, is_admin: 0 }] }) }) }) }
  });
  await inbox.broadcastCall({ type: 'call_signal', sdp: 'v=0' });
  assert.equal(valid.packets.length, 1);
  assert.equal(expired.packets.length, 0);
  assert.equal(expired.code, 4401);
  assert.equal(legacy.packets.length, 0);
  assert.equal(legacy.code, null);
});

test('VoiceCall persists across eviction, arbitrates accept, forwards signals and clears leases', async () => {
  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  database.run("INSERT INTO users(id,username,display_name,password_hash,password_salt) VALUES(1,'alice','Alice','h','s'),(2,'bob','Bob','h','s')");
  database.run("INSERT INTO channels(id,name,kind,dm_key,created_by) VALUES(4,'dm','dm','1:2',1)");
  database.run('INSERT INTO channel_members(channel_id,user_id) VALUES(4,1),(4,2)');
  const values = new Map();
  const notifications = [];
  const leases = new Map();
  const storage = { get: async key => values.get(key), put: async (key, value) => values.set(key, structuredClone(value)), delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); }, setAlarm: async () => {}, deleteAlarm: async () => {} };
  const env = { DB: createD1Adapter(database), USER_INBOX: { idFromName: name => name, get: user => ({ fetch: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (new URL(url).pathname === '/notify') notifications.push({ user, payload });
    else if (new URL(url).pathname === '/call-release') { if (leases.get(user)?.callId === payload.callId) leases.delete(user); }
    else { if (leases.has(user) && leases.get(user).callId !== payload.callId) return Response.json({ ok: false }, { status: 409 }); leases.set(user, payload); }
    return Response.json({ ok: true });
  } }) } };
  let object = new VoiceCall({ storage }, env);
  const request = (userId, body) => object.fetch(new Request('https://internal/action?roomId=4', { method: 'POST', headers: createVerifiedPrincipalHeaders({ 'Content-Type': 'application/json' }, { userId }), body: JSON.stringify(body) }));
  assert.equal((await request(1, start)).status, 200);
  assert.equal(notifications.filter(event => event.payload.type === 'call_invite').length, 2);
  const pending = async userId => (await object.fetch(new Request('https://internal/pending?roomId=4', { headers: createVerifiedPrincipalHeaders({}, { userId }) }))).json();
  assert.equal((await pending(1)).invite, null);
  const recovered = (await pending(2)).invite;
  assert.equal(recovered.callId, callId);
  assert.equal(recovered.media, 'audio');
  object = new VoiceCall({ storage }, env);
  assert.equal((await request(2, { type: 'accept', callId, clientId: calleeClient, mode: 'auto' })).status, 200);
  assert.equal((await pending(2)).invite, null);
  assert.equal((await request(2, { type: 'accept', callId, clientId: callerClient, mode: 'auto' })).status, 409);
  assert.equal((await request(1, { type: 'offer', callId, clientId: callerClient, revision: 1, sdp: 'v=0\r\n' })).status, 200);
  assert.equal(notifications.at(-1).user, 'user:2');
  assert.equal(notifications.at(-1).payload.signal.type, 'offer');
  assert.equal((await request(2, { type: 'hangup', callId, clientId: calleeClient })).status, 200);
  assert.equal(values.has('call'), false);
  assert.equal(leases.size, 0);
  assert.equal(notifications.at(-1).payload.type, 'call_ended');
  database.close();
});

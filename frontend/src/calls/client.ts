import { CALL_RING_MS, CALL_STUN, type CallMode, type CallMedia, type CallAction } from '../../../shared/voice-call.ts';
import { cameraSize, openCamera, type CameraFacing, type GetCamera } from './camera.ts';

interface CallSession {
  callId: string; roomId: number; callerId: number; calleeId: number; name: string;
  mode: CallMode; media: CallMedia; callerClient?: string; calleeClient?: string;
}
interface CallEvent extends CallSession {
  type: string; revision: number; expiresAt: number; reason?: string;
  users?: { id: number; name: string }[];
  signal?: { type: 'offer' | 'answer' | 'ice'; sdp?: string; candidate?: RTCIceCandidateInit };
}
export interface CallSnapshot {
  call: CallSession | null; phase: string; muted: boolean; route: string; needsPlay: boolean; duration: number;
  localVideo: MediaStream | null; remoteVideo: MediaStream | null; cameraEnabled: boolean;
  cameraFacing: CameraFacing; canSwitchCamera: boolean; switchingCamera: boolean;
}
interface CallApi {
  callConfig(roomId: number): Promise<{ turnAvailable: boolean; videoAvailable?: boolean }>;
  callPending(roomId: number): Promise<{ invite: CallEvent | null }>;
  callAction(roomId: number, action: CallAction): Promise<unknown>;
  callIce(roomId: number, callId: string, clientId: string): Promise<{ iceServers: RTCIceServer[] }>;
}
interface CallClientOptions {
  api: CallApi; userId: number; onChange(state: CallSnapshot): void; onError(error: Error): void;
  getMedia?: (media: CallMedia) => Promise<MediaStream>; createPeer?: (config: RTCConfiguration) => RTCPeerConnection;
  getCamera?: GetCamera; getCameras?: () => Promise<MediaDeviceInfo[]>;
  createAudio?: () => HTMLAudioElement; clientId?: string;
}

export function createVoiceCallClient({ api, userId, onChange, onError,
  getMedia = media => navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: media === 'video' ? { facingMode: 'user', ...cameraSize } : false
  }),
  getCamera = video => navigator.mediaDevices.getUserMedia({ audio: false, video }),
  getCameras = () => navigator.mediaDevices.enumerateDevices(),
  createPeer = config => new RTCPeerConnection(config),
  createAudio = () => new Audio(),
  clientId = crypto.randomUUID() }: CallClientOptions) {
  let call: CallSession | null = null;
  let peer: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let audio: HTMLAudioElement | null = null;
  let remoteVideo: MediaStream | null = null;
  let cameraEnabled = false;
  let cameraFacing: CameraFacing = 'user';
  let cameraDevices: MediaDeviceInfo[] = [];
  let cameraIds: Partial<Record<CameraFacing, string>> = {};
  let switchingCamera = false;
  let pendingCamera: MediaStreamTrack | null = null;
  let videoSender: RTCRtpSender | null = null;
  let generation = 0;
  let recovery = 0;
  let revision = 0;
  let candidates: RTCIceCandidateInit[] = [];
  let fallbackTimer: ReturnType<typeof setTimeout>;
  let ringTimer: ReturnType<typeof setTimeout>;
  let heartbeat: ReturnType<typeof setInterval>;
  let clock: ReturnType<typeof setInterval>;
  let connectedAt = 0;
  let turnAvailable = false;
  let eventQueue = Promise.resolve();
  let actionQueue = Promise.resolve();
  let phase = 'idle';
  let muted = false;
  let route = '';
  let needsPlay = false;
  const change = () => onChange({ call, phase, muted, route, needsPlay,
    localVideo: call?.media === 'video' ? stream : null, remoteVideo, cameraEnabled, cameraFacing, switchingCamera,
    canSwitchCamera: call?.media === 'video' && !!stream && cameraDevices.length !== 1,
    duration: connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : 0 });
  const action = (type: string, extra: Partial<CallAction> = {}) => {
    if (!call) return Promise.reject(new Error('call.ended'));
    const roomId = call.roomId;
    const payload = { type, callId: call.callId, clientId, ...extra };
    const pending = actionQueue.then(() => api.callAction(roomId, payload)).catch(error => {
      // 重协商已推进时，旧候选/SDP 只需丢弃，不能把新连接一起挂断。
      if (['ice', 'offer', 'answer'].includes(type) && error.status === 409 && error.rawMessage === '通话协商已更新') return;
      throw error;
    });
    actionQueue = pending.catch(() => {});
    return pending;
  };
  function closePeer() {
    clearTimeout(fallbackTimer);
    if (peer) { peer.onicecandidate = null; peer.onconnectionstatechange = null; peer.ontrack = null; peer.close(); }
    peer = null;
    videoSender = null;
    remoteVideo = null;
    needsPlay = false;
    candidates = [];
    if (audio) { audio.pause(); audio.srcObject = null; }
    audio = null;
  }
  function reset() {
    generation++;
    clearTimeout(ringTimer);
    clearInterval(heartbeat);
    clearInterval(clock);
    closePeer();
    stream?.getTracks().forEach(track => { track.stop(); });
    stream = null;
    pendingCamera?.stop();
    pendingCamera = null;
    cameraEnabled = false;
    cameraFacing = 'user';
    cameraDevices = [];
    cameraIds = {};
    switchingCamera = false;
    call = null;
    revision = 0;
    phase = 'idle';
    route = '';
    muted = false;
    connectedAt = 0;
    needsPlay = false;
    change();
  }
  async function hangup() {
    const answering = call && userId === call.calleeId;
    const localDraft = call && !answering && phase === 'permission';
    const decline = answering && (phase === 'incoming' || phase === 'permission');
    // If accept is already queued, hangup follows it even before our negotiation frame arrives.
    const pending = call && !localDraft ? action(decline ? 'reject' : 'hangup') : Promise.resolve();
    reset();
    await pending.catch(() => {});
  }
  async function fail(error) {
    onError(error);
    await hangup();
  }
  async function acquireMedia(epoch, kind: CallMedia) {
    const media = await getMedia(kind);
    // 用户可在授权弹窗仍打开时取消，迟到的媒体流不能留在后台采集。
    if (epoch !== generation) { media.getTracks().forEach(track => { track.stop(); }); return false; }
    stream = media;
    cameraEnabled = kind === 'video';
    if (cameraEnabled) {
      cameraFacing = media.getVideoTracks()[0]?.getSettings?.().facingMode === 'environment' ? 'environment' : 'user';
      void detectCameras(epoch);
    }
    return true;
  }
  async function detectCameras(epoch: number) {
    try {
      const devices = await getCameras();
      if (epoch !== generation) return;
      cameraDevices = devices.filter(device => device.kind === 'videoinput');
      change();
    } catch {
      // Permission to capture can be available even when the device list is hidden.
    }
  }
  function startTimers() {
    clearTimeout(ringTimer);
    if (phase === 'calling') ringTimer = setTimeout(() => { void fail(new Error('call.noAnswer')); }, CALL_RING_MS);
    heartbeat = setInterval(() => { void action('heartbeat').catch(fail); }, 25_000);
    clock = setInterval(change, 1000);
  }
  async function start(room, mode: CallMode, media: CallMedia = 'audio') {
    if (call || room.kind !== 'dm' || room.isBlockedByMe) return;
    const epoch = ++generation;
    call = { callId: crypto.randomUUID(), roomId: Number(room.id), callerId: userId,
      calleeId: room.otherUser.id, name: room.otherUser.displayName || room.otherUser.username || room.name, mode, media };
    phase = 'permission'; change();
    try {
      const config = await api.callConfig(call.roomId);
      if (epoch !== generation) return;
      turnAvailable = config.turnAvailable;
      if (media === 'video' && !config.videoAvailable) throw new Error('call.videoUnavailable');
      if (mode === 'relay' && !turnAvailable) throw new Error('call.turnUnavailable');
      if (!await acquireMedia(epoch, media)) return;
      phase = 'calling'; change();
      await action('start', { mode, media });
      if (epoch === generation) startTimers();
    } catch (error) { if (epoch === generation) await fail(error); }
  }
  async function accept(mode: CallMode) {
    if (phase !== 'incoming') return;
    const epoch = generation;
    phase = 'permission'; change();
    try {
      const config = await api.callConfig(call.roomId);
      if (epoch !== generation) return;
      turnAvailable = config.turnAvailable;
      if ((mode === 'relay' || call.mode === 'relay') && !turnAvailable) throw new Error('call.turnUnavailable');
      const media = call.media;
      if (!await acquireMedia(epoch, media)) return;
      phase = 'connecting'; change();
      await action('accept', { mode, media });
      if (epoch === generation) startTimers();
    } catch (error) { if (epoch === generation) await fail(error); }
  }
  async function switchMode(mode: CallMode) {
    if (!call || !['connecting', 'connected'].includes(phase) || call.mode === mode) return;
    if (mode === 'relay' && !turnAvailable) { onError(new Error('call.turnUnavailable')); return; }
    clearTimeout(fallbackTimer);
    await action('restart', { mode }).catch(fail);
  }
  function connectionTimeout() {
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (call?.mode === 'auto' && turnAvailable) void switchMode('relay');
      else void fail(new Error('call.connectionFailed'));
    }, call?.mode === 'relay' ? 20_000 : 12_000);
  }
  async function negotiate(event: CallEvent) {
    if (event.revision <= revision) return;
    const epoch = generation;
    closePeer();
    revision = event.revision;
    call.mode = event.mode;
    call.callerClient = event.callerClient;
    call.calleeClient = event.calleeClient;
    phase = 'connecting'; route = ''; change();
    clearTimeout(ringTimer);
    let iceServers: RTCIceServer[] = CALL_STUN;
    if (event.mode === 'relay') {
      const config = await api.callIce(call.roomId, call.callId, clientId);
      if (epoch !== generation || event.revision !== revision) return;
      iceServers = config.iceServers;
    }
    const current = createPeer({ iceServers, iceTransportPolicy: event.mode === 'relay' ? 'relay' : 'all' });
    peer = current;
    stream.getTracks().forEach(track => {
      const sender = current.addTrack(track, stream);
      if (track.kind === 'video') videoSender = sender;
    });
    current.onicecandidate = e => {
      if (peer === current && e.candidate) void action('ice', { revision: event.revision, candidate: e.candidate.toJSON() }).catch(error => {
        if (peer === current) void fail(error);
      });
    };
    current.ontrack = e => {
      if (peer !== current) return;
      if (e.track.kind === 'video') {
        if (call?.media === 'video') {
          remoteVideo = e.streams[0] || new MediaStream([e.track]);
          change();
        }
        return;
      }
      if (e.track.kind !== 'audio') return;
      audio ??= createAudio();
      audio.autoplay = true;
      audio.srcObject = new MediaStream([e.track]);
      void audio.play().catch(() => {
        if (peer === current) { needsPlay = true; change(); }
      });
    };
    current.onconnectionstatechange = () => {
      if (peer !== current) return;
      if (current.connectionState === 'connected') {
        clearTimeout(fallbackTimer);
        phase = 'connected';
        if (!connectedAt) connectedAt = Date.now();
        route = event.mode === 'relay' ? 'TURN' : 'P2P'; change();
      } else if (['failed', 'disconnected'].includes(current.connectionState)) {
        phase = 'connecting'; change(); connectionTimeout();
      }
    };
    connectionTimeout();
    if (userId === call.callerId) {
      await current.setLocalDescription(await current.createOffer());
      if (peer === current) await action('offer', { revision, sdp: current.localDescription.sdp });
    }
  }
  async function handleEvent(event: CallEvent) {
    if (event.type === 'call_invite') {
      if (event.calleeId !== userId || event.expiresAt <= Date.now()) return;
      if (call) {
        if (call.callId !== event.callId) {
          await api.callAction(event.roomId, { type: 'reject', callId: event.callId, clientId });
        }
        return;
      }
      generation++;
      call = { ...event, media: event.media ?? 'audio', name: event.users?.find(user => user.id === event.callerId)?.name || '' };
      phase = 'incoming'; change();
      ringTimer = setTimeout(reset, Math.max(0, event.expiresAt - Date.now()));
      return;
    }
    if (!call || event.callId !== call.callId) return;
    if (event.type === 'call_ended') {
      if (event.reason === 'rejected') onError(new Error('call.rejected'));
      if (event.reason === 'timeout') onError(new Error('call.noAnswer'));
      if (event.reason === 'limit') onError(new Error('call.limit'));
      reset(); return;
    }
    if (event.type === 'call_negotiate') {
      if ((userId === event.callerId ? event.callerClient : event.calleeClient) !== clientId) { reset(); return; }
      await negotiate(event); return;
    }
    if (event.type !== 'call_signal' || !peer || event.revision !== revision) return;
    const signal = event.signal;
    const current = peer;
    if (signal.type === 'ice') {
      if (current.remoteDescription) await current.addIceCandidate(signal.candidate);
      else candidates.push(signal.candidate);
      return;
    }
    await current.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
    if (peer !== current) return;
    for (const candidate of candidates) await current.addIceCandidate(candidate);
    candidates = [];
    if (signal.type === 'offer') {
      const answer = await current.createAnswer();
      if (peer !== current) return;
      await current.setLocalDescription(answer);
      if (peer === current) await action('answer', { revision, sdp: current.localDescription.sdp });
    }
  }
  function receive(event: CallEvent) {
    recovery++;
    const epoch = generation;
    eventQueue = eventQueue.then(() => handleEvent(event)).catch(error => {
      if (epoch === generation) return fail(error);
    });
    return eventQueue;
  }
  async function recoverInvite(roomId: number) {
    if (call) return;
    const request = ++recovery;
    const epoch = generation;
    try {
      const { invite } = await api.callPending(roomId);
      if (invite && request === recovery && epoch === generation) await receive(invite);
    } catch {
      // The live inbox can still deliver an invitation when the recovery request is unavailable.
    }
  }
  async function changeCamera(target: CameraFacing) {
    const local = stream;
    if (!local) return;
    const previous = local.getVideoTracks()[0];
    if (!previous || switchingCamera) return;
    const previousId = previous.getSettings?.().deviceId;
    if (previousId) cameraIds[cameraFacing] = previousId;
    const epoch = generation;
    const capture: GetCamera = constraints => {
      if (epoch !== generation) throw new DOMException('Call ended', 'AbortError');
      return getCamera(constraints);
    };
    async function install(track: MediaStreamTrack, facing: CameraFacing) {
      try {
        if (epoch !== generation) return;
        pendingCamera = track;
        track.enabled = cameraEnabled;
        // A P2P/relay restart can replace the sender while replaceTrack is pending.
        while (videoSender) {
          const sender = videoSender;
          try { await sender.replaceTrack(track); }
          catch (error) { if (sender === videoSender) throw error; }
          if (epoch !== generation) return;
          if (sender === videoSender) break;
        }
        local.addTrack(track);
        local.removeTrack(previous);
        previous.stop();
        cameraFacing = facing;
      } finally {
        if (pendingCamera === track) pendingCamera = null;
        if (epoch !== generation || !local.getVideoTracks().includes(track)) track.stop();
      }
    }
    const switching = target !== cameraFacing;
    const alternateId = cameraIds[target] ?? (previousId && cameraDevices.find(device => device.deviceId !== previousId)?.deviceId);
    const acquire = () => openCamera(capture, target, alternateId, switching ? previousId : undefined);
    switchingCamera = true;
    change();
    try {
      let next: MediaStreamTrack;
      try { next = await acquire(); }
      catch (error) {
        if (epoch !== generation || !switching || !['NotReadableError', 'AbortError'].includes(error.name)) throw error;
        // Some phones can only open one camera at a time. Keep the microphone live.
        previous.stop();
        next = await acquire();
      }
      await install(next, target);
    } catch {
      if (epoch !== generation) return;
      if (switching && previous.readyState === 'ended') {
        try {
          await install(await openCamera(capture, cameraFacing, previousId), cameraFacing);
        } catch {
          // Both lenses are unavailable. The camera toggle can retry while audio continues.
        }
      }
      if (epoch !== generation) return;
      if (local.getVideoTracks()[0]?.readyState === 'ended') cameraEnabled = false;
      onError(new Error('call.cameraSwitchFailed'));
    } finally {
      if (epoch === generation) { switchingCamera = false; change(); }
    }
  }
  function switchCamera() {
    if (call?.media !== 'video' || !cameraEnabled || cameraDevices.length === 1) return;
    return changeCamera(cameraFacing === 'user' ? 'environment' : 'user');
  }
  function toggleCamera() {
    if (!stream || call?.media !== 'video') return;
    cameraEnabled = !cameraEnabled;
    if (pendingCamera) pendingCamera.enabled = cameraEnabled;
    for (const track of stream.getVideoTracks()) track.enabled = cameraEnabled;
    if (cameraEnabled && stream.getVideoTracks()[0]?.readyState === 'ended' && !switchingCamera) {
      return changeCamera(cameraFacing);
    }
    change();
  }
  function toggleMute() {
    muted = !muted;
    stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); change();
  }
  async function play() {
    try { await audio?.play(); needsPlay = false; change(); }
    catch { onError(new Error('call.playFailed')); }
  }
  return { start, accept, hangup, switchMode, receive, recoverInvite, switchCamera, toggleCamera, toggleMute, play, reset };
}

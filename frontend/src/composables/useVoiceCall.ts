import { computed, ref, shallowRef } from 'vue';
import api from '../api.js';
import { t } from '../i18n.js';
import { isDemoMode } from '../runtime.js';
import { createVoiceCallClient, type CallSnapshot } from '../calls/client.ts';
import type { CallMedia, CallMode } from '../../../shared/voice-call.ts';
import { createCallRinger } from '../calls/ringer.ts';
import { isCapacitorAndroid } from '../capacitor-platform.ts';

export function useVoiceCall({ userId, error, notifyIncoming, shouldRing }) {
  const preferredMode = ref<CallMode>('auto');
  const state = shallowRef<CallSnapshot>({ call: null, phase: 'idle', muted: false, route: '', needsPlay: false, duration: 0,
    localVideo: null, remoteVideo: null, cameraEnabled: false, cameraFacing: 'user', switchingCamera: false, canSwitchCamera: false });
  const mode = computed(() => state.value.call && ['connecting', 'connected'].includes(state.value.phase)
    ? state.value.call.mode : preferredMode.value);
  const ringer = createCallRinger();
  const client = createVoiceCallClient({ api, userId,
    onChange: next => {
      if (next.phase === 'incoming' && state.value.phase !== 'incoming') {
        if (shouldRing(next.call)) ringer.start();
        if (document.visibilityState === 'hidden') notifyIncoming(next.call);
      } else if (next.phase !== 'incoming') {
        ringer.stop();
      }
      state.value = next;
    },
    onError: cause => {
      const message = cause.message;
      const video = state.value.call?.media === 'video';
      const mediaError = video && ['NotAllowedError', 'NotFoundError', 'NotReadableError'].includes(cause.name) ? 'call.videoDeviceError' : { NotAllowedError: 'voice.permissionDenied', NotFoundError: 'voice.noMicrophone', NotReadableError: 'voice.startFailed' }[cause.name];
      error.value = message?.startsWith('call.') ? t(message)
        : mediaError ? t(mediaError)
        : message || t('call.connectionFailed');
    }
  });
  function start(room, media: CallMedia = 'audio') {
    if (isDemoMode) { error.value = t('call.demoUnavailable'); return; }
    if (!globalThis.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) { error.value = t('call.unsupported'); return; }
    void client.start(room, preferredMode.value, media);
  }
  function receive(event) { if (!isCapacitorAndroid) void client.receive(event); }
  function recoverInvite(roomId: number) {
    if (!isDemoMode && !isCapacitorAndroid) void client.recoverInvite(roomId);
  }
  function changeMode(value: CallMode) {
    preferredMode.value = value;
    void client.switchMode(value);
  }
  return { state, mode, start, receive, recoverInvite, changeMode, accept: () => client.accept(preferredMode.value),
    hangup: client.hangup, toggleMute: client.toggleMute, toggleCamera: client.toggleCamera, switchCamera: client.switchCamera, play: client.play };
}

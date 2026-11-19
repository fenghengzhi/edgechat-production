<script setup lang="ts">
import { computed } from 'vue';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Volume2 } from '@lucide/vue';
import { useI18n } from '../../i18n.js';
const props = defineProps({ state: { type: Object, required: true } });
defineEmits(['accept', 'hangup', 'mute', 'camera', 'play']);
const { t } = useI18n();
const video = computed(() => props.state.call?.media === 'video');
const phaseLabel = computed(() => {
  if (video.value && props.state.phase === 'incoming') return t('call.videoIncoming');
  if (video.value && props.state.phase === 'permission') return t('call.videoPermission');
  return t(`call.${props.state.phase}`);
});
function duration(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
</script>

<template>
  <section v-if="state.call" class="voice-call-bar" :aria-label="t(video ? 'call.video' : 'call.voice')">
    <div class="voice-call-bar__identity" role="status" aria-live="polite">
      <strong :title="state.call.name">{{ state.call.name }}</strong>
      <span>{{ phaseLabel }}<template v-if="state.route"> · {{ state.route }} · {{ duration(state.duration) }}</template></span>
    </div>
    <button v-if="state.phase === 'incoming'" type="button" class="voice-call-bar__accept" :aria-label="t(video ? 'call.acceptVideo' : 'call.accept')" :title="t(video ? 'call.acceptVideo' : 'call.accept')" @click="$emit('accept')"><Video v-if="video" :size="20" /><Phone v-else :size="20" /></button>
    <button v-if="['connecting', 'connected'].includes(state.phase)" type="button" :aria-label="state.muted ? t('call.unmute') : t('call.mute')" :title="state.muted ? t('call.unmute') : t('call.mute')" :aria-pressed="state.muted" @click="$emit('mute')"><MicOff v-if="state.muted" :size="20" /><Mic v-else :size="20" /></button>
    <button v-if="video && state.localVideo" type="button" :aria-label="t(state.cameraEnabled ? 'call.cameraOff' : 'call.cameraOn')" :title="t(state.cameraEnabled ? 'call.cameraOff' : 'call.cameraOn')" :aria-pressed="state.cameraEnabled" @click="$emit('camera')"><Video v-if="state.cameraEnabled" :size="20" /><VideoOff v-else :size="20" /></button>
    <button v-if="state.needsPlay" type="button" :aria-label="t('call.play')" :title="t('call.play')" @click="$emit('play')"><Volume2 :size="20" /></button>
    <button type="button" class="voice-call-bar__hangup" :aria-label="state.phase === 'incoming' ? t('call.reject') : t('call.hangup')" :title="state.phase === 'incoming' ? t('call.reject') : t('call.hangup')" @click="$emit('hangup')"><PhoneOff :size="20" /></button>
    <div v-if="video && (state.localVideo || state.remoteVideo)" class="call-video">
      <video v-if="state.remoteVideo" class="call-video__remote" :srcObject.prop="state.remoteVideo" autoplay muted playsinline :aria-label="t('call.remoteVideo')" />
      <video v-if="state.localVideo && state.cameraEnabled" class="call-video__local" :class="{ 'call-video__local--inset': state.remoteVideo }" :srcObject.prop="state.localVideo" autoplay muted playsinline :aria-label="t('call.localVideo')" />
    </div>
  </section>
</template>

<style scoped>
.voice-call-bar { position: fixed; z-index: 70; top: var(--chat-viewport-offset-top, 0px); left: 0; width: 100%; height: 64px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--chat-line); background: var(--chat-selected); color: var(--chat-ink); }
.voice-call-bar__identity { flex: 1; min-width: 0; }
.voice-call-bar__identity strong, .voice-call-bar__identity span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 1.5; }
.voice-call-bar__identity span { font-variant-numeric: tabular-nums; }
.voice-call-bar button { flex: 0 0 44px; width: 44px; height: 44px; border: 0; border-radius: 6px; display: grid; place-items: center; background: transparent; color: inherit; cursor: pointer; }
.voice-call-bar button:hover { background: #0001; }
.voice-call-bar button:focus-visible { outline: 2px solid var(--chat-accent, #227a50); outline-offset: 2px; }
.voice-call-bar .voice-call-bar__accept { background: #257d4e; color: #fff; }
.voice-call-bar .voice-call-bar__hangup { background: #bf3434; color: #fff; }
.call-video { position: absolute; top: calc(100% + 8px); right: 8px; width: min(360px, calc(100vw - 16px)); pointer-events: none; }
.call-video video { display: block; max-height: 48dvh; border-radius: 8px; background: #171717; }
.call-video__remote { width: 100%; object-fit: contain; }
.call-video__local { width: 35%; margin-left: auto; transform: scaleX(-1); }
.call-video__local--inset { position: absolute; width: 28%; right: 8px; bottom: 8px; border: 1px solid #fffc; }
@media (max-width: 600px) { .voice-call-bar { padding: 8px; } }
</style>

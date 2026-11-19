<script setup>
import { computed, onMounted, ref } from 'vue';
import { Capacitor } from '@capacitor/core';
import api from '../../api.js';
import store from '../../store.js';
import { isDemoMode } from '../../runtime.js';
import { useI18n } from '../../i18n.js';
import { enableDevicePush, loadDevicePush, removeDevicePush, supportsWebPush } from '../../web-push.js';
import UiButton from '../ui/Button.vue';

const { t } = useI18n();
const visible = !isDemoMode && !Capacitor.isNativePlatform();
const supported = supportsWebPush();
const status = ref(supported ? 'loading' : 'unsupported');
const busy = ref(false);
const feedback = ref('');
let device;

const description = computed(() => t(status.value === 'loading' ? 'common.loading' : `settings.push.${status.value}`));
async function refresh() {
  busy.value = true;
  try {
    device = await loadDevicePush(api, store.session.userId);
    status.value = device.active ? 'on' : Notification.permission === 'denied' ? 'denied' : device.config.enabled ? 'off' : 'unconfigured';
  } catch {
    status.value = 'failed';
  } finally {
    busy.value = false;
  }
}
async function toggle() {
  feedback.value = '';
  busy.value = true;
  try {
    if (status.value === 'on') await removeDevicePush(api, device.registration);
    else await enableDevicePush(api, store.session.userId, device);
  } catch (error) {
    feedback.value = t(error?.name === 'NotAllowedError' ? 'settings.push.permission' : 'settings.push.saveFailed');
  } finally {
    await refresh();
  }
}
onMounted(() => { if (visible && supported) void refresh(); });
</script>

<template>
  <section v-if="visible">
    <h2>{{ t('settings.push.title') }}</h2>
    <p>{{ t('settings.push.hint') }}</p>
    <p role="status">{{ description }}</p>
    <UiButton v-if="status === 'on' || status === 'off'" :disabled="busy" @click="toggle">
      {{ t(status === 'on' ? 'settings.push.disable' : 'settings.push.enable') }}
    </UiButton>
    <UiButton v-else-if="status === 'failed'" :disabled="busy" @click="refresh">{{ t('common.retry') }}</UiButton>
    <p v-if="feedback" role="alert">{{ feedback }}</p>
  </section>
</template>

<style scoped>
h2 { margin: 0; padding-bottom: 10px; border-bottom: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.08); color: var(--auth-ink, #2c4a6e); font-size: 14px; }
p { margin: 8px 0; color: var(--auth-muted, #6b7c93); font-size: 13px; line-height: 1.6; }
</style>

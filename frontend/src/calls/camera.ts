export type CameraFacing = 'user' | 'environment';
export type GetCamera = (constraints: MediaTrackConstraints) => Promise<MediaStream>;

export const cameraSize = { width: { ideal: 640 }, height: { ideal: 480 } };

export async function openCamera(getCamera: GetCamera, facing: CameraFacing, alternateId?: string, previousId?: string) {
  async function open(constraints: MediaTrackConstraints) {
    const media = await getCamera({ ...cameraSize, ...constraints });
    const track = media.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    if (!track || track.readyState === 'ended' || (previousId && settings?.deviceId === previousId)
      || (settings?.facingMode && settings.facingMode !== facing)) {
      media.getTracks().forEach(track => track.stop());
      throw new DOMException('Camera does not match the requested lens', 'OverconstrainedError');
    }
    return track;
  }
  // Restore the original physical lens when a phone has several cameras on the same side.
  if (alternateId && !previousId) return open({ deviceId: { exact: alternateId } });
  try {
    return await open({ facingMode: { exact: facing } });
  } catch (error) {
    // Some browsers expose camera IDs but cannot select devices by facingMode.
    if (!alternateId || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
    return open({ deviceId: { exact: alternateId } });
  }
}

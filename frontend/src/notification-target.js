const ROOM_KINDS = new Set(['dm', 'public', 'private']);
const KIND_PARAM = 'notificationRoomKind';
const ID_PARAM = 'notificationRoomId';
const RECIPIENT_PARAM = 'notificationRecipient';

export function parseNotificationRoomTarget(data) {
  const kind = data?.roomKind;
  const id = Number(data?.roomId);
  if (!ROOM_KINDS.has(kind) || !Number.isSafeInteger(id) || id <= 0) return null;
  if (data?.recipientId == null) return { kind, id };
  const recipientId = Number(data.recipientId);
  return Number.isSafeInteger(recipientId) && recipientId > 0 ? { kind, id, recipientId } : null;
}

export function takeNotificationRoomTarget(browserWindow) {
  const url = new URL(browserWindow.location.href);
  if (!url.searchParams.has(KIND_PARAM) && !url.searchParams.has(ID_PARAM)) {
    return null;
  }

  const target = parseNotificationRoomTarget({
    roomKind: url.searchParams.get(KIND_PARAM),
    roomId: url.searchParams.get(ID_PARAM),
    recipientId: url.searchParams.get(RECIPIENT_PARAM)
  });
  url.searchParams.delete(KIND_PARAM);
  url.searchParams.delete(ID_PARAM);
  url.searchParams.delete(RECIPIENT_PARAM);
  browserWindow.history.replaceState(
    browserWindow.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
  return target;
}
